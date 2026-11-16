const test = require('node:test');
const assert = require('node:assert/strict');
const { Decimal } = require('@prisma/client/runtime/library');
const { getOutstandingOwnerAdvances, summarizeOwnerAdvanceAging } = require('../dist/services/owner-advance.service');

test('owner advances never offset a dollar delivery with peso collections', async () => {
  const liquidation = { id: 1, contratoId: 2, moneda: 'USD', pagos: [{ monto: '100000', moneda: 'ARS' }, { monto: '0.10' }] };
  const advances = await getOutstandingOwnerAdvances({ pagoPropietario: { findMany: async () => [
    { liquidacionId: 1, liquidacion: liquidation, monto: '20.25', moneda: 'USD', fechaPago: new Date('2026-10-01') },
    { liquidacionId: 1, liquidacion: liquidation, monto: '90000', moneda: 'ARS', fechaPago: new Date('2026-10-02') },
  ] } }, 1);
  assert.equal(advances.length, 1);
  assert.equal(advances[0].moneda, 'USD');
  assert.equal(advances[0].monto.toString(), '20.15');
});

test('aging counts one liquidation once and aggregates amounts with decimal precision', () => {
  const rows = [
    { liquidacionId: 1, monto: new Decimal('0.1'), moneda: 'USD', antiguedadDias: 35 },
    { liquidacionId: 1, monto: new Decimal('100'), moneda: 'ARS', antiguedadDias: 2 },
    { liquidacionId: 2, monto: new Decimal('0.2'), moneda: 'USD', antiguedadDias: 18 },
  ];
  assert.deepEqual(summarizeOwnerAdvanceAging(rows), { cantidad: 2, porAntiguedad: { '0_15': 0, '16_30': 1, '31_mas': 1 }, porMoneda: { USD: 0.3, ARS: 100 } });
});
