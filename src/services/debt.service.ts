import { EstadoLiquidacion } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../prisma';

export async function getContractDebtSummary(
    contratoId: number,
    inmobiliariaId: number,
    excludeLiquidacionId?: number
) {
    const liquidaciones = await prisma.liquidacion.findMany({
        where: {
            contratoId,
            inmobiliariaId,
            estado: { not: EstadoLiquidacion.BORRADOR },
            ...(excludeLiquidacionId ? { id: { not: excludeLiquidacionId } } : {})
        },
        include: {
            pagos: true
        },
        orderBy: { periodo: 'asc' }
    });

    const detalle = liquidaciones.map(liq => {
        const totalPagado = liq.pagos.reduce((acc, p) => acc.plus(p.monto), new Decimal(0));
        const deuda = new Decimal(liq.netoACobrar.toString()).minus(totalPagado);

        return {
            periodo: liq.periodo,
            neto: Number(liq.netoACobrar),
            pagado: Number(totalPagado),
            deuda: deuda.greaterThan(0) ? Number(deuda) : 0,
            moneda: liq.moneda,
            estado: liq.estado
        };
    }).filter(item => item.deuda > 0);

    const totalDeuda = detalle.reduce((acc, item) => acc + item.deuda, 0);

    return {
        totalDeuda,
        moneda: detalle[0]?.moneda || 'ARS',
        detalle
    };
}
