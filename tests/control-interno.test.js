process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'internal-control-test-session-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Prisma } = require('@prisma/client');
const { movimientoInternoSchema, filtroControlInternoSchema } = require('../dist/validation/control-interno.schemas');
const { internalMovementWhere, summarizeInternalMovements, internalReportMonthLabel, internalReportFilterLabel } = require('../dist/services/control-interno.service');
const { buildInternalExcel, buildInternalPdf } = require('../dist/services/control-interno-report.service');

const sample = (overrides = {}) => ({
  id: 1, fecha: new Date('2026-10-28T00:00:00.000Z'), tipo: 'GASTO', detalle: 'Artículos de oficina', monto: new Prisma.Decimal('25000.50'), moneda: 'ARS',
  categoria: 'Oficina', metodoPago: null, observaciones: 'Comprobante de compra', anuladoEn: null, motivoAnulacion: null,
  fechaCreacion: new Date('2026-10-28T17:00:00.000Z'), creadoPor: { id: 1, nombreCompleto: 'Jefe de inmobiliaria' }, adjuntos: [], ...overrides
});

test('el registro interno admite medio de pago y comprobantes opcionales, pero exige fecha, detalle e importe válido', () => {
  const valid = { fecha: '2026-10-28', detalle: 'Compra de insumos', monto: '25000.50' };
  const data = movimientoInternoSchema.parse(valid);
  assert.equal(data.metodoPago, undefined);
  assert.equal(data.tipo, 'GASTO');
  assert.equal(data.moneda, 'ARS');
  for (const monto of ['-1', '0', 'NaN', '12.001', 12.001]) assert.equal(movimientoInternoSchema.safeParse({ ...valid, monto }).success, false);
  assert.equal(movimientoInternoSchema.safeParse({ ...valid, fecha: '2026-02-30' }).success, false);
  assert.equal(movimientoInternoSchema.safeParse({ ...valid, detalle: ' ' }).success, false);
});

test('la consulta mensual usa límites civiles exactos y siempre pertenece a una inmobiliaria', () => {
  const where = internalMovementWhere(7, filtroControlInternoSchema.parse({ periodo: '2026-10', categoria: 'Servicios', estado: 'VIGENTES' }));
  assert.equal(where.inmobiliariaId, 7);
  assert.equal(where.fecha.gte.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(where.fecha.lt.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(where.anuladoEn, null);
  assert.equal(where.categoria, 'Servicios');
  assert.equal(filtroControlInternoSchema.safeParse({ periodo: '2026-13' }).success, false);
});

test('los totales internos separan pesos y dólares y excluyen anulados sin asientos de reversión', () => {
  const totals = summarizeInternalMovements([
    sample(), sample({ tipo: 'INGRESO', monto: '50000' }), sample({ moneda: 'USD', monto: '100.25' }),
    sample({ monto: '999999', anuladoEn: new Date() })
  ]);
  assert.deepEqual(totals, [
    { moneda: 'ARS', ingresos: 50000, gastos: 25000.5, diferencia: 24999.5 },
    { moneda: 'USD', ingresos: 0, gastos: 100.25, diferencia: -100.25 }
  ]);
});

test('los reportes identifican el mes en español, sin cambiar de mes por la zona horaria', () => {
  assert.equal(internalReportMonthLabel('2026-10'), 'Mes: Octubre 2026');
  assert.equal(internalReportMonthLabel('2027-01'), 'Mes: Enero 2027');
  assert.equal(internalReportMonthLabel('2026-12'), 'Mes: Diciembre 2026');
  assert.match(internalReportFilterLabel(filtroControlInternoSchema.parse({ periodo: '2026-10' })), /^Mes: Octubre 2026 · Estado:/);
});

test('el Excel es un XLSX real con importes numéricos, filtros, hoja de resumen y texto sin fórmulas', async () => {
  const payload = { agency: 'PropControl', filters: filtroControlInternoSchema.parse({ periodo: '2026-10' }), rows: [sample({ detalle: '=HYPERLINK("https://example.invalid","texto")' }), sample({ id: 2, monto: '90000', anuladoEn: new Date(), motivoAnulacion: 'Duplicado' })] };
  const binary = await buildInternalExcel(payload);
  assert.equal(binary.subarray(0, 2).toString(), 'PK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(binary);
  const sheet = workbook.getWorksheet('Movimientos');
  assert.equal(sheet.getCell('H6').value, 25000.5);
  assert.equal(typeof sheet.getCell('D6').value, 'string');
  assert.equal(sheet.getCell('J7').value, 'Anulado');
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.match(sheet.getCell('A2').value, /^Mes: Octubre 2026/);
  assert.equal(workbook.getWorksheet('Resumen').getCell('B1').value, 'Mes: Octubre 2026');
  assert.equal(workbook.getWorksheet('Resumen').getCell('C3').value, 25000.5);
});

test('el reporte PDF soporta varias páginas y una selección vacía', async () => {
  const filters = filtroControlInternoSchema.parse({ periodo: '2026-10' });
  for (const rows of [[], Array.from({ length: 100 }, (_, index) => sample({ id: index + 1 }))]) {
    const pdf = await buildInternalPdf({ rows, filters, agency: 'PropControl' });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    if (rows.length) assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
  }
});
