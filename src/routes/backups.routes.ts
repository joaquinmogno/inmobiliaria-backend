import { NextFunction, Router } from 'express';
import { authenticateToken, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { AuthRequest } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { auditService } from '../services/audit.service';
import { decryptFileToFile, encryptFile, getClientIp, getUserAgent } from '../services/security.service';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import os from 'os';

const execFilePromise = promisify(execFile);
const router = Router();

// Directorios de backups e scripts
const BACKUPS_ROOT = process.env.BACKUPS_DIR || path.join(__dirname, '../../../backups');
const DB_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'db');
const UPLOADS_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'uploads');
const BACKUP_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+\.enc$/;
let generationInProgress = false;

router.use(authenticateToken, requireAdmin);

const beginGeneration = () => {
    if (generationInProgress) throw Object.assign(new Error('Ya hay un backup en curso'), { statusCode: 429 });
    generationInProgress = true;
};

const endGeneration = () => {
    generationInProgress = false;
};

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

const getDownloadErrorCode = (error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = String((error as { code?: unknown }).code || '').trim();
        if (/^[A-Z0-9_-]{1,50}$/i.test(code)) return code;
    }
    return 'BACKUP_DOWNLOAD_ERROR';
};

const getDownloadAuditDetail = (params: {
    type: string;
    filename: string;
    requestId?: string;
    error?: unknown;
}) => [
    `archivo=${params.type}/${params.filename}`,
    params.requestId ? `requestId=${params.requestId}` : undefined,
    params.error ? `errorCode=${getDownloadErrorCode(params.error)}` : undefined
].filter(Boolean).join('; ');

const getPgDumpUrl = (databaseUrl: string) => {
    const url = new URL(databaseUrl);
    url.searchParams.delete('schema');
    return url.toString();
};

// Listar todos los backups
router.get('/', async (_req, res) => {
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
router.post('/db', requireRecentAuthentication, async (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `manual-db-backup-${timestamp}.sql`;
    const filepath = path.join(DB_BACKUPS_DIR, filename);
    const encryptedFilename = `${filename}.enc`;
    const encryptedPath = path.join(DB_BACKUPS_DIR, encryptedFilename);

    let completed = false;
    let generationAcquired = false;
    try {
        beginGeneration();
        generationAcquired = true;
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

        await encryptFile(filepath, encryptedPath);
        completed = true;

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_DB',
            entidad: 'Backup',
            detalle: encryptedFilename,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });

        res.status(201).json({ message: 'Backup de base de datos generado y cifrado', filename: encryptedFilename });
    } catch (error: any) {
        console.error('Error generating manual DB backup:', error);
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_DB_FALLIDO', entidad: 'Backup', resultado: 'FALLIDO',
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        const status = Number(error?.statusCode) || 500;
        res.status(status).json({ message: status === 500 ? 'Error al generar backup' : error.message });
    } finally {
        if (generationAcquired) endGeneration();
        await fs.promises.unlink(filepath).catch(() => undefined);
        if (!completed) await fs.promises.unlink(encryptedPath).catch(() => undefined);
    }
});

// Generar backup manual de Uploads
router.post('/uploads', requireRecentAuthentication, async (req, res) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sourceDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../../uploads');
    const sourceName = path.basename(sourceDir);
    const sourceParent = path.dirname(sourceDir);
    const filename = `uploads-backup-${timestamp}.tar.gz`;
    const filepath = path.join(UPLOADS_BACKUPS_DIR, filename);
    const encryptedFilename = `${filename}.enc`;
    const encryptedPath = path.join(UPLOADS_BACKUPS_DIR, encryptedFilename);

    let completed = false;
    let generationAcquired = false;
    try {
        beginGeneration();
        generationAcquired = true;
        if (!fs.existsSync(sourceDir)) return res.status(404).json({ message: 'Carpeta de uploads no encontrada' });
        if (!fs.existsSync(UPLOADS_BACKUPS_DIR)) fs.mkdirSync(UPLOADS_BACKUPS_DIR, { recursive: true });

        await execFilePromise('tar', ['-czf', filepath, '-C', sourceParent, sourceName], {
            maxBuffer: 1024 * 1024 * 10
        });
        await encryptFile(filepath, encryptedPath);
        completed = true;

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_UPLOADS',
            entidad: 'Backup',
            detalle: encryptedFilename,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });
        
        res.status(201).json({ message: 'Backup de archivos generado y cifrado', filename: encryptedFilename });
    } catch (error: any) {
        console.error('Error generating manual uploads backup:', error);
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'CREAR_BACKUP_UPLOADS_FALLIDO', entidad: 'Backup', resultado: 'FALLIDO',
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        const status = Number(error?.statusCode) || 500;
        res.status(status).json({ message: status === 500 ? 'Error al generar backup de archivos' : error.message });
    } finally {
        if (generationAcquired) endGeneration();
        await fs.promises.unlink(filepath).catch(() => undefined);
        if (!completed) await fs.promises.unlink(encryptedPath).catch(() => undefined);
    }
});

// Descargar un backup
router.get('/download/:type/:filename', requireRecentAuthentication, async (req, res, next: NextFunction) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const filepath = resolveBackupPath(type, filename);
    const authRequest = req as AuthRequest;

    const recordDownload = async (resultado: 'EXITO' | 'FALLIDO', error?: unknown) => {
        await auditService.log({
            usuarioId: authRequest.user!.id,
            inmobiliariaId: authRequest.user!.inmobiliariaId,
            accion: 'DESCARGAR_BACKUP',
            entidad: 'Backup',
            detalle: getDownloadAuditDetail({ type, filename, requestId: authRequest.requestId, error }),
            resultado,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });
    };

    if (!filepath || !fs.existsSync(filepath)) {
        await recordDownload('FALLIDO', { code: 'BACKUP_NOT_FOUND' });
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const downloadName = filename.replace(/\.enc$/, '');
    // Express ignora por defecto los archivos cuyo basename comienza con punto.
    // El temporal conserva además la extensión real para enviar un Content-Type útil.
    const temporaryPath = path.join(os.tmpdir(), `propcontrol-download-${crypto.randomUUID()}-${downloadName}`);

    try {
        await decryptFileToFile(filepath, temporaryPath);
        res.download(temporaryPath, downloadName, error => {
            void (async () => {
                await fs.promises.unlink(temporaryPath).catch(() => undefined);

                if (error) {
                    await recordDownload('FALLIDO', error);
                    if (!res.headersSent) {
                        res.status(500).json({
                            message: 'Error al enviar backup',
                            requestId: authRequest.requestId
                        });
                        return;
                    }
                    next(error);
                    return;
                }

                await recordDownload('EXITO');
            })().catch(next);
        });
    } catch (error) {
        await fs.promises.unlink(temporaryPath).catch(() => undefined);
        await recordDownload('FALLIDO', error);
        res.status(500).json({
            message: 'Error al preparar backup para la descarga',
            requestId: authRequest.requestId
        });
    }
});

// Eliminar un backup
router.delete('/:type/:filename', requireRecentAuthentication, (req, res) => {
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
                detalle: `${type}/${filename}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'CRITICAL'
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
