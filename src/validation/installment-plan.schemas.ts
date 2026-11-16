import { z } from 'zod';
import { Decimal } from '@prisma/client/runtime/library';
import { positiveMoney, dateOnlyString } from '../middlewares/validation.middleware';

// Creation, preview and rescheduling validate the same financial inputs.
export const installmentScheduleSchema = z.object({
    montoTotal: positiveMoney('El monto total'),
    cantidadCuotas: z.coerce.number().int().min(1, 'Debe tener al menos una cuota').max(120, 'Máximo 120 cuotas'),
    fechaPrimeraCuota: dateOnlyString('El período de la primera cuota').refine(value => value.endsWith('-01'), {
        message: 'El período de la primera cuota debe comenzar el día 01'
    })
}).superRefine((value, ctx) => {
    if (new Decimal(value.montoTotal).times(100).lessThan(value.cantidadCuotas)) {
        ctx.addIssue({ code: 'custom', path: ['montoTotal'], message: 'El monto total debe permitir cuotas de al menos 0,01' });
    }
});
