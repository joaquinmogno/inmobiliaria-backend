import { Prisma } from '@prisma/client';

export const PERSON_DUPLICATE_DNI_CODE = 'PERSON_DUPLICATE_DNI';
export const PERSON_DUPLICATE_DNI_MESSAGE = 'Ya existe una persona con ese DNI';

/**
 * Persiste el documento en un formato comparable, independientemente de que el
 * usuario lo escriba con puntos, guiones, espacios o distinta capitalización.
 */
export const normalizePersonDni = (value: string) =>
    value.normalize('NFKC').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export const isPersonDniUniqueConflict = (error: unknown) => {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        return false;
    }

    const target = error.meta?.target;
    if (Array.isArray(target)) return target.includes('dni');
    return typeof target === 'string' && target.includes('dni');
};
