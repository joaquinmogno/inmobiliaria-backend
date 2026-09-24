import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { TipoMovimiento, EstadoPlanCuotas, EstadoCuota } from '@prisma/client';
import { auditService } from '../services/audit.service';
import { validateBody, requiredText, positiveDecimal, booleanFromForm, dateOnlyString } from '../middlewares/validation.middleware';
import { z } from 'zod';
import { requirePermission } from '../middlewares/permissions.middleware';
import { formatCurrency } from '../utils/currency';
import { Decimal } from '@prisma/client/runtime/library';
import { distributeInstallmentAmounts } from '../services/installment-plan.service';

const router = Router();

router.use(authenticateToken);

const planCuotasSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    concepto: requiredText('El concepto', 255),
    montoTotal: positiveDecimal('El monto total').refine(value => new Decimal(value).decimalPlaces() <= 2, {
        message: 'El monto total admite como máximo dos decimales'
    }),
    cantidadCuotas: z.coerce.number().int().min(1, 'Debe tener al menos una cuota').max(120, 'Máximo 120 cuotas'),
    fechaPrimeraCuota: dateOnlyString('El período de la primera cuota').refine(value => value.endsWith('-01'), {
        message: 'El período de la primera cuota debe comenzar el día 01'
    }),
    tipoMovimiento: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    esParaInmobiliaria: booleanFromForm.optional().default(false)
}).superRefine((value, ctx) => {
    const totalCents = new Decimal(value.montoTotal).times(100).toNumber();
    if (totalCents < value.cantidadCuotas) {
        ctx.addIssue({
            code: 'custom',
            path: ['montoTotal'],
            message: 'El monto total debe permitir cuotas de al menos 0,01'
        });
    }
});

const planLifecycleSchema = z.object({
    motivo: requiredText('El motivo', 1000).refine(value => value.trim().length >= 5, { message: 'El motivo debe tener al menos 5 caracteres' })
});

const reprogramarPlanSchema = planLifecycleSchema.extend({
    montoTotal: positiveDecimal('El monto total').refine(value => new Decimal(value).decimalPlaces() <= 2, {
        message: 'El monto total admite como máximo dos decimales'
    }),
    cantidadCuotas: z.coerce.number().int().min(1, 'Debe tener al menos una cuota').max(120, 'Máximo 120 cuotas'),
    fechaPrimeraCuota: dateOnlyString('El período de la primera cuota').refine(value => value.endsWith('-01'), {
        message: 'El período de la primera cuota debe comenzar el día 01'
    })
}).superRefine((value, ctx) => {
    if (new Decimal(value.montoTotal).times(100).lessThan(value.cantidadCuotas)) {
        ctx.addIssue({ code: 'custom', path: ['montoTotal'], message: 'El monto total debe permitir cuotas de al menos 0,01' });
    }
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

        const installmentAmounts = distributeInstallmentAmounts(montoTotal, cantidadCuotas);
        const [firstYear, firstMonth] = fechaPrimeraCuota.split('-').map(Number);

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

            const cuotasData = [];
            for (let i = 1; i <= cantidadCuotas; i++) {
                cuotasData.push({
                    planId: newPlan.id,
                    numeroCuota: i,
                    fechaVencimiento: new Date(Date.UTC(firstYear, firstMonth - 1 + (i - 1), 1)),
                    monto: installmentAmounts[i - 1],
                    moneda: contrato.moneda,
                    estado: EstadoCuota.PENDIENTE
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

        res.json(planes);
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
                fechaVencimiento: { lte: liquidationPeriod }
            },
            include: {
                plan: true
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
    const { motivo, montoTotal, cantidadCuotas, fechaPrimeraCuota } = req.body;
    try {
        const result = await prisma.$transaction(async tx => {
            const current = await tx.planCuotas.findFirst({ where: { id: planId, inmobiliariaId }, include: { cuotas: true } });
            if (!current) throw Object.assign(new Error('Plan no encontrado'), { statusCode: 404, code: 'INSTALLMENT_PLAN_NOT_FOUND' });
            const pendientes = assertPlanHasAvailableInstallments(current);
            const amounts = distributeInstallmentAmounts(montoTotal, cantidadCuotas);
            const [year, month] = fechaPrimeraCuota.split('-').map(Number);
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
                data: amounts.map((amount, index) => ({
                    planId: successor.id,
                    numeroCuota: index + 1,
                    fechaVencimiento: new Date(Date.UTC(year, month - 1 + index, 1)),
                    monto: amount,
                    moneda: current.moneda,
                    estado: EstadoCuota.PENDIENTE
                }))
            });
            await tx.cuotaPlan.updateMany({ where: { id: { in: pendientes.map(cuota => cuota.id) }, estado: EstadoCuota.PENDIENTE }, data: { estado: EstadoCuota.REPROGRAMADA } });
            const original = await tx.planCuotas.update({
                where: { id: current.id },
                data: { estado: EstadoPlanCuotas.REPROGRAMADO, motivoCierre: motivo, fechaCierre: new Date(), cerradoPorId: usuarioId }
            });
            return { original, successor };
        }, { isolationLevel: 'Serializable' });
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'REPROGRAMAR_PLAN_CUOTAS', entidad: 'PlanCuotas', entidadId: planId, severidad: 'WARNING',
            detalle: JSON.stringify({ motivo, planSucesorId: result.successor.id, montoTotal, cantidadCuotas, fechaPrimeraCuota })
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
