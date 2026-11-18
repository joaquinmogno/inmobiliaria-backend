import { isCreditCardMethod, optionalCardId } from '../services/credit-card.service';
import { z } from 'zod';
import { dateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { argentinaDateOnly } from '../utils/argentina-date';

const movimientoInternoBaseSchema = z.object({
    fecha: dateOnlyString('La fecha'),
    tipo: z.enum(['INGRESO', 'GASTO']).default('GASTO'),
    detalle: z.string().trim().min(1, 'Ingresá el detalle').max(255),
    monto: z.union([z.number(), z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Ingresá un importe con hasta dos decimales')])
        .transform(Number).pipe(z.number().positive('El importe debe ser mayor a cero').max(999999999999.99).finite())
        .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.01, 'El importe admite hasta dos decimales'),
    moneda: z.enum(['ARS', 'USD']).default('ARS'),
    categoria: optionalText(80),
    metodoPago: optionalText(80),
    tarjetaId: optionalCardId,
    cuentaPago: z.string().trim().max(220, 'La cuenta admite hasta 220 caracteres').nullable().optional()
        .transform(value => value === undefined ? undefined : value || null),
    observaciones: optionalText(2000)
});

const requireTransferAccount = (data: z.output<typeof movimientoInternoBaseSchema>, context: z.RefinementCtx) => {
    if (isCreditCardMethod(data.metodoPago) && data.tipo !== 'GASTO') context.addIssue({ code: 'custom', path: ['metodoPago'], message: 'Las tarjetas propias sólo se utilizan para gastos.' });
    const method = data.metodoPago?.trim().replace(/[_\s]+/g, ' ').toLowerCase();
    if ((method === 'transferencia' || method === 'transferencia bancaria') && !data.cuentaPago?.trim()) {
        context.addIssue({
            code: 'custom', path: ['cuentaPago'],
            message: data.tipo === 'GASTO' ? 'Indicá el banco o la cuenta de origen de la transferencia.' : 'Indicá el banco o la cuenta de destino de la transferencia.'
        });
    }
};

export const movimientoInternoSchema = movimientoInternoBaseSchema.superRefine(requireTransferAccount);
export const editarMovimientoInternoSchema = movimientoInternoBaseSchema.extend({ version: z.coerce.number().int().positive() }).superRefine(requireTransferAccount);
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
    tarjetaId: z.coerce.number().int().positive().optional(),
    creadoPorId: z.coerce.number().int().positive().optional(),
    estado: z.enum(['VIGENTES', 'ANULADOS', 'TODOS']).default('VIGENTES')
});

export type FiltroControlInterno = z.infer<typeof filtroControlInternoSchema>;
