import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);
const router = Router();

// Directorios de backups e scripts
const BACKUPS_ROOT = process.env.BACKUPS_DIR || path.join(__dirname, '../../../backups');
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || path.join(__dirname, '../../scripts');
const DB_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'db');
const UPLOADS_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'uploads');
const BACKUP_SCRIPT_PATH = path.join(SCRIPTS_DIR, 'backup-uploads.sh');

router.use(authenticateToken);

// Middleware para verificar que sea ADMIN
const isAdmin = (req: AuthRequest, res: any, next: any) => {
    if (req.user?.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado: Se requiere rol de Administrador' });
    }
    next();
};

// Listar todos los backups
router.get('/', isAdmin, async (req, res) => {
    try {
        const getFiles = (dir: string, type: 'db' | 'uploads') => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .map(file => {
                    const stats = fs.statSync(path.join(dir, file));
                    return {
                        name: file,
                        size: stats.size,
                        date: stats.mtime,
                        type
                    };
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
router.post('/db', isAdmin, async (req, res) => {
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

        // Forma rápida de ejecutar pg_dump usando la URL directamente
        const command = `pg_dump "${dbUrl}" > "${filepath}"`;

        console.log(`Ejecutando backup manual de DB: ${filename}`);
        await execPromise(command);

        res.status(201).json({ message: 'Backup de base de datos generado', filename });
    } catch (error) {
        console.error('Error generating manual DB backup:', error);
        res.status(500).json({ message: 'Error al generar backup de base de datos' });
    }
});

// Generar backup manual de Uploads
router.post('/uploads', isAdmin, async (req, res) => {
    try {
        console.log('Ejecutando backup manual de archivos...');
        const { stdout } = await execPromise(`sh ${BACKUP_SCRIPT_PATH}`, {
            env: {
                ...process.env,
                BACKUPS_DIR: BACKUPS_ROOT,
                UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads')
            }
        });
        
        res.status(201).json({ message: 'Backup de archivos iniciado', output: stdout });
    } catch (error) {
        console.error('Error generating manual uploads backup:', error);
        res.status(500).json({ message: 'Error al generar backup de archivos' });
    }
});

// Descargar un backup
router.get('/download/:type/:filename', isAdmin, (req, res) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const baseDir = type === 'db' ? DB_BACKUPS_DIR : UPLOADS_BACKUPS_DIR;
    const filepath = path.join(baseDir, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    res.download(filepath);
});

// Eliminar un backup
router.delete('/:type/:filename', isAdmin, (req, res) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const baseDir = type === 'db' ? DB_BACKUPS_DIR : UPLOADS_BACKUPS_DIR;
    const filepath = path.join(baseDir, filename);

    try {
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            res.json({ message: 'Backup eliminado exitosamente' });
        } else {
            res.status(404).json({ message: 'Archivo no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar el archivo' });
    }
});

export default router;
