const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateAccruedReport,
  calculateCashLedger,
  getAccruedFinancialReport,
  getCashLedgerReport,
  getMonthlyReportPeriod,
} = require('../dist/services/financial-reporting.service');

test('cash ledger excludes future movements from a historical closing and records reversals in their own month', () => {
  const august = getMonthlyReportPeriod(2026, 8);
  const september = getMonthlyReportPeriod(2026, 9);
  const movements = [
    {
      tipo: 'INGRESO', monto: 100, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-08-15T00:00:00.000Z'),
      pagoId: 1, pagoSueldoId: null, esPagoPropietario: false,
    },
    // Corrección de un asiento de agosto cerrado: es una salida real de septiembre.
    {
      tipo: 'EGRESO', monto: 100, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-09-02T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: false,
      reversionDe: { pagoId: 1, pagoSueldoId: null, esPagoPropietario: false },
    },
    {
      tipo: 'INGRESO', monto: 50, moneda: 'ARS', cuenta: 'BANCO', fecha: new Date('2026-09-10T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: false,
    },
    {
      tipo: 'INGRESO', monto: 999, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-10-01T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: false,
    },
  ];

  const augustLedger = calculateCashLedger(movements, august);
  assert.equal(augustLedger.saldoAlCierre.ARS.saldo, 100);
  assert.equal(augustLedger.saldoAlCierre.ARS.cobrosInquilinos, 100);
  assert.equal(augustLedger.movimientosDelPeriodo.ARS.egresos, 0);

  const septemberLedger = calculateCashLedger(movements, september);
  assert.equal(septemberLedger.movimientosDelPeriodo.ARS.egresos, 100);
  assert.equal(septemberLedger.movimientosDelPeriodo.ARS.cobrosInquilinos, -100);
  assert.equal(septemberLedger.movimientosDelPeriodo.ARS.ingresos, 50);
  assert.equal(septemberLedger.saldoAlCierre.ARS.saldo, 50);
});

test('cash ledger excludes an annulled owner payment together with its same-month reversal', () => {
  const september = getMonthlyReportPeriod(2026, 9);
  const annulledAt = new Date('2026-09-24T12:00:00.000Z');
  const report = calculateCashLedger([
    {
      tipo: 'EGRESO', monto: 100, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-09-05T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true,
    },
    {
      // Segunda entrega anulada: no puede quedar restada si su reversión ya
      // repuso los fondos. Es la regresión del caso de pagos parciales.
      tipo: 'EGRESO', monto: 25, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-09-08T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true, anuladoEn: annulledAt,
    },
    {
      tipo: 'INGRESO', monto: 25, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-09-24T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true,
      reversionDe: { pagoId: null, pagoSueldoId: null, esPagoPropietario: true, anuladoEn: annulledAt },
    },
  ], september);

  assert.equal(report.movimientosDelPeriodo.ARS.pagosPropietarios, 100);
  assert.equal(report.movimientosDelPeriodo.ARS.egresos, 100);
  assert.equal(report.movimientosDelPeriodo.ARS.ingresos, 0);
  assert.equal(report.saldoAlCierre.ARS.saldo, -100);
});

test('cash ledger excludes the whole pair when a total owner payout is annulled in the same month', () => {
  const september = getMonthlyReportPeriod(2026, 9);
  const annulledAt = new Date('2026-09-24T12:00:00.000Z');
  const report = calculateCashLedger([
    {
      tipo: 'EGRESO', monto: 125, moneda: 'ARS', cuenta: 'BANCO', fecha: new Date('2026-09-08T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true, anuladoEn: annulledAt,
    },
    {
      tipo: 'INGRESO', monto: 125, moneda: 'ARS', cuenta: 'BANCO', fecha: new Date('2026-09-24T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true,
      reversionDe: { pagoId: null, pagoSueldoId: null, esPagoPropietario: true, anuladoEn: annulledAt },
    },
  ], september);

  assert.equal(report.movimientosDelPeriodo.ARS.pagosPropietarios, 0);
  assert.equal(report.movimientosDelPeriodo.ARS.ingresos, 0);
  assert.equal(report.movimientosDelPeriodo.ARS.egresos, 0);
  assert.equal(report.saldoAlCierre.ARS.saldo, 0);
});

test('cash ledger preserves a closed-period payout and records its correction in the current period', () => {
  const august = getMonthlyReportPeriod(2026, 8);
  const september = getMonthlyReportPeriod(2026, 9);
  const movements = [
    {
      // El original no se anula porque agosto ya fue conciliado y cerrado.
      tipo: 'EGRESO', monto: 125, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-08-15T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true,
    },
    {
      tipo: 'INGRESO', monto: 25, moneda: 'ARS', cuenta: 'CAJA', fecha: new Date('2026-09-24T00:00:00.000Z'),
      pagoId: null, pagoSueldoId: null, esPagoPropietario: true,
      reversionDe: { pagoId: null, pagoSueldoId: null, esPagoPropietario: true, anuladoEn: null },
    },
  ];

  const augustLedger = calculateCashLedger(movements, august);
  assert.equal(augustLedger.saldoAlCierre.ARS.pagosPropietarios, 125);
  assert.equal(augustLedger.saldoAlCierre.ARS.saldo, -125);

  const septemberLedger = calculateCashLedger(movements, september);
  assert.equal(septemberLedger.movimientosDelPeriodo.ARS.pagosPropietarios, -25);
  assert.equal(septemberLedger.movimientosDelPeriodo.ARS.ingresos, 25);
  assert.equal(septemberLedger.saldoAlCierre.ARS.pagosPropietarios, 100);
  assert.equal(septemberLedger.saldoAlCierre.ARS.saldo, -100);
});

test('cash ledger query retains originals only to classify their reversals economically', async () => {
  let query;
  await getCashLedgerReport({
    movimientoCaja: {
      findMany: async (args) => {
        query = args;
        return [];
      },
    },
  }, 77, getMonthlyReportPeriod(2026, 9));

  assert.equal(query.where.inmobiliariaId, 77);
  assert.equal(query.where.anuladoEn, undefined);
  assert.deepEqual(query.where.fecha, { lt: new Date('2026-10-01T00:00:00.000Z') });
  assert.equal(query.select.anuladoEn, true);
  assert.equal(query.select.reversionDe.select.anuladoEn, true);
});

test('accrued report uses liquidation period and payment application only to expose its outstanding balance', () => {
  const report = calculateAccruedReport([
    {
      estado: 'CONFIRMADA',
      moneda: 'ARS',
      netoACobrar: 100,
      montoPropietario: 85,
      pagos: [{ monto: 60 }],
      aplicacionesCredito: [{ monto: 10 }],
    },
  ], getMonthlyReportPeriod(2026, 8));

  assert.equal(report.porMoneda.ARS.facturado, 100);
  assert.equal(report.porMoneda.ARS.honorariosDevengados, 15);
  assert.equal(report.porMoneda.ARS.cobradoAplicado, 70);
  assert.equal(report.porMoneda.ARS.saldoPendienteInquilinos, 30);
});

test('accrued report includes only confirmed liquidations', () => {
  const report = calculateAccruedReport([
    {
      estado: 'BORRADOR', moneda: 'ARS', netoACobrar: 100, montoPropietario: 85,
      pagos: [], aplicacionesCredito: []
    },
    {
      estado: 'ANULADA', moneda: 'ARS', netoACobrar: 200, montoPropietario: 170,
      pagos: [], aplicacionesCredito: []
    },
    {
      estado: 'CONFIRMADA', moneda: 'ARS', netoACobrar: 300, montoPropietario: 255,
      pagos: [{ monto: 100 }], aplicacionesCredito: []
    },
  ], getMonthlyReportPeriod(2026, 8));

  assert.equal(report.porMoneda.ARS.facturado, 300);
  assert.equal(report.porMoneda.ARS.honorariosDevengados, 45);
  assert.equal(report.porMoneda.ARS.importePropietariosDevengado, 255);
  assert.equal(report.porMoneda.ARS.cobradoAplicado, 100);
  assert.equal(report.porMoneda.ARS.saldoPendienteInquilinos, 200);
});

test('accrued report query explicitly requests only confirmed liquidations', async () => {
  let query;
  await getAccruedFinancialReport({
    liquidacion: {
      findMany: async (args) => {
        query = args;
        return [];
      },
    },
  }, 77, getMonthlyReportPeriod(2026, 8));

  assert.equal(query.where.inmobiliariaId, 77);
  assert.equal(query.where.estado, 'CONFIRMADA');
  assert.deepEqual(query.where.periodo, {
    gte: new Date('2026-08-01T00:00:00.000Z'),
    lt: new Date('2026-09-01T00:00:00.000Z'),
  });
});
