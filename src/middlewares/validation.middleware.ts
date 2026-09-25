import { Request, Response, NextFunction } from 'express';
import { z, ZodTypeAny } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { parseDateOnly } from '../utils/argentina-date';
import { normalizePersonDni } from '../utils/person-dni';
import { normalizePersonCuit } from '../utils/person-identity';
import { isValidBankAlias, isValidCbu, isValidCuit, normalizeBankAlias, normalizeCbu } from '../utils/bank-account';

export const validateBody = (schema: ZodTypeAny) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                message: 'Datos de entrada inválidos',
                errors: result.error.issues.map(issue => ({
                    field: issue.path.join('.'),
                    message: issue.message
                }))
            });
        }

        req.body = result.data;
        next();
    };
};

export const idParamSchema = z.coerce.number().int().positive('ID inválido');

export const paymentMethodSchema = z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE']);

export const optionalText = (max = 255) =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string().trim().max(max, `Máximo ${max} caracteres`).optional()
    );

export const optionalDni = () =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string()
            .trim()
            .max(30, 'Máximo 30 caracteres')
            .transform(normalizePersonDni)
            .refine(value => value.length > 0, 'El DNI/CUIT debe contener letras o números')
            .optional()
    );

export const optionalCuit = () =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string()
            .trim()
            .max(30, 'Máximo 30 caracteres')
            .transform(normalizePersonCuit)
            .refine(value => value.length === 11, 'El CUIT debe tener 11 dígitos')
            .refine(isValidCuit, 'El CUIT no supera la validación de dígito verificador')
            .optional()
    );

export const optionalCbu = () =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string()
            .trim()
            .max(40, 'Máximo 40 caracteres')
            .transform(normalizeCbu)
            .refine(value => value.length === 22, 'El CBU debe tener exactamente 22 dígitos')
            .refine(isValidCbu, 'El CBU no supera la validación de sus dígitos verificadores')
            .optional()
    );

export const optionalBankAlias = () =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string()
            .trim()
            .max(40, 'Máximo 40 caracteres')
            .transform(normalizeBankAlias)
            .refine(isValidBankAlias, 'El alias debe tener entre 6 y 20 caracteres alfanuméricos; puede incluir punto, guion o guion bajo')
            .optional()
    );

export const optionalEmail = () =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string().trim().toLowerCase().email('Email inválido').max(254).optional()
    );

export const optionalPhone = (defaultCountry: 'AR' = 'AR') =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        z.string().trim().max(40).transform((value, ctx) => {
            const phone = parsePhoneNumberFromString(value, defaultCountry);
            if (!phone?.isValid()) {
                ctx.addIssue({ code: 'custom', message: 'Teléfono inválido' });
                return z.NEVER;
            }
            return phone.number;
        }).optional()
    );

export const requiredText = (field: string, max = 255) =>
    z.string({ error: `${field} es obligatorio` })
        .trim()
        .min(1, `${field} es obligatorio`)
        .max(max, `Máximo ${max} caracteres`);

export const positiveDecimal = (field: string) =>
    z.coerce.number({ error: `${field} debe ser numérico` })
        .positive(`${field} debe ser mayor a cero`);

export const nonNegativeDecimal = (field: string) =>
    z.coerce.number({ error: `${field} debe ser numérico` })
        .min(0, `${field} no puede ser negativo`);

export const dateOnlyString = (field: string) =>
    z.string({ error: `${field} es obligatorio` })
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} debe tener formato YYYY-MM-DD`)
        .refine(value => {
            try {
                parseDateOnly(value);
                return true;
            } catch {
                return false;
            }
        }, `${field} no es una fecha válida`);

export const optionalDateOnlyString = (field: string) =>
    z.preprocess(
        value => (value === '' || value === null) ? undefined : value,
        dateOnlyString(field).optional()
    );

export const booleanFromForm = z.preprocess(value => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}, z.boolean());

export const optionalBooleanFromForm = z.preprocess(value => {
    if (value === '' || value === undefined || value === null) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}, z.boolean().optional());
