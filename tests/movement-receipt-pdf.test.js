const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { buildMovementReceiptPdf } = require('../dist/services/movement-receipt-pdf.service');
const { receiptFinancialContext } = require('../dist/services/movement-receipt.service');
const { base: sample, identity, examples, liquidation } = require('./fixtures/receipt-design');
const parse = pdf => execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8' });
const parseRaw = pdf => execFileSync('pdftotext', ['-raw', '-', '-'], { input: pdf, encoding: 'utf8' });
const pages = pdf => parse(pdf).split('\f').filter(page => page.trim());
const normalized = text => text.replace(/\s+/g, '');

function assertPrintBounds(pdf) {
    const xml = execFileSync('pdftotext', ['-bbox', '-', '-'], { input: pdf, encoding: 'utf8' });
    for (const match of xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
        const [x1, y1, x2, y2] = match.slice(1, 5).map(Number);
        assert.ok(x1 >= 41 && x2 <= 554 && y1 >= 35 && y2 <= 813, `Fuera del área imprimible: ${match[5]} (${x1},${y1},${x2},${y2})`);
    }
}

test('recibo breve A4: datos completos, participantes en su dirección y firma en una hoja', async () => {
    for (const estado of ['VIGENTE', 'ANULADO', 'DESACTUALIZADO', 'REEMPLAZADO', 'BORRADOR']) {
        const pdf = await buildMovementReceiptPdf(sample, { ...identity, estado });
        const sheets = pages(pdf);
        assert.equal(sheets.length, 1, estado);
        const text = normalized(sheets[0]);
        for (const value of [sample.emisor.nombre, sample.emisor.direccion, sample.emisor.contacto, sample.datos.pagador, sample.datos.receptor, sample.datos.documentoReceptor, sample.datos.inmueble, sample.datos.descripcion, '150.000,00', '(ARS)', '15/11/2026', 'Firma de quien recibe', 'Aclaración y DNI/CUIT', 'Página 1 de 1']) assert.ok(text.includes(normalized(value)), value);
        assert.equal((sheets[0].match(/VISTA PREVIA/g) || []).length, estado === 'BORRADOR' ? 1 : 0);
        if (estado !== 'BORRADOR') assert.match(sheets[0], /REC-000021/);
        assertPrintBounds(pdf);
    }
});

test('concepto multipágina: no se pierde texto y las firmas acompañan las últimas líneas', async () => {
    for (const estado of ['ANULADO', 'BORRADOR']) {
        const description = Array.from({ length: 40 }, (_, i) => `Tarea ${i + 1}: material y mano de obra.`).join('\n');
        const pdf = await buildMovementReceiptPdf({ ...sample, datos: { ...sample.datos, descripcion: description } }, { ...identity, estado });
        const sheets = pages(pdf);
        assert.equal(sheets.length, 2);
        for (const line of description.split('\n')) assert.ok(normalized(sheets.join(' ')).includes(normalized(line)), line);
        sheets.forEach((page, i) => {
            assert.ok(page.includes(`Página ${i + 1} de 2`));
            assert.equal((page.match(estado === 'BORRADOR' ? /VISTA PREVIA/g : /ANULADO/g) || []).length, 1);
        });
        assert.match(sheets.at(-1), /Tarea 40/);
        assert.match(sheets.at(-1), /Firma de quien recibe/);
        assertPrintBounds(pdf);
    }
});

test('ejemplos de nombres extensos, parciales y monedas se imprimen sin desbordes', async () => {
    for (const item of examples) {
        const pdf = await buildMovementReceiptPdf(item.snapshot, item.identity);
        const text = normalized(parseRaw(pdf));
        for (const value of [item.snapshot.datos.pagador, item.snapshot.datos.receptor, ...item.snapshot.datos.descripcion.split('\n')]) assert.ok(text.includes(normalized(value)), item.name);
        assertPrintBounds(pdf);
    }
});

test('identificadores sin espacios, centavos máximos y logo corrupto conservan los datos', async () => {
    const data = { ...sample, emisor: { ...sample.emisor, logo: 'imagen invalida', cuit: '30-12345678-9' }, movimiento: { ...sample.movimiento, monto: '999999999999.99', moneda: 'USD' }, datos: { ...sample.datos, pagador: 'P'.repeat(180), receptor: 'R'.repeat(180), descripcion: 'X'.repeat(1500), documentoReceptor: '9'.repeat(40), inmueble: 'I'.repeat(255) } };
    const pdf = await buildMovementReceiptPdf(data, identity);
    const text = normalized(parseRaw(pdf));
    for (const value of [data.datos.pagador, data.datos.receptor, data.datos.inmueble, data.datos.documentoReceptor, '999.999.999.999,99', '(USD)', '30-12345678-9']) assert.ok(text.includes(normalized(value)), value.slice(0,40));
    assert.equal((text.match(/X/g) || []).length, 1500, 'El concepto sin espacios se conserva incluso al cambiar de hoja');
    assertPrintBounds(pdf);
});

test('contexto financiero reutiliza totales por moneda y diferencia al inquilino del propietario', async () => {
    const tenant = receiptFinancialContext(liquidation, 'COBRO_INQUILINO', identity.fechaEmision);
    const owner = receiptFinancialContext(liquidation, 'PAGO_PROPIETARIO', identity.fechaEmision);
    assert.deepEqual(tenant.monedas, [
        { moneda: 'USD', total: '100.00', registrado: '100.00', creditoAplicado: '0.00', pendiente: '0.00' },
        { moneda: 'ARS', total: '115000.00', registrado: '50000.25', creditoAplicado: '0.00', pendiente: '64999.75' }
    ]);
    assert.deepEqual(owner.monedas, [
        { moneda: 'USD', total: '100.00', registrado: '0.00', creditoAplicado: '0.00', pendiente: '100.00' },
        { moneda: 'ARS', total: '105000.00', registrado: '50000.00', creditoAplicado: '0.00', pendiente: '55000.00' }
    ]);
    const withCredit = receiptFinancialContext({ ...liquidation, pagos: [...liquidation.pagos, { monto: '999', moneda: 'ARS', anuladoEn: new Date() }], aplicacionesCredito: [{ monto: '1000.25', creditoInquilino: { moneda: 'ARS' } }] }, 'COBRO_INQUILINO');
    assert.equal(withCredit.monedas.find(row => row.moneda === 'ARS').pendiente, '63999.50');
    const historic = parse(await buildMovementReceiptPdf(sample, identity));
    assert.doesNotMatch(historic, /Pendiente|Total a cobrar|Total propietario|Saldo/);
});
