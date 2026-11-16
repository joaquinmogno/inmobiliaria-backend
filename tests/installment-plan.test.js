const test = require('node:test');
const assert = require('node:assert/strict');

const { distributeInstallmentAmounts } = require('../dist/services/installment-plan.service');

test('installment distribution assigns the cent remainder to the last installment', () => {
  const amounts = distributeInstallmentAmounts('100.00', 3);

  assert.deepEqual(amounts.map(amount => amount.toFixed(2)), ['33.33', '33.33', '33.34']);
  assert.equal(amounts.reduce((sum, amount) => sum.plus(amount), amounts[0].minus(amounts[0])).toFixed(2), '100.00');
});

test('installment distribution also corrects an accumulated rounding excess', () => {
  const amounts = distributeInstallmentAmounts('10.00', 6);

  assert.deepEqual(amounts.map(amount => amount.toFixed(2)), ['1.66', '1.66', '1.66', '1.66', '1.66', '1.70']);
  assert.equal(amounts.reduce((sum, amount) => sum.plus(amount)).toFixed(2), '10.00');
});

const { buildInstallmentSchedule, summarizeInstallments } = require('../dist/services/installment-plan.service');
const { installmentScheduleSchema } = require('../dist/validation/installment-plan.schemas');

test('cent minimum, divisible plans and rejection of excessive precision', () => {
  for (const [total, count, expected] of [['0.03', 3, ['0.01', '0.01', '0.01']], ['120.00', 3, ['40.00', '40.00', '40.00']]]) {
    assert.deepEqual(distributeInstallmentAmounts(total, count).map(amount => amount.toFixed(2)), expected);
  }
  for (const [total, count] of [['0.02', 3], ['1.001', 3], ['-1', 1], ['NaN', 3], ['100', 0], ['100', 1.5]]) {
    assert.throws(() => distributeInstallmentAmounts(total, count));
  }
  for (const montoTotal of [0.02, 1.001, '1.001']) {
    assert.equal(installmentScheduleSchema.safeParse({ montoTotal, cantidadCuotas: 3, fechaPrimeraCuota: '2026-12-01' }).success, false);
  }
});

test('preview schedule preserves last-cent rule and monthly dates across years', () => {
  assert.deepEqual(buildInstallmentSchedule('100.00', 3, '2026-12-01'), [
    { numeroCuota: 1, monto: '33.33', fechaVencimiento: '2026-12-01' },
    { numeroCuota: 2, monto: '33.33', fechaVencimiento: '2027-01-01' },
    { numeroCuota: 3, monto: '33.34', fechaVencimiento: '2027-02-01' }
  ]);
});

test('summary separates paid, available pending, linked pending and historical totals', () => {
  const resumen = summarizeInstallments([
    { estado: 'PAGADA', monto: '33.33', liquidacionId: 1, movimientoId: 10 },
    { estado: 'PENDIENTE', monto: '33.33', liquidacionId: 2, movimientoId: 11 },
    { estado: 'PENDIENTE', monto: '33.34', liquidacionId: null, movimientoId: null }
  ]);
  assert.deepEqual(resumen, { sumaCuotas: '100.00', montoCuotasPagadas: '33.33', montoPendiente: '66.67', montoPendienteDisponible: '33.34', montoPendienteVinculado: '33.33', cantidadPendienteDisponible: 1, cantidadPendienteVinculada: 1 });
  assert.equal(summarizeInstallments([{ estado: 'CANCELADA', monto: '100.25' }]).montoPendienteDisponible, '0.00');
});

test('own balance uses decimal subtraction and a fully settled installment has no debt', () => {
  const { getInstallmentOutstanding } = require('../dist/services/installment-plan.service');
  assert.equal(getInstallmentOutstanding({ monto: '33.33', estado: 'PENDIENTE', imputacionesPago: [{ monto: '10.10' }] }).toFixed(2), '23.23');
  assert.equal(getInstallmentOutstanding({ monto: '33.33', estado: 'PAGADA', imputacionesPago: [] }).toFixed(2), '0.00');
});
