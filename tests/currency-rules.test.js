const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CurrencyMismatchError,
  assertSameCurrency,
  buildCurrencyTotals,
  resolveMoneda,
} = require('../dist/services/currency-rules.service');

test('contracts default to ARS when currency is omitted', () => {
  assert.equal(resolveMoneda(undefined), 'ARS');
  assert.equal(resolveMoneda(null), 'ARS');
});

test('contracts can be created in USD', () => {
  assert.equal(resolveMoneda('USD'), 'USD');
});

test('liquidations inherit the contract currency', () => {
  const contrato = { moneda: 'USD' };
  const liquidacion = { moneda: resolveMoneda(contrato.moneda) };

  assert.equal(liquidacion.moneda, 'USD');
});

test('payments must respect the liquidation currency', () => {
  assert.doesNotThrow(() => assertSameCurrency('ARS', 'ARS', 'ok'));

  assert.throws(
    () => assertSameCurrency('USD', 'ARS', 'El pago debe registrarse en ARS; no se permite mezclar monedas en una misma operación'),
    (error) => error instanceof CurrencyMismatchError
      && error.statusCode === 400
      && error.message.includes('no se permite mezclar monedas')
  );
});

test('liquidation movements and installments must respect the contract currency', () => {
  assert.throws(
    () => assertSameCurrency('ARS', 'USD', 'No se pueden liquidar cuotas con una moneda distinta a la del contrato'),
    /No se pueden liquidar cuotas/
  );
});

test('cashbox totals are calculated separately by currency', () => {
  const totals = buildCurrencyTotals([
    { tipo: 'INGRESO', monto: 1000, moneda: 'ARS' },
    { tipo: 'EGRESO', monto: 250, moneda: 'ARS' },
    { tipo: 'INGRESO', monto: 40, moneda: 'USD' },
    { tipo: 'DESCUENTO', monto: 15, moneda: 'USD' },
  ]);

  assert.deepEqual(totals.ARS, { totalIngresos: 1000, totalEgresos: 250, balance: 750 });
  assert.deepEqual(totals.USD, { totalIngresos: 40, totalEgresos: 15, balance: 25 });
});

test('mixed-currency operations are rejected clearly', () => {
  assert.throws(
    () => assertSameCurrency('ARS', 'USD', 'No se puede mezclar ARS y USD dentro de una misma operación financiera'),
    /No se puede mezclar ARS y USD/
  );
});
