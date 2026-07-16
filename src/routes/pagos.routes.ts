import { Router } from 'express';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { MetodoPago, EstadoLiquidacion, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { validateBody, positiveDecimal, optionalDateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { getContractDebtSummary } from '../services/debt.service';
import { formatCurrency } from '../utils/currency';
import { assertSameCurrency } from '../services/currency-rules.service';
import { z } from 'zod';

const router = Router();

const pagoSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    monto: positiveDecimal('El monto'),
    fechaPago: optionalDateOnlyString('La fecha de pago'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional().default('EFECTIVO'),
    moneda: z.enum(['ARS', 'USD']).optional(),
    observaciones: optionalText(1000)
});

/**
 * Obtener todos los pagos de la inmobiliaria (Global) con paginación y búsqueda
 */
router.get('/', authenticateToken, requirePermission('pagos.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { page, limit, search } = req.query;

    const pageNum = page ? parseInt(String(page)) : 1;
    const limitNum = limit ? parseInt(String(limit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    try {
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

        const total = await prisma.pago.count({ where: whereClause });

        const pagos = await prisma.pago.findMany({
            where: whereClause,
            include: {
                creadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
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
            orderBy: { fechaPago: 'desc' },
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
    } catch (error) {
        console.error('Error fetching pagos globales:', error);
        res.status(500).json({ message: 'Error al obtener historial de pagos' });
    }
});

/**
 * Registrar un pago entregado por el inquilino.
 * El monto se distribuye automáticamente entre las liquidaciones adeudadas más antiguas.
 */
router.post('/', authenticateToken, requirePermission('pagos.crear'), validateBody(pagoSchema), async (req, res) => {
    const { contratoId, monto, fechaPago, metodoPago, moneda, observaciones } = req.body;
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;

    try {
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
                    estado: EstadoLiquidacion.PENDIENTE_PAGO
                },
                include: {
                    pagos: true,
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

                const totalPagado = liq.pagos.reduce((acc, p) => acc.plus(p.monto), new Decimal(0));
                const deuda = new Decimal(liq.netoACobrar.toString()).minus(totalPagado);
                return { ...liq, deuda };
            }).filter(l => l.deuda.greaterThan(0));

            if (liquidacionesConDeuda.length === 0) {
                // Si no hay deuda, quizás es un pago adelantado o error? 
                // Por requerimiento técnico: No existen pagos sin liquidación previa.
                throw new Error('No existen liquidaciones pendientes de pago para este contrato');
            }

            const deudaTotal = liquidacionesConDeuda.reduce(
                (total, liquidacion) => total.plus(liquidacion.deuda),
                new Decimal(0)
            );
            const montoEntregado = new Decimal(monto.toString());
            if (montoEntregado.greaterThan(deudaTotal)) {
                throw Object.assign(
                    new Error(`El pago supera la deuda total. El máximo permitido es ${formatCurrency(deudaTotal.toString(), contrato.moneda)}`),
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
                        fechaPago: new Date(fechaPago || new Date()),
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

                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Cobro Alquiler - ${dir} - Liq. ${periodoStr}`,
                        monto: montoAAplicar,
                        moneda: liq.moneda,
                        fecha: new Date(fechaPago || new Date()),
                        creadoPorId: usuarioId,
                        contratoId: Number(contratoId),
                        liquidacionId: liq.id,
                        metodoPago: metodoPago || MetodoPago.EFECTIVO,
                        cuenta: cuentaCobro
                    }
                });

                // Si se cubrió la deuda, marcamos como PAGADA
                if (montoAAplicar.greaterThanOrEqualTo(liq.deuda)) {
                    await tx.liquidacion.update({
                        where: { id: liq.id },
                        data: { estado: EstadoLiquidacion.PAGADA_POR_INQUILINO }
                    });

                }
            }

            // Si sobró dinero, el sistema no lo permite según la regla "No pagos sin liquidación"
            // pero podríamos considerar dejarlo como saldo a favor en una tabla de caja (futuro).
            // Por ahora, devolvemos lo procesado.

            return {
                pagos: pagosCreados,
                montoSobrante: montoRestante,
                moneda: contrato.moneda
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
        res.status(error.statusCode || 400).json({ message: error.message || 'Error al registrar el pago', code: error.code });
    }
});

/**
 * Obtener historial de pagos de un contrato
 */
router.get('/contrato/:id', authenticateToken, requirePermission('pagos.ver'), async (req, res) => {
    const { id } = req.params;
    const { inmobiliariaId } = (req as AuthRequest).user!;

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
                liquidacion: {
                    select: { periodo: true, netoACobrar: true, moneda: true }
                }
            },
            orderBy: {
                fechaPago: 'desc'
            }
        });

        res.json(pagos);
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
