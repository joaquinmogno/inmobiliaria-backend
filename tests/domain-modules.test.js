const test = require('node:test');
const assert = require('node:assert/strict');

const {
  contractCreateSchema,
  contractAttachmentSchema,
  normalizeContractUpdateSettings
} = require('../dist/validation/contratos.schemas.js');
const {
  liquidacionCreateSchema,
  movimientoSchema
} = require('../dist/validation/liquidaciones.schemas.js');
const {
  buildLiquidationCashConcept
} = require('../dist/services/liquidacion-financial.service.js');
const {
  formatDatePdf,
  formatPeriodPdf
} = require('../dist/services/liquidacion-pdf.service.js');

test('el esquema de contratos concentra y valida las reglas de entrada', () => {
  const parsed = contractCreateSchema.safeParse({
    fechaInicio: '2026-09-01',
    fechaFin: '2027-08-31',
    fechaActualizacion: '2026-12-01',
    propiedadId: 1,
    propietarioIds: [2],
    inquilinoIds: [3],
    montoAlquiler: 500000,
    requiereActualizacion: true
  });
  assert.equal(parsed.success, true);

  const invalid = contractCreateSchema.safeParse({
    fechaInicio: '2027-09-01',
    fechaFin: '2026-08-31',
    propiedadId: 1,
    propietarioIds: [2],
    inquilinoIds: [3],
    montoAlquiler: 500000,
    requiereActualizacion: true
  });
  assert.equal(invalid.success, false);
  assert.ok(invalid.error.issues.some(issue => issue.path.includes('fechaFin')));
  assert.ok(invalid.error.issues.some(issue => issue.path.includes('fechaActualizacion')));
});

test('la política de actualización limpia campos cuando no hay ajustes', () => {
  assert.deepEqual(normalizeContractUpdateSettings({
    requiereActualizacion: false,
    fechaActualizacion: '2026-12-01',
    porcentajeActualizacion: 10,
    tipoAjuste: 'IPC'
  }), {
    requiereActualizacion: false,
    fechaProximaActualizacion: null,
    porcentajeActualizacion: null,
    tipoAjuste: null
  });
});

test('los adjuntos del contrato distinguen adendas y no permiten subir un principal por esta vía', () => {
  assert.equal(contractAttachmentSchema.safeParse({ tipo: 'ADENDA', fechaDocumento: '2026-09-24' }).success, true);
  assert.equal(contractAttachmentSchema.safeParse({ tipo: 'CONTRATO_PRINCIPAL' }).success, false);
});

test('los esquemas de liquidación protegen período y movimientos', () => {
  assert.equal(liquidacionCreateSchema.safeParse({ contratoId: 1, periodo: '2026-09-01' }).success, true);
  assert.equal(liquidacionCreateSchema.safeParse({ contratoId: 1, periodo: '2026-09-15' }).success, false);
  assert.equal(movimientoSchema.safeParse({ tipo: 'INGRESO', concepto: 'Alquiler', monto: 1 }).success, true);
  assert.equal(movimientoSchema.safeParse({ tipo: 'INGRESO', concepto: '', monto: -1 }).success, false);
});

test('los servicios documentales y financieros usan formatos argentinos estables', () => {
  assert.equal(formatDatePdf('2026-09-03'), '03/09/2026');
  assert.match(formatPeriodPdf('2026-09-01'), /septiembre.*2026/i);
  assert.match(buildLiquidationCashConcept('Pago Propietario', {
    periodo: '2026-09-01',
    contrato: { propiedad: { direccion: 'Av. Siempre Viva 742' } }
  }), /Pago Propietario - Av\. Siempre Viva 742 - Liq\. septiembre de 2026/i);
});
