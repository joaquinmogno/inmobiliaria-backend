import { Router } from 'express';
import { authenticateToken, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { AuthRequest } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/permissions.middleware';
import { auditService } from '../services/audit.service';
import { decryptFileToFile, encryptFile, getClientIp, getUserAgent } from '../services/security.service';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFilePromise = promisify(execFile);
const router = Router();

// Directorios de backups e scripts
const BACKUPS_ROOT = process.env.BACKUPS_DIR || path.join(__dirname, '../../../backups');
const DB_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'db');
const UPLOADS_BACKUPS_DIR = path.join(BACKUPS_ROOT, 'uploads');
const BACKUP_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+\.enc$/;
const MAX_CONCURRENT_DOWNLOADS = 2;
const activeDownloadSessions = new Set<number>();
const activeVerifications = new Set<number>();
let generationInProgress = false;
let lastGenerationAt = 0;
const GENERATION_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_BACKUP_BYTES = Number(process.env.MAX_BACKUP_BYTES || 5 * 1024 * 1024 * 1024);
const MIN_FREE_BYTES = Number(process.env.MIN_BACKUP_FREE_BYTES || 1024 * 1024 * 1024);
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 90);

router.use(authenticateToken);
router.use(requireSuperAdmin);

const backupBytes = async () => {
    let total = 0;
    for (const dir of [DB_BACKUPS_DIR, UPLOADS_BACKUPS_DIR]) {
        if (!fs.existsSync(dir)) continue;
        for (const file of await fs.promises.readdir(dir)) {
            const stats = await fs.promises.stat(path.join(dir, file));
            if (stats.isFile()) total += stats.size;
        }
    }
    return total;
};

const pruneExpiredBackups = async () => {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const dir of [DB_BACKUPS_DIR, UPLOADS_BACKUPS_DIR]) {
        if (!fs.existsSync(dir)) continue;
        for (const file of await fs.promises.readdir(dir)) {
            if (!BACKUP_FILENAME_PATTERN.test(file)) continue;
            const filepath = path.join(dir, file);
            const stats = await fs.promises.stat(filepath);
            if (stats.isFile() && stats.mtimeMs < cutoff) await fs.promises.unlink(filepath);
        }
    }
};

const beginGeneration = async () => {
    if (generationInProgress) throw Object.assign(new Error('Ya hay un backup en curso'), { statusCode: 429 });
    if (Date.now() - lastGenerationAt < GENERATION_COOLDOWN_MS) throw Object.assign(new Error('Esperá cinco minutos antes de generar otro backup'), { statusCode: 429 });
    await pruneExpiredBackups();
    if (await backupBytes() >= MAX_BACKUP_BYTES) throw Object.assign(new Error('Se alcanzó la cuota máxima de backups'), { statusCode: 507 });
    await fs.promises.mkdir(BACKUPS_ROOT, { recursive: true });
    const filesystem = await fs.promises.statfs(BACKUPS_ROOT);
    if (Number(filesystem.bavail) * Number(filesystem.bsize) < MIN_FREE_BYTES) throw Object.assign(new Error('No hay espacio libre suficiente para generar el backup'), { statusCode: 507 });
    generationInProgress = true;
};

const endGeneration = (completed: boolean) => {
    generationInProgress = false;
    if (completed) lastGenerationAt = Date.now();
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
        await beginGeneration();
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
        const status = Number(error?.statusCode) || 500;
        res.status(status).json({ message: status === 500 ? 'Error al generar backup' : error.message });
    } finally {
        if (generationAcquired) endGeneration(completed);
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
        await beginGeneration();
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
        const status = Number(error?.statusCode) || 500;
        res.status(status).json({ message: status === 500 ? 'Error al generar backup de archivos' : error.message });
    } finally {
        if (generationAcquired) endGeneration(completed);
        await fs.promises.unlink(filepath).catch(() => undefined);
        if (!completed) await fs.promises.unlink(encryptedPath).catch(() => undefined);
    }
});

// Descargar un backup
router.get('/download/:type/:filename', requireRecentAuthentication, async (req, res) => {
    const { type, filename } = req.params as { type: string, filename: string };
    const filepath = resolveBackupPath(type, filename);

    if (!filepath || !fs.existsSync(filepath)) {
        return res.status(404).json({ message: 'Archivo no encontrado' });
    }

    const sessionId = (req as AuthRequest).sessionId!;
    if (activeDownloadSessions.has(sessionId) || activeDownloadSessions.size >= MAX_CONCURRENT_DOWNLOADS) {
        return res.status(429).json({ message: 'Ya hay una descarga de backup en curso. Intente nuevamente en unos minutos.' });
    }

    const temporaryPath = path.join(BACKUPS_ROOT, `.download-${crypto.randomUUID()}.tmp`);
    activeDownloadSessions.add(sessionId);

    try {
        await decryptFileToFile(filepath, temporaryPath);
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'DESCARGAR_BACKUP',
            entidad: 'Backup',
            detalle: `${type}/${filename}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });
        const downloadName = filename.replace(/\.enc$/, '');
        res.download(temporaryPath, downloadName, async error => {
            activeDownloadSessions.delete(sessionId);
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            if (error && !res.headersSent) {
                res.status(500).json({ message: 'Error al enviar backup' });
            }
        });
    } catch (error) {
        activeDownloadSessions.delete(sessionId);
        await fs.promises.unlink(temporaryPath).catch(() => undefined);
        res.status(500).json({ message: 'Error al descifrar backup' });
    }
});

router.post('/:type/:filename/verify', requireRecentAuthentication, async (req, res) => {
    const { type, filename } = req.params as { type: string; filename: string };
    const filepath = resolveBackupPath(type, filename);
    const sessionId = (req as AuthRequest).sessionId!;
    if (!filepath || !fs.existsSync(filepath)) return res.status(404).json({ message: 'Archivo no encontrado' });
    if (activeVerifications.has(sessionId) || activeVerifications.size >= 1) {
        return res.status(429).json({ message: 'Ya hay una verificación de backup en curso' });
    }

    const temporaryPath = path.join(BACKUPS_ROOT, `.verify-${crypto.randomUUID()}.tmp`);
    const temporaryDatabase = `backup_verify_${crypto.randomBytes(8).toString('hex')}`;
    activeVerifications.add(sessionId);
    try {
        await decryptFileToFile(filepath, temporaryPath);
        let details: Record<string, unknown>;
        if (type === 'uploads') {
            const { stdout } = await execFilePromise('tar', ['-tzf', temporaryPath], { maxBuffer: 20 * 1024 * 1024 });
            const files = stdout.split('\n').filter(Boolean);
            details = { files: files.length };
        } else {
            const databaseUrl = process.env.BACKUP_VERIFICATION_DATABASE_URL;
            if (!databaseUrl) return res.status(503).json({ message: 'La verificación aislada de base de datos no está configurada' });
            const maintenanceUrl = new URL(getPgDumpUrl(databaseUrl));
            maintenanceUrl.pathname = '/postgres';
            const verificationUrl = new URL(maintenanceUrl);
            verificationUrl.pathname = `/${temporaryDatabase}`;
            await execFilePromise('createdb', ['--maintenance-db', maintenanceUrl.toString(), temporaryDatabase]);
            try {
                await execFilePromise('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', temporaryPath, verificationUrl.toString()], { maxBuffer: 20 * 1024 * 1024 });
                const { stdout } = await execFilePromise('psql', ['-X', '-At', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'", verificationUrl.toString()]);
                const tables = Number(stdout.trim());
                if (!Number.isFinite(tables) || tables === 0) throw new Error('El backup restauró una base sin tablas públicas');
                details = { tables };
            } finally {
                await execFilePromise('dropdb', ['--if-exists', '--force', '--maintenance-db', maintenanceUrl.toString(), temporaryDatabase]).catch(() => undefined);
            }
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId,
            accion: 'VERIFICAR_BACKUP', entidad: 'Backup', detalle: `${type}/${filename}`,
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        res.json({ message: 'Backup verificado correctamente en un entorno temporal', details });
    } catch (error) {
        console.error('Error verifying backup:', error);
        res.status(422).json({ message: 'El backup no pudo restaurarse o validar su integridad' });
    } finally {
        activeVerifications.delete(sessionId);
        await fs.promises.unlink(temporaryPath).catch(() => undefined);
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
