import { Moneda } from '@prisma/client';

export const monedaSchemaValues = ['ARS', 'USD'] as const;

export function formatCurrency(amount: number | string, moneda: Moneda | string = 'ARS') {
    const numericAmount = Number(amount || 0);
    const symbol = moneda === 'USD' ? 'US$' : '$';
    return `${symbol}${numericAmount.toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}
