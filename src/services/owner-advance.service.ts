import { Decimal } from '@prisma/client/runtime/library';
import { argentinaTodayAsDate } from '../utils/argentina-date';

type Database = {
    pagoPropietario: {
        findMany: (args: any) => Promise<any[]>;
    };
};

export type OwnerAdvance = {
    liquidacionId: number;
    contratoId: number;
    monto: Decimal;
    moneda: string;
    fechaOrigen: Date;
    antiguedadDias: number;
};

/**
 * Expone sólo adelantos aún financiados por la inmobiliaria. Se comparan
 * cobros de caja activos contra entregas activas; créditos documentales no se
 * cuentan como efectivo recuperado.
 */
export async function getOutstandingOwnerAdvances(db: Database, inmobiliariaId: number): Promise<OwnerAdvance[]> {
    const ownerPayments = await db.pagoPropietario.findMany({
        where: { inmobiliariaId, anuladoEn: null, liquidacion: { estado: 'CONFIRMADA' } },
        include: {
            liquidacion: {
                select: {
                    id: true,
                    contratoId: true,
                    moneda: true,
                    pagos: { where: { anuladoEn: null }, select: { monto: true, moneda: true } }
                }
            }
        },
        orderBy: [{ fechaPago: 'asc' }, { id: 'asc' }]
    });
    const grouped = new Map<string, { liquidacionId: number; ownerTotal: Decimal; tenantTotal: Decimal; moneda: string; fechaOrigen: Date }>();
    for (const payment of ownerPayments) {
        const currency = payment.moneda || payment.liquidacion.moneda;
        const key = `${payment.liquidacionId}:${currency}`;
        const current = grouped.get(key) || {
            liquidacionId: payment.liquidacionId,
            ownerTotal: new Decimal(0),
            tenantTotal: payment.liquidacion.pagos.filter((row: { moneda?: string }) => (row.moneda || payment.liquidacion.moneda) === currency).reduce((sum: Decimal, tenantPayment: { monto: Decimal }) => sum.plus(tenantPayment.monto), new Decimal(0)),
            moneda: currency,
            fechaOrigen: payment.fechaPago
        };
        current.ownerTotal = current.ownerTotal.plus(payment.monto);
        if (payment.fechaPago < current.fechaOrigen) current.fechaOrigen = payment.fechaPago;
        grouped.set(key, current);
    }
    const today = argentinaTodayAsDate();
    return [...grouped.entries()].flatMap(([, summary]) => {
        const { liquidacionId } = summary;
        const monto = Decimal.max(new Decimal(0), summary.ownerTotal.minus(summary.tenantTotal));
        if (monto.isZero()) return [];
        const antiguedadDias = Math.max(0, Math.floor((today.getTime() - summary.fechaOrigen.getTime()) / 86_400_000));
        const contratoId = ownerPayments.find(payment => payment.liquidacionId === liquidacionId)!.liquidacion.contratoId;
        return [{ liquidacionId, contratoId, monto, moneda: summary.moneda, fechaOrigen: summary.fechaOrigen, antiguedadDias }];
    });
}

export const summarizeOwnerAdvanceAging = (advances: OwnerAdvance[]) => {
    const ages = new Map<number, number>();
    const totals: Record<string, Decimal> = {};
    for (const item of advances) {
        ages.set(item.liquidacionId, Math.max(ages.get(item.liquidacionId) || 0, item.antiguedadDias));
        totals[item.moneda] = (totals[item.moneda] || new Decimal(0)).plus(item.monto);
    }
    const days = [...ages.values()];
    return {
        cantidad: ages.size,
        porAntiguedad: {
            '0_15': days.filter(age => age <= 15).length,
            '16_30': days.filter(age => age >= 16 && age <= 30).length,
            '31_mas': days.filter(age => age >= 31).length
        },
        porMoneda: Object.fromEntries(Object.entries(totals).map(([currency, amount]) => [currency, amount.toNumber()]))
    };
};
