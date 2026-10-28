process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-liquidation-currency-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getLiquidationCurrencySummaries,
  getOwnerPaymentStateByCurrency,
  getTenantCollectionStateByCurrency,
} = require('../dist/services/liquidation-currency.service');

const dualCurrencyLiquidation = (overrides = {}) => ({
  moneda: 'USD',
  montoHonorarios: 70,
  pagaHonorarios: 'PROPIETARIO',
  movimientos: [
    { tipo: 'INGRESO', concepto: 'Alquiler Mensual', monto: 1400, moneda: 'USD', esParaInmobiliaria: false },
    { tipo: 'INGRESO', concepto: 'Expensas', monto: 479335, moneda: 'ARS', esParaInmobiliaria: false },
  ],
  pagos: [],
  pagosPropietario: [],
  aplicacionesCredito: [],
  ...overrides,
});

test('keeps USD rent and ARS expenses as independent tenant and owner balances', () => {
  const summaries = getLiquidationCurrencySummaries(dualCurrencyLiquidation());
  const usd = summaries.find(summary => summary.moneda === 'USD');
  const ars = summaries.find(summary => summary.moneda === 'ARS');

  assert.deepEqual(
    { tenant: usd.netoACobrar, owner: usd.montoPropietario, tenantBalance: usd.saldoInquilino },
    { tenant: 1400, owner: 1330, tenantBalance: 1400 }
  );
  assert.deepEqual(
    { tenant: ars.netoACobrar, owner: ars.montoPropietario, tenantBalance: ars.saldoInquilino },
    { tenant: 479335, owner: 479335, tenantBalance: 479335 }
  );
  assert.equal(getTenantCollectionStateByCurrency(dualCurrencyLiquidation()), 'PENDIENTE');
  assert.equal(getOwnerPaymentStateByCurrency(dualCurrencyLiquidation()), 'PENDIENTE');
});

test('a peso collection and owner delivery never settle the dollar balance', () => {
  const liquidation = dualCurrencyLiquidation({
    pagos: [{ monto: 479335, moneda: 'ARS' }],
    pagosPropietario: [{ monto: 479335, moneda: 'ARS' }],
  });
  const summaries = getLiquidationCurrencySummaries(liquidation);
  const usd = summaries.find(summary => summary.moneda === 'USD');
  const ars = summaries.find(summary => summary.moneda === 'ARS');

  assert.equal(ars.saldoInquilino, 0);
  assert.equal(ars.saldoPropietario, 0);
  assert.equal(usd.saldoInquilino, 1400);
  assert.equal(usd.saldoPropietario, 1330);
  assert.equal(getTenantCollectionStateByCurrency(liquidation), 'PARCIAL');
  assert.equal(getOwnerPaymentStateByCurrency(liquidation), 'PARCIAL');
});

test('el resumen conserva las notas de crédito aplicadas a los totales del comprobante', () => {
  const summaries = getLiquidationCurrencySummaries(dualCurrencyLiquidation({ netoACobrar: 1300, montoPropietario: 1230 }));
  assert.equal(summaries[0].netoACobrar, 1300);
  assert.equal(summaries[0].montoPropietario, 1230);
  assert.equal(summaries[1].netoACobrar, 479335);
});
