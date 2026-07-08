import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { EstadoLiquidacion } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { auditService } from '../services/audit.service';
import {
    validateBody,
    requiredText,
    positiveDecimal,
    nonNegativeDecimal,
    dateOnlyString,
    optionalDateOnlyString,
    optionalText
} from '../middlewares/validation.middleware';
import { z } from 'zod';
import { requirePermission } from '../middlewares/permissions.middleware';
import { getContractDebtSummary } from '../services/debt.service';
import { formatCurrency } from '../utils/currency';
import { assertSameCurrency } from '../services/currency-rules.service';

const router = Router();

router.use(authenticateToken);

const liquidacionCreateSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    periodo: dateOnlyString('El período'),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional().default(0),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    cuotasIds: z.array(z.coerce.number().int().positive()).optional()
});

const movimientoSchema = z.object({
    tipo: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    concepto: requiredText('El concepto', 255),
    monto: positiveDecimal('El monto'),
    observaciones: optionalText(1000)
});

const honorariosSchema = z.object({
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional(),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional())
}).refine(data => data.montoHonorarios !== undefined || data.porcentajeHonorarios !== undefined, {
    message: 'Debe indicar monto o porcentaje de honorarios'
});

const pagoPropietarioSchema = z.object({
    fechaPago: optionalDateOnlyString('La fecha de pago'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional().default('EFECTIVO'),
    observaciones: optionalText(1000)
});

// Helper para generar concepto descriptivo de movimientos de caja
function generarConcepto(tipo: string, liquidacion: any): string {
    const dir = liquidacion.contrato?.propiedad?.direccion || 'Sin dirección';
    const periodo = new Date(liquidacion.periodo)
        .toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `${tipo} - ${dir} - Liq. ${periodo}`;
}

// Helper para recalcular totales de una liquidación
async function recalcularTotales(liquidacionId: number) {
    const movimientos = await prisma.movimiento.findMany({
        where: { liquidacionId }
    });

    let totalIngresos = new Decimal(0);
    let totalDescuentos = new Decimal(0);
    let totalDescuentosInquilino = new Decimal(0);

    movimientos.forEach(m => {
        const monto = new Decimal(m.monto.toString());
        if (m.tipo === 'INGRESO') {
            totalIngresos = totalIngresos.plus(monto);
        } else {
            totalDescuentos = totalDescuentos.plus(monto);
            // Si NO es para la inmobiliaria, es un descuento real para el inquilino (ej: un arreglo)
            if (!m.esParaInmobiliaria) {
                totalDescuentosInquilino = totalDescuentosInquilino.plus(monto);
            }
        }
    });

    const netoACobrar = totalIngresos.minus(totalDescuentosInquilino);

    return (await prisma.liquidacion.update({
        where: { id: liquidacionId },
        data: {
            totalIngresos,
            totalDescuentos,
            netoACobrar
        },
        include: {
            movimientos: true,
            contrato: {
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                }
            }
        }
    })) as any;
}

// Obtener todas las liquidaciones de la inmobiliaria
router.get('/', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, page, limit, search } = req.query;

    const pageNum = page ? parseInt(String(page)) : 1;
    const limitNum = limit ? parseInt(String(limit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    try {
        const whereClause: any = {
            inmobiliariaId,
            ...(contratoId ? { contratoId: Number(contratoId) } : {})
        };

        if (search) {
            whereClause.contrato = {
                OR: [
                    { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
                    { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                    { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } }
                ]
            };
        }

        const total = await prisma.liquidacion.count({ where: whereClause });

        const liquidaciones = await prisma.liquidacion.findMany({
            where: whereClause,
            include: {
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                        propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                    }
                },
                pagos: true
            },
            orderBy: { periodo: 'desc' },
            skip,
            take: limitNum
        });

        res.json({
            data: liquidaciones,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching liquidaciones:', error);
        res.status(500).json({ message: 'Error al obtener liquidaciones' });
    }
});

// Obtener detalle de una liquidación
router.get('/:id', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
                        propietarios: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } }
                    }
                },
                pagos: {
                    include: {
                        creadoPor: {
                            select: { id: true, nombreCompleto: true, email: true }
                        }
                    }
                },
                creadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                cerradoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                }
            }
        }) as any;

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        const auditLogs = await auditService.history({
            inmobiliariaId,
            entidad: 'Liquidacion',
            entidadId: Number(id)
        });

        res.json({ ...liquidacion, auditLogs });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener detalle de liquidación' });
    }
});

// Crear una nueva liquidación (Borrador)
router.post('/', requirePermission('liquidaciones.crear'), validateBody(liquidacionCreateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, periodo, montoHonorarios, porcentajeHonorarios, cuotasIds } = req.body; // periodo: "YYYY-MM-01"

    try {
        // Verificar que el contrato existe
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(contratoId), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        // Verificar si ya existe una liquidación para ese periodo
        const existente = await prisma.liquidacion.findFirst({
            where: { contratoId: Number(contratoId), periodo: new Date(periodo) }
        });

        if (existente) {
            return res.status(400).json({ message: 'Ya existe una liquidación para este periodo' });
        }

        const cuotasSeleccionadas = [];
        if (cuotasIds && Array.isArray(cuotasIds) && cuotasIds.length > 0) {
            for (const cId of cuotasIds) {
                const cuota = await prisma.cuotaPlan.findUnique({
                    where: { id: Number(cId) },
                    include: { plan: true }
                });

                if (cuota && cuota.estado === 'PENDIENTE') {
                    if (cuota.plan.contratoId !== contrato.id || cuota.plan.inmobiliariaId !== inmobiliariaId) {
                        return res.status(400).json({ message: 'Una o más cuotas no pertenecen al contrato seleccionado' });
                    }
                    assertSameCurrency(cuota.moneda, contrato.moneda, 'No se pueden liquidar cuotas con una moneda distinta a la del contrato');
                    assertSameCurrency(cuota.plan.moneda, contrato.moneda, 'No se pueden liquidar planes con una moneda distinta a la del contrato');
                    cuotasSeleccionadas.push(cuota);
                }
            }
        }

        const liquidacion = await prisma.liquidacion.create({
            data: {
                periodo: new Date(periodo),
                estado: 'BORRADOR',
                contratoId: Number(contratoId),
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id,
                montoHonorarios: montoHonorarios ? Number(montoHonorarios) : 0,
                porcentajeHonorarios: porcentajeHonorarios ? Number(porcentajeHonorarios) : null,
                moneda: contrato.moneda
            }
        });

        await prisma.movimiento.create({
            data: {
                tipo: 'INGRESO',
                concepto: 'Alquiler Mensual',
                monto: contrato.montoAlquiler,
                moneda: contrato.moneda,
                liquidacionId: liquidacion.id
            }
        });

        // Crear movimientos para cuotas seleccionadas
        for (const cuota of cuotasSeleccionadas) {
            const mov = await prisma.movimiento.create({
                data: {
                    tipo: cuota.plan.tipoMovimiento,
                    concepto: `${cuota.plan.concepto} (Cuota ${cuota.numeroCuota})`,
                    monto: cuota.monto,
                    moneda: contrato.moneda,
                    liquidacionId: liquidacion.id,
                    esParaInmobiliaria: cuota.plan.esParaInmobiliaria
                }
            });

            await prisma.cuotaPlan.update({
                where: { id: cuota.id },
                data: {
                    liquidacionId: liquidacion.id,
                    movimientoId: mov.id
                }
            });
            }

        const actualizada = await recalcularTotales(liquidacion.id);
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: liquidacion.id,
            detalle: `Liquidación creada para contrato ${contratoId}, periodo ${periodo}`
        });

        res.status(201).json(actualizada);
    } catch (error: any) {
        console.error(error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al crear liquidación' });
    }
});

// Agregar un movimiento
router.post('/:id/movimientos', requirePermission('liquidaciones.editar'), validateBody(movimientoSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { tipo, concepto, monto, observaciones } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        const ESTADOS_EDITABLES: EstadoLiquidacion[] = ['BORRADOR', 'PENDIENTE_PAGO', 'PAGADA_POR_INQUILINO'];
        if (!ESTADOS_EDITABLES.includes(liquidacion.estado)) {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        await prisma.movimiento.create({
            data: {
                tipo,
                concepto,
                monto: monto ? monto.toString() : 0,
                moneda: liquidacion.moneda,
                observaciones,
                liquidacionId: Number(id)
            }
        });

        const actualizada = await recalcularTotales(Number(id));
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'AGREGAR_MOVIMIENTO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `${tipo}: ${concepto} por monto ${monto}`
        });

        res.status(201).json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al agregar movimiento' });
    }
});

// Eliminar un movimiento
router.delete('/movimientos/:movimientoId', requirePermission('liquidaciones.editar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { movimientoId } = req.params;

    try {
        const movimiento = await prisma.movimiento.findUnique({
            where: { id: Number(movimientoId) },
            include: { liquidacion: true }
        });

        if (!movimiento || movimiento.liquidacion.inmobiliariaId !== inmobiliariaId) {
            return res.status(404).json({ message: 'Movimiento no encontrado' });
        }

        if (movimiento.liquidacion.estado === 'LIQUIDADA') {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        await prisma.movimiento.delete({
            where: { id: Number(movimientoId) }
        });

        const actualizada = await recalcularTotales(movimiento.liquidacionId);

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_MOVIMIENTO',
            entidad: 'Liquidacion',
            entidadId: movimiento.liquidacionId,
            detalle: `${movimiento.tipo}: ${movimiento.concepto} por monto ${movimiento.monto}`
        });

        res.json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar movimiento' });
    }
});

// Confirmar liquidación (Borrador -> Pendiente de Pago)
router.patch('/:id/confirmar', requirePermission('liquidaciones.editar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== 'BORRADOR') {
            return res.status(400).json({ message: 'Solo se pueden confirmar liquidaciones en estado borrador' });
        }

        const actualizada = await prisma.liquidacion.update({
            where: { id: Number(id) },
            data: {
                estado: 'PENDIENTE_PAGO',
            },
            include: { movimientos: true }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CONFIRMAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: 'Liquidación confirmada y pasada a pendiente de pago'
        });

        res.json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al confirmar liquidación' });
    }
});

// Cerrar liquidación (LIQUIDADA ya no se usa aquí directamente, se usa en pagar-propietario)
// Pero mantenemos esta ruta por si se quiere forzar un cierre manual o si el usuario la usaba.
// He decidido renombrarla o ajustarla si es necesario, pero según el plan:
// PAGADA_POR_INQUILINO -> LIQUIDADA (vía pagar-propietario)
// Borrador -> Pendiente (vía confirmar)
// Pendiente -> Pagada (vía pagos)


// Actualizar honorarios de una liquidación
router.patch('/:id/honorarios', requirePermission('liquidaciones.editar'), validateBody(honorariosSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { montoHonorarios, porcentajeHonorarios } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        const ESTADOS_EDITABLES: EstadoLiquidacion[] = ['BORRADOR', 'PENDIENTE_PAGO', 'PAGADA_POR_INQUILINO'];
        if (!ESTADOS_EDITABLES.includes(liquidacion.estado)) {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        const actualizada = await prisma.liquidacion.update({
            where: { id: Number(id) },
            data: {
                montoHonorarios: montoHonorarios !== undefined ? Number(montoHonorarios) : undefined,
                porcentajeHonorarios: porcentajeHonorarios !== undefined ? Number(porcentajeHonorarios) : undefined,
            },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                        propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                    } 
                }
            }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_HONORARIOS_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: JSON.stringify({
                montoHonorarios: { anterior: liquidacion.montoHonorarios.toString(), nuevo: montoHonorarios },
                porcentajeHonorarios: { anterior: liquidacion.porcentajeHonorarios?.toString() || null, nuevo: porcentajeHonorarios }
            })
        });

        res.json(actualizada);
    } catch (error) {
        console.error('Error updates honorarios:', error);
        res.status(500).json({ message: 'Error al actualizar honorarios' });
    }
});

// Eliminar liquidación (Solo si es borrador)
router.delete('/:id', requirePermission('liquidaciones.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== 'BORRADOR') {
            return res.status(400).json({ message: 'Solo se pueden eliminar liquidaciones en borrador' });
        }

        await prisma.liquidacion.delete({
            where: { id: Number(id) }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id)
        });

        res.json({ message: 'Liquidación eliminada' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar liquidación' });
    }
});

// Registrar pago al propietario
router.patch('/:id/pagar-propietario', requirePermission('liquidaciones.editar'), validateBody(pagoPropietarioSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { fechaPago, metodoPago, observaciones } = req.body;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const liquidacion = await tx.liquidacion.findFirst({
                where: { id: Number(id), inmobiliariaId },
                include: {
                    contrato: {
                        include: {
                            propiedad: true,
                            propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                        }
                    }
                }
            });

            if (!liquidacion) {
                throw new Error('Liquidación no encontrada');
            }

            if (liquidacion.estado !== EstadoLiquidacion.PAGADA_POR_INQUILINO) {
                throw new Error('La liquidación debe estar pagada por el inquilino para poder pagar al propietario');
            }

            const montoHonorarios = new Decimal(liquidacion.montoHonorarios.toString());
            
            // Sumamos los movimientos que son para la inmobiliaria
            const movimientosInmobiliaria = await tx.movimiento.findMany({
                where: { liquidacionId: Number(id), esParaInmobiliaria: true }
            });
            const totalOtrosIngresosInmo = movimientosInmobiliaria.reduce(
                (sum, m) => sum.plus(new Decimal(m.monto.toString())), 
                new Decimal(0)
            );

            const montoPropietario = new Decimal(liquidacion.netoACobrar.toString())
                .minus(montoHonorarios)
                .minus(totalOtrosIngresosInmo);

            // 1. Actualizar liquidación
            const actualizada = await tx.liquidacion.update({
                where: { id: Number(id) },
                data: {
                    estado: 'LIQUIDADA',
                    fechaPagoPropietario: new Date(fechaPago || new Date()),
                    metodoPagoPropietario: metodoPago || 'EFECTIVO',
                    cerradoPorId: (req as AuthRequest).user!.id,
                    fechaLiquidacion: new Date()
                }
            });

            // 2. Registrar egreso en caja con concepto descriptivo
            if (montoPropietario.greaterThan(0)) {
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'EGRESO',
                        concepto: generarConcepto('Pago Propietario', liquidacion),
                        monto: montoPropietario,
                        moneda: liquidacion.moneda,
                        fecha: new Date(fechaPago || new Date()),
                        metodoPago: metodoPago || 'EFECTIVO',
                        cuenta: (metodoPago === 'EFECTIVO') ? 'CAJA' : 'BANCO',
                        observaciones: observaciones || undefined,
                        creadoPorId: (req as AuthRequest).user!.id,
                        contratoId: liquidacion.contratoId,
                        liquidacionId: liquidacion.id
                    }
                });
            }

            return {
                ...actualizada,
                montoPropietario: montoPropietario.toString(),
                moneda: liquidacion.moneda,
                propiedadDireccion: liquidacion.contrato?.propiedad?.direccion || 'Sin dirección',
                propietarioNombre: liquidacion.contrato?.propietarios?.[0]?.persona?.nombreCompleto || 'Sin propietario',
                periodoTexto: new Date(liquidacion.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
            };
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'PAGO_PROPIETARIO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `Pago a ${result.propietarioNombre} por ${formatCurrency(result.montoPropietario, result.moneda)} - ${result.propiedadDireccion} - ${result.periodoTexto}`
        });

        res.json(result);
    } catch (error: any) {
        console.error(error);
        res.status(400).json({ message: error.message || 'Error al registrar pago al propietario' });
    }
});

// ─── Helpers PDF ─────────────────────────────────────────────────────────────

const formatCurrencyPdf = (amount: number, moneda: string = 'ARS') =>
    formatCurrency(amount, moneda);

const formatDatePdf = (date: Date | string | null | undefined) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('es-AR', { timeZone: 'UTC' });
};

const formatPeriodPdf = (date: Date | string) =>
    new Date(date).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const ensurePdfSpace = (doc: PDFKit.PDFDocument, y: number, requiredHeight = 100) => {
    if (y + requiredHeight < doc.page.height - 70) return y;
    doc.addPage();
    return 50;
};

const drawDebtSummaryPdf = (
    doc: PDFKit.PDFDocument,
    y: number,
    pageWidth: number,
    debtSummary: Awaited<ReturnType<typeof getContractDebtSummary>>,
    moneyPdf: (amount: number) => string,
    title = 'DEUDA ANTERIOR DEL CONTRATO'
) => {
    if (debtSummary.totalDeuda <= 0) return y;

    y = ensurePdfSpace(doc, y, 120);
    doc.fillColor('#B45309').fontSize(11).font('Helvetica-Bold').text(title, 50, y);
    doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor('#F59E0B').lineWidth(1).stroke();
    y += 22;

    doc.rect(50, y, pageWidth, 20).fill('#FFFBEB');
    doc.fillColor('#92400E').fontSize(8).font('Helvetica-Bold')
        .text('PERÍODO', 58, y + 6)
        .text('NETO', 190, y + 6, { width: 70, align: 'right' })
        .text('PAGADO', 300, y + 6, { width: 70, align: 'right' })
        .text('DEUDA', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
    y += 20;

    debtSummary.detalle.forEach(item => {
        y = ensurePdfSpace(doc, y, 45);
        doc.fillColor('#111827').fontSize(9).font('Helvetica')
            .text(formatPeriodPdf(item.periodo), 58, y + 5)
            .text(moneyPdf(item.neto), 190, y + 5, { width: 70, align: 'right' })
            .text(moneyPdf(item.pagado), 300, y + 5, { width: 70, align: 'right' });
        doc.fillColor('#B91C1C').font('Helvetica-Bold')
            .text(moneyPdf(item.deuda), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
        doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#FDE68A').lineWidth(0.5).stroke();
        y += 20;
    });

    doc.rect(50, y, pageWidth, 22).fill('#FEF3C7');
    doc.fillColor('#92400E').fontSize(9).font('Helvetica-Bold')
        .text('TOTAL DEUDA ANTERIOR', 58, y + 7)
        .text(moneyPdf(debtSummary.totalDeuda), 50 + pageWidth - 120, y + 7, { width: 110, align: 'right' });

    return y + 34;
};

const drawPaymentRowsPdf = (
    doc: PDFKit.PDFDocument,
    y: number,
    pageWidth: number,
    pagos: any[],
    moneyPdf: (amount: number) => string
) => {
    const dateX = 58;
    const methodX = 145;
    const detailX = 238;
    const amountWidth = 105;
    const amountX = 50 + pageWidth - amountWidth - 10;
    const detailWidth = amountX - detailX - 12;

    pagos.forEach((p: any) => {
        const detailText = p.observaciones || '-';
        const methodText = p.metodoPago || '-';

        doc.fontSize(9).font('Helvetica');
        const contentHeight = Math.max(
            doc.heightOfString(formatDatePdf(p.fechaPago), { width: 70 }),
            doc.heightOfString(methodText, { width: 80 }),
            doc.heightOfString(detailText, { width: detailWidth })
        );
        const rowHeight = Math.max(20, contentHeight + 10);
        y = ensurePdfSpace(doc, y, rowHeight + 10);

        doc.fillColor('#111827').fontSize(9).font('Helvetica')
            .text(formatDatePdf(p.fechaPago), dateX, y + 5, { width: 70 })
            .text(methodText, methodX, y + 5, { width: 80 })
            .text(detailText, detailX, y + 5, { width: detailWidth });
        doc.fillColor('#059669').font('Helvetica-Bold')
            .text(moneyPdf(Number(p.monto)), amountX, y + 5, { width: amountWidth, align: 'right' });
        doc.moveTo(50, y + rowHeight - 2).lineTo(50 + pageWidth, y + rowHeight - 2).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
        y += rowHeight;
    });

    return y;
};

// ─── PDF Inquilino (Comprobante de pago) ─────────────────────────────────────
router.get('/:id/pdf', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { include: { persona: true } }, 
                        propietarios: { include: { persona: true } } 
                    } 
                },
                pagos: true
            }
        });

        if (!liquidacion) return res.status(404).json({ message: 'Liquidación no encontrada' });
        const moneyPdf = (amount: number) => formatCurrencyPdf(amount, liquidacion.moneda);
        const deudaAnterior = await getContractDebtSummary(liquidacion.contratoId, inmobiliariaId, Number(id));

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprobante-inquilino-${id}.pdf"`);
        doc.pipe(res);

        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header
        doc.rect(50, 50, pageWidth, 80).fill(INDIGO);
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
            .text('COMPROBANTE DE ALQUILER', 70, 68, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(INDIGO).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAny = liquidacion as any;
        field('Inmueble', liqAny.contrato?.propiedad.direccion || '-', col1, y);
        const pPrincipal = liqAny.contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = liqAny.contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(liquidacion.fechaCreacion), col2, y);
        y += 40;
        field(
            'Próxima Actualización',
            liqAny.contrato?.requiereActualizacion ? formatDatePdf(liqAny.contrato?.fechaProximaActualizacion) : 'No programada',
            col1,
            y
        );
        y += 50;

        // Ingresos
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        liqAny.movimientos.filter((m: any) => m.tipo === 'INGRESO').forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(moneyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(moneyPdf(Number(liquidacion.totalIngresos)), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentos = liquidacion.movimientos.filter(m => m.tipo === 'DESCUENTO');
        if (descuentos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentos.forEach(m => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${moneyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${moneyPdf(Number(liquidacion.totalDescuentos))})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        // Neto
        doc.rect(50, y, pageWidth, 36).fill(INDIGO);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A PAGAR', 58, y + 12)
            .text(moneyPdf(Number(liquidacion.netoACobrar)), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        // Pagos
        if (liqAny.pagos && liqAny.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS REGISTRADOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            y = drawPaymentRowsPdf(doc, y, pageWidth, liqAny.pagos, moneyPdf);
        }

        // Saldo pendiente
        const totalPagado = (liqAny.pagos || []).reduce((acc: number, p: any) => acc + Number(p.monto), 0);
        const saldoPendiente = Number(liquidacion.netoACobrar) - totalPagado;
        if (saldoPendiente > 0) {
            y += 10;
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SALDO PENDIENTE', 58, y)
                .text(moneyPdf(saldoPendiente), 50 + pageWidth - 80, y, { width: 70, align: 'right' });
            y += 18;
        }

        if (deudaAnterior.totalDeuda > 0) {
            y += 12;
            y = drawDebtSummaryPdf(doc, y, pageWidth, deudaAnterior, moneyPdf);

            const totalARegularizar = Math.max(saldoPendiente, 0) + deudaAnterior.totalDeuda;
            y = ensurePdfSpace(doc, y, 50);
            doc.rect(50, y, pageWidth, 34).fill('#7F1D1D');
            doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
                .text('TOTAL A REGULARIZAR', 58, y + 11)
                .text(moneyPdf(totalARegularizar), 50 + pageWidth - 120, y + 11, { width: 110, align: 'right' });
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(`Documento generado el ${formatDatePdf(new Date())}`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF inquilino:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF' });
    }
});

// ─── PDF Propietario (Liquidación con honorarios y datos del contrato) ────────
router.get('/:id/pdf-propietario', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { include: { persona: true } }, 
                        propietarios: { include: { persona: true } } 
                    } 
                },
                pagos: true
            }
        });

        if (!liquidacion) return res.status(404).json({ message: 'Liquidación no encontrada' });
        const moneyPdf = (amount: number) => formatCurrencyPdf(amount, liquidacion.moneda);
        const deudaAnterior = await getContractDebtSummary(liquidacion.contratoId, inmobiliariaId, Number(id));

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="liquidacion-propietario-${id}.pdf"`);
        doc.pipe(res);

        const contrato = liquidacion.contrato as any;
        const TEAL = '#0F766E';
        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header (color verde-teal para diferenciar del PDF del inquilino)
        doc.rect(50, 50, pageWidth, 80).fill(TEAL);
        doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
            .text('LIQUIDACIÓN — COMPROBANTE PROPIETARIO', 70, 64, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato (ampliados)
        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(TEAL).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAnyProp = liquidacion as any;
        field('Inmueble', contrato?.propiedad?.direccion || '-', col1, y);
        const pPrincipal = contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(liquidacion.fechaCreacion), col2, y);
        y += 40;
        field('Vencimiento del Contrato', formatDatePdf(contrato?.fechaFin), col1, y);
        field(
            'Próxima Actualización',
            contrato?.requiereActualizacion ? formatDatePdf(contrato?.fechaProximaActualizacion) : 'No programada',
            col2,
            y
        );
        y += 40;

        // Tipo de ajuste y porcentaje
        const partsAjuste = [
            contrato?.tipoAjuste || null,
            contrato?.porcentajeActualizacion ? `${Number(contrato.porcentajeActualizacion)}%` : null
        ].filter(Boolean);
        field('Tipo / % de Ajuste', partsAjuste.length > 0 ? partsAjuste.join(' · ') : '-', col1, y);
        y += 50;

        // Ingresos
        const ingresosPropietario = liqAnyProp.movimientos.filter((m: any) => m.tipo === 'INGRESO' && !m.esParaInmobiliaria);
        const totalIngresosProp = ingresosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        ingresosPropietario.forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(moneyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(moneyPdf(totalIngresosProp), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentosPropietario = liquidacion.movimientos.filter(m => m.tipo === 'DESCUENTO' && !m.esParaInmobiliaria);
        const totalDescuentosProp = descuentosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        if (descuentosPropietario.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentosPropietario.forEach(m => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${moneyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${moneyPdf(totalDescuentosProp)})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        const netoACobrarProp = totalIngresosProp - totalDescuentosProp;

        // Honorarios inmobiliaria
        const montoHonorarios = Number(liquidacion.montoHonorarios || 0);
        const porcentajeHonorarios = liquidacion.porcentajeHonorarios ? Number(liquidacion.porcentajeHonorarios) : null;
        const pagaHonorarios: string = contrato?.pagaHonorarios || 'INQUILINO';

        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('HONORARIOS INMOBILIARIA', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(TEAL).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 22).fill('#F0FDFA');
        const honorariosDescText = porcentajeHonorarios ? `${porcentajeHonorarios}% sobre alquiler` : 'Monto fijo';
        doc.fillColor('#134E4A').fontSize(9).font('Helvetica')
            .text(`${honorariosDescText} — Abona: ${pagaHonorarios}`, 58, y + 7);
        doc.font('Helvetica-Bold')
            .text(moneyPdf(montoHonorarios), 50 + pageWidth - 80, y + 7, { width: 70, align: 'right' });
        y += 32;

        // Neto al propietario (Se descuentan los honorarios incondicionalmente del dueño)
        const honorariosPropietario = montoHonorarios;
        const netoParaPropietario = netoACobrarProp - honorariosPropietario;

        doc.rect(50, y, pageWidth, 36).fill(TEAL);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A TRANSFERIR AL PROPIETARIO', 58, y + 12)
            .text(moneyPdf(netoParaPropietario), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        // Pagos recibidos
        if (liquidacion.pagos && liquidacion.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS RECIBIDOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            y = drawPaymentRowsPdf(doc, y, pageWidth, liquidacion.pagos, moneyPdf);
        }

        if (deudaAnterior.totalDeuda > 0) {
            y += 18;
            y = drawDebtSummaryPdf(
                doc,
                y,
                pageWidth,
                deudaAnterior,
                moneyPdf,
                'DEUDA ANTERIOR PENDIENTE DEL INQUILINO'
            );
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(`Documento generado el ${formatDatePdf(new Date())} — USO INTERNO`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF propietario:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF del propietario' });
    }
});

export default router;
