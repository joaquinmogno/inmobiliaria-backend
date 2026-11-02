import { DestinatarioNotaLiquidacion, EstadoLiquidacion, Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate } from '../utils/optimistic-lock';
import { createLiquidationVoucherSnapshot } from './liquidation-voucher.service';

// Una aclaración es información documental: nunca recalcula la liquidación,
// registra caja ni cambia el estado de sus cobros o entregas.
export async function updateLiquidationNote(tx: Prisma.TransactionClient, input: {
    liquidacionId: number;
    inmobiliariaId: number;
    usuarioId: number;
    notaLiquidacion: string | null;
    destinatarioNotaLiquidacion: DestinatarioNotaLiquidacion;
    expectedVersion: number;
    auditMetadata?: { ipAddress: string | null; userAgent: string | null; requestId: string | null };
}) {
    const current = await tx.liquidacion.findFirst({
        where: { id: input.liquidacionId, inmobiliariaId: input.inmobiliariaId }
    });
    if (!current) throw new AppError('Liquidación no encontrada', { statusCode: 404, code: 'LIQUIDATION_NOT_FOUND' });
    if (current.estado === EstadoLiquidacion.ANULADA) {
        throw new AppError('No se puede cambiar la nota de una liquidación anulada', { statusCode: 409, code: 'LIQUIDATION_NOT_EDITABLE' });
    }
    assertOptimisticUpdate(current.version === input.expectedVersion ? 1 : 0, input.expectedVersion, current.version);
    const note = input.notaLiquidacion?.trim() || null;
    const recipient = note ? input.destinatarioNotaLiquidacion : DestinatarioNotaLiquidacion.AMBOS;
    if (current.notaLiquidacion === note && current.destinatarioNotaLiquidacion === recipient) {
        return { liquidacion: current, comprobanteVersion: null };
    }
    const claimed = await tx.liquidacion.updateMany({
        where: { id: current.id, inmobiliariaId: input.inmobiliariaId, version: input.expectedVersion, estado: current.estado },
        data: { notaLiquidacion: note, destinatarioNotaLiquidacion: recipient, version: { increment: 1 } }
    });
    assertOptimisticUpdate(claimed.count, input.expectedVersion, current.version);

    // Los comprobantes ya emitidos permanecen inmutables. Una nota agregada,
    // editada o quitada después de confirmar se emite en una nueva versión.
    const voucher = current.estado === EstadoLiquidacion.CONFIRMADA
        ? await createLiquidationVoucherSnapshot({
            tx, liquidacionId: current.id, inmobiliariaId: input.inmobiliariaId,
            usuarioId: input.usuarioId, evento: 'NOTA_LIQUIDACION'
        })
        : null;
    await tx.auditLog.create({
        data: {
            usuarioId: input.usuarioId, inmobiliariaId: input.inmobiliariaId,
            accion: note ? 'GUARDAR_NOTA_LIQUIDACION' : 'QUITAR_NOTA_LIQUIDACION',
            entidad: 'Liquidacion', entidadId: current.id,
            detalle: JSON.stringify({
                notaLiquidacion: { anterior: current.notaLiquidacion, nuevo: note },
                destinatarioNotaLiquidacion: { anterior: current.destinatarioNotaLiquidacion, nuevo: recipient },
                comprobanteVersion: voucher?.version || null
            }),
            ...input.auditMetadata
        }
    });
    return {
        liquidacion: await tx.liquidacion.findUniqueOrThrow({ where: { id: current.id } }),
        comprobanteVersion: voucher?.version || null
    };
}
