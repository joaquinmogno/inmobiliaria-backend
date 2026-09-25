import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { prisma } from '../prisma';

type TxClient = Prisma.TransactionClient;

const renewalTimelineSelect = {
    id: true,
    contratoAnteriorId: true,
    fechaInicio: true,
    fechaFin: true,
    fechaRescision: true,
    estado: true,
    montoAlquiler: true,
    moneda: true,
    propiedad: { select: { direccion: true, piso: true, departamento: true } },
    inquilinos: {
        where: { esPrincipal: true },
        select: { persona: { select: { nombreCompleto: true } } }
    }
} satisfies Prisma.ContratoSelect;

type RenewalTimelineRecord = Prisma.ContratoGetPayload<{ select: typeof renewalTimelineSelect }>;

export type ContractRenewalTimelineEntry = {
    id: number;
    contratoAnteriorId: number | null;
    fechaInicio: Date;
    fechaFin: Date;
    fechaRescision: Date | null;
    estado: string;
    montoAlquiler: unknown;
    moneda: string;
    propiedad: RenewalTimelineRecord['propiedad'];
    inquilinoPrincipal: string | null;
};

const toTimelineEntry = (contract: RenewalTimelineRecord): ContractRenewalTimelineEntry => ({
    id: contract.id,
    contratoAnteriorId: contract.contratoAnteriorId,
    fechaInicio: contract.fechaInicio,
    fechaFin: contract.fechaFin,
    fechaRescision: contract.fechaRescision,
    estado: contract.estado,
    montoAlquiler: contract.montoAlquiler,
    moneda: contract.moneda,
    propiedad: contract.propiedad,
    inquilinoPrincipal: contract.inquilinos[0]?.persona.nombreCompleto || null
});

/**
 * A renewal is intentionally a linear history. This guard keeps the new record
 * in the same commercial context and avoids branching or overlapping terms.
 */
export async function assertValidContractRenewal(
    tx: TxClient,
    input: { contratoAnteriorId?: number; inmobiliariaId: number; propiedadId: number; fechaInicio: Date }
) {
    if (!input.contratoAnteriorId) return null;

    const previous = await tx.contrato.findFirst({
        where: { id: input.contratoAnteriorId, inmobiliariaId: input.inmobiliariaId },
        select: {
            id: true,
            propiedadId: true,
            estado: true,
            fechaFin: true,
            fechaRescision: true,
            contratoRenovado: { select: { id: true } }
        }
    });
    if (!previous) {
        throw new AppError('El contrato anterior no existe o no pertenece a la inmobiliaria', {
            statusCode: 400,
            code: 'INVALID_RENEWAL_SOURCE'
        });
    }
    if (previous.estado === 'PAPELERA') {
        throw new AppError('No se puede renovar un contrato que está en la papelera', {
            statusCode: 409,
            code: 'RENEWAL_SOURCE_IN_TRASH'
        });
    }
    if (previous.contratoRenovado) {
        throw new AppError(`El contrato #${previous.id} ya fue renovado por el contrato #${previous.contratoRenovado.id}`, {
            statusCode: 409,
            code: 'CONTRACT_ALREADY_RENEWED',
            details: { contratoAnteriorId: previous.id, contratoRenovadoId: previous.contratoRenovado.id }
        });
    }
    if (previous.propiedadId !== input.propiedadId) {
        throw new AppError('Una renovación debe conservar el mismo inmueble del contrato anterior', {
            statusCode: 400,
            code: 'RENEWAL_PROPERTY_MISMATCH'
        });
    }

    const effectiveEnd = previous.fechaRescision || previous.fechaFin;
    if (input.fechaInicio <= effectiveEnd) {
        throw new AppError('La renovación debe comenzar después de la finalización efectiva del contrato anterior', {
            statusCode: 400,
            code: 'INVALID_RENEWAL_DATES',
            details: { contratoAnteriorId: previous.id, fechaFinAnterior: effectiveEnd }
        });
    }
    return previous;
}

/** Obtains the complete predecessor/successor chain for the contract detail. */
export async function getContractRenewalTimeline(inmobiliariaId: number, contractId: number) {
    const current = await prismaContractTimelineEntry(inmobiliariaId, contractId);
    if (!current) return [] as ContractRenewalTimelineEntry[];

    const visited = new Set<number>([current.id]);
    const predecessors: RenewalTimelineRecord[] = [];
    let cursor = current;
    while (cursor.contratoAnteriorId) {
        const previous = await prismaContractTimelineEntry(inmobiliariaId, cursor.contratoAnteriorId);
        if (!previous || visited.has(previous.id)) break;
        predecessors.unshift(previous);
        visited.add(previous.id);
        cursor = previous;
    }

    const successors: RenewalTimelineRecord[] = [];
    cursor = current;
    while (true) {
        const following = await prisma.contrato.findFirst({
            where: { inmobiliariaId, contratoAnteriorId: cursor.id },
            select: renewalTimelineSelect
        });
        if (!following || visited.has(following.id)) break;
        successors.push(following);
        visited.add(following.id);
        cursor = following;
    }

    return [...predecessors, current, ...successors].map(toTimelineEntry);
}

async function prismaContractTimelineEntry(inmobiliariaId: number, id: number) {
    return prisma.contrato.findFirst({
        where: { id, inmobiliariaId },
        select: renewalTimelineSelect
    });
}
