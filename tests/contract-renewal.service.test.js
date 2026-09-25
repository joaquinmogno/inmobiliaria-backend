const test = require('node:test');
const assert = require('node:assert/strict');

const { AppError } = require('../dist/errors/app-error.js');
const { prisma } = require('../dist/prisma.js');
const {
  assertValidContractRenewal,
  getContractRenewalTimeline
} = require('../dist/services/contract-renewal.service.js');
const { contractCreateSchema } = require('../dist/validation/contratos.schemas.js');

const endOfPreviousContract = new Date('2026-12-31T00:00:00.000Z');
const validRenewalInput = {
  contratoAnteriorId: 12,
  inmobiliariaId: 1,
  propiedadId: 4,
  fechaInicio: new Date('2027-01-01T00:00:00.000Z')
};

test('a renewal source must belong to the same property and can have only one successor', async () => {
  const source = {
    id: 12,
    propiedadId: 4,
    estado: 'FINALIZADO',
    fechaFin: endOfPreviousContract,
    fechaRescision: null,
    contratoRenovado: null
  };
  const tx = { contrato: { findFirst: async () => source } };

  assert.equal((await assertValidContractRenewal(tx, validRenewalInput)).id, 12);

  await assert.rejects(
    () => assertValidContractRenewal(tx, { ...validRenewalInput, propiedadId: 9 }),
    error => error instanceof AppError && error.code === 'RENEWAL_PROPERTY_MISMATCH'
  );

  source.contratoRenovado = { id: 13 };
  await assert.rejects(
    () => assertValidContractRenewal(tx, validRenewalInput),
    error => error instanceof AppError && error.code === 'CONTRACT_ALREADY_RENEWED'
  );
});

test('a renewal must start after the effective end of the previous contract', async () => {
  const tx = {
    contrato: {
      findFirst: async () => ({
        id: 12,
        propiedadId: 4,
        estado: 'RESCINDIDO',
        fechaFin: endOfPreviousContract,
        fechaRescision: new Date('2026-08-15T00:00:00.000Z'),
        contratoRenovado: null
      })
    }
  };

  await assert.rejects(
    () => assertValidContractRenewal(tx, { ...validRenewalInput, fechaInicio: new Date('2026-08-15T00:00:00.000Z') }),
    error => error instanceof AppError && error.code === 'INVALID_RENEWAL_DATES'
  );
});

test('the timeline returns the full predecessor and successor chain in chronological order', async t => {
  const originalFindFirst = prisma.contrato.findFirst;
  const record = (id, contratoAnteriorId) => ({
    id,
    contratoAnteriorId,
    fechaInicio: new Date(`202${id}-01-01T00:00:00.000Z`),
    fechaFin: new Date(`202${id}-12-31T00:00:00.000Z`),
    fechaRescision: null,
    estado: id === 2 ? 'ACTIVO' : 'FINALIZADO',
    montoAlquiler: String(id * 100000),
    moneda: 'ARS',
    propiedad: { direccion: 'Av. Renovación 123', piso: null, departamento: null },
    inquilinos: [{ persona: { nombreCompleto: 'Inquilino de prueba' } }]
  });
  const records = [record(1, null), record(2, 1), record(3, 2)];
  prisma.contrato.findFirst = async ({ where }) => {
    if (where.id) return records.find(item => item.id === where.id) || null;
    if (where.contratoAnteriorId) return records.find(item => item.contratoAnteriorId === where.contratoAnteriorId) || null;
    return null;
  };
  t.after(() => { prisma.contrato.findFirst = originalFindFirst; });

  const timeline = await getContractRenewalTimeline(1, 2);
  assert.deepEqual(timeline.map(item => item.id), [1, 2, 3]);
  assert.equal(timeline[1].inquilinoPrincipal, 'Inquilino de prueba');
});

test('the creation schema accepts an optional previous-contract reference', () => {
  const parsed = contractCreateSchema.safeParse({
    fechaInicio: '2027-01-01',
    fechaFin: '2027-12-31',
    fechaActualizacion: '2027-04-01',
    propiedadId: 4,
    propietarioIds: [2],
    inquilinoIds: [3],
    montoAlquiler: 500000,
    requiereActualizacion: true,
    contratoAnteriorId: '12'
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.contratoAnteriorId, 12);
});
