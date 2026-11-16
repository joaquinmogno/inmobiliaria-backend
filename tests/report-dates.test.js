const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { execFileSync, spawnSync } = require('node:child_process');
const { formatArgentinaDateTime } = require('../dist/utils/argentina-date');
const { buildInternalExcel } = require('../dist/services/control-interno-report.service');
const { buildMovementReceiptPdf } = require('../dist/services/movement-receipt-pdf.service');

const cases = [
  ['2026-11-10T11:55:24.000Z', '10/11/2026 08:55:24'],
  ['2026-11-10T23:55:24.000Z', '10/11/2026 20:55:24'],
  ['2026-11-11T02:59:59.000Z', '10/11/2026 23:59:59'],
  ['2026-11-11T03:00:00.000Z', '11/11/2026 00:00:00']
];

test('emisión y auditoría usan reloj de 24 horas independiente de la zona del servidor', () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      for (const [date, expected] of cases) {
        assert.equal(formatArgentinaDateTime(date, true), expected);
        assert.equal(formatArgentinaDateTime(new Date(date)), expected.slice(0, -3));
      }
    }
    assert.equal(formatArgentinaDateTime('incorrecta'), '-');
    assert.equal(formatArgentinaDateTime(null), '-');
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('XLSX de los tres módulos conserva fecha operativa y hora de carga completa en Buenos Aires', async () => {
  for (const title of ['Control interno', 'Teodoro', 'Daniel']) {
    const rows = cases.map(([date], index) => ({
      id: index + 1, fecha: new Date('2026-11-10T00:00:00Z'), fechaCreacion: new Date(date),
      tipo: 'GASTO', detalle: 'Prueba de horario', monto: '135760.25', moneda: 'ARS',
      creadoPor: { nombreCompleto: 'Operador' }, adjuntos: [], anuladoEn: null
    }));
    const buffer = await buildInternalExcel({ rows, filters: { periodo: '2026-11', estado: 'VIGENTES' }, agency: 'PropControl', title });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Movimientos');
    assert.match(sheet.getCell('A3').value, /Buenos Aires, 24 h/);
    cases.forEach(([, expected], index) => {
      assert.equal(sheet.getCell(`N${index + 6}`).value, expected);
      assert.equal(sheet.getCell(`B${index + 6}`).value.toISOString(), '2026-11-10T00:00:00.000Z');
      assert.equal(sheet.getCell(`H${index + 6}`).value, 135760.25);
    });
  }
});

test('recibo PDF coincide con pantalla para emisiones de mañana, noche y cambio de día', { skip: spawnSync('pdftotext', ['-v']).status !== 0 }, async () => {
  const snapshot = {
    formato: 1, emisor: { nombre: 'PropControl' },
    movimiento: { id: 1, ambito: 'TEODORO', tipo: 'EGRESO', fecha: '2026-11-10', concepto: 'Reparación', monto: '135760.25', moneda: 'ARS', metodoPago: 'EFECTIVO' },
    datos: { pagador: 'Teodoro', receptor: 'Proveedor', descripcion: 'Reparación' }
  };
  for (const [date, expected] of cases) {
    const pdf = await buildMovementReceiptPdf(snapshot, { numero: 'REC-000001', version: 1, estado: 'VIGENTE', fechaEmision: new Date(date) });
    const text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf }).toString();
    assert.match(text, /EMITIDO/);
    assert.ok(text.includes(`${expected.slice(0, -3)} · Hora de Buenos Aires`), text);
    assert.match(text, /Hora de Buenos Aires/);
    assert.match(text, /FECHA DEL PAGO/);
    assert.match(text, /10\/11\/2026/);
    assert.match(text, /135\.760,25/);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  }
});
