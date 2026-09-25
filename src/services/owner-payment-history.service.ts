import { Decimal } from '@prisma/client/runtime/library';

type OwnerPaymentRecord = {
    id: number;
    monto: Decimal | number | string;
    fechaPago: Date;
    fechaCreacion: Date;
    metodoPago: string;
    cuenta: string;
    comprobante: string | null;
    observaciones: string | null;
    motivoAdelanto: string | null;
    origen: string;
    montoFondosCobrados: Decimal | number | string;
    montoAdelantoPropio: Decimal | number | string;
    anuladoEn: Date | null;
    motivoAnulacion: string | null;
    creadoPor: { id: number; nombreCompleto: string } | null;
    anuladoPor: { id: number; nombreCompleto: string } | null;
    propietario: { id: number; nombreCompleto: string };
    movimientoCaja: { id: number; reversion: { id: number; fecha: Date; fechaCreacion: Date } | null } | null;
};

// Lectura compatible para movimientos anteriores a PagoPropietario. No se usa
// para calcular saldos nuevos, pero permite consultar el mayor histórico.
type LegacyMovement = {
    id: number; tipo: string; monto: Decimal | number | string; fecha: Date; fechaCreacion: Date;
    metodoPago: string; cuenta: string; comprobante: string | null; observaciones: string | null;
    anuladoEn: Date | null; motivoAnulacion: string | null;
    creadoPor: { id: number; nombreCompleto: string } | null;
    anuladoPor: { id: number; nombreCompleto: string } | null;
    reversionDe: { id: number } | null; reversion: { id: number } | null;
};

const buildLegacyHistory = (montoPropietario: Decimal | number | string, movements: LegacyMovement[]) => {
    let delivered = new Decimal(0);
    const total = new Decimal(montoPropietario || 0);
    return [...movements].sort((left, right) => left.fechaCreacion.getTime() - right.fechaCreacion.getTime() || left.id - right.id)
        .map(movement => {
            const amount = new Decimal(movement.monto.toString());
            const reversal = Boolean(movement.reversionDe);
            delivered = reversal ? Decimal.max(0, delivered.minus(amount)) : delivered.plus(amount);
            return {
                id: movement.id, pagoPropietarioId: movement.id,
                tipo: reversal ? 'REVERSION' : 'PAGO',
                estado: reversal ? 'REVERSION' : movement.reversion ? 'REVERTIDO' : movement.anuladoEn ? 'ANULADO' : 'VIGENTE',
                monto: amount.toNumber(), fecha: movement.fecha, fechaCreacion: movement.fechaCreacion,
                metodoPago: movement.metodoPago, cuenta: movement.cuenta,
                comprobante: movement.comprobante || `Asiento #${movement.id}`,
                observaciones: movement.observaciones, motivoAdelanto: null, origen: 'FONDOS_COBRADOS', montoFondosCobrados: amount.toNumber(), montoAdelantoPropio: 0,
                propietario: { id: 0, nombreCompleto: 'Propietario' }, motivoAnulacion: movement.motivoAnulacion,
                creadoPor: movement.creadoPor, anuladoPor: movement.anuladoPor,
                saldoPosterior: Decimal.max(0, total.minus(delivered)).toNumber(),
                reversionDeId: movement.reversionDe?.id || null, reversionId: movement.reversion?.id || null
            };
        }).reverse();
};

/** Mayor de entregas: el pago y su reversión son eventos distintos. */
export function buildOwnerPaymentHistory(montoPropietario: Decimal | number | string, records: OwnerPaymentRecord[] | LegacyMovement[]) {
    if (records.length && 'tipo' in records[0]) return buildLegacyHistory(montoPropietario, records as LegacyMovement[]);
    const payments = records as OwnerPaymentRecord[];
    const total = new Decimal(montoPropietario || 0);
    const events = payments.flatMap(payment => [
        { kind: 'PAGO' as const, payment, date: payment.fechaCreacion, id: payment.id },
        ...(payment.movimientoCaja?.reversion
            ? [{ kind: 'REVERSION' as const, payment, date: payment.movimientoCaja.reversion.fechaCreacion, id: payment.movimientoCaja.reversion.id }]
            : [])
    ]).sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);

    let delivered = new Decimal(0);
    return events.map(event => {
        const amount = new Decimal(event.payment.monto.toString());
        const reversal = event.kind === 'REVERSION';
        delivered = reversal ? Decimal.max(0, delivered.minus(amount)) : delivered.plus(amount);
        const reversalId = event.payment.movimientoCaja?.reversion?.id || null;
        return {
            id: reversal ? -event.id : event.payment.id,
            pagoPropietarioId: event.payment.id,
            tipo: reversal ? 'REVERSION' : 'PAGO',
            estado: reversal ? 'REVERSION' : reversalId ? 'REVERTIDO' : event.payment.anuladoEn ? 'ANULADO' : 'VIGENTE',
            monto: amount.toNumber(),
            fecha: reversal ? event.payment.movimientoCaja!.reversion!.fecha : event.payment.fechaPago,
            fechaCreacion: event.date,
            metodoPago: event.payment.metodoPago,
            cuenta: event.payment.cuenta,
            comprobante: event.payment.comprobante || `Entrega #${event.payment.id}`,
            observaciones: event.payment.observaciones,
            motivoAdelanto: event.payment.motivoAdelanto,
            origen: event.payment.origen,
            montoFondosCobrados: Number(event.payment.montoFondosCobrados),
            montoAdelantoPropio: Number(event.payment.montoAdelantoPropio),
            propietario: event.payment.propietario,
            motivoAnulacion: event.payment.motivoAnulacion,
            creadoPor: event.payment.creadoPor,
            anuladoPor: event.payment.anuladoPor,
            saldoPosterior: Decimal.max(0, total.minus(delivered)).toNumber(),
            reversionDeId: reversal ? event.payment.id : null,
            reversionId: !reversal ? reversalId : null
        };
    }).reverse();
}
