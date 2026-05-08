const unsafeJwtSecrets = new Set([
    'secret_key_change_me',
    'prueba',
    'test',
    'changeme',
    'change_me'
]);

const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET'] as const;

for (const key of requiredEnvVars) {
    if (!process.env[key]) {
        throw new Error(`Variable de entorno requerida faltante: ${key}`);
    }
}

const jwtSecret = process.env.JWT_SECRET!;

if (process.env.NODE_ENV === 'production') {
    if (jwtSecret.length < 32 || unsafeJwtSecrets.has(jwtSecret.toLowerCase())) {
        throw new Error('JWT_SECRET debe tener al menos 32 caracteres y no puede ser un valor de ejemplo en produccion');
    }

    if (!process.env.FRONTEND_URL) {
        throw new Error('FRONTEND_URL es requerida en produccion');
    }
}

export const env = {
    databaseUrl: process.env.DATABASE_URL!,
    jwtSecret,
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || '3000',
    frontendUrl: process.env.FRONTEND_URL,
    uploadDir: process.env.UPLOAD_DIR,
    backupsDir: process.env.BACKUPS_DIR,
    scriptsDir: process.env.SCRIPTS_DIR
};
