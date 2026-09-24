import { z } from 'zod';
import {
    optionalCuit,
    optionalDateOnlyString,
    optionalEmail,
    optionalPhone,
    optionalText,
    requiredText
} from '../middlewares/validation.middleware';

const optionalLogoUrl = () => z.preprocess(
    value => (value === '' || value === null) ? undefined : value,
    z.string().trim().max(2048, 'La URL del logo es demasiado extensa').url('La URL del logo no es válida')
        .refine(value => /^https?:\/\//i.test(value), 'La URL del logo debe usar http o https')
        .optional()
);

const optionalIngresosBrutos = () => z.preprocess(
    value => (value === '' || value === null) ? undefined : value,
    z.string().trim().toUpperCase().max(30, 'Máximo 30 caracteres')
        .regex(/^(EXENTO|[0-9]{5,20})$/, 'Ingresá el número de Ingresos Brutos o EXENTO')
        .optional()
);

export const agencyProfileFields = z.object({
    nombre: requiredText('El nombre comercial', 140),
    razonSocial: optionalText(160),
    cuit: optionalCuit(),
    direccion: optionalText(180),
    domicilioFiscal: optionalText(180),
    email: optionalEmail(),
    telefono: optionalPhone(),
    contactoAdministrativo: optionalText(140),
    slogan: optionalText(160),
    logoUrl: optionalLogoUrl(),
    condicionIva: z.enum(['NO_INFORMADO', 'RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'EXENTO', 'CONSUMIDOR_FINAL']).optional().default('NO_INFORMADO'),
    ingresosBrutos: optionalIngresosBrutos(),
    puntoVenta: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().min(1, 'El punto de venta debe ser mayor a cero').max(99999, 'El punto de venta no puede superar 99999').optional()),
    inicioActividades: optionalDateOnlyString('La fecha de inicio de actividades')
});

export const agencyProfileSchema = agencyProfileFields.superRefine((data, ctx) => {
    const hasFiscalData = Boolean(
        data.razonSocial || data.cuit || data.ingresosBrutos || data.puntoVenta || data.inicioActividades
        || data.condicionIva !== 'NO_INFORMADO'
    );
    if (!hasFiscalData) return;
    if (!data.razonSocial) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['razonSocial'], message: 'La razón social es obligatoria al informar datos fiscales' });
    }
    if (!data.cuit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cuit'], message: 'El CUIT es obligatorio al informar datos fiscales' });
    }
    if (data.condicionIva === 'NO_INFORMADO') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['condicionIva'], message: 'Indicá la condición frente al IVA al informar datos fiscales' });
    }
});

// The API supports a named profile update, while final legal consistency is
// checked after combining it with the stored profile.
export const agencyProfileUpdateSchema = agencyProfileFields.partial().extend({
    nombre: requiredText('El nombre comercial', 140)
}).strict();

export type AgencyProfileInput = z.infer<typeof agencyProfileSchema>;
