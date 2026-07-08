import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { prisma } from '../prisma';

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

router.get('/:agencyDir/:filename', requirePermission('contratos.archivos.ver'), async (req, res) => {
    const { inmobiliariaId, role } = (req as AuthRequest).user!;
    const { agencyDir, filename } = req.params as { agencyDir: string; filename: string };
    const expectedAgencyDir = `inmobiliaria-${inmobiliariaId}`;

    if (!safeFilenamePattern.test(filename)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    if (role !== 'SUPERADMIN' && agencyDir !== expectedAgencyDir) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const filepath = path.resolve(uploadDir, agencyDir, filename);
    const agencyRoot = path.resolve(uploadDir, agencyDir);

    if (!filepath.startsWith(`${agencyRoot}${path.sep}`) || !fs.existsSync(filepath)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const relativePath = `${agencyDir}/${filename}`;
    const fileOwner = await prisma.contrato.findFirst({
        where: {
            ...(role === 'SUPERADMIN' ? {} : { inmobiliariaId }),
            OR: [
                { rutaArchivoContrato: relativePath },
                { adjuntos: { some: { rutaArchivo: relativePath } } }
            ]
        },
        select: { id: true }
    });

    if (!fileOwner) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const extension = path.extname(filename).toLowerCase();
    const contentType = contentTypesByExtension[extension] || 'application/octet-stream';
    const disposition = downloadExtensions.has(extension) ? 'attachment' : 'inline';

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `${disposition}; filename="${sanitizeHeaderFilename(filename)}"`);
    res.sendFile(filepath);
});

export default router;
