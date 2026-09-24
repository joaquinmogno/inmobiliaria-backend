import { Router } from 'express';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { z } from 'zod';
import { CuentaCaja, MetodoPago, Moneda, Prisma, TipoAjusteSueldo } from '@prisma/client';
import { dateOnlyString, paymentMethodSchema, validateBody } from '../middlewares/validation.middleware';
import { argentinaTodayAsDate, assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate, optimisticVersionSchema } from '../utils/optimistic-lock';
import { withPagination } from '../middlewares/pagination.middleware';
import { assertCashEntryCanBeRewritten, assertCashPeriodOpen } from '../services/cash-closing.service';

const router = Router();

router.use(authenticateToken);

const sueldoSchema = z.object({
    usuarioId: z.coerce.number().int().positive(),
    monto: z.coerce.number().positive(),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    fecha: dateOnlyString('La fecha'),
    periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El período debe tener formato AAAA-MM'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    observaciones: z.string().trim().max(1000).optional().nullable()
});

const sueldoUpdateSchema = sueldoSchema.partial().extend({ version: optimisticVersionSchema }).refine(
    data => Object.keys(data).some(key => key !== 'version'),
    { message: 'Debe indicar al menos un campo para actualizar' }
);

const ajusteSueldoSchema = z.object({
    tipo: z.nativeEnum(TipoAjusteSueldo),
    monto: z.coerce.number().positive('El monto debe ser mayor a cero'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    motivo: z.string().trim().min(5, 'El motivo debe tener al menos 5 caracteres').max(1000)
});

const sueldoResponseInclude = {
    usuario: {
        select: { id: true, nombreCompleto: true, email: true }
    },
    creadoPor: {
        select: { nombreCompleto: true }
    },
    ajustes: {
        orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
        select: { id: true, tipo: true, monto: true, moneda: true, fecha: true, metodoPago: true, motivo: true }
    }
} satisfies Prisma.PagoSueldoInclude;

type SalaryCashMovementInput = {
    employeeName: string;
    monto: Decimal;
    moneda: Moneda;
    fecha: Date;
    periodo: string;
    metodoPago: MetodoPago;
    observaciones: string | null;
};

const buildSalaryCashMovement = (input: SalaryCashMovementInput) => ({
    tipo: 'EGRESO' as const,
    concepto: `Sueldo de ${input.employeeName} - Período ${input.periodo}`.slice(0, 255),
    monto: input.monto,
    moneda: input.moneda,
    fecha: input.fecha,
    metodoPago: input.metodoPago,
    cuenta: (input.metodoPago === MetodoPago.EFECTIVO ? CuentaCaja.CAJA : CuentaCaja.BANCO),
    observaciones: input.observaciones
});

// Get salaries
router.get('/', requirePermission('sueldos.ver'), withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const pagination = res.locals.pagination;
    const search = String(req.query.search || '').trim();
    const periodo = String(req.query.periodo || '').trim();

    try {
        const where: any = {
            inmobiliariaId,
            ...(periodo ? { periodo } : {}),
            ...(search ? { usuario: { OR: [
                { nombreCompleto: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } }
            ] } } : {})
        };

        const [total, sueldos] = await prisma.$transaction([
          prisma.pagoSueldo.count({ where }),
          prisma.pagoSueldo.findMany({
            where,
            include: sueldoResponseInclude,
            orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
            skip: pagination.skip,
            take: pagination.limit
          })
        ]);

        res.json({ data: sueldos, meta: { total, page: pagination.page, limit: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
        console.error('Error fetching salaries:', error);
        res.status(500).json({ message: 'Error al obtener sueldos' });
    }
});

// Create salary payment
router.post('/', requirePermission('sueldos.crear'), requireRecentAuthentication, async (req, res) => {
    const { id: adminId, inmobiliariaId } = (req as AuthRequest).user!;
    const validation = sueldoSchema.safeParse(req.body);

    if (!validation.success) {
        return res.status(400).json({
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
        });
    }

    const { usuarioId, monto, moneda, fecha, periodo, metodoPago, observaciones } = validation.data;

    try {
        // Verify recipient belongs to the same agency
        const recipient = await prisma.usuario.findFirst({
            where: { id: Number(usuarioId), inmobiliariaId }
        });

        if (!recipient) {
            return res.status(404).json({ message: 'Usuario no encontrado en esta inmobiliaria' });
        }

        const sueldo = await prisma.$transaction(async tx => {
            const montoDecimal = new Decimal(monto);
            const fechaPago = parseDateOnly(fecha);
            assertOperationalDateIsNotFuture(fechaPago, 'La fecha del pago de sueldo');
            const metodo = metodoPago as MetodoPago;
            const movimiento = buildSalaryCashMovement({
                employeeName: recipient.nombreCompleto,
                monto: montoDecimal,
                moneda: moneda as Moneda,
                fecha: fechaPago,
                periodo,
                metodoPago: metodo,
                observaciones: observaciones || null
            });
            await assertCashPeriodOpen(tx, {
                inmobiliariaId,
                fecha: fechaPago,
                cuenta: movimiento.cuenta,
                moneda: moneda as Moneda
            });
            const created = await tx.pagoSueldo.create({
                data: {
                    monto: montoDecimal,
                    moneda,
                    fecha: fechaPago,
                    periodo,
                    metodoPago: metodo,
                    observaciones,
                    usuarioId: Number(usuarioId),
                    inmobiliariaId,
                    creadoPorId: adminId
                }
            });
            await tx.movimientoCaja.create({
                data: {
                    ...movimiento,
                    inmobiliariaId,
                    creadoPorId: adminId,
                    pagoSueldoId: created.id
                }
            });
            return tx.pagoSueldo.findUniqueOrThrow({
                where: { id: created.id },
                include: sueldoResponseInclude
            });
        });

        await auditService.log({
            usuarioId: adminId,
            inmobiliariaId,
            accion: 'REGISTRAR_SUELDO',
            entidad: 'PagoSueldo',
            entidadId: sueldo.id,
            detalle: `Pago de sueldo registrado para ${sueldo.usuario.nombreCompleto} - Periodo: ${periodo}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(sueldo);
    } catch (error: any) {
        console.error('Error creating salary payment:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return res.status(409).json({ message: 'Ya existe un pago de sueldo para ese usuario, período y moneda' });
        }
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al registrar el pago de sueldo', code: error.code });
    }
});

router.put('/:id', requirePermission('sueldos.editar'), requireRecentAuthentication, async (req, res) => {
    const { id: adminId, inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const validation = sueldoUpdateSchema.safeParse(req.body);

    if (!validation.success) {
        return res.status(400).json({
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
        });
    }

    try {
        const sueldo = await prisma.pagoSueldo.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: { usuario: { select: { id: true, nombreCompleto: true } } }
        });

        if (!sueldo) {
            return res.status(404).json({ message: 'Sueldo no encontrado' });
        }

        if (sueldo.version !== validation.data.version) {
            assertOptimisticUpdate(0, validation.data.version, sueldo.version);
        }

        let recipient = sueldo.usuario;
        if (validation.data.usuarioId !== undefined) {
            const nextRecipient = await prisma.usuario.findFirst({
                where: { id: validation.data.usuarioId, inmobiliariaId }
            });

            if (!nextRecipient) {
                return res.status(404).json({ message: 'Usuario no encontrado en esta inmobiliaria' });
            }
            recipient = nextRecipient;
        }

        const nextMonto = validation.data.monto !== undefined ? new Decimal(validation.data.monto) : sueldo.monto;
        const nextMoneda = (validation.data.moneda || sueldo.moneda) as Moneda;
        const nextFecha = validation.data.fecha ? parseDateOnly(validation.data.fecha) : sueldo.fecha;
        assertOperationalDateIsNotFuture(nextFecha, 'La fecha del pago de sueldo');
        const nextPeriodo = validation.data.periodo || sueldo.periodo;
        const nextMetodoPago = (validation.data.metodoPago || sueldo.metodoPago) as MetodoPago;
        const nextObservaciones = 'observaciones' in validation.data
            ? validation.data.observaciones || null
            : sueldo.observaciones;

        const updated = await prisma.$transaction(async tx => {
            const currentMovement = await tx.movimientoCaja.findUnique({ where: { pagoSueldoId: sueldo.id } });
            await assertCashEntryCanBeRewritten(tx, {
                inmobiliariaId,
                fecha: currentMovement?.fecha || sueldo.fecha,
                cuenta: currentMovement?.cuenta || (sueldo.metodoPago === MetodoPago.EFECTIVO ? CuentaCaja.CAJA : CuentaCaja.BANCO),
                moneda: currentMovement?.moneda || sueldo.moneda
            });
            const claim = await tx.pagoSueldo.updateMany({
                where: { id: sueldo.id, inmobiliariaId, version: validation.data.version },
                data: {
                    ...('usuarioId' in validation.data ? { usuarioId: validation.data.usuarioId } : {}),
                    monto: nextMonto,
                    moneda: nextMoneda,
                    fecha: nextFecha,
                    periodo: nextPeriodo,
                    metodoPago: nextMetodoPago,
                    observaciones: nextObservaciones,
                    version: { increment: 1 }
                }
            });
            const currentVersion = claim.count === 0
                ? (await tx.pagoSueldo.findFirst({ where: { id: sueldo.id, inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(claim.count, validation.data.version, currentVersion);
            const movementData = buildSalaryCashMovement({
                employeeName: recipient.nombreCompleto,
                monto: nextMonto,
                moneda: nextMoneda,
                fecha: nextFecha,
                periodo: nextPeriodo,
                metodoPago: nextMetodoPago,
                observaciones: nextObservaciones
            });
            await assertCashPeriodOpen(tx, {
                inmobiliariaId,
                fecha: nextFecha,
                cuenta: movementData.cuenta,
                moneda: nextMoneda
            });
            await tx.movimientoCaja.upsert({
                where: { pagoSueldoId: sueldo.id },
                update: movementData,
                create: {
                    ...movementData,
                    inmobiliariaId,
                    creadoPorId: sueldo.creadoPorId,
                    pagoSueldoId: sueldo.id
                }
            });
            return tx.pagoSueldo.findUniqueOrThrow({
                where: { id: sueldo.id },
                include: sueldoResponseInclude
            });
        });

        await auditService.log({
            usuarioId: adminId,
            inmobiliariaId,
            accion: 'EDITAR_SUELDO',
            entidad: 'PagoSueldo',
            entidadId: updated.id,
            detalle: `Pago de sueldo editado - Periodo: ${updated.periodo}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(updated);
    } catch (error: any) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        console.error('Error updating salary payment:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return res.status(409).json({ message: 'Ya existe un pago de sueldo para ese usuario, período y moneda' });
        }
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al actualizar el pago de sueldo', code: error.code });
    }
});

/**
 * Corrige un pago de sueldo sin modificar su comprobante ni su asiento
 * original. El ajuste siempre queda fechado hoy, en el período abierto.
 */
router.post('/:id/ajustes', requirePermission('sueldos.editar'), requireRecentAuthentication, validateBody(ajusteSueldoSchema), async (req, res) => {
    const { id: usuarioId, inmobiliariaId } = (req as AuthRequest).user!;
    const sueldoId = Number(req.params.id);
    const { tipo, monto, metodoPago, motivo } = req.body as z.infer<typeof ajusteSueldoSchema>;

    if (!Number.isInteger(sueldoId) || sueldoId <= 0) {
        return res.status(400).json({ message: 'Pago de sueldo inválido' });
    }

    try {
        const result = await prisma.$transaction(async tx => {
            const sueldo = await tx.pagoSueldo.findFirst({
                where: { id: sueldoId, inmobiliariaId },
                include: { usuario: { select: { nombreCompleto: true } } }
            });
            if (!sueldo) {
                throw Object.assign(new Error('Pago de sueldo no encontrado'), { statusCode: 404, code: 'SALARY_NOT_FOUND' });
            }

            const fechaAjuste = argentinaTodayAsDate();
            const metodo = metodoPago as MetodoPago;
            const cuenta = metodo === MetodoPago.EFECTIVO ? CuentaCaja.CAJA : CuentaCaja.BANCO;
            await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: fechaAjuste, cuenta, moneda: sueldo.moneda });

            const movimientoCaja = await tx.movimientoCaja.create({
                data: {
                    inmobiliariaId,
                    tipo: tipo === TipoAjusteSueldo.PAGO_ADICIONAL ? 'EGRESO' : 'INGRESO',
                    concepto: `Ajuste de sueldo #${sueldo.id} - ${sueldo.usuario.nombreCompleto}`.slice(0, 255),
                    monto: new Decimal(monto),
                    moneda: sueldo.moneda,
                    fecha: fechaAjuste,
                    metodoPago: metodo,
                    cuenta,
                    observaciones: motivo,
                    creadoPorId: usuarioId
                }
            });

            const ajuste = await tx.ajustePagoSueldo.create({
                data: {
                    pagoSueldoId: sueldo.id,
                    tipo,
                    monto: new Decimal(monto),
                    moneda: sueldo.moneda,
                    fecha: fechaAjuste,
                    metodoPago: metodo,
                    motivo,
                    creadoPorId: usuarioId,
                    movimientoCajaId: movimientoCaja.id
                }
            });

            return { ajuste, sueldo };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'AJUSTAR_SUELDO',
            entidad: 'PagoSueldo',
            entidadId: sueldoId,
            severidad: 'WARNING',
            detalle: `Ajuste ${result.ajuste.tipo} de ${result.ajuste.moneda} ${result.ajuste.monto.toString()} sobre pago de sueldo #${sueldoId}. Motivo: ${motivo}`
        });
        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(result.ajuste);
    } catch (error: any) {
        console.error('Error creando ajuste de sueldo:', error);
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo registrar el ajuste de sueldo', code: error.code });
    }
});

router.delete('/:id', requirePermission('sueldos.eliminar'), requireRecentAuthentication, async (req, res) => {
    const { id: adminId, inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const sueldo = await prisma.pagoSueldo.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                usuario: {
                    select: { nombreCompleto: true }
                },
                _count: { select: { ajustes: true } }
            }
        });

        if (!sueldo) {
            return res.status(404).json({ message: 'Sueldo no encontrado' });
        }
        if (sueldo._count.ajustes > 0) {
            return res.status(409).json({
                message: 'Este pago ya tiene ajustes registrados y no puede eliminarse. Conservá el historial y registrá un nuevo ajuste si corresponde.',
                code: 'SALARY_HAS_ADJUSTMENTS'
            });
        }

        await prisma.$transaction(async tx => {
            const movement = await tx.movimientoCaja.findUnique({ where: { pagoSueldoId: sueldo.id } });
            await assertCashEntryCanBeRewritten(tx, {
                inmobiliariaId,
                fecha: movement?.fecha || sueldo.fecha,
                cuenta: movement?.cuenta || (sueldo.metodoPago === MetodoPago.EFECTIVO ? CuentaCaja.CAJA : CuentaCaja.BANCO),
                moneda: movement?.moneda || sueldo.moneda
            });
            await tx.movimientoCaja.deleteMany({
                where: { pagoSueldoId: sueldo.id, inmobiliariaId }
            });
            await tx.pagoSueldo.delete({
                where: { id: sueldo.id }
            });
        });

        await auditService.log({
            usuarioId: adminId,
            inmobiliariaId,
            accion: 'ELIMINAR_SUELDO',
            entidad: 'PagoSueldo',
            entidadId: sueldo.id,
            detalle: `Pago de sueldo eliminado para ${sueldo.usuario.nombreCompleto} - Periodo: ${sueldo.periodo}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json({ message: 'Pago de sueldo eliminado con éxito' });
    } catch (error: any) {
        console.error('Error deleting salary payment:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al eliminar el pago de sueldo', code: error.code });
    }
});

export default router;
