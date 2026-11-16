process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Decimal } = require('@prisma/client/runtime/library');
const { prisma } = require('../dist/prisma');
const { getMonthlyLiquidationPreparation } = require('../dist/services/liquidation-preparation.service');

test('monthly total counts contracts, and resolved payments do not fabricate administrative closure', async t => {
  const closedAt = new Date('2026-10-31T15:00:00Z');
  const liquidation = { id: 10, moneda: 'ARS', montoPropietario: new Decimal(900), pagosPropietario: [{ monto: new Decimal(900), moneda: 'ARS' }], estado: 'CONFIRMADA', estadoCobroInquilino: 'COBRADO', estadoPagoPropietario: 'PAGADO', netoACobrar: new Decimal(1000), pagos: [{ monto: new Decimal(1000) }], fechaVencimiento: new Date('2026-10-10'), fechaLiquidacion: null, cerradoPorId: null };
  const contract = { id: 1, version: 1, moneda: 'ARS', montoAlquiler: new Decimal(1000), montoHonorarios: new Decimal(0), porcentajeHonorarios: null, diaVencimiento: 10, actualizaciones: [], inquilinos: [], propietarios: [], planesCuotas: [], decisionesLiquidacion: [], propiedad: { id: 1, direccion: 'Mismo inmueble', piso: null, departamento: null }, liquidaciones: [liquidation] };
  const originalContracts = prisma.contrato.findMany;
  const originalLiquidations = prisma.liquidacion.findMany;
  t.after(() => { prisma.contrato.findMany = originalContracts; prisma.liquidacion.findMany = originalLiquidations; });
  prisma.contrato.findMany = async () => [contract, { ...contract, id: 2, liquidaciones: [{ ...liquidation, id: 11, fechaLiquidacion: closedAt, cerradoPorId: 7 }] }, { ...contract, id: 3, liquidaciones: [{ ...liquidation, id: 12, estado: 'BORRADOR' }] }];
  prisma.liquidacion.findMany = async () => [{ ...liquidation, contratoId: 2, pagos: [] }];
  const result = await getMonthlyLiquidationPreparation(1, new Date('2026-10-01'));
  assert.equal(result.resumen.total, 3, 'three contracts, even if all reference one property');
  assert.equal(result.resumen.finalizadas, 2);
  assert.equal(result.resumen.borradores, 1);
  assert.equal(result.resumen.moraHoy, 1);
  assert.equal(result.data[0].fechaLiquidacion, null);
  assert.equal(result.data[0].cerradoPorId, null);
  assert.equal(result.data[1].fechaLiquidacion, closedAt);
  assert.equal(result.data[1].cerradoPorId, 7);
});
