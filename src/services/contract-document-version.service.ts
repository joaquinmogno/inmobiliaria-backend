import { Prisma, TipoDocumentoContrato } from '@prisma/client';
import { argentinaTodayAsDate } from '../utils/argentina-date';

type PrincipalDocumentInput = {
    contratoId: number;
    rutaArchivo: string;
    nombreArchivo?: string | null;
    observacion?: string | null;
    creadoPorId: number;
};

/** Registra una nueva versión del contrato principal, sin alterar las anteriores. */
export async function createPrincipalContractDocument(
    tx: Prisma.TransactionClient,
    input: PrincipalDocumentInput
) {
    const latestDocument = await tx.adjuntoContrato.findFirst({
        where: {
            contratoId: input.contratoId,
            tipo: TipoDocumentoContrato.CONTRATO_PRINCIPAL
        },
        orderBy: [{ versionDocumento: 'desc' }, { id: 'desc' }],
        select: { versionDocumento: true }
    });
    const versionDocumento = (latestDocument?.versionDocumento || 0) + 1;

    await tx.adjuntoContrato.updateMany({
        where: {
            contratoId: input.contratoId,
            tipo: TipoDocumentoContrato.CONTRATO_PRINCIPAL,
            esVigente: true
        },
        data: { esVigente: false }
    });

    return tx.adjuntoContrato.create({
        data: {
            contratoId: input.contratoId,
            rutaArchivo: input.rutaArchivo,
            nombreArchivo: input.nombreArchivo || null,
            tipo: TipoDocumentoContrato.CONTRATO_PRINCIPAL,
            fechaDocumento: argentinaTodayAsDate(),
            observacion: input.observacion || null,
            versionDocumento,
            esVigente: true,
            creadoPorId: input.creadoPorId
        }
    });
}
