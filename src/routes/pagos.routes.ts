import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { MetodoPago, EstadoLiquidacion } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { validateBody, positiveDecimal, optionalDateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { z } from 'zod';

const router = Router();

const pagoSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    monto: positiveDecimal('El monto'),
    fechaPago: optionalDateOnlyString('La fecha de pago'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional().default('EFECTIVO'),
    observaciones: optionalText(1000)
});

/**
 * Obtener todos los pagos de la inmobiliaria (Global) con paginación y búsqueda
 */
router.get('/', authenticateToken, async (req, res) => {
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
router.post('/', authenticateToken, validateBody(pagoSchema), async (req, res) => {
    const { contratoId, monto, fechaPago, metodoPago, observaciones } = req.body;
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
                const totalPagado = liq.pagos.reduce((acc, p) => acc.plus(p.monto), new Decimal(0));
                const deuda = new Decimal(liq.netoACobrar.toString()).minus(totalPagado);
                return { ...liq, deuda };
            }).filter(l => l.deuda.greaterThan(0));

            if (liquidacionesConDeuda.length === 0) {
                // Si no hay deuda, quizás es un pago adelantado o error? 
                // Por requerimiento técnico: No existen pagos sin liquidación previa.
                throw new Error('No existen liquidaciones pendientes de pago para este contrato');
            }

            let montoRestante = new Decimal(monto.toString());
            const pagosCreados = [];

            // 3. Distribuir el monto
            for (const liq of liquidacionesConDeuda) {
                if (montoRestante.lessThanOrEqualTo(0)) break;

                const montoAAplicar = Decimal.min(montoRestante, liq.deuda);

                const nuevoPago = await tx.pago.create({
                    data: {
                        monto: montoAAplicar,
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

                // Si se cubrió la deuda, marcamos como PAGADA
                if (montoAAplicar.greaterThanOrEqualTo(liq.deuda)) {
                    await tx.liquidacion.update({
                        where: { id: liq.id },
                        data: { estado: EstadoLiquidacion.PAGADA_POR_INQUILINO }
                    });

                    // Inyectar Cobro de Alquiler en la Caja Chica unificado
                    const cuentaCobro = (metodoPago === 'EFECTIVO' || !metodoPago) ? 'CAJA' : 'BANCO';
                    const dir = (liq as any).contrato?.propiedad?.direccion || 'Sin dirección';
                    const periodoStr = new Date(liq.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                    
                    await tx.movimientoCaja.create({
                        data: {
                            inmobiliariaId,
                            tipo: 'INGRESO',
                            concepto: `Cobro Alquiler - ${dir} - Liq. ${periodoStr}`,
                            monto: montoAAplicar, // El monto total cobrado en este paso
                            fecha: new Date(fechaPago || new Date()),
                            creadoPorId: usuarioId,
                            contratoId: Number(contratoId),
                            liquidacionId: liq.id,
                            metodoPago: metodoPago || MetodoPago.EFECTIVO,
                            cuenta: cuentaCobro
                        }
                    });
                }
            }

            // Si sobró dinero, el sistema no lo permite según la regla "No pagos sin liquidación"
            // pero podríamos considerar dejarlo como saldo a favor en una tabla de caja (futuro).
            // Por ahora, devolvemos lo procesado.

            return {
                pagos: pagosCreados,
                montoSobrante: montoRestante
            };
        });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO',
            entidad: 'Contrato',
            entidadId: Number(contratoId),
            detalle: `Pago registrado por $${monto} aplicado a ${result.pagos.length} liquidaciones.`
        });

        await Promise.all(result.pagos.map((pago) => auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO',
            entidad: 'Pago',
            entidadId: pago.id,
            detalle: `Pago registrado por $${pago.monto} para liquidación ${pago.liquidacionId}`
        })));

        await Promise.all(result.pagos.map((pago) => auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'REGISTRAR_PAGO_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: pago.liquidacionId,
            detalle: `Pago de inquilino registrado por $${pago.monto}`
        })));

        res.status(201).json(result);
    } catch (error: any) {
        console.error(error);
        res.status(400).json({ message: error.message || 'Error al registrar el pago' });
    }
});

/**
 * Obtener historial de pagos de un contrato
 */
router.get('/contrato/:id', authenticateToken, async (req, res) => {
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
                    select: { periodo: true, netoACobrar: true }
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
router.get('/deuda/contrato/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { inmobiliariaId } = (req as AuthRequest).user!;

    try {
        const liquidaciones = await prisma.liquidacion.findMany({
            where: {
                contratoId: Number(id),
                inmobiliariaId,
                estado: { not: EstadoLiquidacion.BORRADOR }
            },
            include: {
                pagos: true
            }
        });

        const resumen = liquidaciones.map(liq => {
            const totalPagado = liq.pagos.reduce((acc, p) => acc.plus(p.monto), new Decimal(0));
            const deuda = new Decimal(liq.netoACobrar.toString()).minus(totalPagado);
            return {
                periodo: liq.periodo,
                neto: liq.netoACobrar,
                pagado: totalPagado,
                deuda: deuda.greaterThan(0) ? deuda : new Decimal(0),
                estado: liq.estado
            };
        }).filter(r => r.deuda.greaterThan(0));

        const totalDeuda = resumen.reduce((acc, r) => acc.plus(r.deuda), new Decimal(0));

        res.json({
            totalDeuda,
            detalle: resumen
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener deuda' });
    }
});

export default router;
