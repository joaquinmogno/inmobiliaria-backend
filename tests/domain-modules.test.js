const test = require('node:test');
const assert = require('node:assert/strict');

const {
  contractCreateSchema,
  contractAttachmentSchema,
  normalizeContractUpdateSettings
} = require('../dist/validation/contratos.schemas.js');
const {
  liquidacionCreateSchema,
  movimientoSchema,
  ajusteLiquidacionSchema
} = require('../dist/validation/liquidaciones.schemas.js');
const {
  buildLiquidationCashConcept
} = require('../dist/services/liquidacion-financial.service.js');
const {
  calculateLiquidationAdjustment
} = require('../dist/services/liquidation-adjustment.service.js');
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

test('los ajustes documentan importes por parte y el tipo define su sentido', () => {
  const base = { concepto: 'Corrección de alquiler', motivo: 'Se corrigió un importe cargado por error' };
  assert.equal(ajusteLiquidacionSchema.safeParse({
    ...base, tipo: 'CREDITO', montoInquilino: 10000, montoPropietario: 10000
  }).success, true);
  assert.equal(ajusteLiquidacionSchema.safeParse({
    ...base, tipo: 'DEBITO', montoInquilino: -1, montoPropietario: 0
  }).success, false);
  assert.equal(ajusteLiquidacionSchema.safeParse({
    ...base, tipo: 'CREDITO', montoInquilino: 0, montoPropietario: 0
  }).success, false);
  // El formato anterior no puede seguir enviando impactos firmados sin los
  // importes documentados que los justifican.
  assert.equal(ajusteLiquidacionSchema.safeParse({
    ...base, tipo: 'CREDITO', monto: 1, impactoInquilino: -100000, impactoPropietario: -100000
  }).success, false);
});

test('el sentido contable de una nota no puede contradecir sus importes documentados', () => {
  const credit = calculateLiquidationAdjustment({
    tipo: 'CREDITO', montoInquilino: 10000, montoPropietario: 7500
  });
  assert.equal(credit.impactoInquilino.toString(), '-10000');
  assert.equal(credit.impactoPropietario.toString(), '-7500');
  assert.equal(credit.montoHistorico.toString(), '10000');

  const debit = calculateLiquidationAdjustment({
    tipo: 'DEBITO', montoInquilino: 5000, montoPropietario: 0
  });
  assert.equal(debit.impactoInquilino.toString(), '5000');
  assert.equal(debit.impactoPropietario.toString(), '0');
  assert.throws(() => calculateLiquidationAdjustment({
    tipo: 'CREDITO', montoInquilino: 0, montoPropietario: 0
  }));
});

test('los servicios documentales y financieros usan formatos argentinos estables', () => {
  assert.equal(formatDatePdf('2026-09-03'), '03/09/2026');
  assert.match(formatPeriodPdf('2026-09-01'), /septiembre.*2026/i);
  assert.match(buildLiquidationCashConcept('Pago Propietario', {
    periodo: '2026-09-01',
    contrato: { propiedad: { direccion: 'Av. Siempre Viva 742' } }
  }), /Pago Propietario - Av\. Siempre Viva 742 - Liq\. septiembre de 2026/i);
});
