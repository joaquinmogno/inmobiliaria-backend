import { Decimal } from '@prisma/client/runtime/library';

export function distributeInstallmentAmounts(total: Decimal.Value, count: number): Decimal[] {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error('La cantidad de cuotas debe ser un entero positivo');
    }

    const normalizedTotal = new Decimal(total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const totalCents = normalizedTotal.times(100).toNumber();
    if (!Number.isSafeInteger(totalCents) || totalCents < count) {
        throw new Error('El monto total debe permitir cuotas de al menos 0,01');
    }

    const baseCents = Math.floor(totalCents / count);
    const remainderCents = totalCents - (baseCents * count);

    return Array.from({ length: count }, (_, index) => {
        const cents = index === count - 1 ? baseCents + remainderCents : baseCents;
        return new Decimal(cents).dividedBy(100);
    });
}
