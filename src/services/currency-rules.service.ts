import { Moneda } from '@prisma/client';

export const MONEDAS: Moneda[] = ['ARS', 'USD'];

export class CurrencyMismatchError extends Error {
    statusCode = 400;

    constructor(message: string) {
        super(message);
        this.name = 'CurrencyMismatchError';
    }
}

export function resolveMoneda(moneda?: Moneda | string | null): Moneda {
    return moneda === 'USD' ? 'USD' : 'ARS';
}

export function assertSameCurrency(actual: Moneda | string | null | undefined, expected: Moneda | string | null | undefined, message: string) {
    if (resolveMoneda(actual) !== resolveMoneda(expected)) {
        throw new CurrencyMismatchError(message);
    }
}

export function buildCurrencyTotals<T extends { tipo: string; monto: number | string; moneda?: Moneda | string | null }>(items: T[]) {
    return MONEDAS.reduce((acc, moneda) => {
        const ingresos = items
            .filter(item => resolveMoneda(item.moneda) === moneda && item.tipo === 'INGRESO')
            .reduce((sum, item) => sum + Number(item.monto || 0), 0);
        const egresos = items
            .filter(item => resolveMoneda(item.moneda) === moneda && (item.tipo === 'EGRESO' || item.tipo === 'DESCUENTO'))
            .reduce((sum, item) => sum + Number(item.monto || 0), 0);

        acc[moneda] = {
            totalIngresos: ingresos,
            totalEgresos: egresos,
            balance: ingresos - egresos
        };
        return acc;
    }, {} as Record<Moneda, { totalIngresos: number; totalEgresos: number; balance: number }>);
}
