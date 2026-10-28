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
  replaceDraftMonthlyRent,
} = require('../dist/services/liquidacion-financial.service');
const { Decimal } = require('@prisma/client/runtime/library');

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

function draftDatabase(overrides = {}) {
  const draft = { id: 10, inmobiliariaId: 1, version: 2, estado: 'BORRADOR', moneda: 'ARS', porcentajeHonorarios: 5, montoHonorarios: new Decimal(75000), montoAlquilerBase: new Decimal(1500000), ...overrides };
  const movements = [
    { id: 1, liquidacionId: 10, tipo: 'INGRESO', concepto: 'Alquiler Mensual', moneda: 'ARS', monto: new Decimal(1500000), esParaInmobiliaria: false },
    { id: 2, liquidacionId: 10, tipo: 'INGRESO', concepto: 'Expensas', moneda: 'USD', monto: new Decimal(100), esParaInmobiliaria: false },
  ];
  const db = {
    liquidacion: {
      findUniqueOrThrow: async () => ({ ...draft }),
      updateMany: async ({ where, data }) => {
        if (where.estado !== draft.estado || where.version !== draft.version) return { count: 0 };
        Object.assign(draft, data, { version: draft.version + data.version.increment });
        return { count: 1 };
      },
      update: async ({ data }) => Object.assign(draft, data),
    },
    movimiento: {
      findMany: async ({ where }) => movements.filter(row => row.liquidacionId === where.liquidacionId && (!where.concepto || row.concepto === where.concepto)),
      update: async ({ where, data }) => Object.assign(movements.find(row => row.id === where.id), data),
    },
  };
  return { db, draft, movements };
}

test('actualizar 1.500.000 a 1.550.000 reemplaza el alquiler completo y aplica 5% al total', async () => {
  const { db, draft, movements } = draftDatabase();
  await replaceDraftMonthlyRent(db, { ...draft }, new Decimal(1550000), { alquilerExcepcional: false, motivo: 'Actualización por IPC' });
  assert.equal(draft.montoAlquilerBase.toString(), '1550000');
  assert.equal(draft.montoHonorarios.toString(), '77500');
  assert.equal(draft.netoACobrar.toString(), '1550000');
  assert.equal(draft.montoPropietario.toString(), '1472500');
  assert.equal(movements[0].monto.toString(), '1550000');
  assert.equal(movements[1].monto.toString(), '100');
  assert.equal(draft.version, 3);
});

test('una excepción manual conserva el honorario fijo y admite importes con centavos', async () => {
  const { db, draft } = draftDatabase({ porcentajeHonorarios: null, montoHonorarios: new Decimal(30000) });
  await replaceDraftMonthlyRent(db, { ...draft }, new Decimal('1550000.50'), { alquilerExcepcional: true, motivo: 'Acuerdo solo este período' });
  assert.equal(draft.montoHonorarios.toString(), '30000');
  assert.equal(draft.montoPropietario.toString(), '1520000.5');
  assert.equal(draft.alquilerExcepcional, true);
});

test('un alquiler confirmado o modificado concurrentemente no puede reemplazarse', async () => {
  const { db, draft, movements } = draftDatabase({ estado: 'CONFIRMADA' });
  await assert.rejects(replaceDraftMonthlyRent(db, { ...draft }, new Decimal(1550000), { alquilerExcepcional: false, motivo: 'Actualización IPC' }), error => error.code === 'LIQUIDATION_CHANGED');
  assert.equal(movements[0].monto.toString(), '1500000');
});
