import { Request, Response, NextFunction } from 'express';
import { z, ZodTypeAny } from 'zod';

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

export const optionalText = (max = 255) =>
    z.preprocess(
        value => value === '' ? undefined : value,
        z.string().trim().max(max, `Máximo ${max} caracteres`).optional()
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
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} debe tener formato YYYY-MM-DD`);

export const optionalDateOnlyString = (field: string) =>
    z.preprocess(
        value => value === '' ? undefined : value,
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
