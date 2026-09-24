import { Router } from 'express';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { MetodoPago, EstadoLiquidacion, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { validateBody, positiveDecimal, optionalDateOnlyString, optionalText, paymentMethodSchema, requiredText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { getContractDebtSummary } from '../services/debt.service';
import { formatCurrency } from '../utils/currency';
import { assertSameCurrency } from '../services/currency-rules.service';
import { assertCashPeriodOpen, prepareCashCorrection } from '../services/cash-closing.service';
import { z } from 'zod';
import { argentinaTodayAsDate, assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import { withPagination } from '../middlewares/pagination.middleware';
import { getTenantCollectionState, getTenantSettlement } from '../services/tenant-credit.service';
import { syncInstallmentsForLiquidationSettlement } from '../services/installment-plan-lifecycle.service';
import { userHasPermission } from '../services/permissions.service';

const router = Router();

const pagoSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    liquidacionId: z.coerce.number().int().positive('Liquidación inválida').optional(),
    monto: positiveDecimal('El monto'),
    fechaPago: optionalDateOnlyString('La fecha de pago'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    moneda: z.enum(['ARS', 'USD']).optional(),
    observaciones: optionalText(1000),
    expectedLiquidationVersion: z.coerce.number().int().positive().optional()
});

const anulacionSchema = z.object({
    motivo: requiredText('El motivo de anulación', 1000).min(5, 'El motivo debe tener al menos 5 caracteres')
});

const emptyOptionalQueryValues = new Set(['', 'undefined', 'null']);

/**
 * Los clientes no siempre controlan los parámetros opcionales antes de
 * serializarlos. Los placeholders vacíos no son filtros ni fechas válidas.
 */
const optionalQueryText = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
        throw Object.assign(new Error(`El filtro ${field} no es válido`), {
            statusCode: 400,
            code: 'INVALID_PAYMENT_FILTER'
        });
    }
    const normalized = value.trim();
    return emptyOptionalQueryValues.has(normalized.toLowerCase()) ? undefined : normalized;
};

const optionalPaymentDateFilter = (value: unknown, field: 'desde' | 'hasta') => {
    const dateText = optionalQueryText(value, field);
    if (!dateText) return undefined;
    try {
        return parseDateOnly(dateText);
    } catch {
        throw Object.assign(new Error(`El filtro ${field} debe tener formato YYYY-MM-DD`), {
            statusCode: 400,
            code: 'INVALID_PAYMENT_DATE_FILTER',
            details: { field }
        });
    }
};

/**
 * Obtener todos los pagos de la inmobiliaria (Global) con paginación y búsqueda
 */
router.get('/', authenticateToken, requirePermission('pagos.ver'), withPagination(50), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search, moneda, metodoPago, estado, desde, hasta, propietarioId, inquilinoId, cuenta } = req.query;

    const { page: pageNum, limit: limitNum, skip } = res.locals.pagination;

    try {
        const desdeDate = optionalPaymentDateFilter(desde, 'desde');
        const hastaDate = optionalPaymentDateFilter(hasta, 'hasta');
        if (desdeDate && hastaDate && desdeDate > hastaDate) {
            throw Object.assign(new Error('El filtro desde no puede ser posterior al filtro hasta'), {
                statusCode: 400,
                code: 'INVALID_PAYMENT_DATE_RANGE'
            });
        }
        const whereClause: any = {
            liquidacion: {
                inmobiliariaId
            }
        };

        if (search) {
            whereClause.OR = [
                { observaciones: { contains: String(search), mode: 'insensitive' } },
                { liquidacion: { contrato: { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } } } },
                { liquidacion: { contrato: { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } } } }
            ];
        }
        if (moneda === 'ARS' || moneda === 'USD') whereClause.moneda = moneda;
        if (['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE'].includes(String(metodoPago))) whereClause.metodoPago = metodoPago;
        if (estado === 'ANULADO') whereClause.anuladoEn = { not: null };
        if (estado === 'VIGENTE') whereClause.anuladoEn = null;
        if (cuenta === 'CAJA' || cuenta === 'BANCO') whereClause.movimientoCaja = { is: { cuenta } };
        if (desdeDate || hastaDate) whereClause.fechaPago = {
            ...(desdeDate ? { gte: desdeDate } : {}),
            ...(hastaDate ? { lte: hastaDate } : {})
        };
        const contractFilter: any = {};
        if (Number(propietarioId)) contractFilter.propietarios = { some: { personaId: Number(propietarioId) } };
        if (Number(inquilinoId)) contractFilter.inquilinos = { some: { personaId: Number(inquilinoId) } };
        if (Object.keys(contractFilter).length) whereClause.liquidacion = { ...whereClause.liquidacion, contrato: contractFilter };

        const total = await prisma.pago.count({ where: whereClause });

        const pagos = await prisma.pago.findMany({
            where: whereClause,
            include: {
                creadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                anuladoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                movimientoCaja: { select: { cuenta: true } },
                liquidacion: {
                    include: {
                        contrato: {
                            include: {
                                propiedad: true,
                                inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                                propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                            }
                        }
                    }
                }
            },
            orderBy: [{ fechaPago: 'desc' }, { id: 'desc' }],
            skip,
            take: limitNum
        });

        const auditLogs = await prisma.auditLog.findMany({
            where: {
                inmobiliariaId,
                entidad: 'Pago',
                entidadId: { in: pagos.map(p => p.id) }
            },
            include: {
                usuario: {
                    select: { id: true, nombreCompleto: true, email: true }
                }
            },
            orderBy: { fechaCreacion: 'desc' }
        });

        const pagosConAuditoria = pagos.map(pago => ({
            ...pago,
            auditLogs: auditLogs.filter(log => log.entidadId === pago.id)
        }));

        res.json({
            data: pagosConAuditoria,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error: any) {
        if (error?.statusCode === 400) {
            return res.status(400).json({
                message: error.message || 'Los filtros de pagos no son válidos',
                code: error.code || 'INVALID_PAYMENT_FILTER',
                details: error.details
            });
        }
        console.error('Error fetching pagos globales:', error);
        res.status(500).json({ message: 'Error al obtener historial de pagos' });
    }
});

/**
 * Registrar un pago entregado por el inquilino.
 * Desde el detalle se aplica a una liquidación explícita. Sin liquidacionId se
 * conserva el flujo global que distribuye sobre las deudas más antiguas.
 */
router.post('/', authenticateToken, requirePermission('pagos.crear'), validateBody(pagoSchema), async (req, res) => {
    const { contratoId, liquidacionId, monto, fechaPago, metodoPago, moneda, observaciones, expectedLiquidationVersion } = req.body;
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;

    try {
        const paymentDate = fechaPago ? parseDateOnly(fechaPago) : argentinaTodayAsDate();
        assertOperationalDateIsNotFuture(paymentDate, 'La fecha de cobro');
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(contratoId), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        // Ejecutamos todo en una transacción para asegurar integridad
        const result = await prisma.$transaction(async (tx) => {
            // 1. Buscar liquidaciones del contrato que no sean borrador y no estén pagadas del todo
            // Traemos también sus pagos para calcular la deuda actual de cada una
            const liquidaciones = await tx.liquidacion.findMany({
                where: {
                    contratoId: Number(contratoId),
                    inmobiliariaId,
                    // El pago al propietario no cambia la posibilidad de
                    // cobrar al inquilino: sólo los documentos confirmados
                    // con saldo real se consideran aquí.
                    estado: EstadoLiquidacion.CONFIRMADA,
                    ...(liquidacionId ? { id: Number(liquidacionId) } : {})
                },
                include: {
                    pagos: { where: { anuladoEn: null } },
                    aplicacionesCredito: true,
                    contrato: {
                        include: { propiedad: true }
                    }
                },
                orderBy: {
                    periodo: 'asc'
                }
            });

            // 2. Calcular deuda real por liquidación y filtrar las que deben algo
            const liquidacionesConDeuda = liquidaciones.map(liq => {
                assertSameCurrency(liq.moneda, contrato.moneda, 'La liquidación tiene una moneda distinta a la del contrato');
                if (moneda && moneda !== liq.moneda) {
                    assertSameCurrency(moneda, liq.moneda, `El pago debe registrarse en ${liq.moneda}; no se permite mezclar monedas en una misma operación`);
                }

                const { saldo: deuda } = getTenantSettlement(liq);
                return { ...liq, deuda };
            }).filter(l => l.deuda.greaterThan(0));

            if (liquidacionesConDeuda.length === 0) {
                // Si no hay deuda, quizás es un pago adelantado o error? 
                // Por requerimiento técnico: No existen pagos sin liquidación previa.
                throw Object.assign(
                    new Error(liquidacionId
                        ? 'La liquidación indicada no tiene deuda pendiente o no pertenece al contrato'
                        : 'No existen liquidaciones pendientes de pago para este contrato'),
                    { statusCode: 409, code: liquidacionId ? 'LIQUIDATION_NOT_PAYABLE' : 'NO_PENDING_LIQUIDATIONS' }
                );
            }

            const deudaTotal = liquidacionesConDeuda.reduce(
                (total, liquidacion) => total.plus(liquidacion.deuda),
                new Decimal(0)
            );
            const montoEntregado = new Decimal(monto.toString());
            if (montoEntregado.greaterThan(deudaTotal)) {
                throw Object.assign(
                    new Error(`El pago supera ${liquidacionId ? 'la deuda de esta liquidación' : 'la deuda total'}. El máximo permitido es ${formatCurrency(deudaTotal.toString(), contrato.moneda)}`),
                    { statusCode: 409, code: 'PAYMENT_EXCEEDS_DEBT' }
                );
            }

            let montoRestante = montoEntregado;
            const pagosCreados = [];

            // 3. Distribuir el monto
            for (const liq of liquidacionesConDeuda) {
                if (montoRestante.lessThanOrEqualTo(0)) break;

                const montoAAplicar = Decimal.min(montoRestante, liq.deuda);

                const nuevoPago = await tx.pago.create({
                    data: {
                        monto: montoAAplicar,
                        moneda: liq.moneda,
                        fechaPago: paymentDate,
                        metodoPago: metodoPago || MetodoPago.EFECTIVO,
                        observaciones,
                        contratoId: Number(contratoId),
                        liquidacionId: liq.id,
                        inmobiliariaId,
                        creadoPorId: usuarioId
                    }
                });

                pagosCreados.push(nuevoPago);
                montoRestante = montoRestante.minus(montoAAplicar);

                const cuentaCobro = (metodoPago === 'EFECTIVO' || !metodoPago) ? 'CAJA' : 'BANCO';
                const dir = (liq as any).contrato?.propiedad?.direccion || 'Sin dirección';
                const periodoStr = new Date(liq.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

                await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: paymentDate, cuenta: cuentaCobro, moneda: liq.moneda });
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Cobro Alquiler - ${dir} - Liq. ${periodoStr}`,
                        monto: montoAAplicar,
                        moneda: liq.moneda,
                        fecha: paymentDate,
                        creadoPorId: usuarioId,
                        contratoId: Number(contratoId),
                        liquidacionId: liq.id,
                        pagoId: nuevoPago.id,
                        metodoPago: metodoPago || MetodoPago.EFECTIVO,
                        cuenta: cuentaCobro
                    }
                });

                const updatedLiquidation = await tx.liquidacion.updateMany({
                    where: {
                        id: liq.id,
                        estado: EstadoLiquidacion.CONFIRMADA,
                        ...(liquidacionId && expectedLiquidationVersion ? { version: expectedLiquidationVersion } : {})
                    },
                    data: {
                        estadoCobroInquilino: getTenantCollectionState({
                            ...liq,
                            pagos: [...liq.pagos, nuevoPago]
                        }),
                        version: { increment: 1 }
                    }
                });
                if (updatedLiquidation.count !== 1) {
                    throw Object.assign(new Error('La liquidación cambió mientras registrabas el cobro. Actualizá la pantalla e intentá nuevamente'), {
                        statusCode: 409, code: 'LIQUIDATION_CHANGED'
                    });
                }
                await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId: liq.id, usuarioId });
            }

            // Si sobró dinero, el sistema no lo permite según la regla "No pagos sin liquidación"
            // pero podríamos considerar dejarlo como saldo a favor en una tabla de caja (futuro).
            // Por ahora, devolvemos lo procesado.

            return {
                pagos: pagosCreados,
                montoSobrante: montoRestante,
                moneda: contrato.moneda,
                modoAplicacion: liquidacionId ? 'LIQUIDACION_ESPECIFICA' : 'DEUDA_MAS_ANTIGUA'
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO',
            entidad: 'Contrato',
            entidadId: Number(contratoId),
            detalle: `Pago registrado por ${formatCurrency(monto, result.moneda)} aplicado a ${result.pagos.length} liquidaciones.`
        });

        const pagosConDetalle = await prisma.pago.findMany({
            where: { id: { in: result.pagos.map(p => p.id) } },
            include: {
                liquidacion: {
                    include: {
                        contrato: {
                            include: {
                                propiedad: true,
                                inquilinos: { where: { esPrincipal: true }, include: { persona: true } }
                            }
                        }
                    }
                }
            }
        });

        await Promise.all(pagosConDetalle.map((pago) => {
            const periodo = new Date(pago.liquidacion.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            const propiedad = pago.liquidacion.contrato?.propiedad?.direccion || 'Sin dirección';
            const inquilino = pago.liquidacion.contrato?.inquilinos?.[0]?.persona?.nombreCompleto || 'Sin inquilino';
            const detalle = `Cobro a ${inquilino} por ${formatCurrency(pago.monto.toString(), pago.moneda)} - ${propiedad} - ${periodo}`;

            return auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO',
            entidad: 'Pago',
            entidadId: pago.id,
            detalle
        });
        }));

        await Promise.all(pagosConDetalle.map((pago) => {
            const periodo = new Date(pago.liquidacion.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            const propiedad = pago.liquidacion.contrato?.propiedad?.direccion || 'Sin dirección';

            return auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: pago.liquidacionId,
            detalle: `Cobro de inquilino por ${formatCurrency(pago.monto.toString(), pago.moneda)} - ${propiedad} - ${periodo}`
        });
        }));

        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(result);
    } catch (error: any) {
        console.error(error);
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'REGISTRAR_PAGO_LIQUIDACION', entidad: 'Liquidacion',
            entidadId: liquidacionId ? Number(liquidacionId) : undefined,
            detalle: error.message, resultado: 'FALLIDO', severidad: 'WARNING'
        });
        res.status(error.statusCode || 400).json({ message: error.message || 'Error al registrar el pago', code: error.code });
    }
});

/**
 * Anular un pago sin borrar historia. La misma transacción marca el pago,
 * revierte su asiento de caja y vuelve a calcular el estado de la liquidación.
 */
router.post('/:id/anular', authenticateToken, requirePermission('pagos.eliminar'), requireRecentAuthentication, validateBody(anulacionSchema), async (req, res) => {
    const pagoId = Number(req.params.id);
    const { motivo } = req.body;
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;

    if (!Number.isInteger(pagoId) || pagoId <= 0) {
        return res.status(400).json({ message: 'Pago inválido' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const pago = await tx.pago.findFirst({
                where: { id: pagoId, inmobiliariaId },
                include: {
                    liquidacion: {
                        include: {
                            pagos: { where: { anuladoEn: null }, select: { id: true, monto: true } },
                            pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } }
                        }
                    },
                    movimientoCaja: { include: { reversion: true } }
                }
            });

            if (!pago) {
                throw Object.assign(new Error('Pago no encontrado'), { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
            }
            if (pago.anuladoEn) {
                throw Object.assign(new Error('El pago ya fue anulado'), { statusCode: 409, code: 'PAYMENT_ALREADY_VOIDED' });
            }
            const cobradoLuegoDeAnular = pago.liquidacion.pagos
                .filter(item => item.id !== pago.id)
                .reduce((total, item) => total.plus(item.monto), new Decimal(0));
            const entregadoPropietario = pago.liquidacion.pagosPropietario
                .reduce((total, item) => total.plus(item.monto), new Decimal(0));
            if (entregadoPropietario.greaterThan(cobradoLuegoDeAnular)
                && !(await userHasPermission(usuarioId, (req as AuthRequest).user!.tipo, 'liquidaciones.adelantar_propietario'))) {
                throw Object.assign(new Error('Anular este cobro aumenta un adelanto vigente. Requiere permiso para adelantar fondos al propietario.'), {
                    statusCode: 403, code: 'OWNER_ADVANCE_PERMISSION_REQUIRED'
                });
            }

            let movimientoOriginal = pago.movimientoCaja;
            if (!movimientoOriginal) {
                movimientoOriginal = await tx.movimientoCaja.findFirst({
                    where: {
                        inmobiliariaId,
                        pagoId: null,
                        tipo: 'INGRESO',
                        contratoId: pago.contratoId,
                        liquidacionId: pago.liquidacionId,
                        monto: pago.monto,
                        moneda: pago.moneda,
                        fecha: pago.fechaPago,
                        metodoPago: pago.metodoPago,
                        reversionDeId: null
                    },
                    include: { reversion: true },
                    orderBy: { id: 'asc' }
                });

            }

            if (!movimientoOriginal || movimientoOriginal.reversion) {
                throw Object.assign(
                    new Error('No se encontró un asiento de caja reversible para este pago'),
                    { statusCode: 409, code: 'PAYMENT_CASH_ENTRY_NOT_REVERSIBLE' }
                );
            }

            const anulacionEn = new Date();
            const fechaCorreccion = argentinaTodayAsDate(anulacionEn);
            const { originalPeriodClosed } = await prepareCashCorrection(tx, {
                inmobiliariaId,
                fechaCorreccion,
                movimientoOriginal: movimientoOriginal
            });
            const updated = await tx.pago.updateMany({
                where: { id: pago.id, inmobiliariaId, anuladoEn: null },
                data: { anuladoEn: anulacionEn, anuladoPorId: usuarioId, motivoAnulacion: motivo }
            });
            if (updated.count !== 1) {
                throw Object.assign(new Error('El pago ya fue anulado'), { statusCode: 409, code: 'PAYMENT_ALREADY_VOIDED' });
            }

            // El documento de pago se anula para recalcular la deuda actual,
            // pero su asiento histórico queda intacto si ese mes ya se cerró.
            if (!originalPeriodClosed) {
                await tx.movimientoCaja.update({
                    where: { id: movimientoOriginal.id },
                    data: { anuladoEn: anulacionEn, anuladoPorId: usuarioId, motivoAnulacion: motivo }
                });
            }

            const movimientoReversion = await tx.movimientoCaja.create({
                data: {
                    inmobiliariaId,
                    tipo: 'EGRESO',
                    concepto: `Reversión pago #${pago.id}: ${movimientoOriginal.concepto}`,
                    monto: pago.monto,
                    moneda: pago.moneda,
                    fecha: fechaCorreccion,
                    metodoPago: movimientoOriginal.metodoPago,
                    cuenta: movimientoOriginal.cuenta,
                    observaciones: motivo,
                    creadoPorId: usuarioId,
                    contratoId: pago.contratoId,
                    liquidacionId: pago.liquidacionId,
                    reversionDeId: movimientoOriginal.id
                }
            });

            const liquidacionActualizada = await tx.liquidacion.findUniqueOrThrow({
                where: { id: pago.liquidacionId },
                include: {
                    pagos: { where: { anuladoEn: null } },
                    aplicacionesCredito: true
                }
            });
            await tx.liquidacion.update({
                where: { id: pago.liquidacionId },
                data: { estadoCobroInquilino: getTenantCollectionState(liquidacionActualizada), version: { increment: 1 } }
            });
            await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId: pago.liquidacionId, usuarioId });

            await tx.auditLog.create({
                data: {
                    usuarioId,
                    inmobiliariaId,
                    accion: 'ANULAR_PAGO',
                    entidad: 'Pago',
                    entidadId: pago.id,
                    severidad: 'WARNING',
                    detalle: `Pago de ${formatCurrency(pago.monto.toString(), pago.moneda)} anulado. Motivo: ${motivo}. Asiento inverso #${movimientoReversion.id}.`
                }
            });

            return {
                pagoId: pago.id,
                anuladoEn: anulacionEn,
                motivoAnulacion: motivo,
                movimientoReversion,
                liquidacion: { id: pago.liquidacionId, estadoCobroInquilino: liquidacionActualizada.estadoCobroInquilino }
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(result);
    } catch (error: any) {
        console.error('Error al anular pago:', error);
        res.status(error.statusCode || 400).json({ message: error.message || 'Error al anular el pago', code: error.code });
    }
});

/**
 * Obtener historial de pagos de un contrato
 */
router.get('/contrato/:id', authenticateToken, requirePermission('pagos.ver'), withPagination(50), async (req, res) => {
    const { id } = req.params;
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const pagination = res.locals.pagination;

    try {
        const pagos = await prisma.pago.findMany({
            where: {
                contratoId: Number(id),
                inmobiliariaId
            },
            include: {
                creadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                anuladoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                liquidacion: {
                    select: { periodo: true, netoACobrar: true, moneda: true }
                }
            },
            orderBy: [{ fechaPago: 'desc' }, { id: 'desc' }],
            skip: pagination.skip,
            take: pagination.limit
        });

        const total = await prisma.pago.count({ where: { contratoId: Number(id), inmobiliariaId } });
        res.json({
            data: pagos,
            meta: {
                total,
                page: pagination.page,
                limit: pagination.limit,
                totalPages: Math.ceil(total / pagination.limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener pagos' });
    }
});

/**
 * Obtener resumen de deuda de un contrato
 */
router.get('/deuda/contrato/:id', authenticateToken, requirePermission('pagos.ver'), async (req, res) => {
    const { id } = req.params;
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const excludeLiquidacionId = req.query.excludeLiquidacionId
        ? Number(req.query.excludeLiquidacionId)
        : undefined;

    try {
        res.json(await getContractDebtSummary(Number(id), inmobiliariaId, excludeLiquidacionId));
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener deuda' });
    }
});

export default router;
