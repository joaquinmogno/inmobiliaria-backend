const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getVoucherSummary,
  readLiquidationVoucherSnapshot,
  voucherSnapshotToPdfData,
} = require('../dist/services/liquidation-voucher.service');

const snapshot = {
  schemaVersion: 1,
  version: 2,
  emitidoEn: '2026-09-24T12:00:00.000Z',
  totalesOriginales: { totalIngresos: 100000, totalDescuentos: 0, netoACobrar: 100000, montoPropietario: 90000, montoHonorarios: 10000, montoAlquilerBase: 100000 },
  liquidacion: {
    id: 154, estado: 'PENDIENTE_PAGO', periodo: '2026-09-01T00:00:00.000Z', fechaCreacion: '2026-09-01T00:00:00.000Z',
    fechaConfirmacion: '2026-09-02T00:00:00.000Z', fechaVencimiento: '2026-09-10T00:00:00.000Z', moneda: 'ARS',
    totales: { totalIngresos: 100000, totalDescuentos: 0, netoACobrar: 90000, montoPropietario: 81000, montoHonorarios: 9000, montoAlquilerBase: 90000 },
    pagaHonorarios: 'INQUILINO', porcentajeHonorarios: 10, propiedadDireccion: 'Av. Siempre Viva 123', inquilinoNombre: 'Inquilino', propietarioNombre: 'Propietario',
  },
  contrato: {
    id: 20, fechaInicio: '2026-01-01T00:00:00.000Z', fechaFin: '2027-01-01T00:00:00.000Z', fechaProximaActualizacion: null,
    requiereActualizacion: false, tipoAjuste: null, porcentajeActualizacion: null, pagaHonorarios: 'INQUILINO', propiedad: { direccion: 'Av. Siempre Viva 123' },
    inquilinos: [{ id: 1, esPrincipal: true, persona: { nombreCompleto: 'Inquilino' } }], propietarios: [{ id: 2, esPrincipal: true, persona: { nombreCompleto: 'Propietario' } }],
  },
  movimientos: [{ id: 1, tipo: 'INGRESO', concepto: 'Alquiler', monto: 100000, esParaInmobiliaria: false, observaciones: null }],
  pagos: [], aplicacionesCredito: [], deudaAnterior: { totalDeuda: 0, moneda: 'ARS', detalle: [] },
  ajustes: [{
    id: 18, tipo: 'CREDITO', concepto: 'Corrección de alquiler', motivo: 'Se incluyó un importe de más', monto: 10000,
    impactoInquilino: -10000, impactoPropietario: -9000, fechaCreacion: '2026-09-24T12:00:00.000Z',
    creadoPor: { id: 7, nombreCompleto: 'María Administración' }, creditoInquilino: null,
  }],
};

test('voucher summary preserves original, corrected totals and linked correction metadata', () => {
  const parsed = readLiquidationVoucherSnapshot(snapshot);
  const summary = getVoucherSummary({
    id: 88, version: 2, fechaEmision: new Date(snapshot.emitidoEn), creadoPor: { id: 7, nombreCompleto: 'María Administración' }, fotografia: snapshot,
  });

  assert.equal(parsed.version, 2);
  assert.equal(summary.importeOriginal, 100000);
  assert.equal(summary.importeCorregido, 90000);
  assert.equal(summary.ajustes[0].motivo, 'Se incluyó un importe de más');
  assert.equal(summary.ajustes[0].creadoPor.nombreCompleto, 'María Administración');
});

test('PDF data comes exclusively from the stored snapshot', () => {
  const data = voucherSnapshotToPdfData(readLiquidationVoucherSnapshot(snapshot));

  assert.equal(data.netoACobrar, 90000);
  assert.equal(data.contrato.propiedad.direccion, 'Av. Siempre Viva 123');
  assert.equal(data.ajustes[0].id, 18);
});
