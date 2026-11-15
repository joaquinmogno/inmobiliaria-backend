const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMovementReceiptPdf } = require('../dist/services/movement-receipt-pdf.service');
const sample = {
    formato: 1,
    emisor: { nombre: 'Inmobiliaria de prueba', cuit: '30-12345678-9', direccion: 'Cabildo 1532', contacto: 'info@example.com', logo: null },
    movimiento: { id: 10, ambito: 'TEODORO', tipo: 'EGRESO', fecha: '2026-11-12', concepto: 'Arreglo de baño', monto: '135760.25', moneda: 'ARS', metodoPago: 'EFECTIVO' },
    datos: { pagador: 'Teodoro', receptor: 'José Albañil', documentoReceptor: '20-12345678-3', inmueble: 'Cabildo 1532', descripcion: 'Arreglo del baño' }
};
const identity = { numero: 'REC-000010', version: 1, fechaEmision: new Date('2026-11-12T15:00:00Z'), estado: 'VIGENTE' };
const pages = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test('recibo breve cabe en una hoja A4, incluyendo firma y pie sin páginas vacías', async () => {
    for (const estado of ['VIGENTE', 'ANULADO', 'DESACTUALIZADO', 'REEMPLAZADO', 'BORRADOR']) {
        const pdf = await buildMovementReceiptPdf(sample, { ...identity, estado });
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        assert.equal(pages(pdf), 1, estado);
    }
});

test('descripción larga continúa en otra hoja y mantiene espacio para las firmas', async () => {
    const pdf = await buildMovementReceiptPdf({ ...sample, datos: { ...sample.datos, descripcion: 'Detalle del arreglo del baño y materiales utilizados. '.repeat(28).slice(0, 1500) } }, { ...identity, estado: 'ANULADO' });
    assert.equal(pages(pdf), 2);
});
