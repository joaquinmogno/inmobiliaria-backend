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

export const contractListStatusSchema = z.enum(['PROGRAMADO', 'ACTIVO', 'EN_CIERRE', 'FINALIZADO', 'RESCINDIDO', 'PAPELERA']);

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

const contractServiceExpenseSchema = z.object({
    concepto: z.string()
        .trim()
        .min(2, 'El concepto debe tener al menos 2 caracteres')
        .max(120, 'El concepto no puede superar los 120 caracteres')
        .transform(value => value.replace(/\s+/g, ' ')),
    responsable: z.enum(['INQUILINO', 'PROPIETARIO'])
});

const contractServiceExpensesSchema = parseJsonField(
    z.array(contractServiceExpenseSchema).max(30, 'Podés registrar hasta 30 servicios o gastos').optional()
).superRefine((items, ctx) => {
    if (!items) return;
    const seen = new Set<string>();
    items.forEach((item, index) => {
        const normalized = item.concepto
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleUpperCase('es-AR');
        if (seen.has(normalized)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'concepto'],
                message: 'No se puede repetir un servicio o gasto en el mismo contrato'
            });
        }
        seen.add(normalized);
    });
});

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
    frecuenciaActualizacionMeses: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().min(1).max(120).optional()),
    observaciones: optionalText(2000),
    serviciosGastos: contractServiceExpensesSchema,
    observacionDocumento: optionalText(1000),
    propiedadId: z.coerce.number().int().positive('Propiedad inválida').optional(),
    contratoAnteriorId: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().positive('Contrato anterior inválido').optional()),
    borradorId: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().positive('Borrador inválido').optional()),
    propiedad: parseJsonField(propertyCandidateSchema).optional(),
    propietarioIds: idListFromForm.optional(),
    inquilinoIds: idListFromForm.optional(),
    propietarios: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un propietario')).optional(),
    inquilinos: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un inquilino')).optional(),
    montoAlquiler: positiveDecimal('El monto de alquiler'),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional().default(0),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional().default(5)),
    pagaHonorarios: z.literal('PROPIETARIO').optional().default('PROPIETARIO'),
    diaVencimiento: z.coerce.number().int().min(1).max(31).optional().default(10),
    modalidadCobroInquilino: z.preprocess(value => value === '' ? null : value, paymentMethodSchema.nullable().optional()),
    modalidadPagoPropietario: z.preprocess(value => value === '' ? null : value, paymentMethodSchema.nullable().optional()),
    cuentaCobroAcordadaId: z.preprocess(value => value === '' ? null : value, z.coerce.number().int().positive('Cuenta de cobro inválida').nullable().optional()),
    porcentajeActualizacion: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de actualización').max(999).optional()),
    tipoAjuste: optionalText(80),
    administrado: optionalBooleanFromForm.default(true),
    requiereActualizacion: optionalBooleanFromForm.default(true),
    honorarioInicial: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El honorario inicial').optional()),
    // Se mantiene opcional para que las integraciones existentes conserven la
    // moneda del contrato cuando todavía no envían esta nueva selección.
    monedaHonorarioInicial: z.enum(['ARS', 'USD']).optional(),
    honorarioInicialMetodoPago: paymentMethodSchema.optional(),
    honorarioInicialCuentaBancariaId: z.preprocess(value => value === '' || value === null ? undefined : value, z.coerce.number().int().positive('Cuenta bancaria inválida').optional())
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
    if (value.honorarioInicial && Number(value.honorarioInicial) > 0 && value.honorarioInicialMetodoPago !== 'EFECTIVO' && !value.honorarioInicialCuentaBancariaId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['honorarioInicialCuentaBancariaId'], message: 'Seleccioná la cuenta bancaria donde ingresó el honorario inicial.' });
    }
    if (value.modalidadCobroInquilino === 'TRANSFERENCIA' && !value.cuentaCobroAcordadaId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cuentaCobroAcordadaId'], message: 'Seleccioná la cuenta acordada para cobrar las transferencias del inquilino.' });
    }
});

export const contractUpdateSchema = contractCreateSchemaBase
    .omit({ propiedadId: true, contratoAnteriorId: true, borradorId: true, propietarioIds: true, inquilinoIds: true, honorarioInicial: true, monedaHonorarioInicial: true, honorarioInicialMetodoPago: true, honorarioInicialCuentaBancariaId: true })
    .partial()
    .extend({
        administrado: optionalBooleanFromForm,
        requiereActualizacion: optionalBooleanFromForm,
        version: optimisticVersionSchema
    });

const rescissionMoney = (label: string) => nonNegativeDecimal(label)
    .max(99_999_999.99, `${label} supera el importe máximo`)
    .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, `${label} admite hasta dos decimales`);

const keyDeliveryFields = z.object({
    fechaEntregaLlaves: dateOnlyString('La fecha de entrega de llaves'),
    horaEntrega: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Indicá una hora válida').optional().nullable(),
    cantidadLlaves: z.number().int().min(1).max(100),
    receptorNombre: requiredText('La persona que recibe las llaves', 200),
    estadoInmueble: requiredText('El estado del inmueble', 2000),
    observaciones: optionalText(4000),
    inmuebleDesocupado: z.literal(true),
    vistaPreviaHash: z.string().length(64).optional(),
    version: optimisticVersionSchema
});

export const keyDeliverySchema = keyDeliveryFields;
export type KeyDeliveryInput = z.infer<typeof keyDeliverySchema>;

const rescissionFields = z.object({
    tipoCierre: z.enum(['ANTICIPADA_INQUILINO', 'VENCIMIENTO_ACORDADO']),
    sinReclamosConfirmado: z.literal(true),
    serviciosSaldadosConfirmados: z.literal(true),
    depositoResueltoConfirmado: z.literal(true),
    motivo: requiredText('El motivo de la rescisión', 1000).refine(value => value.trim().length >= 5, {
        message: 'El motivo de la rescisión debe tener al menos 5 caracteres'
    }),
    fechaRescision: dateOnlyString('La fecha de rescisión'),
    llavesEntregadas: z.boolean(),
    fechaEntregaLlaves: optionalDateOnlyString('La fecha de entrega de llaves'),
    cantidadLlaves: z.number().int().min(0).max(100),
    estadoInmueble: requiredText('El estado del inmueble', 2000),
    observaciones: optionalText(4000),
    motivoRevision: optionalText(1000),
    multaImporte: rescissionMoney('La multa'),
    multaResponsable: z.enum(['INQUILINO', 'PROPIETARIO']).nullable(),
    depositoADevolver: rescissionMoney('El depósito a devolver'),
    depositoRetenido: rescissionMoney('El depósito retenido'),
    motivoRetencion: optionalText(1000),
    pendientesManuales: z.array(z.object({
        concepto: requiredText('El concepto pendiente', 200),
        tipo: z.enum(['ALQUILER', 'SERVICIO', 'EXPENSA', 'OTRO']),
        responsable: z.enum(['INQUILINO', 'PROPIETARIO']),
        importe: rescissionMoney('El importe pendiente').refine(value => value > 0, 'El importe pendiente debe ser mayor a cero')
    })).max(30),
    vistaPreviaHash: z.string().length(64).optional(),
    version: optimisticVersionSchema
}).superRefine((data, ctx) => {
    if (data.pendientesManuales.length > 0) ctx.addIssue({ code: 'custom', path: ['pendientesManuales'], message: 'No puede emitirse un cierre sin reclamos con importes pendientes. Resolvelos antes de firmar.' });
    if (data.llavesEntregadas && !data.fechaEntregaLlaves) ctx.addIssue({ code: 'custom', path: ['fechaEntregaLlaves'], message: 'Indicá cuándo se entregaron las llaves' });
    if (data.llavesEntregadas && data.cantidadLlaves < 1) ctx.addIssue({ code: 'custom', path: ['cantidadLlaves'], message: 'Indicá cuántas llaves se entregaron' });
    if (!data.llavesEntregadas && data.fechaEntregaLlaves) ctx.addIssue({ code: 'custom', path: ['fechaEntregaLlaves'], message: 'No puede haber fecha de entrega si las llaves siguen pendientes' });
    if (data.depositoRetenido > 0 && !data.motivoRetencion) ctx.addIssue({ code: 'custom', path: ['motivoRetencion'], message: 'Explicá la retención del depósito' });
    if (data.multaImporte > 0 && !data.multaResponsable) ctx.addIssue({ code: 'custom', path: ['multaResponsable'], message: 'Indicá quién debe pagar la multa' });
});

export const contractRescissionSchema = rescissionFields;
export const contractRescissionRevisionSchema = rescissionFields.safeExtend({ motivoRevision: requiredText('El motivo de la nueva versión', 1000) });
export type ContractRescissionInput = z.infer<typeof contractRescissionSchema>;

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
    payload: Pick<ContractCreateInput, 'requiereActualizacion' | 'fechaActualizacion' | 'frecuenciaActualizacionMeses' | 'porcentajeActualizacion' | 'tipoAjuste'>
) => payload.requiereActualizacion ? {
    requiereActualizacion: true,
    fechaProximaActualizacion: payload.fechaActualizacion ? parseDateOnly(payload.fechaActualizacion) : null,
    frecuenciaActualizacionMeses: payload.frecuenciaActualizacionMeses ?? null,
    porcentajeActualizacion: payload.porcentajeActualizacion ? new Decimal(payload.porcentajeActualizacion) : null,
    tipoAjuste: payload.tipoAjuste || null
} : {
    requiereActualizacion: false,
    fechaProximaActualizacion: null,
    frecuenciaActualizacionMeses: null,
    porcentajeActualizacion: null,
    tipoAjuste: null
};
