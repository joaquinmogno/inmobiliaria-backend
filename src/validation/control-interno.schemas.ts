import { z } from 'zod';
import { dateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { argentinaDateOnly } from '../utils/argentina-date';

export const movimientoInternoSchema = z.object({
    fecha: dateOnlyString('La fecha'),
    tipo: z.enum(['INGRESO', 'GASTO']).default('GASTO'),
    detalle: z.string().trim().min(1, 'Ingresá el detalle').max(255),
    monto: z.union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Ingresá un importe con hasta dos decimales')])
        .transform(Number).pipe(z.number().positive('El importe debe ser mayor a cero').max(999999999999.99).finite())
        .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.01, 'El importe admite hasta dos decimales'),
    moneda: z.enum(['ARS', 'USD']).default('ARS'),
    categoria: optionalText(80),
    metodoPago: optionalText(80),
    observaciones: optionalText(2000)
});

export const editarMovimientoInternoSchema = movimientoInternoSchema.extend({ version: z.coerce.number().int().positive() });
export const anularMovimientoInternoSchema = z.object({
    version: z.coerce.number().int().positive(),
    motivo: z.string().trim().min(5, 'Explicá el motivo de anulación').max(1000)
});
export const adjuntarMovimientoInternoSchema = z.object({ version: z.coerce.number().int().positive() });

export const filtroControlInternoSchema = z.object({
    periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Seleccioná un mes válido')
        .refine(value => Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 2100, 'El año debe estar entre 1900 y 2100')
        .default(() => argentinaDateOnly().slice(0, 7)),
    tipo: z.enum(['INGRESO', 'GASTO']).optional(),
    moneda: z.enum(['ARS', 'USD']).optional(),
    categoria: z.string().trim().max(80).optional(),
    metodoPago: z.string().trim().max(80).optional(),
    search: z.string().trim().max(255).optional(),
    creadoPorId: z.coerce.number().int().positive().optional(),
    estado: z.enum(['VIGENTES', 'ANULADOS', 'TODOS']).default('VIGENTES')
});

export type FiltroControlInterno = z.infer<typeof filtroControlInternoSchema>;
