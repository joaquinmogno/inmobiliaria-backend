import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { prisma } from '../prisma';
import { findPersonIdentityMatches, getPersonIdentity } from '../utils/person-identity';

type MergeResult = {
    destinoId: number;
    origen: { id: number; nombreCompleto: string };
    destino: { id: number; nombreCompleto: string };
    relaciones: { propietarios: number; inquilinos: number; garantes: number; liquidaciones: number };
};

const conflict = (contractIds: number[]) => new AppError(
    'No se pueden fusionar estas personas porque quedarían con roles de propietario e inquilino en el mismo contrato',
    { statusCode: 409, code: 'PERSON_MERGE_CONTRACT_ROLE_CONFLICT', details: { contratos: contractIds } }
);

const moveOwners = async (tx: Prisma.TransactionClient, sourceId: number, targetId: number) => {
    const relations = await tx.contratoPropietario.findMany({ where: { personaId: sourceId } });
    for (const relation of relations) {
        const target = await tx.contratoPropietario.findFirst({ where: { contratoId: relation.contratoId, personaId: targetId } });
        if (target) {
            if (relation.esPrincipal && !target.esPrincipal) {
                await tx.contratoPropietario.update({ where: { id: target.id }, data: { esPrincipal: true } });
            }
            await tx.contratoPropietario.delete({ where: { id: relation.id } });
        } else {
            await tx.contratoPropietario.update({ where: { id: relation.id }, data: { personaId: targetId } });
        }
    }
    return relations.length;
};

const moveTenants = async (tx: Prisma.TransactionClient, sourceId: number, targetId: number) => {
    const relations = await tx.contratoInquilino.findMany({ where: { personaId: sourceId } });
    for (const relation of relations) {
        const target = await tx.contratoInquilino.findFirst({ where: { contratoId: relation.contratoId, personaId: targetId } });
        if (target) {
            if (relation.esPrincipal && !target.esPrincipal) {
                await tx.contratoInquilino.update({ where: { id: target.id }, data: { esPrincipal: true } });
            }
            await tx.contratoInquilino.delete({ where: { id: relation.id } });
        } else {
            await tx.contratoInquilino.update({ where: { id: relation.id }, data: { personaId: targetId } });
        }
    }
    return relations.length;
};

export const mergePeople = async (params: {
    inmobiliariaId: number;
    sourceId: number;
    targetId: number;
    sourceVersion: number;
    userId: number;
}) => prisma.$transaction(async tx => {
    const source = await tx.persona.findFirst({ where: { id: params.sourceId, inmobiliariaId: params.inmobiliariaId } });
    const target = await tx.persona.findFirst({ where: { id: params.targetId, inmobiliariaId: params.inmobiliariaId } });
    if (!source || !target) {
        throw new AppError('La persona de origen o destino no existe en esta inmobiliaria', { statusCode: 404, code: 'PERSON_NOT_FOUND' });
    }
    if (source.id === target.id) {
        throw new AppError('Elegí dos personas diferentes para fusionar', { statusCode: 400, code: 'PERSON_MERGE_SAME_PERSON' });
    }
    if (source.version !== params.sourceVersion) {
        throw new AppError('La persona de origen fue modificada por otro usuario. Actualizá la pantalla y revisá la fusión.', {
            statusCode: 409, code: 'VERSION_CONFLICT', details: { expectedVersion: params.sourceVersion, currentVersion: source.version }
        });
    }

    const [sourceOwners, sourceTenants, targetOwners, targetTenants] = await Promise.all([
        tx.contratoPropietario.findMany({ where: { personaId: source.id }, select: { contratoId: true } }),
        tx.contratoInquilino.findMany({ where: { personaId: source.id }, select: { contratoId: true } }),
        tx.contratoPropietario.findMany({ where: { personaId: target.id }, select: { contratoId: true } }),
        tx.contratoInquilino.findMany({ where: { personaId: target.id }, select: { contratoId: true } })
    ]);
    const sourceOwnerIds = new Set(sourceOwners.map(item => item.contratoId));
    const sourceTenantIds = new Set(sourceTenants.map(item => item.contratoId));
    const roleConflicts = [
        ...targetTenants.filter(item => sourceOwnerIds.has(item.contratoId)).map(item => item.contratoId),
        ...targetOwners.filter(item => sourceTenantIds.has(item.contratoId)).map(item => item.contratoId)
    ];
    if (roleConflicts.length) throw conflict([...new Set(roleConflicts)]);

    const targetHasBankDestination = Boolean(target.cbu || target.aliasBancario);
    const merged = {
        dni: target.dni || source.dni,
        cuit: target.cuit || source.cuit,
        email: target.email || source.email,
        telefono: target.telefono || source.telefono,
        direccion: target.direccion || source.direccion,
        banco: target.banco || source.banco,
        cbu: target.cbu || source.cbu,
        aliasBancario: target.aliasBancario || source.aliasBancario,
        titularCuentaBancaria: target.titularCuentaBancaria || source.titularCuentaBancaria,
        // The verification travels only with the account whose details were retained.
        titularidadBancariaVerificada: targetHasBankDestination
            ? target.titularidadBancariaVerificada
            : source.titularidadBancariaVerificada,
        contactoAlternativo: target.contactoAlternativo || source.contactoAlternativo,
        telefonoAlternativo: target.telefonoAlternativo || source.telefonoAlternativo
    };
    const collisions = (await findPersonIdentityMatches(tx, params.inmobiliariaId, merged))
        .filter(person => person.id !== source.id && person.id !== target.id);
    if (collisions.length) {
        throw new AppError('La fusión incorporaría un identificador que ya pertenece a otra persona', {
            statusCode: 409, code: 'PERSON_MERGE_IDENTITY_CONFLICT', details: { coincidencias: collisions }
        });
    }

    const propietarios = await moveOwners(tx, source.id, target.id);
    const inquilinos = await moveTenants(tx, source.id, target.id);
    const garantes = await tx.contrato.updateMany({ where: { garanteId: source.id }, data: { garanteId: target.id } });
    const liquidaciones = await tx.liquidacion.updateMany({ where: { propietarioPagoId: source.id }, data: { propietarioPagoId: target.id } });

    // Free unique identifiers before assigning the retained values to the destination.
    await tx.persona.update({
        where: { id: source.id },
        data: { dni: null, cuit: null, email: null, telefono: null, cuitNormalizado: null, emailNormalizado: null, telefonoNormalizado: null }
    });
    const identity = getPersonIdentity(merged);
    await tx.persona.update({
        where: { id: target.id },
        data: {
            ...merged,
            cuitNormalizado: identity.cuitNormalizado || null,
            emailNormalizado: identity.emailNormalizado || null,
            telefonoNormalizado: identity.telefonoNormalizado || null,
            actualizadoPorId: params.userId,
            version: { increment: 1 }
        }
    });
    await tx.persona.delete({ where: { id: source.id } });

    return {
        destinoId: target.id,
        origen: { id: source.id, nombreCompleto: source.nombreCompleto },
        destino: { id: target.id, nombreCompleto: target.nombreCompleto },
        relaciones: { propietarios, inquilinos, garantes: garantes.count, liquidaciones: liquidaciones.count }
    } satisfies MergeResult;
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
