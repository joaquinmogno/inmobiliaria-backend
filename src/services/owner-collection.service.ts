import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError } from '../errors/app-error';
import { argentinaTodayAsDate, assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import { auditService } from './audit.service';
import { assertCashPeriodOpen, prepareCashCorrection } from './cash-closing.service';
import { getLiquidationCurrencyDecimalSummaries, liquidationCurrencyRelations } from './liquidation-currency.service';
import { createLiquidationVoucherSnapshot } from './liquidation-voucher.service';
import { refreshPrepaymentStates } from './rent-prepayment.service';

type Context = { inmobiliariaId: number; usuarioId: number; liquidacionId: number };
const fail = (message: string) => { throw new AppError(message, { statusCode: 409, code: 'OWNER_COLLECTION_CONFLICT' }); };
async function lockedLiquidation(tx: Prisma.TransactionClient, context: Context) {
    await tx.$queryRaw`SELECT id FROM "Liquidacion" WHERE id = ${context.liquidacionId} AND "inmobiliariaId" = ${context.inmobiliariaId} FOR UPDATE`;
    const row = await tx.liquidacion.findFirst({ where: { id: context.liquidacionId, inmobiliariaId: context.inmobiliariaId }, include: liquidationCurrencyRelations });
    if (!row) throw new AppError('Liquidación no encontrada', { statusCode: 404 });
    if (row.estado !== 'CONFIRMADA' || !row.montoAlquilerAnticipado.greaterThan(0)) fail('El cobro al propietario requiere una liquidación confirmada con alquiler anticipado.');
    if (await tx.actaRescision.count({ where: { contratoId: row.contratoId } })) fail('El contrato tiene un cierre sin reclamos emitido.');
    return row;
}
export async function collectFromOwner(tx: Prisma.TransactionClient, context: Context, input: {
    monto: number; moneda: 'ARS' | 'USD'; fechaPago: string; metodoPago: 'EFECTIVO' | 'TRANSFERENCIA' | 'CHEQUE'; cuentaBancariaId?: number; comprobante?: string; observaciones?: string;
}) {
    const row = await lockedLiquidation(tx, context);
    const summary = getLiquidationCurrencyDecimalSummaries(row).find(s => s.moneda === input.moneda);
    const amount = new Decimal(input.monto);
    if (!summary || amount.greaterThan(summary.saldoACobrarPropietario)) fail('El cobro supera el saldo pendiente del propietario.');
    const fecha = parseDateOnly(input.fechaPago);
    assertOperationalDateIsNotFuture(fecha, 'La fecha del cobro');
    const cuenta = input.metodoPago === 'EFECTIVO' ? 'CAJA' : 'BANCO';
    const bank = cuenta === 'BANCO' && input.cuentaBancariaId ? await tx.cuentaBancaria.findFirst({ where: { id: input.cuentaBancariaId, inmobiliariaId: context.inmobiliariaId, activa: true, moneda: input.moneda } }) : null;
    if (cuenta === 'BANCO' && !bank) fail('Seleccioná una cuenta bancaria activa en la moneda del cobro.');
    await assertCashPeriodOpen(tx, { inmobiliariaId: context.inmobiliariaId, fecha, cuenta, moneda: input.moneda, cuentaBancariaId: bank?.id });
    const cash = await tx.movimientoCaja.create({ data: {
        inmobiliariaId: context.inmobiliariaId, tipo: 'INGRESO', concepto: `Cobro de administración y gastos a ${row.propietarioNombre || 'propietario'} - Liquidación #${row.id}`,
        monto: amount, moneda: input.moneda, fecha, metodoPago: input.metodoPago, cuenta, cuentaBancariaId: bank?.id,
        comprobante: input.comprobante, observaciones: input.observaciones, creadoPorId: context.usuarioId, contratoId: row.contratoId, liquidacionId: row.id
    } });
    const payment = await tx.cobroPropietario.create({ data: { inmobiliariaId: context.inmobiliariaId, liquidacionId: row.id, movimientoCajaId: cash.id, monto: amount, moneda: input.moneda, fechaPago: fecha, creadoPorId: context.usuarioId } });
    const field = input.moneda === 'ARS' ? 'cobradoPropietarioARS' : 'cobradoPropietarioUSD';
    await tx.liquidacion.update({ where: { id: row.id }, data: { [field]: { increment: amount } } });
    await refreshPrepaymentStates(tx, row.id);
    await createLiquidationVoucherSnapshot({ tx, ...context, evento: 'COBRO_PROPIETARIO' });
    await auditService.log({ ...context, accion: 'COBRAR_PROPIETARIO', entidad: 'Liquidacion', entidadId: row.id, detalle: `Cobro #${payment.id}: ${amount} ${input.moneda}; caja #${cash.id}` }, tx);
    return payment;
}
export async function reverseOwnerCollection(tx: Prisma.TransactionClient, context: Context, id: number, motivo: string) {
    const row = await lockedLiquidation(tx, context);
    const payment = await tx.cobroPropietario.findFirst({ where: { id, liquidacionId: row.id, inmobiliariaId: context.inmobiliariaId }, include: { movimientoCaja: true } });
    if (!payment) throw new AppError('Cobro no encontrado', { statusCode: 404 });
    if (payment.anuladoEn) return payment;
    const fecha = argentinaTodayAsDate();
    const original = payment.movimientoCaja;
    const { originalPeriodClosed } = await prepareCashCorrection(tx, { inmobiliariaId: context.inmobiliariaId, movimientoOriginal: original, fechaCorreccion: fecha });
    const cancelled = await tx.cobroPropietario.update({ where: { id }, data: { anuladoEn: new Date(), motivoAnulacion: motivo } });
    if (!originalPeriodClosed) await tx.movimientoCaja.update({ where: { id: original.id }, data: { anuladoEn: new Date(), anuladoPorId: context.usuarioId, motivoAnulacion: motivo } });
    await tx.movimientoCaja.create({ data: { inmobiliariaId: context.inmobiliariaId, tipo: 'EGRESO', concepto: `Reversión cobro a propietario #${id}`, monto: payment.monto, moneda: payment.moneda, fecha, metodoPago: original.metodoPago, cuenta: original.cuenta, cuentaBancariaId: original.cuentaBancariaId, creadoPorId: context.usuarioId, observaciones: motivo, contratoId: row.contratoId, liquidacionId: row.id, reversionDeId: original.id } });
    const field = payment.moneda === 'ARS' ? 'cobradoPropietarioARS' : 'cobradoPropietarioUSD';
    await tx.liquidacion.update({ where: { id: row.id }, data: { [field]: { decrement: payment.monto }, fechaLiquidacion: null, cerradoPorId: null } });
    await refreshPrepaymentStates(tx, row.id);
    await createLiquidationVoucherSnapshot({ tx, ...context, evento: 'ANULACION_COBRO_PROPIETARIO' });
    await auditService.log({ ...context, accion: 'ANULAR_COBRO_PROPIETARIO', entidad: 'Liquidacion', entidadId: row.id, detalle: `Cobro #${id}: ${motivo}` }, tx);
    return cancelled;
}
