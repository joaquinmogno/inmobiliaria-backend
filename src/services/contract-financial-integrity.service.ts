import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError } from '../errors/app-error';
import { getTenantSettlement } from './tenant-credit.service';

type Tx = Prisma.TransactionClient;

export type ContractFinancialHistory = {
    liquidaciones: number;
    pagos: number;
    movimientosCaja: number;
    planesCuotas: number;
};

export const getContractFinancialHistory = async (tx: Tx, contratoId: number): Promise<ContractFinancialHistory> => {
    const [liquidaciones, pagos, movimientosCaja, planesCuotas] = await Promise.all([
        tx.liquidacion.count({ where: { contratoId } }),
        tx.pago.count({ where: { contratoId } }),
        tx.movimientoCaja.count({ where: { contratoId } }),
        tx.planCuotas.count({ where: { contratoId } })
    ]);
    return { liquidaciones, pagos, movimientosCaja, planesCuotas };
};

export const hasContractFinancialHistory = (history: ContractFinancialHistory) =>
    Object.values(history).some(count => count > 0);

export type ContractOutstandingObligations = {
    cobrosPendientesInquilino: Array<{ liquidacionId: number; periodo: Date; saldo: string; moneda: string }>;
    pagosPendientesPropietario: Array<{ liquidacionId: number; periodo: Date; saldo: string; moneda: string }>;
    cuotasPendientes: number;
    saldosAFavorInquilino: Array<{ creditoId: number; saldo: string; moneda: string }>;
};

export const getContractOutstandingObligations = async (tx: Tx, contratoId: number): Promise<ContractOutstandingObligations> => {
    const [liquidaciones, cuotasPendientes, creditos] = await Promise.all([
        tx.liquidacion.findMany({
            where: { contratoId, estado: { not: 'BORRADOR' } },
            include: { pagos: { where: { anuladoEn: null } }, aplicacionesCredito: true },
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
    for (const liquidacion of liquidaciones) {
        const settlement = getTenantSettlement(liquidacion);
        if (settlement.saldo.greaterThan(0)) {
            cobrosPendientesInquilino.push({
                liquidacionId: liquidacion.id,
                periodo: liquidacion.periodo,
                saldo: settlement.saldo.toFixed(2),
                moneda: liquidacion.moneda
            });
        }
        const saldoPropietario = new Decimal(liquidacion.montoPropietario.toString())
            .minus(liquidacion.montoPagadoPropietario.toString());
        if (saldoPropietario.greaterThan(0)) {
            pagosPendientesPropietario.push({
                liquidacionId: liquidacion.id,
                periodo: liquidacion.periodo,
                saldo: saldoPropietario.toFixed(2),
                moneda: liquidacion.moneda
            });
        }
    }

    return {
        cobrosPendientesInquilino,
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
    || obligations.cuotasPendientes > 0
    || obligations.saldosAFavorInquilino.length > 0;

export const assertContractCanBeRescinded = async (tx: Tx, contratoId: number) => {
    const obligations = await getContractOutstandingObligations(tx, contratoId);
    if (hasContractOutstandingObligations(obligations)) {
        throw new AppError('No se puede rescindir mientras existan obligaciones pendientes. Regularizá los saldos antes de continuar.', {
            statusCode: 409,
            code: 'CONTRACT_OUTSTANDING_OBLIGATIONS',
            details: obligations
        });
    }
    return obligations;
};
