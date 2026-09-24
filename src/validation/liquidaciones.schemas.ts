import { z } from 'zod';
import {
    dateOnlyString,
    nonNegativeDecimal,
    optionalDateOnlyString,
    optionalText,
    paymentMethodSchema,
    positiveDecimal,
    requiredText
} from '../middlewares/validation.middleware';

export const liquidacionCreateSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    periodo: dateOnlyString('El período').refine(value => value.endsWith('-01'), {
        message: 'El período debe comenzar el día 01'
    }),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional(),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    cuotasIds: z.array(z.coerce.number().int().positive()).optional()
});

export const movimientoSchema = z.object({
    tipo: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    concepto: requiredText('El concepto', 255),
    monto: positiveDecimal('El monto'),
    observaciones: optionalText(1000),
    expectedVersion: z.coerce.number().int().positive().optional()
});

export const honorariosSchema = z.object({
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional(),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    expectedVersion: z.coerce.number().int().positive().optional()
}).refine(data => data.montoHonorarios !== undefined || data.porcentajeHonorarios !== undefined, {
    message: 'Debe indicar monto o porcentaje de honorarios'
});

export const pagoPropietarioSchema = z.object({
    monto: positiveDecimal('El monto a pagar'),
    fechaPago: optionalDateOnlyString('La fecha de pago'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    propietarioId: z.coerce.number().int().positive('Propietario inválido'),
    comprobante: optionalText(120),
    observaciones: optionalText(1000),
    motivoAdelanto: optionalText(1000),
    expectedVersion: z.coerce.number().int().positive().optional()
});

export const ajusteLiquidacionSchema = z.object({
    tipo: z.enum(['CREDITO', 'DEBITO']),
    concepto: requiredText('El concepto', 255),
    motivo: requiredText('El motivo', 1000).refine(value => value.length >= 5, { message: 'El motivo debe tener al menos 5 caracteres' }),
    monto: positiveDecimal('El monto'),
    // Los impactos se expresan con signo: negativo reduce el saldo de esa parte.
    impactoInquilino: z.coerce.number().finite().refine(value => Number.isFinite(value), 'Impacto de inquilino inválido'),
    impactoPropietario: z.coerce.number().finite().refine(value => Number.isFinite(value), 'Impacto de propietario inválido'),
    destinoCredito: z.enum(['DEVOLUCION', 'SALDO_A_FAVOR', 'COMPENSACION']).optional(),
    liquidacionDestinoId: z.coerce.number().int().positive('Liquidación destino inválida').optional(),
    fechaDevolucion: optionalDateOnlyString('La fecha de devolución'),
    metodoDevolucion: paymentMethodSchema.optional().default('EFECTIVO'),
    observacionesDevolucion: optionalText(1000)
}).refine(data => data.impactoInquilino !== 0 || data.impactoPropietario !== 0, {
    message: 'El ajuste debe afectar al inquilino o al propietario'
}).superRefine((data, ctx) => {
    if (data.destinoCredito === 'COMPENSACION' && !data.liquidacionDestinoId) {
        ctx.addIssue({ code: 'custom', path: ['liquidacionDestinoId'], message: 'Elegí la liquidación a compensar' });
    }
    if (data.destinoCredito !== 'COMPENSACION' && data.liquidacionDestinoId) {
        ctx.addIssue({ code: 'custom', path: ['liquidacionDestinoId'], message: 'Sólo indicá una liquidación destino al compensar un crédito' });
    }
});

export const aplicarCreditoInquilinoSchema = z.object({
    liquidacionDestinoId: z.coerce.number().int().positive('Liquidación destino inválida'),
    monto: positiveDecimal('El monto a aplicar')
});

export const anulacionPagoPropietarioSchema = z.object({
    motivo: requiredText('El motivo', 1000).refine(value => value.trim().length >= 5, {
        message: 'El motivo debe tener al menos 5 caracteres'
    })
});

export const generarPeriodoSchema = z.object({
    periodo: dateOnlyString('El período').refine(value => value.endsWith('-01'), {
        message: 'El período debe comenzar el día 01'
    }),
    contratoIds: z.array(z.coerce.number().int().positive()).max(200).optional(),
    selecciones: z.array(z.object({
        contratoId: z.coerce.number().int().positive(),
        contratoVersion: z.coerce.number().int().positive().optional(),
        cuotasVencidasIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
        cuotasVencidasRevisadas: z.boolean().optional()
    })).max(200).optional()
});

export const confirmacionLiquidacionSchema = z.object({
    expectedVersion: z.coerce.number().int().positive().optional()
});

export const decisionLiquidacionMensualSchema = z.object({
    contratoId: z.coerce.number().int().positive('Contrato inválido'),
    periodo: dateOnlyString('El período').refine(value => value.endsWith('-01'), {
        message: 'El período debe comenzar el día 01'
    }),
    motivo: requiredText('El motivo', 500).refine(value => value.length >= 5, {
        message: 'El motivo debe tener al menos 5 caracteres'
    })
});

export const reabrirDecisionLiquidacionMensualSchema = decisionLiquidacionMensualSchema.pick({
    contratoId: true,
    periodo: true
});
