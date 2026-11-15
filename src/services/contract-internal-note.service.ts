import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate } from '../utils/optimistic-lock';

export const INTERNAL_CONTRACT_NOTE_ACTIONS = ['GUARDAR_NOTA_INTERNA_CONTRATO', 'ELIMINAR_NOTA_INTERNA_CONTRATO'];

const internalNoteSelect = {
    id: true,
    notaInterna: true,
    notaInternaVersion: true,
    notaInternaActualizadaEn: true,
    notaInternaActualizadaPor: { select: { id: true, nombreCompleto: true } }
} as const satisfies Prisma.ContratoSelect;

export const getContractInternalNote = (contract: Prisma.ContratoGetPayload<{ select: typeof internalNoteSelect }>) => ({
    texto: contract.notaInterna,
    version: contract.notaInternaVersion,
    actualizadaEn: contract.notaInternaActualizadaEn,
    actualizadaPor: contract.notaInternaActualizadaPor
});

// Una única nota vigente por contrato: se consulta desde cualquier período.
// Su versión independiente impide que una pestaña antigua restaure una nota
// eliminada o sobrescriba una edición realizada desde otra liquidación.
export async function updateContractInternalNote(tx: Prisma.TransactionClient, input: {
    liquidacionId: number;
    inmobiliariaId: number;
    usuarioId: number;
    texto: string | null;
    expectedVersion: number;
    auditMetadata?: { ipAddress: string | null; userAgent: string | null; requestId: string | null };
}) {
    const liquidation = await tx.liquidacion.findFirst({
        where: { id: input.liquidacionId, inmobiliariaId: input.inmobiliariaId },
        select: { contrato: { select: internalNoteSelect } }
    });
    if (!liquidation) throw new AppError('Liquidación no encontrada', { statusCode: 404, code: 'LIQUIDATION_NOT_FOUND' });
    const current = liquidation.contrato;
    assertOptimisticUpdate(current.notaInternaVersion === input.expectedVersion ? 1 : 0, input.expectedVersion, current.notaInternaVersion);
    const text = input.texto?.trim() || null;
    if (current.notaInterna === text) return getContractInternalNote(current);
    const updated = await tx.contrato.updateMany({
        where: { id: current.id, inmobiliariaId: input.inmobiliariaId, notaInternaVersion: input.expectedVersion },
        data: {
            notaInterna: text,
            notaInternaVersion: { increment: 1 },
            notaInternaActualizadaEn: new Date(),
            notaInternaActualizadaPorId: input.usuarioId
        }
    });
    assertOptimisticUpdate(updated.count, input.expectedVersion, current.notaInternaVersion);
    await tx.auditLog.create({
        data: {
            usuarioId: input.usuarioId,
            inmobiliariaId: input.inmobiliariaId,
            entidad: 'Contrato', entidadId: current.id,
            accion: text ? 'GUARDAR_NOTA_INTERNA_CONTRATO' : 'ELIMINAR_NOTA_INTERNA_CONTRATO',
            detalle: JSON.stringify({
                'Nota interna': { anterior: current.notaInterna, nuevo: text },
                liquidacionOrigenId: input.liquidacionId
            }),
            ...input.auditMetadata
        }
    });
    return getContractInternalNote(await tx.contrato.findUniqueOrThrow({ where: { id: current.id }, select: internalNoteSelect }));
}
