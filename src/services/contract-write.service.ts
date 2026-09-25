import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import {
    isPersonDniUniqueConflict,
    PERSON_DUPLICATE_DNI_CODE,
    PERSON_DUPLICATE_DNI_MESSAGE
} from '../utils/person-dni';
import {
    assertPersonIdentityAvailable,
    getPersonIdentity,
    isPersonIdentityUniqueConflict,
    PERSON_IDENTITY_DUPLICATE_CODE,
    PERSON_IDENTITY_DUPLICATE_MESSAGE
} from '../utils/person-identity';
import type { ContractCreateInput, PersonCandidate, PropertyCandidate } from '../validation/contratos.schemas';

type TxClient = Prisma.TransactionClient;

export const ensureExistingProperty = async (tx: TxClient, inmobiliariaId: number, propiedadId: number) => {
    const propiedad = await tx.propiedad.findFirst({ where: { id: propiedadId, inmobiliariaId } });
    if (!propiedad) {
        throw new AppError('La propiedad seleccionada no existe o no pertenece a la inmobiliaria', {
            statusCode: 400,
            code: 'INVALID_PROPERTY_REFERENCE'
        });
    }
    if (propiedad.estado === 'INACTIVO') {
        throw new AppError('No se puede crear un contrato sobre una propiedad inactiva', {
            statusCode: 409,
            code: 'PROPERTY_INACTIVE'
        });
    }
    return propiedad;
};

export const assertPropertyAvailableForPeriod = async (
    tx: TxClient,
    propiedadId: number,
    fechaInicio: Date,
    fechaFin: Date,
    excludeContractId?: number
) => {
    const overlapping = await tx.contrato.findFirst({
        where: {
            propiedadId,
            estado: { in: ['PROGRAMADO', 'ACTIVO'] },
            ...(excludeContractId ? { id: { not: excludeContractId } } : {}),
            fechaInicio: { lte: fechaFin },
            fechaFin: { gte: fechaInicio }
        },
        select: { id: true }
    });
    if (overlapping) {
        throw new AppError('La propiedad ya tiene un contrato activo para el período seleccionado', {
            statusCode: 409,
            code: 'PROPERTY_ALREADY_RENTED',
            details: { conflictingContractId: overlapping.id }
        });
    }
};

const ensureExistingPeople = async (
    tx: TxClient,
    inmobiliariaId: number,
    ids: number[],
    roleLabel: 'propietario' | 'inquilino'
) => {
    const people = await tx.persona.findMany({ where: { id: { in: ids }, inmobiliariaId } });
    if (people.length !== ids.length) {
        throw new AppError(`Uno o más ${roleLabel}s seleccionados no existen o no pertenecen a la inmobiliaria`, {
            statusCode: 400,
            code: 'INVALID_PERSON_REFERENCE'
        });
    }
    const peopleById = new Map(people.map(person => [person.id, person.id]));
    return ids.map(id => peopleById.get(id)!);
};

export const createPropertyIfNeeded = async (
    tx: TxClient,
    payload: ContractCreateInput,
    inmobiliariaId: number,
    userId: number
) => {
    if (payload.propiedadId) return ensureExistingProperty(tx, inmobiliariaId, payload.propiedadId);

    const propertyInput = payload.propiedad as PropertyCandidate | undefined;
    if (!propertyInput) {
        throw new AppError('Faltan los datos de la propiedad', {
            statusCode: 400,
            code: 'MISSING_PROPERTY_DATA'
        });
    }
    return tx.propiedad.create({ data: { ...propertyInput, inmobiliariaId, creadoPorId: userId } });
};

export const createPeopleIfNeeded = async (
    tx: TxClient,
    candidates: PersonCandidate[] | undefined,
    legacyIds: number[] | undefined,
    inmobiliariaId: number,
    userId: number,
    roleLabel: 'propietario' | 'inquilino'
) => {
    if (candidates && candidates.length > 0) {
        const resolvedIds: number[] = [];
        for (const candidate of candidates) {
            if (candidate.id) {
                const existing = await tx.persona.findFirst({ where: { id: candidate.id, inmobiliariaId } });
                if (!existing) {
                    throw new AppError(`El ${roleLabel} seleccionado no existe o no pertenece a la inmobiliaria`, {
                        statusCode: 400,
                        code: 'INVALID_PERSON_REFERENCE'
                    });
                }
                resolvedIds.push(existing.id);
                continue;
            }

            await assertPersonIdentityAvailable(tx, inmobiliariaId, candidate);
            const identity = getPersonIdentity(candidate);

            const created = await tx.persona.create({
                data: {
                    nombreCompleto: candidate.nombreCompleto!,
                    dni: candidate.dni,
                    cuit: candidate.cuit,
                    email: candidate.email,
                    telefono: candidate.telefono,
                    cuitNormalizado: identity.cuitNormalizado || null,
                    emailNormalizado: identity.emailNormalizado || null,
                    telefonoNormalizado: identity.telefonoNormalizado || null,
                    direccion: candidate.direccion,
                    estado: candidate.estado || 'ACTIVO',
                    inmobiliariaId,
                    creadoPorId: userId
                }
            });
            resolvedIds.push(created.id);
        }
        return resolvedIds;
    }

    if (!legacyIds || legacyIds.length === 0) {
        throw new AppError(`Debe indicar al menos un ${roleLabel}`, {
            statusCode: 400,
            code: 'MISSING_CONTRACT_PARTY'
        });
    }
    return ensureExistingPeople(tx, inmobiliariaId, legacyIds, roleLabel);
};

export const assertUniqueContractParties = (propietariosIds: number[], inquilinosIds: number[]) => {
    const repeatedOwner = propietariosIds.find((id, index) => propietariosIds.indexOf(id) !== index);
    if (repeatedOwner) {
        throw new AppError('No se puede repetir una persona entre los propietarios del mismo contrato', {
            statusCode: 409, code: 'DUPLICATE_CONTRACT_PARTY', details: { personaId: repeatedOwner, rol: 'PROPIETARIO' }
        });
    }
    const repeatedTenant = inquilinosIds.find((id, index) => inquilinosIds.indexOf(id) !== index);
    if (repeatedTenant) {
        throw new AppError('No se puede repetir una persona entre los inquilinos del mismo contrato', {
            statusCode: 409, code: 'DUPLICATE_CONTRACT_PARTY', details: { personaId: repeatedTenant, rol: 'INQUILINO' }
        });
    }
    const bothRoles = propietariosIds.filter(id => inquilinosIds.includes(id));
    if (bothRoles.length) {
        throw new AppError('Una persona no puede ser a la vez propietario e inquilino del mismo contrato', {
            statusCode: 409, code: 'CONTRACT_PARTY_ROLE_CONFLICT', details: { personaIds: bothRoles }
        });
    }
};

export const buildContractCreateError = (error: unknown, requestId?: string) => {
    if (error instanceof AppError) return error;
    if (isPersonDniUniqueConflict(error)) {
        return new AppError(PERSON_DUPLICATE_DNI_MESSAGE, {
            statusCode: 409,
            code: PERSON_DUPLICATE_DNI_CODE
        });
    }
    if (isPersonIdentityUniqueConflict(error)) {
        return new AppError(PERSON_IDENTITY_DUPLICATE_MESSAGE, {
            statusCode: 409,
            code: PERSON_IDENTITY_DUPLICATE_CODE
        });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return new AppError('No se pudo guardar el contrato por un conflicto de datos en la base', {
            statusCode: 409,
            code: 'DATABASE_CONFLICT',
            details: { prismaCode: error.code, target: error.meta?.target, requestId }
        });
    }
    if (error instanceof Prisma.PrismaClientValidationError) {
        return new AppError('Los datos del contrato son inválidos para persistir en la base', {
            statusCode: 400,
            code: 'DATABASE_VALIDATION_ERROR',
            details: { requestId }
        });
    }
    return new AppError('Ocurrió un error inesperado al crear el contrato', {
        statusCode: 500,
        code: 'CONTRACT_CREATE_FAILED',
        details: { requestId }
    });
};
