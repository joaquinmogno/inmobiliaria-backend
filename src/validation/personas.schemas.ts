import { z } from 'zod';
import {
    optionalBankAlias,
    optionalBooleanFromForm,
    optionalCbu,
    optionalCuit,
    optionalDni,
    optionalEmail,
    optionalPhone,
    optionalText,
    requiredText
} from '../middlewares/validation.middleware';
import { optimisticVersionSchema } from '../utils/optimistic-lock';

export const personaSchema = z.object({
    nombreCompleto: requiredText('El nombre completo', 140),
    dni: optionalDni(),
    email: optionalEmail(),
    telefono: optionalPhone(),
    direccion: optionalText(180),
    cuit: optionalCuit(),
    banco: optionalText(100),
    cbu: optionalCbu(),
    aliasBancario: optionalBankAlias(),
    titularCuentaBancaria: optionalText(140),
    titularidadBancariaVerificada: optionalBooleanFromForm.default(false),
    contactoAlternativo: optionalText(140),
    telefonoAlternativo: optionalPhone(),
    estado: z.enum(['ACTIVO', 'INACTIVO']).optional().default('ACTIVO')
}).superRefine((data, ctx) => {
    const hasBankDestination = Boolean(data.cbu || data.aliasBancario);
    if (hasBankDestination && !data.titularidadBancariaVerificada) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['titularidadBancariaVerificada'],
            message: 'Confirmá que verificaste la titularidad de la cuenta antes de guardar datos bancarios'
        });
    }
    if (!hasBankDestination && data.titularidadBancariaVerificada) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['titularidadBancariaVerificada'],
            message: 'No podés confirmar titularidad sin informar un CBU o alias'
        });
    }
});

export const personaUpdateSchema = personaSchema.extend({ version: optimisticVersionSchema });

type ExistingPhoneFields = {
    telefono: string | null;
    telefonoAlternativo: string | null;
};

/**
 * Existing records predate strict phone validation. A user must be able to
 * correct another field without having to alter an untouched legacy phone.
 * Any new or changed phone still goes through the regular validation.
 */
export const parsePersonaUpdate = (input: unknown, existing: ExistingPhoneFields) => {
    const strictResult = personaUpdateSchema.safeParse(input);
    if (strictResult.success || !input || typeof input !== 'object' || Array.isArray(input)) {
        return strictResult;
    }

    const compatibilityInput: Record<string, unknown> = { ...input };
    const unchangedLegacyPhones: Partial<ExistingPhoneFields> = {};

    for (const field of ['telefono', 'telefonoAlternativo'] as const) {
        const submitted = compatibilityInput[field];
        const stored = existing[field];
        if (typeof stored === 'string' && stored.length > 0 && submitted === stored) {
            compatibilityInput[field] = undefined;
            unchangedLegacyPhones[field] = stored;
        }
    }

    if (Object.keys(unchangedLegacyPhones).length === 0) return strictResult;

    const compatibilityResult = personaUpdateSchema.safeParse(compatibilityInput);
    if (!compatibilityResult.success) return strictResult;

    return {
        success: true as const,
        data: { ...compatibilityResult.data, ...unchangedLegacyPhones }
    };
};
