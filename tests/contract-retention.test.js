process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-retention-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const uploadDirectory = path.join(os.tmpdir(), `propcontrol-retention-${process.pid}`);
process.env.UPLOAD_DIR = uploadDirectory;

const { prisma } = require('../dist/prisma');
const { deleteContractPermanently } = require('../dist/services/contract-deletion.service');
const { runMaintenance } = require('../dist/services/maintenance.service');
const { optionalPhone } = require('../dist/middlewares/validation.middleware');

function mockTransaction(contract, dependencies = {}) {
  const deleted = [];
  const tx = {
    contrato: {
      findFirst: async () => contract,
      delete: async args => deleted.push(args.where.id)
    },
    liquidacion: { count: async () => dependencies.liquidaciones || 0 },
    pago: { count: async () => dependencies.pagos || 0 },
    movimientoCaja: { count: async () => dependencies.movimientosCaja || 0 },
    planCuotas: { count: async () => dependencies.planesCuotas || 0 }
  };
  return { transaction: async callback => callback(tx), deleted };
}

test('permanent deletion requires a contract in trash', async t => {
  const originalTransaction = prisma.$transaction;
  const mock = mockTransaction({ id: 12, estado: 'ACTIVO', adjuntos: [], rutaArchivoContrato: null });
  prisma.$transaction = mock.transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });

  await assert.rejects(
    () => deleteContractPermanently(12, 3),
    error => error.code === 'CONTRACT_NOT_IN_TRASH' && error.statusCode === 409
  );
  assert.deepEqual(mock.deleted, []);
});

test('financial history blocks permanent deletion', async t => {
  const originalTransaction = prisma.$transaction;
  const mock = mockTransaction(
    { id: 13, estado: 'PAPELERA', adjuntos: [], rutaArchivoContrato: null },
    { liquidaciones: 1 }
  );
  prisma.$transaction = mock.transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });

  await assert.rejects(
    () => deleteContractPermanently(13, 3),
    error => error.code === 'CONTRACT_HAS_FINANCIAL_HISTORY' && error.details.liquidaciones === 1
  );
  assert.deepEqual(mock.deleted, []);
});

test('physical contract files are removed after the database deletion', async t => {
  const originalTransaction = prisma.$transaction;
  const contractFile = 'agency-3/contract.pdf';
  const attachmentFile = 'agency-3/attachment.pdf';
  await fs.mkdir(path.join(uploadDirectory, 'agency-3'), { recursive: true });
  await fs.writeFile(path.join(uploadDirectory, contractFile), 'contract');
  await fs.writeFile(path.join(uploadDirectory, attachmentFile), 'attachment');

  const mock = mockTransaction({
    id: 14,
    estado: 'PAPELERA',
    rutaArchivoContrato: contractFile,
    adjuntos: [{ rutaArchivo: attachmentFile }]
  });
  prisma.$transaction = mock.transaction;
  t.after(async () => {
    prisma.$transaction = originalTransaction;
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  });

  const result = await deleteContractPermanently(14, 3);
  assert.deepEqual(mock.deleted, [14]);
  assert.deepEqual(result, { deletedFiles: 2 });
  await assert.rejects(() => fs.access(path.join(uploadDirectory, contractFile)));
  await assert.rejects(() => fs.access(path.join(uploadDirectory, attachmentFile)));
});

test('maintenance deletes expired sessions and old revoked sessions', async t => {
  const originalDeleteMany = prisma.userSession.deleteMany;
  const originalFindMany = prisma.contrato.findMany;
  let receivedWhere;
  prisma.userSession.deleteMany = async args => {
    receivedWhere = args.where;
    return { count: 2 };
  };
  prisma.contrato.findMany = async () => [];
  t.after(() => {
    prisma.userSession.deleteMany = originalDeleteMany;
    prisma.contrato.findMany = originalFindMany;
  });

  await runMaintenance();
  assert.ok(receivedWhere.OR[0].expiresAt.lt instanceof Date);
  assert.ok(receivedWhere.OR[1].revokedAt.lt instanceof Date);
  assert.ok(receivedWhere.OR[1].revokedAt.lt < receivedWhere.OR[0].expiresAt.lt);
});

test('Argentine phone numbers are stored in E.164 and invalid values are rejected', () => {
  assert.equal(optionalPhone().parse('11 5555-1234'), '+541155551234');
  assert.equal(optionalPhone().parse('+54 9 11 5555-1234'), '+5491155551234');
  assert.equal(optionalPhone().safeParse('123').success, false);
});
