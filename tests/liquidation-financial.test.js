process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-liquidation-financial-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateLiquidationTotals,
  assertValidLiquidationTotals,
  getEffectiveRentForPeriod,
  getLiquidationDueDate,
} = require('../dist/services/liquidacion-financial.service');

const rentMovement = {
  tipo: 'INGRESO',
  monto: 100000,
  esParaInmobiliaria: false,
};

test('tenant-paid fees increase tenant total without reducing the owner amount', () => {
  const totals = calculateLiquidationTotals({
    montoHonorarios: 5000,
    pagaHonorarios: 'INQUILINO',
  }, [rentMovement]);

  assert.equal(totals.netoACobrar.toString(), '105000');
  assert.equal(totals.montoPropietario.toString(), '100000');
});

test('owner-paid fees reduce only the owner amount', () => {
  const totals = calculateLiquidationTotals({
    montoHonorarios: 5000,
    pagaHonorarios: 'PROPIETARIO',
  }, [rentMovement]);

  assert.equal(totals.netoACobrar.toString(), '100000');
  assert.equal(totals.montoPropietario.toString(), '95000');
});

test('historical rent is reconstructed from the contract update trail', () => {
  const updates = [
    {
      fechaActualizacion: new Date('2026-08-15T12:00:00.000Z'),
      montoAnterior: 100000,
    },
  ];

  assert.equal(
    getEffectiveRentForPeriod(150000, updates, new Date('2026-07-01T00:00:00.000Z')).toString(),
    '100000'
  );
  assert.equal(
    getEffectiveRentForPeriod(150000, updates, new Date('2026-08-01T00:00:00.000Z')).toString(),
    '150000'
  );
});

test('negative owner totals are rejected before they can be confirmed or paid', () => {
  const totals = calculateLiquidationTotals({
    montoHonorarios: 120000,
    pagaHonorarios: 'PROPIETARIO',
  }, [rentMovement]);
  assert.throws(
    () => assertValidLiquidationTotals(totals),
    error => error.code === 'NEGATIVE_OWNER_TOTAL'
  );
});

test('contract due day is preserved and capped for short months', () => {
  assert.equal(getLiquidationDueDate(new Date('2026-09-01T00:00:00.000Z'), 10).toISOString(), '2026-09-10T00:00:00.000Z');
  assert.equal(getLiquidationDueDate(new Date('2027-02-01T00:00:00.000Z'), 31).toISOString(), '2027-02-28T00:00:00.000Z');
});
