const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildInternalPdf } = require('../dist/services/control-interno-report.service');

const sample = (index, overrides = {}) => ({
    id: index + 1, fecha: new Date('2026-11-10T00:00:00Z'), tipo: 'GASTO', detalle: `Movimiento-${String(index + 1).padStart(3, '0')}`,
    monto: '1000.50', moneda: 'ARS', categoria: 'Administración', metodoPago: 'EFECTIVO', cuentaPago: null,
    creadoPor: { nombreCompleto: 'Usuario de prueba' }, adjuntos: [], anuladoEn: null, ...overrides
});
const filters = { periodo: '2026-11', estado: 'VIGENTES' };
const pageCount = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
const popplerAvailable = spawnSync('pdftotext', ['-v']).status === 0;
const outputDir = process.env.PDF_REPORT_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'propcontrol-monthly-pdf-'));
fs.mkdirSync(outputDir, { recursive: true });
test.after(() => { if (!process.env.PDF_REPORT_ARTIFACT_DIR) fs.rmSync(outputDir, { recursive: true, force: true }); });

async function report(name, rows, options = {}) {
    const pdf = await buildInternalPdf({ rows, filters, agency: 'PropControl', ...options });
    const file = path.join(outputDir, `${name}.pdf`);
    fs.writeFileSync(file, pdf);
    return { pdf, file };
}

function inspect(file, pdf) {
    const pages = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\f').filter(page => page.trim());
    assert.equal(pages.length, pageCount(pdf));
    pages.forEach((page, index) => {
        assert.match(page, /PropControl/);
        assert.match(page, /Mes: Noviembre 2026/);
        assert.match(page, /Fecha\s+Tipo\s+Detalle/);
        assert.equal((page.match(/Página \d+ de \d+/g) || []).length, 1, `Un pie por página: ${index + 1}`);
        assert.ok(page.includes(`Página ${index + 1} de ${pages.length}`));
        assert.match(page, /Movimiento-|No hay movimientos|TOTALES DE MOVIMIENTOS|continuación/, 'Cada página debe tener contenido además del encabezado y pie');
    });
    const bbox = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
    for (const word of bbox.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
        assert.ok(Number(word[1]) >= 37.5, `Margen izquierdo: ${word[5]}`);
        assert.ok(Number(word[3]) <= 804.4, `Margen derecho: ${word[5]}`);
        assert.ok(Number(word[2]) >= 33, `Margen superior: ${word[5]}`);
        assert.ok(Number(word[4]) <= 569, `Margen inferior: ${word[5]}`);
        assert.ok(Number(word[2]) >= 559 || Number(word[4]) <= 536, `El contenido invade el espacio del pie: ${word[5]}`);
    }
    return pages;
}

test('PDF mensual: 0, 1 y 3 movimientos caben en una página en los tres ámbitos', async () => {
    for (const title of ['Finanzas Ricardo', 'Teodoro', 'Daniel']) {
        for (const count of [0, 1, 3]) {
            const { pdf } = await report(`${title}-${count}`, Array.from({ length: count }, (_, i) => sample(i)), { title });
            assert.equal(pageCount(pdf), 1, `${title}: ${count} movimientos`);
        }
    }
});

test('PDF mensual: páginas, columnas, totales y centavos se conservan con 0, 1, 3, 30 y 125 filas', { skip: !popplerAvailable && 'Requiere pdftotext (Poppler)' }, async () => {
    for (const count of [0, 1, 3, 30, 125]) {
        const rows = Array.from({ length: count }, (_, i) => sample(i, {
            moneda: i % 2 ? 'USD' : 'ARS',
            anuladoEn: i === 2 ? new Date() : null,
            // Check the rightmost column and a wrapped bank reference.
            adjuntos: Array.from({ length: 12 }, () => ({ nombreArchivo: 'comprobante.pdf' })),
            cuentaPago: i === 1 ? 'Banco de prueba · Cuenta de administración de alquileres' : null
        }));
        const { pdf, file } = await report(`rows-${count}`, rows, { filters: { ...filters, estado: 'TODOS' } });
        const pages = inspect(file, pdf);
        if (count > 3) assert.ok(pages.length > 1);
        const allText = pages.join('\n');
        rows.forEach(row => assert.equal(allText.split(row.detalle).length - 1, 1, row.detalle));
        assert.equal((allText.match(/TOTALES DE MOVIMIENTOS VIGENTES/g) || []).length, 1);
        const totalsPage = pages.find(page => page.includes('TOTALES DE MOVIMIENTOS VIGENTES'));
        assert.match(totalsPage, /ARS\s+Ingresos:/);
        assert.match(totalsPage, /USD\s+Ingresos:/);
        if (count === 3) {
            // The third ARS row is annulled: it must not increase the totals.
            assert.match(totalsPage, /ARS\s+Ingresos: \$0,00\s+Gastos: \$1\.000,50\s+Diferencia: \$-1\.000,50/);
            assert.match(totalsPage, /USD\s+Ingresos: US\$0,00\s+Gastos: US\$1\.000,50/);
        }
    }
});

test('PDF mensual: texto extenso, referencias sin espacios, importes máximos y fila que ocupa varias páginas', { skip: !popplerAvailable && 'Requiere pdftotext (Poppler)' }, async () => {
    const rows = [
        sample(0, { detalle: 'Movimiento-001 ' + 'Descripción extensa del servicio prestado en el inmueble. '.repeat(4), categoria: 'Categoría de gastos de administración '.repeat(2), cuentaPago: 'REFERENCIA'.repeat(22), monto: '999999999999.99', creadoPor: { nombreCompleto: 'Responsable de administración con nombre completo extenso' } }),
        sample(1, { detalle: ['Movimiento-002', ...Array.from({ length: 120 }, (_, i) => `Línea-${String(i).padStart(3, '0')}`), 'FIN-DETALLE'].join('\n'), moneda: 'USD' }),
        sample(2)
    ];
    const { pdf, file } = await report('long-content', rows, { filters: { ...filters, search: 'Búsqueda con texto extenso '.repeat(8) } });
    const pages = inspect(file, pdf);
    assert.ok(pages.length >= 3);
    const allText = pages.join('\n');
    assert.match(allText, /continuación/);
    for (let i = 0; i < 120; i++) assert.equal(allText.split(`Línea-${String(i).padStart(3, '0')}`).length - 1, 1);
    assert.match(allText, /FIN-DETALLE/);
    assert.match(allText, /Movimiento-003/);
    assert.match(allText, /\$999\.999\.999\.999,99/);
});
