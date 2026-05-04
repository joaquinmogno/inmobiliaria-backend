import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { prisma } from '../prisma';

const router = Router();
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const safeFilenamePattern = /^[a-zA-Z0-9._-]+$/;

router.use(authenticateToken);

router.get('/:agencyDir/:filename', async (req, res) => {
    const { inmobiliariaId, role } = (req as AuthRequest).user!;
    const { agencyDir, filename } = req.params;
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
                { rutaPdf: relativePath },
                { adjuntos: { some: { rutaArchivo: relativePath } } }
            ]
        },
        select: { id: true }
    });

    if (!fileOwner) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    res.set('Content-Disposition', 'inline');
    res.sendFile(filepath);
});

export default router;
