import { EstadoLiquidacion } from '@prisma/client';
import { prisma } from '../prisma';
import { Decimal } from '@prisma/client/runtime/library';
import { getLiquidationCurrencyDecimalSummaries, liquidationCurrencyRelations } from './liquidation-currency.service';

export async function getContractDebtSummary(
    contratoId: number,
    inmobiliariaId: number,
    excludeLiquidacionId?: number
) {
    const liquidaciones = await prisma.liquidacion.findMany({
        where: {
            contratoId,
            inmobiliariaId,
            estado: EstadoLiquidacion.CONFIRMADA,
            ...(excludeLiquidacionId ? { id: { not: excludeLiquidacionId } } : {})
        },
        include: liquidationCurrencyRelations,
        orderBy: { periodo: 'asc' }
    });

    const currencies = { ARS: new Decimal(0), USD: new Decimal(0) };
    const detalle = liquidaciones.flatMap(liq => getLiquidationCurrencyDecimalSummaries(liq)
        .filter(summary => summary.saldoInquilino.greaterThan(0))
        .map(summary => {
            currencies[summary.moneda] = currencies[summary.moneda].plus(summary.saldoInquilino);
            return {
                id: liq.id, periodo: liq.periodo, estado: liq.estado, moneda: summary.moneda,
                neto: summary.netoACobrar.toNumber(), pagado: summary.cobradoInquilino.toNumber(),
                creditosAplicados: summary.creditoAplicadoInquilino.toNumber(), deuda: summary.saldoInquilino.toNumber()
            };
        }));
    const moneda = liquidaciones[0]?.moneda || 'ARS';
    return {
        // Compatibilidad: el escalar representa sólo la moneda contractual.
        totalDeuda: currencies[moneda].toNumber(), moneda, detalle,
        porMoneda: Object.entries(currencies).map(([moneda, total]) => ({ moneda, monto: total.toNumber() }))
    };
}
