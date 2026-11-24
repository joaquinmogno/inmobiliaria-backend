import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
const fail = (message: string) => { throw new AppError(message, { statusCode: 409, code: 'RENT_PREPAYMENT_CONFLICT' }); };

export async function applyRentPrepayment(db: Prisma.TransactionClient, liquidacionId: number) {
    const row = await db.liquidacion.findUniqueOrThrow({ where: { id: liquidacionId } });
    const advance = await db.anticipoAlquiler.findFirst({ where: { contratoId: row.contratoId, inmobiliariaId: row.inmobiliariaId, anuladoEn: null, periodoDesde: { lte: row.periodo }, periodoHasta: { gte: row.periodo } } });
    if (advance && (advance.moneda !== row.moneda || advance.montoMensual.greaterThan(row.montoAlquilerBase))) {
        fail('El anticipo supera el alquiler del período o tiene otra moneda. Revisá el anticipo y el alquiler antes de continuar.');
    }
    if (!advance && !row.anticipoAlquilerId && !Number(row.montoAlquilerAnticipado || 0)) return row;
    if (advance && row.pagaHonorarios !== 'PROPIETARIO') fail('El alquiler anticipado requiere honorarios a cargo del propietario.');
    return db.liquidacion.update({ where: { id: row.id }, data: { anticipoAlquilerId: advance?.id || null, montoAlquilerAnticipado: advance?.montoMensual || 0 } });
}

