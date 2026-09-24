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
                    pagos: { where: { anuladoEn: null }, select: { monto: true } }
                }
            }
        },
        orderBy: [{ fechaPago: 'asc' }, { id: 'asc' }]
    });
    const grouped = new Map<number, { ownerTotal: Decimal; tenantTotal: Decimal; moneda: string; fechaOrigen: Date }>();
    for (const payment of ownerPayments) {
        const current = grouped.get(payment.liquidacionId) || {
            ownerTotal: new Decimal(0),
            tenantTotal: payment.liquidacion.pagos.reduce((sum: Decimal, tenantPayment: { monto: Decimal }) => sum.plus(tenantPayment.monto), new Decimal(0)),
            moneda: payment.liquidacion.moneda,
            fechaOrigen: payment.fechaPago
        };
        current.ownerTotal = current.ownerTotal.plus(payment.monto);
        if (payment.fechaPago < current.fechaOrigen) current.fechaOrigen = payment.fechaPago;
        grouped.set(payment.liquidacionId, current);
    }
    const today = argentinaTodayAsDate();
    return [...grouped.entries()].flatMap(([liquidacionId, summary]) => {
        const monto = Decimal.max(new Decimal(0), summary.ownerTotal.minus(summary.tenantTotal));
        if (monto.isZero()) return [];
        const antiguedadDias = Math.max(0, Math.floor((today.getTime() - summary.fechaOrigen.getTime()) / 86_400_000));
        const contratoId = ownerPayments.find(payment => payment.liquidacionId === liquidacionId)!.liquidacion.contratoId;
        return [{ liquidacionId, contratoId, monto, moneda: summary.moneda, fechaOrigen: summary.fechaOrigen, antiguedadDias }];
    });
}

export const summarizeOwnerAdvanceAging = (advances: OwnerAdvance[]) => ({
    cantidad: advances.length,
    porAntiguedad: {
        '0_15': advances.filter(item => item.antiguedadDias <= 15).length,
        '16_30': advances.filter(item => item.antiguedadDias >= 16 && item.antiguedadDias <= 30).length,
        '31_mas': advances.filter(item => item.antiguedadDias >= 31).length
    },
    porMoneda: advances.reduce<Record<string, number>>((result, item) => {
        result[item.moneda] = (result[item.moneda] || 0) + item.monto.toNumber();
        return result;
    }, {})
});
