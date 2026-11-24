import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { getLiquidationCurrencyDecimalSummaries, liquidationCurrencyRelations } from './liquidation-currency.service';

type Tx = Prisma.TransactionClient;

export type ContractFinancialHistory = {
    liquidaciones: number;
    pagos: number;
    movimientosCaja: number;
    planesCuotas: number;
    anticiposAlquiler: number;
};

export const getContractFinancialHistory = async (tx: Tx, contratoId: number): Promise<ContractFinancialHistory> => {
    const [liquidaciones, pagos, movimientosCaja, planesCuotas, anticiposAlquiler] = await Promise.all([
        tx.liquidacion.count({ where: { contratoId } }),
        tx.pago.count({ where: { contratoId } }),
        tx.movimientoCaja.count({ where: { contratoId } }),
        tx.planCuotas.count({ where: { contratoId } }),
        tx.anticipoAlquiler.count({ where: { contratoId } })
    ]);
    return { liquidaciones, pagos, movimientosCaja, planesCuotas, anticiposAlquiler };
};

export const hasContractFinancialHistory = (history: ContractFinancialHistory) =>
    Object.values(history).some(count => count > 0);

export type ContractOutstandingObligations = {
    cobrosPendientesInquilino: Array<{ liquidacionId: number; periodo: Date; saldo: string; moneda: string }>;
    pagosPendientesPropietario: Array<{ liquidacionId: number; periodo: Date; saldo: string; moneda: string }>;
    cobrosPendientesPropietario: Array<{ liquidacionId: number; periodo: Date; saldo: string; moneda: string }>;
    cuotasPendientes: number;
    saldosAFavorInquilino: Array<{ creditoId: number; saldo: string; moneda: string }>;
};

export const getContractOutstandingObligations = async (tx: Tx, contratoId: number): Promise<ContractOutstandingObligations> => {
    const [liquidaciones, cuotasPendientes, creditos] = await Promise.all([
        tx.liquidacion.findMany({
            where: { contratoId, estado: { notIn: ['BORRADOR', 'ANULADA'] } },
            include: liquidationCurrencyRelations,
            orderBy: { periodo: 'asc' }
        }),
        tx.cuotaPlan.count({
            where: { plan: { contratoId, estado: 'VIGENTE' }, estado: 'PENDIENTE' }
        }),
        tx.creditoInquilino.findMany({
            where: { contratoId, saldoPendiente: { gt: 0 } },
            select: { id: true, saldoPendiente: true, moneda: true }
        })
    ]);

    const cobrosPendientesInquilino: ContractOutstandingObligations['cobrosPendientesInquilino'] = [];
    const pagosPendientesPropietario: ContractOutstandingObligations['pagosPendientesPropietario'] = [];
    const cobrosPendientesPropietario: ContractOutstandingObligations['cobrosPendientesPropietario'] = [];
    for (const liquidacion of liquidaciones) {
        for (const summary of getLiquidationCurrencyDecimalSummaries(liquidacion)) {
            const entry = (amount: Decimal) => ({ liquidacionId: liquidacion.id, periodo: liquidacion.periodo, saldo: amount.toFixed(2), moneda: summary.moneda });
            if (summary.saldoInquilino.greaterThan(0)) cobrosPendientesInquilino.push(entry(summary.saldoInquilino));
            if (summary.saldoPropietario.greaterThan(0)) pagosPendientesPropietario.push(entry(summary.saldoPropietario));
            if (summary.saldoACobrarPropietario.greaterThan(0)) cobrosPendientesPropietario.push(entry(summary.saldoACobrarPropietario));
        }
    }

    return {
        cobrosPendientesInquilino,
        cobrosPendientesPropietario,
        pagosPendientesPropietario,
        cuotasPendientes,
        saldosAFavorInquilino: creditos.map(credito => ({
            creditoId: credito.id,
            saldo: new Decimal(credito.saldoPendiente.toString()).toFixed(2),
            moneda: credito.moneda
        }))
    };
};

export const hasContractOutstandingObligations = (obligations: ContractOutstandingObligations) =>
    obligations.cobrosPendientesInquilino.length > 0
    || obligations.pagosPendientesPropietario.length > 0
    || (obligations.cobrosPendientesPropietario?.length || 0) > 0
    || obligations.cuotasPendientes > 0
    || obligations.saldosAFavorInquilino.length > 0;
