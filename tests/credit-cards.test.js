const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { creditCardSchema, isCreditCardMethod, resolvePaymentCard } = require('../dist/services/credit-card.service');
const { calculateCashLedger, getMonthlyReportPeriod } = require('../dist/services/financial-reporting.service');
const { isCashPeriodClosed } = require('../dist/services/cash-closing.service');

test('card identity preserves leading zeroes and rejects full numbers, CVV and incomplete suffixes', () => {
  assert.equal(creditCardSchema.parse({ nombre: 'Visa', banco: 'Galicia', ultimosCuatro: '0012' }).ultimosCuatro, '0012');
  for (const ultimosCuatro of ['123', '12345', '1234 1234 1234 1234', 'abcd']) {
    assert.equal(creditCardSchema.safeParse({ nombre: 'Visa', banco: 'Galicia', ultimosCuatro }).success, false);
  }
  assert.equal(creditCardSchema.safeParse({ nombre: 'Visa', banco: 'Galicia', ultimosCuatro: '0012', cvv: '123' }).success, false);
  for (const method of ['Tarjeta', 'Tarjeta de crédito', 'TARJETA_CREDITO']) assert.equal(isCreditCardMethod(method), true);
});

test('credit requires a scoped active card, while edits may retain an inactive historic card', async () => {
  const input = { inmobiliariaId: 1, ambito: 'DANIEL', metodoPago: 'TARJETA_CREDITO' };
  await assert.rejects(resolvePaymentCard({}, input), { code: 'CREDIT_CARD_REQUIRED' });
  await assert.rejects(resolvePaymentCard({ $queryRaw: async () => [] }, { ...input, tarjetaId: 3 }), { code: 'INVALID_CREDIT_CARD' });
  const tx = { $queryRaw: async () => [{ id: 3, nombre: 'Visa', banco: 'Galicia', ultimosCuatro: '0012', activa: false }] };
  await assert.rejects(resolvePaymentCard(tx, { ...input, tarjetaId: 3 }), { code: 'INVALID_CREDIT_CARD' });
  assert.deepEqual(await resolvePaymentCard(tx, { ...input, tarjetaId: 3, previousCardId: 3 }), { tarjetaId: 3, tarjetaDescripcion: 'Visa · Galicia · •••• 0012' });
  await assert.rejects(resolvePaymentCard(tx, { ...input, metodoPago: 'EFECTIVO', tarjetaId: 3 }));
});

test('credit spending never reduces cash/bank liquidity and its annulments disappear from spending totals', async () => {
  const row = { tipo: 'EGRESO', cuenta: 'TARJETA', monto: '150000.25', moneda: 'ARS', fecha: new Date('2026-11-02'), pagoId: null, esPagoPropietario: false };
  const period = getMonthlyReportPeriod(2026, 11);
  const ledger = calculateCashLedger([
    { ...row, tipo: 'INGRESO', cuenta: 'CAJA', monto: '200000' }, row,
    { ...row, moneda: 'USD', monto: '12.50' },
    { ...row, monto: '999', anuladoEn: new Date() },
    { ...row, tipo: 'INGRESO', monto: '999', reversionDe: { anuladoEn: new Date(), pagoId: null, esPagoPropietario: false } }
  ], period);
  assert.equal(ledger.saldoAlCierre.ARS.saldo, 200000);
  assert.equal(ledger.saldoAlCierre.ARS.cuentas.BANCO.saldo, 0);
  assert.equal(ledger.movimientosDelPeriodo.ARS.egresos, 0);
  assert.equal(ledger.movimientosDelPeriodo.ARS.gastosTarjeta, 150000.25);
  assert.equal(ledger.movimientosDelPeriodo.USD.gastosTarjeta, 12.5);
  assert.equal(await isCashPeriodClosed({}, { cuenta: 'TARJETA' }), false);
});

test('adding optional card metadata does not invalidate old receipt fingerprints', async () => {
  const { loadReceiptSource } = require('../dist/services/movement-receipt.service');
  const movement = { id: 1, ambito: 'DANIEL', tipo: 'EGRESO', fecha: '2026-11-02', concepto: 'Reparación', monto: '200.00', moneda: 'ARS', metodoPago: 'Efectivo' };
  const { Decimal } = require('@prisma/client');
  const source = await loadReceiptSource({
    movimientoInterno: { findFirst: async () => ({ id: 1, tipo: 'GASTO', fecha: new Date('2026-11-02'), detalle: 'Reparación', monto: new Decimal(200), moneda: 'ARS', metodoPago: 'Efectivo', tarjetaDescripcion: null, anuladoEn: null }) },
    reciboMovimiento: { findFirst: async () => null }
  }, 'DANIEL', 1, 1);
  assert.equal(source.huellaMovimiento, createHash('sha256').update(JSON.stringify(movement)).digest('hex'));
});
