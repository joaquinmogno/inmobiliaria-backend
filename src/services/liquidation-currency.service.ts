import { Decimal } from '@prisma/client/runtime/library';
import { EstadoCobroInquilino, EstadoPagoPropietario, Prisma } from '@prisma/client';
import { calculateLiquidationTotals } from './liquidacion-financial.service';

export type LiquidationCurrency = 'ARS' | 'USD';

type AmountWithCurrency = {
    monto: Decimal | number | string;
    moneda?: LiquidationCurrency | string | null;
    anuladoEn?: Date | null;
    creditoInquilino?: { moneda?: string; ajusteLiquidacion?: { concepto: string } };
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

export type MultiCurrencyLiquidation = {
    moneda: LiquidationCurrency;
    montoHonorarios?: Decimal | number | string;
    pagaHonorarios?: string;
    netoACobrar?: Decimal | number | string;
    montoPropietario?: Decimal | number | string;
    movimientos?: CurrencyMovement[];
    pagos?: AmountWithCurrency[];
    pagosPropietario?: AmountWithCurrency[];
    aplicacionesCredito?: AmountWithCurrency[];
};

const asDecimal = (value: Decimal | number | string | null | undefined) => new Decimal(value?.toString() || 0);

const rowCurrency = (row: AmountWithCurrency, fallback: LiquidationCurrency) => row.moneda || row.creditoInquilino?.moneda || fallback;
const activeRowsInCurrency = <T extends AmountWithCurrency>(rows: T[] | undefined, moneda: LiquidationCurrency, fallback: LiquidationCurrency) =>
    (rows || []).filter(row => !row.anuladoEn && rowCurrency(row, fallback) === moneda);

// Todas las proyecciones financieras consultan las mismas relaciones y monedas.
export const liquidationCurrencyRelations = {
    movimientos: { select: { tipo: true, monto: true, moneda: true, esParaInmobiliaria: true } },
    pagos: { where: { anuladoEn: null }, select: { monto: true, moneda: true } },
    pagosPropietario: { where: { anuladoEn: null }, select: { monto: true, moneda: true } },
    aplicacionesCredito: { select: { monto: true, creditoInquilino: { select: { moneda: true } } } }
} satisfies Prisma.LiquidacionInclude;

const sumRows = (rows: AmountWithCurrency[]) => rows.reduce((total, row) => total.plus(asDecimal(row.monto)), new Decimal(0));

/**
 * A liquidación can contain concepts paid in a currency different from the
 * contract currency (for example, USD rent and ARS building expenses). Amounts
 * are intentionally never converted or summed across currencies.
 */
export function getLiquidationCurrencyDecimalSummaries(liquidacion: MultiCurrencyLiquidation) {
    const currencies = new Set<LiquidationCurrency>([liquidacion.moneda]);
    [...(liquidacion.movimientos || []), ...(liquidacion.pagos || []), ...(liquidacion.pagosPropietario || []), ...(liquidacion.aplicacionesCredito || [])]
        .forEach(row => {
            const currency = rowCurrency(row, liquidacion.moneda);
            if (!row.anuladoEn && (currency === 'ARS' || currency === 'USD')) currencies.add(currency);
        });

    return [...currencies]
        .sort((left, right) => (left === liquidacion.moneda ? -1 : right === liquidacion.moneda ? 1 : left.localeCompare(right)))
        .map(moneda => {
            const movements = activeRowsInCurrency(liquidacion.movimientos, moneda, liquidacion.moneda);
            const terms = {
                montoHonorarios: moneda === liquidacion.moneda ? liquidacion.montoHonorarios ?? 0 : 0,
                pagaHonorarios: liquidacion.pagaHonorarios || 'PROPIETARIO'
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
            const pagos = sumRows(activeRowsInCurrency(liquidacion.pagos, moneda, liquidacion.moneda));
            const creditosAplicados = sumRows(activeRowsInCurrency(liquidacion.aplicacionesCredito, moneda, liquidacion.moneda));
            const pagadoPropietario = sumRows(activeRowsInCurrency(liquidacion.pagosPropietario, moneda, liquidacion.moneda));
            const saldoInquilino = Decimal.max(new Decimal(0), netoACobrar.minus(pagos).minus(creditosAplicados));
            const saldoPropietario = Decimal.max(new Decimal(0), montoPropietario.minus(pagadoPropietario));

            return {
                moneda,
                totalIngresos: totals.totalIngresos,
                totalDescuentos: totals.totalDescuentos,
                netoACobrar,
                montoPropietario,
                cobradoInquilino: pagos,
                creditoAplicadoInquilino: creditosAplicados,
                saldoInquilino,
                pagadoPropietario,
                saldoPropietario,
                capitalPropioExpuesto: Decimal.max(new Decimal(0), pagadoPropietario.minus(pagos))
            };
        });
}

export function getLiquidationCurrencySummaries(liquidacion: MultiCurrencyLiquidation): LiquidationCurrencySummary[] {
    return getLiquidationCurrencyDecimalSummaries(liquidacion).map(({ moneda, ...amounts }) => ({
        moneda,
        ...Object.fromEntries(Object.entries(amounts).map(([key, amount]) => [key, amount.toNumber()]))
    } as LiquidationCurrencySummary));
}

/** Lectura acotada por lotes: calcula criterios antes de paginar, sin usar estados históricos obsoletos. */
export async function findLiquidationFinancialMatches(
    db: Prisma.TransactionClient,
    where: Prisma.LiquidacionWhereInput,
    matches: (row: MultiCurrencyLiquidation & { id: number; contratoId: number; fechaVencimiento: Date | null }) => boolean
) {
    const ids: number[] = [];
    let cursor: number | undefined;
    while (true) {
        const rows = await db.liquidacion.findMany({
            where, include: liquidationCurrencyRelations, orderBy: { id: 'asc' }, take: 500,
            ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
        });
        ids.push(...rows.filter(matches).map(row => row.id));
        if (rows.length < 500) return ids;
        cursor = rows[rows.length - 1].id;
    }
}

export function getTenantCollectionStateByCurrency(liquidacion: MultiCurrencyLiquidation): EstadoCobroInquilino {
    const summaries = getLiquidationCurrencyDecimalSummaries(liquidacion).filter(summary => summary.netoACobrar.greaterThan(0));
    if (!summaries.length) return EstadoCobroInquilino.NO_APLICA;
    if (summaries.every(summary => summary.saldoInquilino.lessThanOrEqualTo(0))) return EstadoCobroInquilino.COBRADO;
    if (summaries.some(summary => summary.cobradoInquilino.greaterThan(0) || summary.creditoAplicadoInquilino.greaterThan(0))) return EstadoCobroInquilino.PARCIAL;
    return EstadoCobroInquilino.PENDIENTE;
}

export function getOwnerPaymentStateByCurrency(liquidacion: MultiCurrencyLiquidation): EstadoPagoPropietario {
    const summaries = getLiquidationCurrencyDecimalSummaries(liquidacion).filter(summary => summary.montoPropietario.greaterThan(0));
    if (!summaries.length) return EstadoPagoPropietario.NO_APLICA;
    if (summaries.every(summary => summary.saldoPropietario.lessThanOrEqualTo(0))) return EstadoPagoPropietario.PAGADO;
    if (summaries.some(summary => summary.pagadoPropietario.greaterThan(0))) return EstadoPagoPropietario.PARCIAL;
    return EstadoPagoPropietario.PENDIENTE;
}
