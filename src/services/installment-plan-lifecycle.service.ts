import { EstadoCuota, EstadoPlanCuotas, Prisma } from '@prisma/client';
import { getTenantSettlement } from './tenant-credit.service';

type Tx = Prisma.TransactionClient;

export const syncInstallmentPlanCompletion = async (tx: Tx, planIds: number[], usuarioId?: number) => {
    const ids = [...new Set(planIds)];
    if (!ids.length) return;
    const plans = await tx.planCuotas.findMany({
        where: { id: { in: ids } },
        include: { cuotas: { select: { estado: true } } }
    });

    for (const plan of plans) {
        const allPaid = plan.cuotas.length > 0 && plan.cuotas.every(cuota => cuota.estado === EstadoCuota.PAGADA);
        if (plan.estado === EstadoPlanCuotas.VIGENTE && allPaid) {
            await tx.planCuotas.update({
                where: { id: plan.id },
                data: {
                    estado: EstadoPlanCuotas.CUMPLIDO,
                    fechaCierre: new Date(),
                    motivoCierre: 'Plan cumplido: todas sus cuotas fueron pagadas',
                    ...(usuarioId ? { cerradoPorId: usuarioId } : {})
                }
            });
        }
        // Una anulación de pago puede volver a abrir una cuota que antes figuraba
        // cumplida. El plan vuelve a vigente; el evento de caja conserva la traza.
        if (plan.estado === EstadoPlanCuotas.CUMPLIDO && !allPaid) {
            await tx.planCuotas.update({
                where: { id: plan.id },
                data: { estado: EstadoPlanCuotas.VIGENTE, fechaCierre: null, motivoCierre: null, cerradoPorId: null }
            });
        }
    }
};

export const syncInstallmentsForLiquidationSettlement = async ({
    tx,
    liquidacionId,
    usuarioId
}: {
    tx: Tx;
    liquidacionId: number;
    usuarioId?: number;
}) => {
    const liquidacion = await tx.liquidacion.findUnique({
        where: { id: liquidacionId },
        include: { pagos: { where: { anuladoEn: null } }, aplicacionesCredito: true }
    });
    if (!liquidacion) return;

    const settlement = getTenantSettlement(liquidacion);
    const cuotas = await tx.cuotaPlan.findMany({
        where: { liquidacionId },
        select: { id: true, planId: true, estado: true }
    });
    if (!cuotas.length) return;

    const estadoObjetivo: EstadoCuota = settlement.saldo.isZero() ? EstadoCuota.PAGADA : EstadoCuota.PENDIENTE;
    const eligibleStates: EstadoCuota[] = estadoObjetivo === EstadoCuota.PAGADA ? [EstadoCuota.PENDIENTE] : [EstadoCuota.PAGADA];
    await tx.cuotaPlan.updateMany({
        where: { id: { in: cuotas.map(cuota => cuota.id) }, estado: { in: eligibleStates } },
        data: { estado: estadoObjetivo }
    });
    await syncInstallmentPlanCompletion(tx, cuotas.map(cuota => cuota.planId), usuarioId);
};
