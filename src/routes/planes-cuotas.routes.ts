import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { TipoMovimiento, EstadoPlanCuotas, EstadoCuota } from '@prisma/client';
import { auditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);

/**
 * Crear un nuevo plan de cuotas
 */
router.post('/', async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { contratoId, concepto, montoTotal, cantidadCuotas, tipoMovimiento, esParaInmobiliaria } = req.body;

    if (!contratoId || !concepto || !montoTotal || !cantidadCuotas || !tipoMovimiento) {
        return res.status(400).json({ message: 'Faltan datos requeridos' });
    }

    try {
        const montoCuota = Number(montoTotal) / Number(cantidadCuotas);

        const plan = await prisma.$transaction(async (tx) => {
            const newPlan = await tx.planCuotas.create({
                data: {
                    inmobiliariaId,
                    contratoId: Number(contratoId),
                    concepto,
                    montoTotal: Number(montoTotal),
                    tipoMovimiento: tipoMovimiento as TipoMovimiento,
                    estado: 'ACTIVO',
                    esParaInmobiliaria: !!esParaInmobiliaria,
                }
            });

            const cuotasData = [];
            for (let i = 1; i <= cantidadCuotas; i++) {
                cuotasData.push({
                    planId: newPlan.id,
                    numeroCuota: i,
                    monto: montoCuota,
                    estado: 'PENDIENTE' as EstadoCuota
                });
            }

            await tx.cuotaPlan.createMany({
                data: cuotasData
            });

            return newPlan;
        });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'CREAR_PLAN_CUOTAS',
            entidad: 'PlanCuotas',
            entidadId: plan.id,
            detalle: `Plan creado: ${concepto}, ${cantidadCuotas} cuotas de $${montoCuota.toFixed(2)}`
        });

        res.status(201).json(plan);
    } catch (error) {
        console.error('Error creating plan cuotas:', error);
        res.status(500).json({ message: 'Error al crear el plan de cuotas' });
    }
});

/**
 * Obtener planes de cuotas de un contrato
 */
router.get('/contrato/:contratoId', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId } = req.params;

    try {
        const planes = await prisma.planCuotas.findMany({
            where: {
                contratoId: Number(contratoId),
                inmobiliariaId
            },
            include: {
                cuotas: {
                    orderBy: { numeroCuota: 'asc' },
                    include: {
                        liquidacion: {
                            select: { id: true, periodo: true, estado: true }
                        }
                    }
                }
            }
        });

        res.json(planes);
    } catch (error) {
        console.error('Error in GET /contrato/:contratoId:', error);
        res.status(500).json({ message: 'Error al obtener planes de cuotas' });
    }
});

/**
 * Obtener cuotas pendientes por contrato (para sugerir en liquidación)
 */
router.get('/contrato/:contratoId/pendientes', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId } = req.params;

    try {
        const cuotas = await prisma.cuotaPlan.findMany({
            where: {
                plan: {
                    contratoId: Number(contratoId),
                    inmobiliariaId,
                    estado: 'ACTIVO'
                },
                estado: 'PENDIENTE',
                liquidacionId: null // No asignadas a otra liquidación aún
            },
            include: {
                plan: true
            },
            orderBy: [
                { planId: 'asc' },
                { numeroCuota: 'asc' }
            ]
        });

        // Agrupar para devolver solo la siguiente cuota de cada plan (opcional, pero mejor devolver todas y que el frontal elija)
        res.json(cuotas);
    } catch (error) {
        console.error('Error getting pendientes:', error);
        res.status(500).json({ message: 'Error al obtener cuotas pendientes' });
    }
});

/**
 * Eliminar un plan de cuotas (Solo si no tiene cuotas pagadas)
 */
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const plan = await prisma.planCuotas.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: { cuotas: true }
        });

        if (!plan) {
            return res.status(404).json({ message: 'Plan no encontrado' });
        }

        const tienePagadas = plan.cuotas.some(c => c.estado === 'PAGADA' || c.liquidacionId !== null);
        if (tienePagadas) {
            return res.status(400).json({ message: 'No se puede eliminar un plan que ya tiene cuotas liquidadas o programadas' });
        }

        await prisma.planCuotas.delete({
            where: { id: Number(id) }
        });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ELIMINAR_PLAN_CUOTAS',
            entidad: 'PlanCuotas',
            entidadId: Number(id),
            detalle: `Plan eliminado: ${plan.concepto}`
        });

        res.json({ message: 'Plan eliminado' });
    } catch (error) {
        console.error('Error deleting plan cuotas:', error);
        res.status(500).json({ message: 'Error al eliminar el plan' });
    }
});

export default router;
