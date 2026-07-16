import { Router } from 'express';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
import { parsePagination } from '../utils/pagination';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const router = Router();

router.use(authenticateToken);

const sueldoSchema = z.object({
    usuarioId: z.coerce.number().int().positive(),
    monto: z.coerce.number().positive(),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD'),
    periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El período debe tener formato AAAA-MM'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional().default('EFECTIVO'),
    observaciones: z.string().trim().max(1000).optional().nullable()
});

const sueldoUpdateSchema = sueldoSchema.partial().refine(
    data => Object.keys(data).length > 0,
    { message: 'Debe indicar al menos un campo para actualizar' }
);

// Get salaries
router.get('/', requirePermission('sueldos.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const pagination = parsePagination(req.query.page, req.query.limit, 25);
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
            include: {
                usuario: {
                    select: {
                        id: true,
                        nombreCompleto: true,
                        email: true
                    }
                },
                creadoPor: {
                    select: {
                        nombreCompleto: true
                    }
                }
            },
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
router.post('/', requirePermission('sueldos.crear'), async (req, res) => {
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

        const sueldo = await prisma.pagoSueldo.create({
            data: {
                monto: new Decimal(monto),
                moneda,
                fecha: new Date(fecha),
                periodo,
                metodoPago: metodoPago || 'EFECTIVO',
                observaciones,
                usuarioId: Number(usuarioId),
                inmobiliariaId,
                creadoPorId: adminId
            },
            include: {
                usuario: {
                    select: { nombreCompleto: true }
                }
            }
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
    } catch (error) {
        console.error('Error creating salary payment:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return res.status(409).json({ message: 'Ya existe un pago de sueldo para ese usuario, período y moneda' });
        }
        res.status(500).json({ message: 'Error al registrar el pago de sueldo' });
    }
});

router.put('/:id', requirePermission('sueldos.editar'), async (req, res) => {
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
            where: { id: Number(id), inmobiliariaId }
        });

        if (!sueldo) {
            return res.status(404).json({ message: 'Sueldo no encontrado' });
        }

        if (validation.data.usuarioId) {
            const recipient = await prisma.usuario.findFirst({
                where: { id: validation.data.usuarioId, inmobiliariaId }
            });

            if (!recipient) {
                return res.status(404).json({ message: 'Usuario no encontrado en esta inmobiliaria' });
            }
        }

        const updated = await prisma.pagoSueldo.update({
            where: { id: sueldo.id },
            data: {
                ...('usuarioId' in validation.data ? { usuarioId: validation.data.usuarioId } : {}),
                ...('monto' in validation.data ? { monto: new Decimal(validation.data.monto!) } : {}),
                ...('moneda' in validation.data ? { moneda: validation.data.moneda } : {}),
                ...('fecha' in validation.data ? { fecha: new Date(validation.data.fecha!) } : {}),
                ...('periodo' in validation.data ? { periodo: validation.data.periodo } : {}),
                ...('metodoPago' in validation.data ? { metodoPago: validation.data.metodoPago } : {}),
                ...('observaciones' in validation.data ? { observaciones: validation.data.observaciones } : {})
            },
            include: {
                usuario: {
                    select: {
                        id: true,
                        nombreCompleto: true,
                        email: true
                    }
                },
                creadoPor: {
                    select: {
                        nombreCompleto: true
                    }
                }
            }
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
    } catch (error) {
        console.error('Error updating salary payment:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return res.status(409).json({ message: 'Ya existe un pago de sueldo para ese usuario, período y moneda' });
        }
        res.status(500).json({ message: 'Error al actualizar el pago de sueldo' });
    }
});

router.delete('/:id', requirePermission('sueldos.eliminar'), async (req, res) => {
    const { id: adminId, inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const sueldo = await prisma.pagoSueldo.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                usuario: {
                    select: { nombreCompleto: true }
                }
            }
        });

        if (!sueldo) {
            return res.status(404).json({ message: 'Sueldo no encontrado' });
        }

        await prisma.pagoSueldo.delete({
            where: { id: sueldo.id }
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
    } catch (error) {
        console.error('Error deleting salary payment:', error);
        res.status(500).json({ message: 'Error al eliminar el pago de sueldo' });
    }
});

export default router;
