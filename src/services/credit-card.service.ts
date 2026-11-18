import { Prisma, type AmbitoTarjeta } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors/app-error';

export const creditCardSchema = z.object({
    nombre: z.string().trim().min(1, 'Ingresá un nombre para la tarjeta').max(80),
    banco: z.string().trim().min(1, 'Ingresá el banco o emisor').max(80),
    ultimosCuatro: z.string().regex(/^\d{4}$/, 'Ingresá exactamente los últimos 4 dígitos')
}).strict();

export const outgoingPaymentMethodSchema = z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'TARJETA_CREDITO']);
export const optionalCardId = z.coerce.number().int().positive().nullable().optional();
export const isCreditCardMethod = (method?: string | null) => ['tarjeta', 'tarjeta de credito', 'tarjeta credito'].includes(
    (method || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\s]+/g, ' ').trim().toLowerCase()
);
export const creditCardLabel = (card: { nombre: string; banco: string; ultimosCuatro: string }) => `${card.nombre} · ${card.banco} · •••• ${card.ultimosCuatro}`;

// La fila queda bloqueada hasta registrar el pago. Desactivar y pagar no pueden
// intercalarse. Una edición puede conservar la tarjeta histórica desactivada.
export async function resolvePaymentCard(tx: Prisma.TransactionClient, input: {
    inmobiliariaId: number; ambito: AmbitoTarjeta; metodoPago?: string | null;
    tarjetaId?: number | null; previousCardId?: number | null;
}) {
    if (!isCreditCardMethod(input.metodoPago)) {
        if (input.tarjetaId) throw new AppError('Sólo indicá una tarjeta al pagar con crédito.', { statusCode: 400 });
        return { tarjetaId: null, tarjetaDescripcion: null };
    }
    if (!input.tarjetaId) throw new AppError('Seleccioná la tarjeta de crédito utilizada.', { statusCode: 400, code: 'CREDIT_CARD_REQUIRED' });
    const cards = await tx.$queryRaw<Array<{ id: number; nombre: string; banco: string; ultimosCuatro: string; activa: boolean }>>(Prisma.sql`
        SELECT "id", "nombre", "banco", "ultimosCuatro", "activa" FROM "TarjetaCredito"
        WHERE "id" = ${input.tarjetaId} AND "inmobiliariaId" = ${input.inmobiliariaId}
          AND "ambito"::text = ${input.ambito} FOR UPDATE
    `);
    const card = cards[0];
    if (!card || (!card.activa && card.id !== input.previousCardId)) {
        throw new AppError('La tarjeta no está disponible en este apartado. Elegí una tarjeta activa.', { statusCode: 400, code: 'INVALID_CREDIT_CARD' });
    }
    return { tarjetaId: card.id, tarjetaDescripcion: creditCardLabel(card) };
}
