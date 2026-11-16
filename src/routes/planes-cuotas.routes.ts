import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { TipoMovimiento, EstadoPlanCuotas, EstadoCuota } from '@prisma/client';
import { auditService } from '../services/audit.service';
import { validateBody, requiredText, positiveMoney, booleanFromForm, dateOnlyString } from '../middlewares/validation.middleware';
import { z } from 'zod';
import { requirePermission } from '../middlewares/permissions.middleware';
import { formatCurrency } from '../utils/currency';
import { Decimal } from '@prisma/client/runtime/library';
import { buildInstallmentSchedule, summarizeInstallments } from '../services/installment-plan.service';
import { installmentScheduleSchema } from '../validation/installment-plan.schemas';

const router = Router();

router.use(authenticateToken);

const planCuotasSchema = installmentScheduleSchema.safeExtend({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    concepto: requiredText('El concepto', 255),
    tipoMovimiento: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    esParaInmobiliaria: booleanFromForm.optional().default(false)
});

const planLifecycleSchema = z.object({
    motivo: requiredText('El motivo', 1000).refine(value => value.trim().length >= 5, { message: 'El motivo debe tener al menos 5 caracteres' })
});
const reprogramarPlanSchema = installmentScheduleSchema.safeExtend({
    motivo: planLifecycleSchema.shape.motivo,
    montoPendienteEsperado: positiveMoney('El pendiente revisado').optional()
});
const previewSchema = installmentScheduleSchema.safeExtend({
    contratoId: z.coerce.number().int().positive(),
    planId: z.coerce.number().int().positive().optional()
});

// Read-only quote: uses exactly the schedule persisted by create/reschedule.
router.post('/vista-previa', requirePermission('liquidaciones.editar'), validateBody(previewSchema), async (req, res, next) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, planId, montoTotal, cantidadCuotas, fechaPrimeraCuota } = req.body;
    try {
        const contract = await prisma.contrato.findFirst({ where: { id: contratoId, inmobiliariaId }, select: { moneda: true } });
        if (!contract) return res.status(404).json({ message: 'Contrato no encontrado' });
        const plan = planId ? await prisma.planCuotas.findFirst({ where: { id: planId, contratoId, inmobiliariaId }, include: { cuotas: true } }) : null;
        if (planId && !plan) return res.status(404).json({ message: 'Plan no encontrado' });
        const cuotas = buildInstallmentSchedule(montoTotal, cantidadCuotas, fechaPrimeraCuota);
        res.json({
            moneda: plan?.moneda || contract.moneda,
            montoTotal: new Decimal(montoTotal).toFixed(2),
            sumaCuotas: cuotas.reduce((sum, item) => sum.plus(item.monto), new Decimal(0)).toFixed(2),
            cuotas,
            ...(plan ? { resumen: summarizeInstallments(plan.cuotas), estadoPlan: plan.estado } : {})
        });
    } catch (error) { next(error); }
});

const assertPlanHasAvailableInstallments = (plan: { estado: EstadoPlanCuotas; cuotas: Array<{ id: number; estado: EstadoCuota; liquidacionId: number | null; movimientoId: number | null }> }) => {
    if (plan.estado !== EstadoPlanCuotas.VIGENTE) {
        throw Object.assign(new Error('Sólo se pueden modificar planes vigentes'), { statusCode: 409, code: 'INSTALLMENT_PLAN_NOT_ACTIVE' });
    }
    const vinculadas = plan.cuotas.filter(cuota => cuota.estado === EstadoCuota.PENDIENTE && (cuota.liquidacionId !== null || cuota.movimientoId !== null));
    if (vinculadas.length) {
        throw Object.assign(new Error('Hay cuotas pendientes ya incorporadas a una liquidación. Eliminá primero ese borrador o regularizá el cobro.'), {
            statusCode: 409,
            code: 'INSTALLMENT_ALREADY_CLAIMED',
            details: { cuotasIds: vinculadas.map(cuota => cuota.id) }
        });
    }
    const disponibles = plan.cuotas.filter(cuota => cuota.estado === EstadoCuota.PENDIENTE && cuota.liquidacionId === null && cuota.movimientoId === null);
    if (!disponibles.length) {
        throw Object.assign(new Error('El plan no tiene cuotas pendientes disponibles para esta operación'), { statusCode: 409, code: 'NO_PENDING_INSTALLMENTS' });
    }
    return disponibles;
};

/**
 * Crear un nuevo plan de cuotas
 */
router.post('/', requirePermission('liquidaciones.editar'), validateBody(planCuotasSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { contratoId, concepto, montoTotal, cantidadCuotas, fechaPrimeraCuota, tipoMovimiento, esParaInmobiliaria } = req.body;

    try {
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(contratoId), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const schedule = buildInstallmentSchedule(montoTotal, cantidadCuotas, fechaPrimeraCuota);

        const plan = await prisma.$transaction(async (tx) => {
            const newPlan = await tx.planCuotas.create({
                data: {
                    inmobiliariaId,
                    contratoId: Number(contratoId),
                    concepto,
                    montoTotal: Number(montoTotal),
                    moneda: contrato.moneda,
                    tipoMovimiento: tipoMovimiento as TipoMovimiento,
                    estado: EstadoPlanCuotas.VIGENTE,
                    esParaInmobiliaria: !!esParaInmobiliaria,
                }
            });

            await tx.cuotaPlan.createMany({
                data: schedule.map(item => ({
                    planId: newPlan.id, numeroCuota: item.numeroCuota,
                    fechaVencimiento: new Date(`${item.fechaVencimiento}T00:00:00.000Z`),
                    monto: item.monto, moneda: contrato.moneda, estado: EstadoCuota.PENDIENTE
                }))
            });

            return newPlan;
        });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'CREAR_PLAN_CUOTAS',
            entidad: 'PlanCuotas',
            entidadId: plan.id,
            detalle: `Plan creado: ${concepto}, ${cantidadCuotas} cuotas por un total de ${formatCurrency(Number(montoTotal), contrato.moneda)}`
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
router.get('/contrato/:contratoId', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId } = req.params;

    try {
        const planes = await prisma.planCuotas.findMany({
            where: {
                contratoId: Number(contratoId),
                inmobiliariaId
            },
            include: {
                planOrigen: { select: { id: true, concepto: true } },
                planesReprogramados: { select: { id: true, estado: true } },
                cerradoPor: { select: { id: true, nombreCompleto: true } },
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

        res.json(planes.map(plan => ({ ...plan, resumen: summarizeInstallments(plan.cuotas) })));
    } catch (error) {
        console.error('Error in GET /contrato/:contratoId:', error);
        res.status(500).json({ message: 'Error al obtener planes de cuotas' });
    }
});

/**
 * Obtener cuotas pendientes por contrato (para sugerir en liquidación)
 */
router.get('/contrato/:contratoId/pendientes', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId } = req.params;
    const parsedPeriod = dateOnlyString('El período').safeParse(req.query.periodo);

    if (!parsedPeriod.success || !parsedPeriod.data.endsWith('-01')) {
        return res.status(400).json({
            message: 'El período es obligatorio y debe tener formato YYYY-MM-01',
            code: 'INVALID_LIQUIDATION_PERIOD'
        });
    }
    const liquidationPeriod = new Date(`${parsedPeriod.data}T00:00:00.000Z`);

    try {
        const cuotas = await prisma.cuotaPlan.findMany({
            where: {
                    plan: {
                        contratoId: Number(contratoId),
                        inmobiliariaId,
                        estado: EstadoPlanCuotas.VIGENTE
                },
                estado: 'PENDIENTE',
                liquidacionId: null,
                movimientoId: null,
                ...(req.query.incluirFuturas === 'true' ? {} : { fechaVencimiento: { lte: liquidationPeriod } })
            },
            include: {
                plan: { include: { _count: { select: { cuotas: true } } } }
            },
            orderBy: [
                { fechaVencimiento: 'asc' },
                { planId: 'asc' },
                { numeroCuota: 'asc' }
            ]
        });

        res.json(cuotas.map(cuota => ({
            ...cuota,
            correspondeAlPeriodo: cuota.fechaVencimiento.getTime() === liquidationPeriod.getTime(),
            vencida: cuota.fechaVencimiento < liquidationPeriod
        })));
    } catch (error) {
        console.error('Error getting pendientes:', error);
        res.status(500).json({ message: 'Error al obtener cuotas pendientes' });
    }
});

// Los planes nunca se eliminan: una decisión operativa conserva tanto las
// cuotas ya usadas como las pendientes y queda explicada por su motivo.
router.post('/:id/cancelar', requirePermission('liquidaciones.editar'), requireRecentAuthentication, validateBody(planLifecycleSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const planId = Number(req.params.id);
    const { motivo } = req.body;
    try {
        const plan = await prisma.$transaction(async tx => {
            const current = await tx.planCuotas.findFirst({ where: { id: planId, inmobiliariaId }, include: { cuotas: true } });
            if (!current) throw Object.assign(new Error('Plan no encontrado'), { statusCode: 404, code: 'INSTALLMENT_PLAN_NOT_FOUND' });
            const pendientes = assertPlanHasAvailableInstallments(current);
            await tx.cuotaPlan.updateMany({ where: { id: { in: pendientes.map(cuota => cuota.id) }, estado: EstadoCuota.PENDIENTE }, data: { estado: EstadoCuota.CANCELADA } });
            return tx.planCuotas.update({
                where: { id: current.id },
                data: { estado: EstadoPlanCuotas.CANCELADO, motivoCierre: motivo, fechaCierre: new Date(), cerradoPorId: usuarioId }
            });
        }, { isolationLevel: 'Serializable' });
        await auditService.log({ usuarioId, inmobiliariaId, accion: 'CANCELAR_PLAN_CUOTAS', entidad: 'PlanCuotas', entidadId: planId, severidad: 'WARNING', detalle: `Plan cancelado. Motivo: ${motivo}` });
        res.json({ message: 'Plan cancelado; sus cuotas pendientes quedaron preservadas como canceladas', plan });
    } catch (error: any) {
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo cancelar el plan', code: error.code, details: error.details });
    }
});

router.post('/:id/condonar', requirePermission('liquidaciones.editar'), requireRecentAuthentication, validateBody(planLifecycleSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const planId = Number(req.params.id);
    const { motivo } = req.body;
    try {
        const plan = await prisma.$transaction(async tx => {
            const current = await tx.planCuotas.findFirst({ where: { id: planId, inmobiliariaId }, include: { cuotas: true } });
            if (!current) throw Object.assign(new Error('Plan no encontrado'), { statusCode: 404, code: 'INSTALLMENT_PLAN_NOT_FOUND' });
            const pendientes = assertPlanHasAvailableInstallments(current);
            await tx.cuotaPlan.updateMany({ where: { id: { in: pendientes.map(cuota => cuota.id) }, estado: EstadoCuota.PENDIENTE }, data: { estado: EstadoCuota.CONDONADA } });
            return tx.planCuotas.update({
                where: { id: current.id },
                data: { estado: EstadoPlanCuotas.CONDONADO, motivoCierre: motivo, fechaCierre: new Date(), cerradoPorId: usuarioId }
            });
        }, { isolationLevel: 'Serializable' });
        await auditService.log({ usuarioId, inmobiliariaId, accion: 'CONDONAR_PLAN_CUOTAS', entidad: 'PlanCuotas', entidadId: planId, severidad: 'WARNING', detalle: `Plan condonado. Motivo: ${motivo}` });
        res.json({ message: 'Plan condonado; sus cuotas pendientes quedaron preservadas como condonadas', plan });
    } catch (error: any) {
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo condonar el plan', code: error.code, details: error.details });
    }
});

router.post('/:id/reprogramar', requirePermission('liquidaciones.editar'), requireRecentAuthentication, validateBody(reprogramarPlanSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const planId = Number(req.params.id);
    const { motivo, montoTotal, cantidadCuotas, fechaPrimeraCuota, montoPendienteEsperado } = req.body;
    try {
        const result = await prisma.$transaction(async tx => {
            const current = await tx.planCuotas.findFirst({ where: { id: planId, inmobiliariaId }, include: { cuotas: true } });
            if (!current) throw Object.assign(new Error('Plan no encontrado'), { statusCode: 404, code: 'INSTALLMENT_PLAN_NOT_FOUND' });
            const pendientes = assertPlanHasAvailableInstallments(current);
            const previousSummary = summarizeInstallments(current.cuotas);
            if (montoPendienteEsperado !== undefined && !new Decimal(montoPendienteEsperado).equals(previousSummary.montoPendienteDisponible)) {
                throw Object.assign(new Error('El pendiente del plan cambió. Volvé a abrir la reprogramación para revisar los importes actuales.'), { statusCode: 409, code: 'INSTALLMENT_BALANCE_CHANGED' });
            }
            const schedule = buildInstallmentSchedule(montoTotal, cantidadCuotas, fechaPrimeraCuota);
            const successor = await tx.planCuotas.create({
                data: {
                    concepto: current.concepto,
                    montoTotal: new Decimal(montoTotal),
                    moneda: current.moneda,
                    tipoMovimiento: current.tipoMovimiento,
                    estado: EstadoPlanCuotas.VIGENTE,
                    inmobiliariaId,
                    contratoId: current.contratoId,
                    esParaInmobiliaria: current.esParaInmobiliaria,
                    planOrigenId: current.id
                }
            });
            await tx.cuotaPlan.createMany({
                data: schedule.map(item => ({
                    planId: successor.id,
                    numeroCuota: item.numeroCuota,
                    fechaVencimiento: new Date(`${item.fechaVencimiento}T00:00:00.000Z`),
                    monto: item.monto,
                    moneda: current.moneda,
                    estado: EstadoCuota.PENDIENTE
                }))
            });
            await tx.cuotaPlan.updateMany({ where: { id: { in: pendientes.map(cuota => cuota.id) }, estado: EstadoCuota.PENDIENTE }, data: { estado: EstadoCuota.REPROGRAMADA } });
            const original = await tx.planCuotas.update({
                where: { id: current.id },
                data: { estado: EstadoPlanCuotas.REPROGRAMADO, motivoCierre: motivo, fechaCierre: new Date(), cerradoPorId: usuarioId }
            });
            return { original, successor, resumenAnterior: previousSummary };
        }, { isolationLevel: 'Serializable' });
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'REPROGRAMAR_PLAN_CUOTAS', entidad: 'PlanCuotas', entidadId: planId, severidad: 'WARNING',
            detalle: JSON.stringify({ motivo, planSucesorId: result.successor.id, montoTotal, cantidadCuotas, fechaPrimeraCuota, pendienteAnterior: result.resumenAnterior.montoPendienteDisponible, variacionTotal: new Decimal(montoTotal).minus(result.resumenAnterior.montoPendienteDisponible).toFixed(2), importeCuotasPagadas: result.resumenAnterior.montoCuotasPagadas })
        });
        res.status(201).json({ message: 'Plan reprogramado; se creó un plan sucesor y se conservó el anterior', ...result });
    } catch (error: any) {
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo reprogramar el plan', code: error.code, details: error.details });
    }
});

router.delete('/:id', requirePermission('liquidaciones.editar'), async (_req, res) => {
    res.status(409).json({
        message: 'Los planes de cuotas no se eliminan. Cancelalos, condonalos o reprogramalos para conservar el historial.',
        code: 'INSTALLMENT_PLAN_DELETION_REPLACED'
    });
});

export default router;
