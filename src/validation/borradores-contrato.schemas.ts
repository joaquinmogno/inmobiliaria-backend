import { z } from 'zod';
import { optimisticVersionSchema } from '../utils/optimistic-lock';

const text = (max: number) => z.string().max(max);
const optionalId = z.number().int().positive().optional();

const partySchema = z.object({
    id: optionalId,
    nombreCompleto: text(140),
    telefono: text(40)
}).strict();

const propertySchema = z.object({
    id: z.number().int().positive(),
    direccion: text(180),
    piso: z.string().max(30).nullable(),
    departamento: z.string().max(30).nullable()
}).strict();

const formSchema = z.object({
    address: text(180),
    floor: text(30),
    unit: text(30),
    startDate: text(10),
    endDate: text(10),
    updateDate: text(10),
    montoAlquiler: text(30),
    moneda: z.enum(['ARS', 'USD']),
    montoHonorarios: text(30),
    porcentajeHonorarios: text(10),
    porcentajeActualizacion: text(10),
    pagaHonorarios: z.enum(['INQUILINO', 'PROPIETARIO']),
    diaVencimiento: text(2),
    tipoAjuste: text(80),
    observacionDocumento: text(1000),
    observations: text(2000),
    tipoArchivosAdicionales: z.enum(['ADENDA', 'ADJUNTO']),
    administrado: z.boolean(),
    requiereActualizacion: z.boolean(),
    frecuenciaActualizacion: text(3),
    honorarioInicial: text(30),
    monedaHonorarioInicial: z.enum(['ARS', 'USD']),
    honorarioInicialMetodoPago: z.enum(['', 'EFECTIVO', 'TRANSFERENCIA', 'CHEQUE']),
    honorarioInicialCuentaBancariaId: text(20)
}).strict();

// Unlike a contract, a draft deliberately accepts incomplete operational data.
export const contractDraftDataSchema = z.object({
    form: formSchema,
    selectedProperty: propertySchema.nullable(),
    owners: z.array(partySchema).max(20),
    tenants: z.array(partySchema).max(20)
}).strict();

export const contractDraftWriteSchema = z.object({
    datos: contractDraftDataSchema
}).strict();

export const contractDraftUpdateSchema = contractDraftWriteSchema.extend({
    version: optimisticVersionSchema
}).strict();

export const contractDraftAttachmentSchema = z.object({
    tipo: z.enum(['CONTRATO_PRINCIPAL', 'ADENDA', 'ADJUNTO']).default('ADJUNTO')
});

export type ContractDraftData = z.infer<typeof contractDraftDataSchema>;
