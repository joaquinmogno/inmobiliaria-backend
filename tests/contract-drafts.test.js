const test = require('node:test');
const assert = require('node:assert/strict');

const { contractDraftWriteSchema } = require('../dist/validation/borradores-contrato.schemas.js');

const emptyDraft = {
  form: {
    address: '', floor: '', unit: '', startDate: '', endDate: '', updateDate: '',
    montoAlquiler: '', moneda: 'ARS', montoHonorarios: '', porcentajeHonorarios: '',
    porcentajeActualizacion: '', pagaHonorarios: 'INQUILINO', diaVencimiento: '10',
    tipoAjuste: '', observacionDocumento: '', observations: '', tipoArchivosAdicionales: 'ADJUNTO',
    administrado: true, requiereActualizacion: true, frecuenciaActualizacion: '3',
    honorarioInicial: '', monedaHonorarioInicial: 'ARS', honorarioInicialMetodoPago: '',
    honorarioInicialCuentaBancariaId: ''
  },
  selectedProperty: null,
  owners: [],
  tenants: []
};

test('a contract draft accepts incomplete data without satisfying contract creation requirements', () => {
  const parsed = contractDraftWriteSchema.safeParse({ datos: emptyDraft });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.datos.form.address, '');
  assert.deepEqual(parsed.data.datos.owners, []);
});

test('a contract draft keeps a bounded and structured payload', () => {
  const invalid = contractDraftWriteSchema.safeParse({
    datos: { ...emptyDraft, owners: [{ nombreCompleto: 'A'.repeat(141), telefono: '', unexpected: true }] }
  });

  assert.equal(invalid.success, false);
  assert.match(invalid.error.issues.map(issue => issue.message).join(' '), /140|Unrecognized key/i);
});
