import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { prisma } from '../prisma';
import { userHasPermission } from '../services/permissions.service';
import { auditService, getAuditRequestMetadata } from '../services/audit.service';

const router = Router();
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const safeFilenamePattern = /^[a-zA-Z0-9._-]+$/;
const contentTypesByExtension: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
};
const downloadExtensions = new Set(['.doc', '.docx']);

const sanitizeHeaderFilename = (filename: string) => filename.replace(/["\\]/g, '');

router.use(authenticateToken);

router.get('/:agencyDir/:filename', async (req, res, next) => {
    const { id: userId, tipo, inmobiliariaId } = (req as AuthRequest).user!;
    const { agencyDir, filename } = req.params as { agencyDir: string; filename: string };
    const expectedAgencyDir = `inmobiliaria-${inmobiliariaId}`;
    const auditFailure = (reason: string, action = 'ACCESO_ARCHIVO_FALLIDO') => auditService.log({
        usuarioId: userId,
        inmobiliariaId,
        accion: action,
        entidad: 'Archivo',
        detalle: JSON.stringify({ reason, filename: filename.slice(0, 255) }),
        severidad: 'WARNING',
        resultado: 'FALLIDO',
        ...getAuditRequestMetadata(req as AuthRequest)
    });

    if (!safeFilenamePattern.test(filename)) {
        await auditFailure('INVALID_FILENAME');
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    if (agencyDir !== expectedAgencyDir) {
        await auditFailure('CROSS_AGENCY_PATH');
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const filepath = path.resolve(uploadDir, agencyDir, filename);
    const agencyRoot = path.resolve(uploadDir, agencyDir);

    if (!filepath.startsWith(`${agencyRoot}${path.sep}`) || !fs.existsSync(filepath)) {
        await auditFailure('FILE_NOT_FOUND');
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const relativePath = `${agencyDir}/${filename}`;
    const [contractOwner, propertyOwner] = await Promise.all([
        prisma.contrato.findFirst({
            where: {
                inmobiliariaId,
                OR: [
                    { rutaArchivoContrato: relativePath },
                    { adjuntos: { some: { rutaArchivo: relativePath } } }
                ]
            },
            select: { id: true }
        }),
        prisma.adjuntoPropiedad.findFirst({
            where: { rutaArchivo: relativePath, propiedad: { inmobiliariaId } },
            select: { id: true }
        })
    ]);

    if (!contractOwner && !propertyOwner) {
        await auditFailure('UNREGISTERED_FILE');
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const [canViewContractFile, canViewPropertyFile] = await Promise.all([
        contractOwner ? userHasPermission(userId, tipo, 'contratos.archivos.ver') : false,
        propertyOwner ? userHasPermission(userId, tipo, 'propiedades.ver') : false
    ]);
    if (!canViewContractFile && !canViewPropertyFile) {
        await auditFailure('PERMISSION_MISSING', 'ACCESO_ARCHIVO_DENEGADO');
        return res.status(403).json({ message: 'No tenés permiso para ver este archivo' });
    }

    const extension = path.extname(filename).toLowerCase();
    const contentType = contentTypesByExtension[extension] || 'application/octet-stream';
    const disposition = downloadExtensions.has(extension) ? 'attachment' : 'inline';

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `${disposition}; filename="${sanitizeHeaderFilename(filename)}"`);
    const entity = contractOwner ? 'Contrato' : 'AdjuntoPropiedad';
    const entityId = contractOwner?.id || propertyOwner?.id;
    const action = disposition === 'attachment' ? 'DESCARGAR_ARCHIVO' : 'CONSULTAR_ARCHIVO';

    res.sendFile(filepath, error => {
        void (async () => {
            await auditService.log({
                usuarioId: userId,
                inmobiliariaId,
                accion: error ? `${action}_FALLIDO` : action,
                entidad: entity,
                entidadId: entityId,
                detalle: JSON.stringify({ filename, disposition, ...(error ? { error: error.message } : {}) }),
                severidad: error ? 'WARNING' : 'INFO',
                resultado: error ? 'FALLIDO' : 'EXITO',
                ...getAuditRequestMetadata(req as AuthRequest)
            });
            if (error) next(error);
        })();
    });
});

export default router;
