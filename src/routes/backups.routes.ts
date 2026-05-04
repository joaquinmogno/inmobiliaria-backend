import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { AuthRequest } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { auditService } from '../services/audit.service';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);
const router = Router();

// Directorios de backups e scripts
const BACKUPS_ROOT = process.env.BACKUPS_DIR || path.join(__dirname, '../../../backups');
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.join(__dirname, '../../scripts');
const DB_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'db');
const UPLOADS_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'uploads');
const BACKUP_SCRIPT_PATH = path.join(SCRIPTS_DIR, 'backup-uploads.sh');
const BACKUP_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

router.use(authenticateToken);

const getBackupDir = (type: string) => {
    if (type === 'db') return DB_BACKUPS_DIR;
    if (type === 'uploads') return UPLOADS_BACKUPS_DIR;
    return null;
};

const resolveBackupPath = (type: string, filename: string) => {
    const baseDir = getBackupDir(type);
    if (!baseDir || !BACKUP_FILENAME_PATTERN.test(filename)) return null;

    const resolvedBase = path.resolve(baseDir);
    const resolvedFile = path.resolve(resolvedBase, filename);

    if (!resolvedFile.startsWith(`${resolvedBase}${path.sep}`)) return null;
    return resolvedFile;
};

const getPgDumpUrl = (databaseUrl: string) => {
    const url = new URL(databaseUrl);
    url.searchParams.delete('schema');
    return url.toString();
};

// Listar todos los backups
router.get('/', requireAdmin, async (req, res) => {
    try {
        const getFiles = (dir: string, type: 'db' | 'uploads') => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter(file => BACKUP_FILENAME_PATTERN.test(file))
                .flatMap(file => {
                    const stats = fs.statSync(path.join(dir, file));
                    if (!stats.isFile()) return [];
                    return [{
                        name: file,
                        size: stats.size,
                        date: stats.mtime,
                        type
                    }];
                })
                .sort((a, b) => b.date.getTime() - a.date.getTime());
        };

        const dbFiles = getFiles(DB_BACKUPS_DIR, 'db');
        const uploadsFiles = getFiles(UPLOADS_BACKUPS_DIR, 'uploads');

        res.json([...dbFiles, ...uploadsFiles]);
    } catch (error) {
        console.error('Error listing backups:', error);
        res.status(500).json({ message: 'Error al listar backups' });
    }
});

// Generar backup manual de DB
router.post('/db', requireAdmin, async (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `manual-db-backup-${timestamp}.sql`;
    const filepath = path.join(DB_BACKUPS_DIR, filename);

    try {
        if (!fs.existsSync(DB_BACKUPS_DIR)) fs.mkdirSync(DB_BACKUPS_DIR, { recursive: true });

        // Extraer credenciales de la URL de la base de datos (o usar variables de entorno)
        // La URL suele ser: postgresql://USER:PASS@HOST:PORT/DB?schema=public
        const dbUrl = process.env.DATABASE_URL;
        
        if (!dbUrl) {
            throw new Error('DATABASE_URL no está definida');
        }

        console.log(`Ejecutando backup manual de DB: ${filename}`);
        const pgDumpUrl = getPgDumpUrl(dbUrl);
        const { stderr } = await execFilePromise('pg_dump', ['-f', filepath, pgDumpUrl], {
            maxBuffer: 1024 * 1024 * 10
        });
        if (stderr && stderr.toLowerCase().includes('error')) {
            console.error('pg_dump stderr:', stderr);
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_DB',
            entidad: 'Backup',
            detalle: filename
        });

        res.status(201).json({ message: 'Backup de base de datos generado', filename });
    } catch (error: any) {
        console.error('Error generating manual DB backup:', error);
        res.status(500).json({ message: 'Error al generar backup', details: error.message || String(error) });
    }
});

// Generar backup manual de Uploads
router.post('/uploads', requireAdmin, async (req, res) => {
    try {
        console.log('Ejecutando backup manual de archivos...');
        const { stdout } = await execFilePromise('sh', [BACKUP_SCRIPT_PATH], {
            env: {
                ...process.env,
                BACKUPS_DIR: BACKUPS_ROOT,
                UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads')
            }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_UPLOADS',
            entidad: 'Backup',
            detalle: stdout || 'Backup de archivos generado'
        });
        
        res.status(201).json({ message: 'Backup de archivos iniciado', output: stdout });
    } catch (error) {
        console.error('Error generating manual uploads backup:', error);
        res.status(500).json({ message: 'Error al generar backup de archivos' });
    }
});

// Descargar un backup
router.get('/download/:type/:filename', requireAdmin, (req, res) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const filepath = resolveBackupPath(type, filename);

    if (!filepath || !fs.existsSync(filepath)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    res.download(filepath);
});

// Eliminar un backup
router.delete('/:type/:filename', requireAdmin, (req, res) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const filepath = resolveBackupPath(type, filename);

    try {
        if (filepath && fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);

            auditService.log({
                usuarioId: (req as AuthRequest).user!.id,
                inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
                accion: 'ELIMINAR_BACKUP',
                entidad: 'Backup',
                detalle: `${type}/${filename}`
            });

            res.json({ message: 'Backup eliminado exitosamente' });
        } else {
            res.status(404).json({ message: 'Archivo no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar el archivo' });
    }
});

export default router;
