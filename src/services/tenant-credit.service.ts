import { Decimal } from '@prisma/client/runtime/library';
import { EstadoCobroInquilino, EstadoPagoPropietario } from '@prisma/client';

type Amount = { monto: Decimal | number | string };

export const sumAmounts = (rows: Amount[] = []) =>
    rows.reduce((total, row) => total.plus(row.monto), new Decimal(0));

export const getTenantSettlement = (liquidacion: {
    netoACobrar: Decimal | number | string;
    pagos?: Amount[];
    aplicacionesCredito?: Amount[];
}) => {
    const pagos = sumAmounts(liquidacion.pagos);
    const creditosAplicados = sumAmounts(liquidacion.aplicacionesCredito);
    const totalAplicado = pagos.plus(creditosAplicados);
    const saldo = Decimal.max(new Decimal(0), new Decimal(liquidacion.netoACobrar).minus(totalAplicado));

    return { pagos, creditosAplicados, totalAplicado, saldo };
};

export const getTenantCollectionState = (liquidacion: {
    netoACobrar: Decimal | number | string;
    pagos?: Amount[];
    aplicacionesCredito?: Amount[];
}): EstadoCobroInquilino => {
    const { totalAplicado } = getTenantSettlement(liquidacion);
    if (totalAplicado.lessThanOrEqualTo(0)) return EstadoCobroInquilino.PENDIENTE;
    return totalAplicado.lessThan(new Decimal(liquidacion.netoACobrar))
        ? EstadoCobroInquilino.PARCIAL
        : EstadoCobroInquilino.COBRADO;
};

export const getOwnerPaymentSettlement = (liquidacion: {
    montoPropietario: Decimal | number | string;
    pagosPropietario?: Amount[];
}) => {
    const pagado = sumAmounts(liquidacion.pagosPropietario);
    const saldo = Decimal.max(new Decimal(0), new Decimal(liquidacion.montoPropietario).minus(pagado));
    return { pagado, saldo };
};

export const getOwnerPaymentState = (liquidacion: {
    montoPropietario: Decimal | number | string;
    pagosPropietario?: Amount[];
}): EstadoPagoPropietario => {
    const { pagado, saldo } = getOwnerPaymentSettlement(liquidacion);
    if (pagado.lessThanOrEqualTo(0)) return EstadoPagoPropietario.PENDIENTE;
    return saldo.greaterThan(0) ? EstadoPagoPropietario.PARCIAL : EstadoPagoPropietario.PAGADO;
};

/**
 * El resumen persistido de una liquidación se reconstruye siempre desde las
 * entregas vigentes de la base. No se debe derivar de una lista precargada al
 * anular un pago: esa lista todavía puede contener el registro que acaba de
 * cambiar de estado dentro de la misma transacción.
 */
export async function getActiveOwnerPaymentSettlement(
    db: { pagoPropietario: { findMany: (args: any) => Promise<Array<Amount & { id: number }>> } },
    input: { inmobiliariaId: number; liquidacionId: number; montoPropietario: Decimal | number | string }
) {
    const pagosPropietario = await db.pagoPropietario.findMany({
        where: {
            inmobiliariaId: input.inmobiliariaId,
            liquidacionId: input.liquidacionId,
            anuladoEn: null
        },
        select: { id: true, monto: true },
        orderBy: { id: 'asc' }
    });
    const settlement = getOwnerPaymentSettlement({
        montoPropietario: input.montoPropietario,
        pagosPropietario
    });
    return {
        pagosPropietario,
        ...settlement,
        estado: getOwnerPaymentState({ montoPropietario: input.montoPropietario, pagosPropietario })
    };
}

/**
 * Capital de la inmobiliaria todavía inmovilizado en una liquidación. Los
 * créditos aplicados reducen la deuda documental, pero no son efectivo: por
 * eso sólo los cobros de caja del inquilino compensan un adelanto.
 */
export const getAgencyAdvanceExposure = (liquidacion: {
    pagos?: Amount[];
    pagosPropietario?: Amount[];
}) => {
    const cobradoInquilino = sumAmounts(liquidacion.pagos);
    const entregadoPropietario = sumAmounts(liquidacion.pagosPropietario);
    return Decimal.max(new Decimal(0), entregadoPropietario.minus(cobradoInquilino));
};
