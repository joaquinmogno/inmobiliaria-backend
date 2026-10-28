import { Decimal } from '@prisma/client/runtime/library';
import { EstadoCobroInquilino, EstadoPagoPropietario } from '@prisma/client';
import { calculateLiquidationTotals } from './liquidacion-financial.service';

export type LiquidationCurrency = 'ARS' | 'USD';

type AmountWithCurrency = {
    monto: Decimal | number | string;
    moneda?: LiquidationCurrency | string | null;
    anuladoEn?: Date | null;
};

type CurrencyMovement = AmountWithCurrency & {
    tipo: string;
    esParaInmobiliaria: boolean;
};

export type LiquidationCurrencySummary = {
    moneda: LiquidationCurrency;
    totalIngresos: number;
    totalDescuentos: number;
    netoACobrar: number;
    montoPropietario: number;
    cobradoInquilino: number;
    creditoAplicadoInquilino: number;
    saldoInquilino: number;
    pagadoPropietario: number;
    saldoPropietario: number;
    capitalPropioExpuesto: number;
};

type MultiCurrencyLiquidation = {
    moneda: LiquidationCurrency;
    montoHonorarios: Decimal | number | string;
    pagaHonorarios: string;
    netoACobrar?: Decimal | number | string;
    montoPropietario?: Decimal | number | string;
    movimientos?: CurrencyMovement[];
    pagos?: AmountWithCurrency[];
    pagosPropietario?: AmountWithCurrency[];
    aplicacionesCredito?: AmountWithCurrency[];
};

const asDecimal = (value: Decimal | number | string | null | undefined) => new Decimal(value?.toString() || 0);

const activeRowsInCurrency = <T extends AmountWithCurrency>(rows: T[] | undefined, moneda: LiquidationCurrency) =>
    (rows || []).filter(row => !row.anuladoEn && (row.moneda || moneda) === moneda);

const sumRows = (rows: AmountWithCurrency[]) => rows.reduce((total, row) => total.plus(asDecimal(row.monto)), new Decimal(0));

/**
 * A liquidación can contain concepts paid in a currency different from the
 * contract currency (for example, USD rent and ARS building expenses). Amounts
 * are intentionally never converted or summed across currencies.
 */
export function getLiquidationCurrencySummaries(liquidacion: MultiCurrencyLiquidation): LiquidationCurrencySummary[] {
    const currencies = new Set<LiquidationCurrency>([liquidacion.moneda]);
    [...(liquidacion.movimientos || []), ...(liquidacion.pagos || []), ...(liquidacion.pagosPropietario || [])]
        .forEach(row => {
            if (row.moneda === 'ARS' || row.moneda === 'USD') currencies.add(row.moneda);
        });

    return [...currencies]
        .sort((left, right) => (left === liquidacion.moneda ? -1 : right === liquidacion.moneda ? 1 : left.localeCompare(right)))
        .map(moneda => {
            const movements = (liquidacion.movimientos || []).filter(movement => (movement.moneda || liquidacion.moneda) === moneda);
            const terms = {
                montoHonorarios: moneda === liquidacion.moneda ? liquidacion.montoHonorarios ?? 0 : 0,
                pagaHonorarios: liquidacion.pagaHonorarios
            };
            const totals = calculateLiquidationTotals(terms, movements);
            // La moneda contractual usa los totales persistidos, que también
            // incluyen las notas de crédito/débito de comprobantes confirmados.
            const contractCurrency = moneda === liquidacion.moneda;
            const netoACobrar = contractCurrency && liquidacion.netoACobrar !== undefined
                ? asDecimal(liquidacion.netoACobrar)
                : totals.netoACobrar;
            const montoPropietario = contractCurrency && liquidacion.montoPropietario !== undefined
                ? asDecimal(liquidacion.montoPropietario)
                : totals.montoPropietario;
            const pagos = sumRows(activeRowsInCurrency(liquidacion.pagos, moneda));
            // Los saldos a favor existentes pertenecen a la moneda contractual.
            const creditosAplicados = moneda === liquidacion.moneda
                ? sumRows((liquidacion.aplicacionesCredito || []).filter(item => !item.anuladoEn))
                : new Decimal(0);
            const pagadoPropietario = sumRows(activeRowsInCurrency(liquidacion.pagosPropietario, moneda));
            const saldoInquilino = Decimal.max(new Decimal(0), netoACobrar.minus(pagos).minus(creditosAplicados));
            const saldoPropietario = Decimal.max(new Decimal(0), montoPropietario.minus(pagadoPropietario));

            return {
                moneda,
                totalIngresos: totals.totalIngresos.toNumber(),
                totalDescuentos: totals.totalDescuentos.toNumber(),
                netoACobrar: netoACobrar.toNumber(),
                montoPropietario: montoPropietario.toNumber(),
                cobradoInquilino: pagos.toNumber(),
                creditoAplicadoInquilino: creditosAplicados.toNumber(),
                saldoInquilino: saldoInquilino.toNumber(),
                pagadoPropietario: pagadoPropietario.toNumber(),
                saldoPropietario: saldoPropietario.toNumber(),
                capitalPropioExpuesto: Decimal.max(new Decimal(0), pagadoPropietario.minus(pagos)).toNumber()
            };
        });
}

export function getTenantCollectionStateByCurrency(liquidacion: MultiCurrencyLiquidation): EstadoCobroInquilino {
    const summaries = getLiquidationCurrencySummaries(liquidacion).filter(summary => summary.netoACobrar > 0);
    if (!summaries.length) return EstadoCobroInquilino.NO_APLICA;
    if (summaries.every(summary => summary.saldoInquilino <= 0)) return EstadoCobroInquilino.COBRADO;
    if (summaries.some(summary => summary.cobradoInquilino > 0 || summary.creditoAplicadoInquilino > 0)) return EstadoCobroInquilino.PARCIAL;
    return EstadoCobroInquilino.PENDIENTE;
}

export function getOwnerPaymentStateByCurrency(liquidacion: MultiCurrencyLiquidation): EstadoPagoPropietario {
    const summaries = getLiquidationCurrencySummaries(liquidacion).filter(summary => summary.montoPropietario > 0);
    if (!summaries.length) return EstadoPagoPropietario.NO_APLICA;
    if (summaries.every(summary => summary.saldoPropietario <= 0)) return EstadoPagoPropietario.PAGADO;
    if (summaries.some(summary => summary.pagadoPropietario > 0)) return EstadoPagoPropietario.PARCIAL;
    return EstadoPagoPropietario.PENDIENTE;
}
