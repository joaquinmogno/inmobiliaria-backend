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
import path from 'path';
import fs from 'fs';
import {
    cleanupFailedUpload,
    commitUploadedFile,
    removeUploadedFile,
    uploadAgencyLogo,
    validateUploadedFileContent
} from '../middlewares/upload.middleware';

const router = Router();
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const logoContentTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
};

const isSafeAgencyLogoPath = (logoPath: string, inmobiliariaId: number) => {
    const agencyDirectory = `inmobiliaria-${inmobiliariaId}`;
    if (!logoPath.startsWith(`${agencyDirectory}/`)) return false;
    const absolutePath = path.resolve(uploadDir, logoPath);
    const expectedDirectory = path.resolve(uploadDir, agencyDirectory);
    return absolutePath.startsWith(`${expectedDirectory}${path.sep}`);
};

// El logo se entrega únicamente al usuario autenticado de esa inmobiliaria.
router.get('/me/logo', authenticateToken, async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId } = req.user!;
    try {
        const agency = await prisma.inmobiliaria.findUnique({
            where: { id: inmobiliariaId },
            select: { logoArchivo: true }
        });
        if (!agency?.logoArchivo || !isSafeAgencyLogoPath(agency.logoArchivo, inmobiliariaId)) {
            return res.status(404).json({ message: 'Logo no encontrado' });
        }
        const logoPath = path.resolve(uploadDir, agency.logoArchivo);
        const contentType = logoContentTypes[path.extname(logoPath).toLowerCase()];
        if (!contentType || !fs.existsSync(logoPath)) return res.status(404).json({ message: 'Logo no encontrado' });
        res.set('Content-Type', contentType);
        res.set('Content-Disposition', 'inline');
        res.sendFile(logoPath);
    } catch {
        res.status(500).json({ message: 'No se pudo obtener el logo' });
    }
});

router.post(
    '/me/logo',
    authenticateToken,
    requirePermission('configuracion.perfil.editar'),
    uploadAgencyLogo,
    validateUploadedFileContent,
    cleanupFailedUpload,
    async (req: AuthRequest, res: Response) => {
        const { id: usuarioId, inmobiliariaId } = req.user!;
        if (!req.file) return res.status(400).json({ message: 'Seleccioná una imagen para el logo', code: 'AGENCY_LOGO_REQUIRED' });

        let newLogoPath: string | null = null;
        try {
            const currentAgency = await prisma.inmobiliaria.findUnique({
                where: { id: inmobiliariaId },
                select: { logoArchivo: true }
            });
            if (!currentAgency) return res.status(404).json({ message: 'Inmobiliaria no encontrada' });

            newLogoPath = await commitUploadedFile(req.file, inmobiliariaId);
            const updatedAgency = await prisma.inmobiliaria.update({
                where: { id: inmobiliariaId },
                data: { logoArchivo: newLogoPath, logoUrl: null }
            });
            if (currentAgency.logoArchivo && currentAgency.logoArchivo !== newLogoPath) {
                await removeUploadedFile(currentAgency.logoArchivo);
            }
            await auditService.log({
                usuarioId,
                inmobiliariaId,
                accion: 'CARGAR_LOGO_INMOBILIARIA',
                entidad: 'Inmobiliaria',
                entidadId: inmobiliariaId,
                detalle: JSON.stringify({ formato: path.extname(req.file.originalname).slice(1).toUpperCase(), bytes: req.file.size }),
                resultado: 'EXITO',
                ...getAuditRequestMetadata(req)
            });
            res.json(updatedAgency);
        } catch (error) {
            await removeUploadedFile(newLogoPath);
            await auditService.log({
                usuarioId,
                inmobiliariaId,
                accion: 'CARGAR_LOGO_INMOBILIARIA',
                entidad: 'Inmobiliaria',
                entidadId: inmobiliariaId,
                detalle: JSON.stringify({ reason: 'PERSISTENCE_ERROR' }),
                resultado: 'FALLIDO',
                severidad: 'WARNING',
                ...getAuditRequestMetadata(req)
            });
            res.status(500).json({ message: 'No se pudo guardar el logo' });
        }
    }
);

router.delete('/me/logo', authenticateToken, requirePermission('configuracion.perfil.editar'), async (req: AuthRequest, res: Response) => {
    const { id: usuarioId, inmobiliariaId } = req.user!;
    try {
        const agency = await prisma.inmobiliaria.findUnique({
            where: { id: inmobiliariaId },
            select: { logoArchivo: true, logoUrl: true }
        });
        if (!agency) return res.status(404).json({ message: 'Inmobiliaria no encontrada' });
        const updatedAgency = await prisma.inmobiliaria.update({
            where: { id: inmobiliariaId },
            data: { logoArchivo: null, logoUrl: null }
        });
        await removeUploadedFile(agency.logoArchivo);
        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ELIMINAR_LOGO_INMOBILIARIA',
            entidad: 'Inmobiliaria',
            entidadId: inmobiliariaId,
            detalle: JSON.stringify({ hadUploadedLogo: Boolean(agency.logoArchivo), hadLegacyUrl: Boolean(agency.logoUrl) }),
            resultado: 'EXITO',
            ...getAuditRequestMetadata(req)
        });
        res.json(updatedAgency);
    } catch {
        res.status(500).json({ message: 'No se pudo eliminar el logo' });
    }
});

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
