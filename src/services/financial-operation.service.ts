import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../errors/app-error';

const conflict = () => new AppError('Otra operación actualizó los datos mientras guardabas. Actualizá el estado y revisalo antes de volver a confirmar.', { statusCode: 409, code: 'TRANSACTION_CONFLICT' });

export function isTransactionConflict(error: any): boolean {
    return error?.code === 'P2034' || ['40001', '40P01'].includes(error?.code)
        || ['40001', '40P01'].includes(error?.meta?.code)
        || (error?.name === 'PrismaClientUnknownRequestError' && /PostgresError \{ code: "(?:40001|40P01)"/.test(error.message || ''));
}

export function financialError(error: any) {
    if (isTransactionConflict(error)) return conflict();
    if (error?.statusCode && error.statusCode < 500) return error;
    // Never expose query text, schema details or driver errors to the operator.
    return new AppError('No se pudo completar la operación. Actualizá el estado antes de reintentar.', { statusCode: 500, code: 'FINANCIAL_OPERATION_FAILED' });
}

export function canonicalJson(value: any): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

// A completed operation, its financial writes and its success audit commit together.
// There is no expiry: an old retry must never become a new charge.
export async function financialOperation<T>(req: AuthRequest, execute: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const key = req.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
        throw new AppError('Falta un identificador válido de operación. Actualizá la aplicación antes de registrar el pago.', { statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const { id: usuarioId, inmobiliariaId } = req.user!;
    const scope = `${req.method}:${req.baseUrl}${req.path}`;
    const requestHash = createHash('sha256').update(canonicalJson(req.body)).digest('hex');
    const where = { inmobiliariaId_clave: { inmobiliariaId, clave: key } };
    const replay = (record: { usuarioId: number; alcance: string; hashSolicitud: string; respuesta: Prisma.JsonValue }) => {
        if (record.usuarioId !== usuarioId || record.alcance !== scope || record.hashSolicitud !== requestHash) {
            throw new AppError('El identificador ya pertenece a otra operación. Revisá el resultado anterior antes de registrar una nueva.', { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return record.respuesta as T;
    };
    const prior = await prisma.operacionFinanciera.findUnique({ where });
    if (prior) return replay(prior);
    try {
        return await prisma.$transaction(async tx => {
            const existing = await tx.operacionFinanciera.findUnique({ where });
            if (existing) return replay(existing);
            const response = await execute(tx);
            const json = JSON.parse(JSON.stringify(response));
            await tx.operacionFinanciera.create({ data: { inmobiliariaId, usuarioId, clave: key, alcance: scope, hashSolicitud: requestHash, respuesta: json } });
            return json as T;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
    } catch (error: any) {
        if (isTransactionConflict(error) || error?.code === 'P2002') {
            const committed = await prisma.operacionFinanciera.findUnique({ where });
            if (committed) return replay(committed);
            throw conflict();
        }
        throw error;
    }
}
