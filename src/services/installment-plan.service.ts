import { Decimal } from '@prisma/client/runtime/library';

export function distributeInstallmentAmounts(total: Decimal.Value, count: number): Decimal[] {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error('La cantidad de cuotas debe ser un entero positivo');
    }

    const normalizedTotal = new Decimal(total);
    if (!normalizedTotal.isFinite() || normalizedTotal.decimalPlaces() > 2) {
        throw new Error('El monto total admite como máximo dos decimales');
    }
    const totalCents = normalizedTotal.times(100).toNumber();
    if (!Number.isSafeInteger(totalCents) || totalCents < count) {
        throw new Error('El monto total debe permitir cuotas de al menos 0,01');
    }

    const baseCents = Math.floor(totalCents / count);
    const remainderCents = totalCents - (baseCents * count);

    return Array.from({ length: count }, (_, index) => {
        const cents = index === count - 1 ? baseCents + remainderCents : baseCents;
        return new Decimal(cents).dividedBy(100);
    });
}

export function buildInstallmentSchedule(total: Decimal.Value, count: number, firstPeriod: string) {
    const [year, month] = firstPeriod.split('-').map(Number);
    return distributeInstallmentAmounts(total, count).map((amount, index) => ({
        numeroCuota: index + 1,
        monto: amount.toFixed(2),
        fechaVencimiento: new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 10)
    }));
}

type InstallmentBalance = { estado: string; monto: Decimal.Value; liquidacionId?: number | null; movimientoId?: number | null };

export function getInstallmentOutstanding(cuota: { estado: string; monto: Decimal.Value; imputacionesPago: Array<{ monto: Decimal.Value }> }): Decimal {
    if (cuota.estado === 'PAGADA') return new Decimal(0);
    const allocated = cuota.imputacionesPago.reduce((sum, item) => sum.plus(item.monto), new Decimal(0));
    return Decimal.max(0, new Decimal(cuota.monto).minus(allocated));
}

export function summarizeInstallments(cuotas: InstallmentBalance[]) {
    const paid = cuotas.filter(cuota => cuota.estado === 'PAGADA');
    const pending = cuotas.filter(cuota => cuota.estado === 'PENDIENTE');
    const available = pending.filter(cuota => cuota.liquidacionId == null && cuota.movimientoId == null);
    const linked = pending.filter(cuota => cuota.liquidacionId != null || cuota.movimientoId != null);
    const sum = (items: InstallmentBalance[]) => items.reduce((total, item) => total.plus(item.monto), new Decimal(0)).toFixed(2);
    return {
        sumaCuotas: sum(cuotas), montoCuotasPagadas: sum(paid), montoPendiente: sum(pending),
        montoPendienteDisponible: sum(available), montoPendienteVinculado: sum(linked),
        cantidadPendienteDisponible: available.length, cantidadPendienteVinculada: linked.length
    };
}
