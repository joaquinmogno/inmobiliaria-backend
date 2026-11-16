import { AppError } from '../errors/app-error';

export function assertBackupClientVersion(clientVersion: string, serverVersion: string) {
    const clientMajor = Number(clientVersion.match(/\b(\d+)\./)?.[1]);
    const serverMajor = Math.floor(Number(serverVersion) / 10000);
    if (!clientMajor || clientMajor !== serverMajor) {
        throw new AppError('La herramienta de respaldo debe usar la misma versión principal de PostgreSQL que la base. Revisá la instalación antes de generar el respaldo.', { statusCode: 503, code: 'BACKUP_CLIENT_VERSION_MISMATCH' });
    }
}
