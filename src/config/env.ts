import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const buildDatabaseUrl = () => {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    const user = process.env.POSTGRES_USER;
    const password = process.env.POSTGRES_PASSWORD;
    const db = process.env.POSTGRES_DB;

    if (!user || !password || !db) return undefined;

    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '55432';
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}?schema=public`;
};

process.env.DATABASE_URL = buildDatabaseUrl();

const unsafeSessionSecrets = new Set([
    'secret_key_change_me',
    'prueba',
    'test',
    'changeme',
    'change_me'
]);

const requiredEnvVars = ['DATABASE_URL', 'SESSION_SECRET'] as const;

for (const key of requiredEnvVars) {
    if (!process.env[key]) {
        throw new Error(`Variable de entorno requerida faltante: ${key}`);
    }
}

const sessionSecret = process.env.SESSION_SECRET!;

if (process.env.NODE_ENV === 'production') {
    if (sessionSecret.length < 32 || unsafeSessionSecrets.has(sessionSecret.toLowerCase())) {
        throw new Error('SESSION_SECRET debe tener al menos 32 caracteres y no puede ser un valor de ejemplo en produccion');
    }

    if (!process.env.FRONTEND_URL) {
        throw new Error('FRONTEND_URL es requerida en produccion');
    }

    if (!process.env.BACKUP_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY.length < 32) {
        throw new Error('BACKUP_ENCRYPTION_KEY debe tener al menos 32 caracteres en produccion');
    }

    if (!process.env.INITIAL_SETUP_TOKEN || process.env.INITIAL_SETUP_TOKEN.length < 24) {
        throw new Error('INITIAL_SETUP_TOKEN debe tener al menos 24 caracteres en produccion');
    }
}

export const env = {
    databaseUrl: process.env.DATABASE_URL!,
    sessionSecret,
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || '3000',
    frontendUrl: process.env.FRONTEND_URL,
    uploadDir: process.env.UPLOAD_DIR,
    backupsDir: process.env.BACKUPS_DIR,
    scriptsDir: process.env.SCRIPTS_DIR,
    backupEncryptionKey: process.env.BACKUP_ENCRYPTION_KEY || 'development-backup-key-change-me-32',
    initialSetupToken: process.env.INITIAL_SETUP_TOKEN
};
