import { EstadoLiquidacion } from '@prisma/client';
import { prisma } from '../prisma';
import { getTenantSettlement } from './tenant-credit.service';

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
        include: {
            pagos: { where: { anuladoEn: null } },
            aplicacionesCredito: true
        },
        orderBy: { periodo: 'asc' }
    });

    const detalle = liquidaciones.map(liq => {
        const { pagos, creditosAplicados, saldo } = getTenantSettlement(liq);

        return {
            id: liq.id,
            periodo: liq.periodo,
            neto: Number(liq.netoACobrar),
            pagado: Number(pagos),
            creditosAplicados: Number(creditosAplicados),
            deuda: Number(saldo),
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
