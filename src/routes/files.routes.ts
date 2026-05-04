import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const safeFilenamePattern = /^[a-zA-Z0-9._-]+$/;

router.use(authenticateToken);

router.get('/:agencyDir/:filename', (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { agencyDir, filename } = req.params;
    const expectedAgencyDir = `inmobiliaria-${inmobiliariaId}`;

    if (agencyDir !== expectedAgencyDir || !safeFilenamePattern.test(filename)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const filepath = path.resolve(uploadDir, agencyDir, filename);
    const agencyRoot = path.resolve(uploadDir, agencyDir);

    if (!filepath.startsWith(`${agencyRoot}${path.sep}`) || !fs.existsSync(filepath)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    res.set('Content-Disposition', 'inline');
    res.sendFile(filepath);
});

export default router;
