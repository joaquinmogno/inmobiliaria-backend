import { Decimal } from '@prisma/client/runtime/library';
import { z } from 'zod';
import {
    dateOnlyString,
    nonNegativeDecimal,
    optionalBooleanFromForm,
    optionalCuit,
    optionalDateOnlyString,
    optionalDni,
    optionalEmail,
    optionalPhone,
    optionalText,
    paymentMethodSchema,
    positiveDecimal,
    requiredText
} from '../middlewares/validation.middleware';
import { parseDateOnly } from '../utils/argentina-date';
import { optimisticVersionSchema } from '../utils/optimistic-lock';

export const contractListStatusSchema = z.enum(['PROGRAMADO', 'ACTIVO', 'FINALIZADO', 'RESCINDIDO', 'PAPELERA']);

const parseJsonField = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}, schema);

const idListFromForm = z.preprocess(value => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return value;
}, z.array(z.coerce.number().int().positive()).min(1, 'Debe seleccionar al menos una persona'));

export const personCandidateSchema = z.object({
    id: z.coerce.number().int().positive().optional(),
    nombreCompleto: optionalText(140),
    dni: optionalDni(),
    cuit: optionalCuit(),
    email: optionalEmail(),
    telefono: optionalPhone(),
    direccion: optionalText(180),
    estado: z.enum(['ACTIVO', 'INACTIVO']).optional().default('ACTIVO')
}).superRefine((value, ctx) => {
    if (!value.id && !value.nombreCompleto) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nombreCompleto'],
            message: 'El nombre completo es obligatorio para una persona nueva'
        });
    }
});

export const propertyCandidateSchema = z.object({
    direccion: requiredText('La dirección', 180),
    piso: optionalText(30),
    departamento: optionalText(30),
    tipo: z.enum(['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO']).optional().default('DEPARTAMENTO'),
    estado: z.enum(['DISPONIBLE', 'ALQUILADO', 'INACTIVO']).optional().default('DISPONIBLE'),
    observaciones: optionalText(1000)
});

const contractCreateSchemaBase = z.object({
    fechaInicio: dateOnlyString('La fecha de inicio'),
    fechaFin: dateOnlyString('La fecha de fin'),
    fechaActualizacion: optionalDateOnlyString('La fecha de actualización'),
    observaciones: optionalText(2000),
    observacionDocumento: optionalText(1000),
    propiedadId: z.coerce.number().int().positive('Propiedad inválida').optional(),
    contratoAnteriorId: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().positive('Contrato anterior inválido').optional()),
    propiedad: parseJsonField(propertyCandidateSchema).optional(),
    propietarioIds: idListFromForm.optional(),
    inquilinoIds: idListFromForm.optional(),
    propietarios: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un propietario')).optional(),
    inquilinos: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un inquilino')).optional(),
    montoAlquiler: positiveDecimal('El monto de alquiler'),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional().default(0),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    pagaHonorarios: z.enum(['INQUILINO', 'PROPIETARIO']).optional().default('INQUILINO'),
    diaVencimiento: z.coerce.number().int().min(1).max(31).optional().default(10),
    porcentajeActualizacion: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de actualización').max(999).optional()),
    tipoAjuste: optionalText(80),
    administrado: optionalBooleanFromForm.default(true),
    requiereActualizacion: optionalBooleanFromForm.default(true),
    honorarioInicial: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El honorario inicial').optional()),
    honorarioInicialMetodoPago: paymentMethodSchema.optional()
});

export const contractCreateSchema = contractCreateSchemaBase.superRefine((value, ctx) => {
    if (!value.propiedadId && !value.propiedad) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['propiedad'], message: 'Debe seleccionar una propiedad existente o cargar una nueva' });
    }
    if (!value.propietarioIds && !value.propietarios) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['propietarios'], message: 'Debe indicar al menos un propietario' });
    }
    if (!value.inquilinoIds && !value.inquilinos) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inquilinos'], message: 'Debe indicar al menos un inquilino' });
    }
    const idsFor = (candidates?: Array<{ id?: number }>, legacyIds?: number[]) =>
        candidates ? candidates.flatMap(candidate => candidate.id ? [candidate.id] : []) : legacyIds || [];
    const ownerIds = idsFor(value.propietarios, value.propietarioIds);
    const tenantIds = idsFor(value.inquilinos, value.inquilinoIds);
    const duplicateOwner = ownerIds.find((id, index) => ownerIds.indexOf(id) !== index);
    const duplicateTenant = tenantIds.find((id, index) => tenantIds.indexOf(id) !== index);
    if (duplicateOwner) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['propietarios'], message: 'No se puede repetir una persona entre los propietarios del mismo contrato' });
    }
    if (duplicateTenant) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inquilinos'], message: 'No se puede repetir una persona entre los inquilinos del mismo contrato' });
    }
    if (ownerIds.some(id => tenantIds.includes(id))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inquilinos'], message: 'Una persona no puede ser a la vez propietario e inquilino del mismo contrato' });
    }
    if (parseDateOnly(value.fechaInicio) > parseDateOnly(value.fechaFin)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fechaFin'], message: 'La fecha de fin debe ser posterior o igual a la fecha de inicio' });
    }
    if (value.fechaActualizacion && parseDateOnly(value.fechaActualizacion) < parseDateOnly(value.fechaInicio)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fechaActualizacion'], message: 'La próxima actualización no puede ser anterior al inicio del contrato' });
    }
    if (value.requiereActualizacion && !value.fechaActualizacion) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fechaActualizacion'], message: 'La próxima actualización es obligatoria si el contrato tiene actualización programada' });
    }
});

export const contractUpdateSchema = contractCreateSchemaBase
    .omit({ propiedadId: true, contratoAnteriorId: true, propietarioIds: true, inquilinoIds: true, honorarioInicial: true, honorarioInicialMetodoPago: true })
    .partial()
    .extend({
        administrado: optionalBooleanFromForm,
        requiereActualizacion: optionalBooleanFromForm,
        version: optimisticVersionSchema
    });

export const contractRescissionSchema = z.object({
    motivo: requiredText('El motivo de la rescisión', 1000).refine(value => value.trim().length >= 5, {
        message: 'El motivo de la rescisión debe tener al menos 5 caracteres'
    }),
    fechaRescision: optionalDateOnlyString('La fecha de rescisión'),
    version: optimisticVersionSchema
});

export const contractRentUpdateSchema = z.object({
    montoNuevo: positiveDecimal('El monto nuevo'),
    fechaProximaNueva: dateOnlyString('La próxima fecha'),
    observaciones: optionalText(1000),
    version: optimisticVersionSchema
});

export const contractAttachmentSchema = z.object({
    nombreArchivo: optionalText(255),
    tipo: z.enum(['ADENDA', 'ADJUNTO']).optional().default('ADJUNTO'),
    fechaDocumento: optionalDateOnlyString('La fecha del documento'),
    observacion: optionalText(1000)
});

export type PersonCandidate = z.infer<typeof personCandidateSchema>;
export type PropertyCandidate = z.infer<typeof propertyCandidateSchema>;
export type ContractCreateInput = z.infer<typeof contractCreateSchema>;

export const normalizeContractUpdateSettings = (
    payload: Pick<ContractCreateInput, 'requiereActualizacion' | 'fechaActualizacion' | 'porcentajeActualizacion' | 'tipoAjuste'>
) => payload.requiereActualizacion ? {
    requiereActualizacion: true,
    fechaProximaActualizacion: payload.fechaActualizacion ? parseDateOnly(payload.fechaActualizacion) : null,
    porcentajeActualizacion: payload.porcentajeActualizacion ? new Decimal(payload.porcentajeActualizacion) : null,
    tipoAjuste: payload.tipoAjuste || null
} : {
    requiereActualizacion: false,
    fechaProximaActualizacion: null,
    porcentajeActualizacion: null,
    tipoAjuste: null
};
