process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-contract-rent-update-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Decimal } = require('@prisma/client/runtime/library');
const { prisma } = require('../dist/prisma');
const { auditService } = require('../dist/services/audit.service');
const routes = require('../dist/routes/contratos.routes').default;
const { getEffectiveRentForPeriod } = require('../dist/services/liquidacion-financial.service');

function mockDatabase() {
  const contract = { id: 1, inmobiliariaId: 1, version: 1, moneda: 'ARS', montoAlquiler: new Decimal(1500000), montoHonorarios: new Decimal(75000), porcentajeHonorarios: new Decimal(5), requiereActualizacion: true, fechaProximaActualizacion: new Date('2026-10-01T00:00:00.000Z') };
  const drafts = ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'].map((period, index) => ({
    id: index + 1, contratoId: 1, inmobiliariaId: 1, version: 1, estado: 'BORRADOR', moneda: 'ARS', periodo: new Date(`${period}T00:00:00.000Z`),
    alquilerExcepcional: index === 2, montoAlquilerBase: new Decimal(1500000), montoHonorarios: new Decimal(75000), porcentajeHonorarios: new Decimal(5), pagaHonorarios: 'PROPIETARIO'
  }));
  const movements = drafts.map(draft => ({ id: draft.id, liquidacionId: draft.id, tipo: 'INGRESO', concepto: 'Alquiler Mensual', monto: draft.montoAlquilerBase, moneda: 'ARS', esParaInmobiliaria: false }));
  const updates = [];
  const matches = (row, where) => row.contratoId === where.contratoId && row.inmobiliariaId === where.inmobiliariaId && row.estado === where.estado && (!where.periodo?.gte || row.periodo >= where.periodo.gte) && (where.alquilerExcepcional === undefined || row.alquilerExcepcional === where.alquilerExcepcional);
  prisma.contrato = {
    findFirst: async () => ({ ...contract }),
    findUniqueOrThrow: async () => ({ ...contract }),
    updateMany: async ({ where, data }) => {
      if (where.version !== contract.version) return { count: 0 };
      Object.assign(contract, data, { version: contract.version + data.version.increment });
      return { count: 1 };
    }
  };
  prisma.actualizacionContrato = { create: async ({ data }) => { updates.push(data); return data; } };
  prisma.liquidacion = {
    findFirst: async ({ where }) => drafts.find(row => matches(row, where)) || null,
    findMany: async ({ where }) => drafts.filter(row => matches(row, where)).map(row => ({ ...row })),
    findUniqueOrThrow: async ({ where }) => ({ ...drafts.find(row => row.id === where.id) }),
    updateMany: async ({ where, data }) => {
      const row = drafts.find(row => row.id === where.id && row.version === where.version && row.estado === where.estado);
      if (!row) return { count: 0 };
      Object.assign(row, data, { version: row.version + data.version.increment });
      return { count: 1 };
    },
    update: async ({ where, data }) => Object.assign(drafts.find(row => row.id === where.id), data)
  };
  prisma.movimiento = {
    findMany: async ({ where }) => movements.filter(row => row.liquidacionId === where.liquidacionId && (!where.concepto || row.concepto === where.concepto)),
    update: async ({ where, data }) => Object.assign(movements.find(row => row.id === where.id), data)
  };
  prisma.$transaction = async callback => callback(prisma);
  auditService.log = async () => ({});
  return { contract, drafts, movements, updates };
}

async function requestUpdate(body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, tipo: 'ADMIN', inmobiliariaId: 1 };
    req.sessionId = 1;
    next();
  });
  app.use('/api/contratos', routes);
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contratos/1/actualizar`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('actualizar desde el contrato recalcula borradores completos y conserva excepciones y períodos anteriores', async () => {
  const { contract, drafts, movements, updates } = mockDatabase();
  const response = await requestUpdate({ montoNuevo: 1550000, fechaProximaNueva: '2027-01-01', observaciones: 'Actualización por IPC', version: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(contract.montoAlquiler.toString(), '1550000');
  assert.equal(contract.montoHonorarios.toString(), '77500');
  for (const index of [1, 3]) {
    assert.equal(drafts[index].montoAlquilerBase.toString(), '1550000');
    assert.equal(drafts[index].montoHonorarios.toString(), '77500');
    assert.equal(drafts[index].montoPropietario.toString(), '1472500');
    assert.equal(movements[index].monto.toString(), '1550000');
  }
  for (const index of [0, 2]) assert.equal(drafts[index].montoAlquilerBase.toString(), '1500000');
  assert.equal(updates[0].fechaVigencia.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(getEffectiveRentForPeriod(contract.montoAlquiler, [{ ...updates[0], fechaActualizacion: new Date() }], new Date('2026-09-01T00:00:00.000Z')).toString(), '1500000');
});

test('un comprobante confirmado impide actualizar retroactivamente su alquiler desde el contrato', async () => {
  const { contract, drafts, updates } = mockDatabase();
  drafts[1].estado = 'CONFIRMADA';
  const response = await requestUpdate({ montoNuevo: 1550000, fechaProximaNueva: '2027-01-01', version: 1 });
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.equal(response.data.code, 'CONFIRMED_RENT_PERIOD_REQUIRES_REVIEW');
  assert.equal(contract.montoAlquiler.toString(), '1500000');
  assert.equal(updates.length, 0);
});
