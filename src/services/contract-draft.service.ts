import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middlewares/auth.middleware';
import { AppError } from '../errors/app-error';

export const draftScope = (user: NonNullable<AuthRequest['user']>) => ({
    inmobiliariaId: user.inmobiliariaId,
    ...(user.tipo === 'ADMIN' ? {} : { creadoPorId: user.id })
});

// All attachment mutations and conversion share this lock. A conversion cannot
// consume the draft while an upload is still attaching a document to it.
export async function lockContractDraft(tx: Prisma.TransactionClient, id: number, user: NonNullable<AuthRequest['user']>) {
    const rows = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT id FROM "BorradorContrato"
        WHERE id = ${id} AND "inmobiliariaId" = ${user.inmobiliariaId}
        ${user.tipo === 'ADMIN' ? Prisma.empty : Prisma.sql`AND "creadoPorId" = ${user.id}`}
        FOR UPDATE
    `);
    if (!rows.length) throw new AppError('El borrador no está disponible: pudo ser eliminado o convertido. Tus datos siguen en el formulario.', {
        statusCode: 404, code: 'DRAFT_NOT_FOUND'
    });
}
