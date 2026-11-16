process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-liquidation-currency-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getLiquidationCurrencySummaries,
  getLiquidationCurrencyDecimalSummaries,
  getOwnerPaymentStateByCurrency,
  getTenantCollectionStateByCurrency,
} = require('../dist/services/liquidation-currency.service');

test('legacy rows without currency belong only to the contractual currency', () => {
  const rows = getLiquidationCurrencySummaries(dualCurrencyLiquidation({
    pagos: [{ monto: '0.10' }, { monto: '0.20' }, { monto: 900, anuladoEn: new Date() }],
    pagosPropietario: [{ monto: '0.15' }], aplicacionesCredito: [{ monto: '0.05' }],
  }));
  assert.equal(rows[0].cobradoInquilino, 0.3);
  assert.equal(rows[0].pagadoPropietario, 0.15);
  assert.equal(rows[0].creditoAplicadoInquilino, 0.05);
  assert.equal(rows[1].cobradoInquilino, 0);
  assert.equal(rows[1].pagadoPropietario, 0);
  assert.equal(rows[1].creditoAplicadoInquilino, 0);
});

test('decimal summaries preserve cents and credit currency before serialization', () => {
  const rows = getLiquidationCurrencyDecimalSummaries(dualCurrencyLiquidation({
    pagos: Array.from({ length: 1000 }, () => ({ monto: '0.01', moneda: 'ARS' })),
    aplicacionesCredito: [{ monto: '0.05', creditoInquilino: { moneda: 'ARS' } }],
  }));
  assert.equal(rows[1].cobradoInquilino.toString(), '10');
  assert.equal(rows[1].saldoInquilino.toString(), '479324.95');
  assert.equal(rows[0].creditoAplicadoInquilino.toString(), '0');
});

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

test('el cobrado separa USD 1.000 y ARS 135.760, conserva centavos y excluye anulados', () => {
  const summaries = getLiquidationCurrencySummaries(dualCurrencyLiquidation({
    pagos: [
      { monto: '1000.00', moneda: 'USD' },
      { monto: '135760.00', moneda: 'ARS' },
      { monto: '0.25', moneda: 'ARS' },
      { monto: '9000', moneda: 'USD', anuladoEn: new Date() },
    ],
    aplicacionesCredito: [{ monto: 100 }],
  }));
  assert.equal(summaries[0].cobradoInquilino, 1000);
  assert.equal(summaries[1].cobradoInquilino, 135760.25);
  assert.equal(summaries[0].creditoAplicadoInquilino, 100);
  assert.equal(summaries[1].creditoAplicadoInquilino, 0);
  assert.equal(summaries[0].saldoInquilino, 300);
  assert.equal(summaries[1].saldoInquilino, 343574.75);
});
