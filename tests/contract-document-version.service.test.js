const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrincipalContractDocument } = require('../dist/services/contract-document-version.service');

test('a replacement creates a new current version and preserves the previous document', async () => {
  const calls = { updateMany: [], create: [] };
  const tx = {
    adjuntoContrato: {
      findFirst: async args => {
        assert.equal(args.where.contratoId, 154);
        assert.equal(args.where.tipo, 'CONTRATO_PRINCIPAL');
        return { versionDocumento: 2 };
      },
      updateMany: async args => calls.updateMany.push(args),
      create: async args => {
        calls.create.push(args);
        return { id: 19, ...args.data };
      }
    }
  };

  const document = await createPrincipalContractDocument(tx, {
    contratoId: 154,
    rutaArchivo: 'agency-3/contracts/renewed-contract.pdf',
    nombreArchivo: 'contrato-renovado.pdf',
    observacion: 'Reemplaza la versión firmada previamente',
    creadoPorId: 7
  });

  assert.deepEqual(calls.updateMany[0], {
    where: { contratoId: 154, tipo: 'CONTRATO_PRINCIPAL', esVigente: true },
    data: { esVigente: false }
  });
  assert.equal(calls.create[0].data.versionDocumento, 3);
  assert.equal(calls.create[0].data.esVigente, true);
  assert.equal(calls.create[0].data.tipo, 'CONTRATO_PRINCIPAL');
  assert.equal(calls.create[0].data.creadoPorId, 7);
  assert.equal(document.rutaArchivo, 'agency-3/contracts/renewed-contract.pdf');
  assert.ok(calls.create[0].data.fechaDocumento instanceof Date);
});
