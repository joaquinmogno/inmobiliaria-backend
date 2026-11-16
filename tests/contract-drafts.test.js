const test = require('node:test');
const assert = require('node:assert/strict');

const { contractDraftWriteSchema } = require('../dist/validation/borradores-contrato.schemas.js');

const emptyDraft = {
  form: {
    address: '', floor: '', unit: '', startDate: '', endDate: '', updateDate: '',
    montoAlquiler: '', moneda: 'ARS', montoHonorarios: '', porcentajeHonorarios: '',
    porcentajeActualizacion: '', pagaHonorarios: 'INQUILINO', diaVencimiento: '10',
    modalidadCobroInquilino: '', modalidadPagoPropietario: '', cuentaCobroAcordadaId: '', serviciosGastos: [],
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


test('draft fields preserve partial service rows, account, currency and cents without coercion', () => {
  const datos = structuredClone(emptyDraft);
  Object.assign(datos.form, {
    modalidadCobroInquilino: 'TRANSFERENCIA', modalidadPagoPropietario: 'CHEQUE',
    cuentaCobroAcordadaId: '42', moneda: 'USD', montoAlquiler: '1000.25', honorarioInicial: '50.10',
    serviciosGastos: [{ concepto: '', responsable: 'INQUILINO' }, { id: 2, concepto: 'Expensas', responsable: 'PROPIETARIO' }]
  });
  assert.deepEqual(contractDraftWriteSchema.parse({ datos }).datos, datos);
});

test('legacy drafts receive only missing new fields', () => {
  const datos = structuredClone(emptyDraft);
  for (const field of ['modalidadCobroInquilino', 'modalidadPagoPropietario', 'cuentaCobroAcordadaId', 'serviciosGastos']) delete datos.form[field];
  assert.deepEqual(contractDraftWriteSchema.parse({ datos }).datos, emptyDraft);
});

test('new fields remain strictly typed and bounded', () => {
  for (const fields of [
    { modalidadCobroInquilino: 'INVALID' }, { modalidadPagoPropietario: null },
    { cuentaCobroAcordadaId: '-1' }, { serviciosGastos: Array(31).fill({ concepto: '', responsable: 'INQUILINO' }) },
    { serviciosGastos: [{ concepto: 'A'.repeat(121), responsable: 'INQUILINO' }] },
    { serviciosGastos: [{ concepto: '', responsable: 'OTRO' }] },
    { serviciosGastos: [{ concepto: '', responsable: 'INQUILINO', unexpected: true }] }, { unexpected: true }
  ]) assert.equal(contractDraftWriteSchema.safeParse({ datos: { ...emptyDraft, form: { ...emptyDraft.form, ...fields } } }).success, false);
});
