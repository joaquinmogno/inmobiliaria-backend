import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { normalizePersonDni } from './person-dni';

export const PERSON_IDENTITY_DUPLICATE_CODE = 'PERSON_IDENTITY_DUPLICATE';
export const PERSON_IDENTITY_DUPLICATE_MESSAGE = 'Ya existe una persona con alguno de los datos de identificación ingresados';

export type PersonIdentityInput = {
    dni?: string | null;
    cuit?: string | null;
    email?: string | null;
    telefono?: string | null;
};

export type PersonIdentityField = 'dni' | 'cuit' | 'email' | 'telefono';

export type PersonIdentity = {
    dni?: string;
    cuitNormalizado?: string;
    emailNormalizado?: string;
    telefonoNormalizado?: string;
};

const text = (value?: string | null) => value?.normalize('NFKC').trim() || undefined;

export const normalizePersonCuit = (value: string) =>
    value.normalize('NFKC').replace(/[^0-9]/g, '');

export const normalizePersonEmail = (value: string) => value.normalize('NFKC').trim().toLowerCase();

/** The validation layer persists phones in E.164. Digits make old and new values comparable. */
export const normalizePersonPhone = (value: string) => value.normalize('NFKC').replace(/[^0-9]/g, '');

export const getPersonIdentity = (input: PersonIdentityInput): PersonIdentity => {
    const dni = text(input.dni);
    const cuit = text(input.cuit);
    const email = text(input.email);
    const telefono = text(input.telefono);
    return {
        ...(dni ? { dni: normalizePersonDni(dni) } : {}),
        ...(cuit ? { cuitNormalizado: normalizePersonCuit(cuit) } : {}),
        ...(email ? { emailNormalizado: normalizePersonEmail(email) } : {}),
        ...(telefono ? { telefonoNormalizado: normalizePersonPhone(telefono) } : {})
    };
};

const fieldLabels: Record<PersonIdentityField, string> = {
    dni: 'DNI', cuit: 'CUIT', email: 'correo electrónico', telefono: 'teléfono'
};

const identityClauses = (identity: PersonIdentity): Prisma.PersonaWhereInput[] => [
    ...(identity.dni ? [{ dni: identity.dni }] : []),
    ...(identity.cuitNormalizado ? [{ cuitNormalizado: identity.cuitNormalizado }] : []),
    ...(identity.emailNormalizado ? [{ emailNormalizado: identity.emailNormalizado }] : []),
    ...(identity.telefonoNormalizado ? [{ telefonoNormalizado: identity.telefonoNormalizado }] : [])
];

type IdentityClient = Pick<Prisma.TransactionClient, 'persona'>;

export const findPersonIdentityMatches = async (
    client: IdentityClient,
    inmobiliariaId: number,
    input: PersonIdentityInput,
    excludeId?: number
) => {
    const identity = getPersonIdentity(input);
    const clauses = identityClauses(identity);
    if (clauses.length === 0) return [];

    const people = await client.persona.findMany({
        where: {
            inmobiliariaId,
            ...(excludeId ? { id: { not: excludeId } } : {}),
            OR: clauses
        },
        select: {
            id: true, nombreCompleto: true, dni: true, cuit: true, email: true, telefono: true,
            estado: true, version: true
        },
        orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }]
    });

    return people.map(person => {
        const personIdentity = getPersonIdentity(person);
        const coincidencias = (Object.entries({
            dni: identity.dni && identity.dni === personIdentity.dni,
            cuit: identity.cuitNormalizado && identity.cuitNormalizado === personIdentity.cuitNormalizado,
            email: identity.emailNormalizado && identity.emailNormalizado === personIdentity.emailNormalizado,
            telefono: identity.telefonoNormalizado && identity.telefonoNormalizado === personIdentity.telefonoNormalizado
        }) as [PersonIdentityField, boolean][])
            .filter(([, matches]) => Boolean(matches))
            .map(([field]) => ({ field, label: fieldLabels[field] }));
        return { ...person, coincidencias };
    });
};

export const assertPersonIdentityAvailable = async (
    client: IdentityClient,
    inmobiliariaId: number,
    input: PersonIdentityInput,
    excludeId?: number
) => {
    const matches = await findPersonIdentityMatches(client, inmobiliariaId, input, excludeId);
    if (matches.length === 0) return;

    const fields = [...new Set(matches.flatMap(match => match.coincidencias.map(coincidencia => coincidencia.field)))];
    const onlyDni = fields.length === 1 && fields[0] === 'dni';
    throw new AppError(onlyDni ? 'Ya existe una persona con ese DNI' : PERSON_IDENTITY_DUPLICATE_MESSAGE, {
        statusCode: 409,
        code: onlyDni ? 'PERSON_DUPLICATE_DNI' : PERSON_IDENTITY_DUPLICATE_CODE,
        details: { coincidencias: matches }
    });
};

export const isPersonIdentityUniqueConflict = (error: unknown) => {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
    const target = error.meta?.target;
    const targetText = Array.isArray(target) ? target.join(',') : String(target || '');
    return /(?:dni|cuitNormalizado|emailNormalizado|telefonoNormalizado)/i.test(targetText);
};
