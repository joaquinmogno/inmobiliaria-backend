const test = require('node:test');
const assert = require('node:assert/strict');
const { getLiquidationCurrencySummaries, getOwnerPaymentStateByCurrency, getTenantCollectionStateByCurrency } = require('../dist/services/liquidation-currency.service');
const { getTenantSettlement, getOwnerPaymentSettlement } = require('../dist/services/tenant-credit.service');
const base = { moneda: 'USD', montoHonorarios: 23, pagaHonorarios: 'PROPIETARIO', netoACobrar: 2300, montoPropietario: 2277, montoAlquilerAnticipado: 2300, movimientos: [{ tipo: 'INGRESO', monto: 2300, moneda: 'USD', esParaInmobiliaria: false }] };
test('el alquiler recibido por el propietario cancela renta, conserva honorarios y no simula caja', () => {
    const [s] = getLiquidationCurrencySummaries(base);
    assert.equal(s.saldoInquilino, 0); assert.equal(s.cobradoInquilino, 0); assert.equal(s.pagadoPropietario, 0);
    assert.equal(s.importeAEntregarPropietario, 0); assert.equal(s.saldoPropietario, 0); assert.equal(s.saldoACobrarPropietario, 23);
    assert.equal(s.capitalPropioExpuesto, 0); assert.equal(getTenantCollectionStateByCurrency(base), 'COBRADO'); assert.equal(getOwnerPaymentStateByCurrency(base), 'PENDIENTE');
    assert.equal(getTenantSettlement(base).saldo.toNumber(), 0); assert.equal(getOwnerPaymentSettlement(base).saldoACobrar.toNumber(), 23);
});
test('honorarios parciales, completos y anulados conservan estados separados', () => {
    assert.equal(getOwnerPaymentStateByCurrency({ ...base, cobradoPropietarioUSD: 10 }), 'PARCIAL');
    assert.equal(getOwnerPaymentStateByCurrency({ ...base, cobradoPropietarioUSD: 23 }), 'PAGADO');
    assert.equal(getLiquidationCurrencySummaries({ ...base, cobradoPropietarioUSD: 13 })[0].saldoACobrarPropietario, 10);
});
test('los servicios en pesos y la administración en dólares no se cancelan entre sí', () => {
    const value = { ...base, movimientos: [...base.movimientos, { tipo: 'INGRESO', monto: 80000, moneda: 'ARS', esParaInmobiliaria: false }], pagos: [{ monto: 40000, moneda: 'ARS' }], cobradoPropietarioUSD: 23 };
    const [usd, ars] = getLiquidationCurrencySummaries(value);
    assert.equal(usd.saldoACobrarPropietario, 0); assert.equal(ars.saldoInquilino, 40000); assert.equal(ars.saldoPropietario, 80000); assert.equal(ars.alquilerAnticipado, 0);
    assert.equal(getTenantCollectionStateByCurrency(value), 'PARCIAL'); assert.equal(getOwnerPaymentStateByCurrency(value), 'PARCIAL');
});
test('un gasto a cargo del propietario no desaparece aunque el alquiler esté anticipado', () => {
    const value = { ...base, movimientos: [...base.movimientos, { tipo: 'DESCUENTO', monto: 1500, moneda: 'ARS', esParaInmobiliaria: true }] };
    const [,ars] = getLiquidationCurrencySummaries(value);
    assert.equal(ars.saldoInquilino, 0); assert.equal(ars.saldoPropietario, 0); assert.equal(ars.saldoACobrarPropietario, 1500);
    assert.equal(getOwnerPaymentStateByCurrency({ ...value, cobradoPropietarioUSD: 23 }), 'PARCIAL');
});
test('una diferencia de alquiler queda pendiente y un mes fuera de cobertura conserva el flujo habitual', () => {
    const [difference] = getLiquidationCurrencySummaries({ ...base, netoACobrar: 2500, montoPropietario: 2475, montoHonorarios: 25 });
    assert.equal(difference.saldoInquilino, 200); assert.equal(difference.saldoPropietario, 200); assert.equal(difference.saldoACobrarPropietario, 25);
    const [normal] = getLiquidationCurrencySummaries({ ...base, montoAlquilerAnticipado: 0 });
    assert.equal(normal.saldoInquilino, 2300); assert.equal(normal.saldoPropietario, 2277); assert.equal(normal.saldoACobrarPropietario, 0);
});
