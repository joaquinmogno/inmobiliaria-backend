const test = require('node:test');
const assert = require('node:assert/strict');
const { positiveMoney, nonNegativeMoney } = require('../dist/middlewares/validation.middleware');
const { movimientoSchema, honorariosSchema } = require('../dist/validation/liquidaciones.schemas');

test('money validation preserves canonical decimal amounts and rejects coercion/rounding', () => {
    for (const value of [1000.5, '1000.50', 0.01, '0.01', 99999999.99]) assert.equal(positiveMoney('Monto').parse(value), Number(value));
    for (const value of [0, -1, '-0.01', 1.001, '1.001', '1000,50', '1.000,50', '1e3', '0x10', true, null, '', ' ', [], Infinity, NaN, 100000000]) {
        assert.equal(positiveMoney('Monto').safeParse(value).success, false, String(value));
    }
    assert.equal(nonNegativeMoney('Monto').parse(0), 0);
});

test('liquidation amounts preserve cents and percentages retain their own validation', () => {
    const result = movimientoSchema.parse({ tipo: 'INGRESO', concepto: 'Centavos', monto: '1000.50', moneda: 'USD' });
    assert.equal(result.monto, 1000.5);
    assert.equal(result.moneda, 'USD');
    assert.equal(honorariosSchema.parse({ porcentajeHonorarios: 12.5, motivo: 'Prueba decimal' }).porcentajeHonorarios, 12.5);
    assert.equal(honorariosSchema.safeParse({ porcentajeHonorarios: 100.01, motivo: 'Prueba decimal' }).success, false);
});
