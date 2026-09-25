import { Router, Response } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { requireAdmin, requirePermission } from '../middlewares/permissions.middleware';
import { argentinaDayRange } from '../utils/argentina-date';
import { withPagination } from '../middlewares/pagination.middleware';
import { auditService, getAuditRequestMetadata } from '../services/audit.service';
import { logger } from '../services/logger.service';
import { validateBody } from '../middlewares/validation.middleware';
import { agencyProfileSchema, agencyProfileUpdateSchema, type AgencyProfileInput } from '../validation/inmobiliaria.schemas';
import { parseDateOnly } from '../utils/argentina-date';

const router = Router();

// GET /api/inmobiliaria/me
router.get('/me', authenticateToken, requirePermission('configuracion.perfil.ver'), async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId } = req.user!;

    try {
        const inmobiliaria = await prisma.inmobiliaria.findUnique({
            where: { id: inmobiliariaId }
        });

        if (!inmobiliaria) {
            return res.status(404).json({ message: 'Inmobiliaria no encontrada' });
        }

        res.json(inmobiliaria);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener datos de la inmobiliaria' });
    }
});

// PUT /api/inmobiliaria/me
router.put('/me', authenticateToken, requirePermission('configuracion.perfil.editar'), validateBody(agencyProfileUpdateSchema), async (req: AuthRequest, res: Response) => {
    const { id: usuarioId, inmobiliariaId } = req.user!;

    try {
        const currentInmobiliaria = await prisma.inmobiliaria.findUnique({
            where: { id: inmobiliariaId }
        });
        if (!currentInmobiliaria) return res.status(404).json({ message: 'Inmobiliaria no encontrada' });

        const profileCandidate = {
            ...currentInmobiliaria,
            inicioActividades: currentInmobiliaria.inicioActividades?.toISOString().slice(0, 10),
            ...req.body
        };
        const parsed = agencyProfileSchema.safeParse(profileCandidate);
        if (!parsed.success) {
            return res.status(400).json({
                message: 'Datos institucionales inválidos',
                errors: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
            });
        }
        const profile = parsed.data as AgencyProfileInput;
        const updatedInmobiliaria = await prisma.inmobiliaria.update({
            where: { id: inmobiliariaId },
            data: {
                nombre: profile.nombre,
                razonSocial: profile.razonSocial ?? null,
                cuit: profile.cuit ?? null,
                direccion: profile.direccion ?? null,
                domicilioFiscal: profile.domicilioFiscal ?? null,
                email: profile.email ?? null,
                telefono: profile.telefono ?? null,
                contactoAdministrativo: profile.contactoAdministrativo ?? null,
                slogan: profile.slogan ?? null,
                logoUrl: profile.logoUrl ?? null,
                condicionIva: profile.condicionIva,
                ingresosBrutos: profile.ingresosBrutos ?? null,
                puntoVenta: profile.puntoVenta ?? null,
                inicioActividades: profile.inicioActividades ? parseDateOnly(profile.inicioActividades) : null
            }
        });

        const profileFields = [
            'nombre', 'razonSocial', 'cuit', 'direccion', 'domicilioFiscal', 'email', 'telefono',
            'contactoAdministrativo', 'slogan', 'logoUrl', 'condicionIva', 'ingresosBrutos',
            'puntoVenta', 'inicioActividades'
        ] as const;
        const comparable = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null;
        const changes = Object.fromEntries(profileFields.flatMap(field => {
            const anterior = comparable(currentInmobiliaria[field]);
            const nuevo = comparable(updatedInmobiliaria[field]);
            return anterior === nuevo ? [] : [[field, { anterior, nuevo }]];
        }));

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ACTUALIZAR_PERFIL_INMOBILIARIA',
            entidad: 'Inmobiliaria',
            entidadId: inmobiliariaId,
            detalle: JSON.stringify({ cambios: changes }),
            resultado: 'EXITO',
            ...getAuditRequestMetadata(req)
        });
        res.json(updatedInmobiliaria);
    } catch (error) {
        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ACTUALIZAR_PERFIL_INMOBILIARIA',
            entidad: 'Inmobiliaria',
            entidadId: inmobiliariaId,
            detalle: JSON.stringify({ reason: 'PERSISTENCE_ERROR' }),
            severidad: 'CRITICAL',
            resultado: 'FALLIDO',
            ...getAuditRequestMetadata(req)
        });
        logger.error('Agency profile update failed', {
            requestId: req.requestId,
            usuarioId,
            inmobiliariaId,
            error
        });
        res.status(500).json({ message: 'Error al actualizar datos de la inmobiliaria' });
    }
});

// GET /api/inmobiliaria/logs
router.get('/logs', authenticateToken, requireAdmin, withPagination(15), async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId } = req.user!;

    const { accion, fechaDesde, fechaHasta, usuario, resultado, requestId } = req.query;

    try {
        const { page: pageNum, limit: limitNum, skip } = res.locals.pagination;

        const whereClause: any = { inmobiliariaId };

        if (accion) {
            whereClause.accion = accion as string;
        }
        if (resultado === 'EXITO' || resultado === 'FALLIDO') whereClause.resultado = resultado;
        if (requestId) whereClause.requestId = String(requestId).slice(0, 100);
        if (usuario) {
            whereClause.usuario = { is: { OR: [
                { nombreCompleto: { contains: String(usuario), mode: 'insensitive' } },
                { email: { contains: String(usuario), mode: 'insensitive' } }
            ] } };
        }

        if (fechaDesde || fechaHasta) {
            whereClause.fechaCreacion = {};
            if (fechaDesde) {
                whereClause.fechaCreacion.gte = argentinaDayRange(String(fechaDesde)).start;
            }
            if (fechaHasta) {
                whereClause.fechaCreacion.lt = argentinaDayRange(String(fechaHasta)).end;
            }
        }

        // Fetch logs and total count
        const [total, logs] = await prisma.$transaction([
            prisma.auditLog.count({ where: whereClause }),
            prisma.auditLog.findMany({
                where: whereClause,
                include: {
                    usuario: {
                        select: { nombreCompleto: true }
                    }
                },
                orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
                skip,
                take: limitNum
            })
        ]);
        
        res.json({
            data: logs,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ message: 'Error al obtener logs' });
    }
});

export default router;
