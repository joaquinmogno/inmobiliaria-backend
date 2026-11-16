require('./financial-request-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');
const { getAccruedFinancialReport, getMonthlyReportPeriod } = require('../dist/services/financial-reporting.service');
assert.match(process.env.DATABASE_URL || '', /127\.0\.0\.1:55433\/propcontrol_integration(?:\?|$)/);
const base = 'http://127.0.0.1:3100/api';
let headers;
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
test.before(async () => {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  const cookie = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1];
  headers = { cookie: `pc_session=${cookie}; pc_csrf=${data.csrfToken}`, 'x-csrf-token': data.csrfToken, 'content-type': 'application/json' };
});
test.after(() => prisma.$disconnect());
async function fixture(moneda, rent, fees = 0, movements = []) {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Conciliación ${suffix}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', moneda, montoAlquiler: rent, montoHonorarios: fees,
    pagaHonorarios: 'PROPIETARIO', fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), requiereActualizacion: false,
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }, propietarios: { create: { personaId: owner.id, esPrincipal: true } }
  } });
  let liq = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-11-01' });
  for (const movement of movements) liq = await api(`/liquidaciones/${liq.id}/movimientos`, 'POST', { ...movement, expectedVersion: liq.version });
  liq = await api(`/liquidaciones/${liq.id}/confirmar`, 'PATCH', { expectedVersion: liq.version });
  return { contract, liq, owner, agency };
}
async function collect(f, moneda, monto, fechaPago = '2026-11-10') {
  return api('/pagos', 'POST', { contratoId: f.contract.id, liquidacionId: f.liq.id, moneda, monto, fechaPago, metodoPago: 'EFECTIVO' });
}
const income = (moneda, monto) => ({ tipo: 'INGRESO', concepto: 'Concepto de conciliación', moneda, monto });
async function projections(f) {
  const detail = await api(`/liquidaciones/${f.liq.id}`);
  const history = await api(`/liquidaciones?contratoId=${f.contract.id}`);
  const preparation = await api('/liquidaciones/preparacion?periodo=2026-11-01');
  const timeline = await api(`/liquidaciones/contrato/${f.contract.id}/periodos`);
  assert.deepEqual(history.data[0].resumenMonedas, detail.resumenMonedas);
  assert.deepEqual(preparation.data.find(row => row.contratoId === f.contract.id).resumenMonedas, detail.resumenMonedas);
  assert.deepEqual(timeline.periodos.find(row => row.liquidacionId === f.liq.id).resumenMonedas, detail.resumenMonedas);
  return detail;
}

test('informe: documentos, resúmenes, deuda secundaria y movimientos vinculados concilian por moneda', async () => {
  const initial = await api('/reportes/dashboard');
  const initialCash = await api('/cajachica/resumen?mes=11&anio=2026');
  const a = await fixture('USD', 1000, 0, [income('ARS', 135760)]);
  await fixture('USD', 1400);
  await fixture('USD', 1000);
  const qa = await fixture('ARS', 100000, 10000, [income('ARS', 20000), { tipo: 'DESCUENTO', concepto: 'Descuento', moneda: 'ARS', monto: 5000 }, income('USD', 100)]);
  const confirmed = await projections(qa);
  const documentVersion = await prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: qa.liq.id }, orderBy: { version: 'asc' } });
  const snapshot = JSON.stringify(documentVersion.fotografia);
  assert.deepEqual(confirmed.resumenMonedas.map(s => [s.moneda, s.netoACobrar, s.montoPropietario]), [['ARS', 115000, 105000], ['USD', 100, 100]]);
  const dashboard = await api('/reportes/dashboard');
  assert.equal(dashboard.finanzas.devengado.porMoneda.ARS.facturado - initial.finanzas.devengado.porMoneda.ARS.facturado, 250760);
  assert.equal(dashboard.finanzas.devengado.porMoneda.USD.facturado - initial.finanzas.devengado.porMoneda.USD.facturado, 3500);

  const arsPayment = await collect(qa, 'ARS', 115000);
  // Reproduce estados históricos desactualizados sin tocar los importes.
  await prisma.liquidacion.update({ where: { id: qa.liq.id }, data: { estadoCobroInquilino: 'COBRADO', estadoPagoPropietario: 'PAGADO' } });
  // Aun cuando los pesos están saldados, la deuda USD tiene que seguir visible.
  const owing = await api(`/liquidaciones?contratoId=${qa.contract.id}&soloDeuda=true&limit=1&page=1`);
  assert.equal(owing.meta.total, 1);
  assert.equal(owing.meta.totalPages, 1);
  assert.equal(owing.data[0].estadoCobroInquilino, 'PARCIAL');
  assert.equal(owing.data[0].estadoPagoPropietario, 'PENDIENTE');
  assert.equal((await api(`/liquidaciones?contratoId=${qa.contract.id}&soloDeuda=true&limit=1&page=2`)).data.length, 0);
  const secondaryDebt = await api(`/pagos/deuda/contrato/${qa.contract.id}`);
  assert.deepEqual(secondaryDebt.porMoneda, [{ moneda: 'ARS', monto: 0 }, { moneda: 'USD', monto: 100 }]);
  const monthly = await api('/liquidaciones/preparacion?periodo=2026-11-01');
  assert.equal(monthly.data.find(row => row.contratoId === qa.contract.id).estadoCobroInquilino, 'PARCIAL');
  const periods = await api(`/liquidaciones/contrato/${qa.contract.id}/periodos`);
  assert.equal(periods.periodos.find(row => row.liquidacionId === qa.liq.id).estado, 'EN_MORA');
  const dashboardWithDebt = await api('/reportes/dashboard');
  assert.equal(dashboardWithDebt.operacion.cobrosPendientes - initial.operacion.cobrosPendientes, 4);
  assert.equal((await api(`/liquidaciones?contratoId=${a.contract.id}&moneda=ARS`)).meta.total, 1);
  const usdPayment = await collect(qa, 'USD', 100);
  await api(`/liquidaciones/${qa.liq.id}/pagar-propietario`, 'PATCH', { propietarioId: qa.owner.id, moneda: 'ARS', monto: 50000, fechaPago: '2026-11-10', metodoPago: 'EFECTIVO' });
  const paid = await projections(qa);
  assert.deepEqual(paid.resumenMonedas.map(s => [s.moneda, s.cobradoInquilino, s.saldoInquilino, s.pagadoPropietario, s.saldoPropietario]), [['ARS', 115000, 0, 50000, 55000], ['USD', 100, 0, 0, 100]]);
  assert.equal((await api(`/liquidaciones?contratoId=${qa.contract.id}&soloDeuda=true`)).meta.total, 0);
  for (const payment of [arsPayment.pagos[0], usdPayment.pagos[0]]) {
    const movement = await prisma.movimientoCaja.findUniqueOrThrow({ where: { pagoId: payment.id } });
    assert.equal(movement.moneda, payment.moneda);
    assert.equal(movement.monto.toString(), payment.monto);
    assert.equal(movement.tipo, 'INGRESO');
  }
  const payout = await prisma.pagoPropietario.findFirstOrThrow({ where: { liquidacionId: qa.liq.id } });
  const cash = await prisma.movimientoCaja.findMany({ where: { contratoId: qa.contract.id, esPagoPropietario: true } });
  assert.equal(cash.length, 1);
  assert.equal(cash[0].moneda, payout.moneda);
  assert.equal(cash[0].monto.toString(), payout.monto.toString());
  assert.equal(cash[0].tipo, 'EGRESO');
  const report = await getAccruedFinancialReport(prisma, qa.agency.id, getMonthlyReportPeriod(2026, 11));
  assert.equal(report.porMoneda.ARS.pagadoPropietarios - initial.finanzas.devengado.porMoneda.ARS.pagadoPropietarios, 50000);
  assert.equal(JSON.stringify((await prisma.comprobanteLiquidacion.findUniqueOrThrow({ where: { id: documentVersion.id } })).fotografia), snapshot);

  // Una anulación vuelve a abrir sólo la moneda correspondiente y conserva Caja por contrapartida.
  await api(`/pagos/${usdPayment.pagos[0].id}/anular`, 'POST', { motivo: 'Prueba de conciliación por moneda' });
  const reversed = await projections(qa);
  assert.equal(reversed.resumenMonedas.find(s => s.moneda === 'USD').saldoInquilino, 100);
  assert.equal(reversed.resumenMonedas.find(s => s.moneda === 'ARS').saldoInquilino, 0);
  const original = await prisma.movimientoCaja.findUniqueOrThrow({ where: { pagoId: usdPayment.pagos[0].id }, include: { reversion: true } });
  assert.equal(original.reversion.moneda, 'USD');
  assert.equal(original.reversion.monto.toString(), '100');
  assert.equal(original.reversion.tipo, 'EGRESO');
  const reconciledCash = await api('/cajachica/resumen?mes=11&anio=2026');
  assert.equal(reconciledCash.totalesPorMoneda.ARS.totalCobrado - initialCash.totalesPorMoneda.ARS.totalCobrado, 115000);
  assert.equal(reconciledCash.totalesPorMoneda.ARS.totalPagadoPropietarios - initialCash.totalesPorMoneda.ARS.totalPagadoPropietarios, 50000);
  assert.equal(reconciledCash.totalesPorMoneda.USD.totalCobrado - initialCash.totalesPorMoneda.USD.totalCobrado, 0);
});

test('moneda única con centavos y cobro de otro mes: devengado y caja conservan criterios diferentes', async () => {
  const f = await fixture('USD', 100.25);
  const receipt = await collect(f, 'USD', 0.10, '2026-10-30');
  const detail = await projections(f);
  assert.equal(detail.resumenMonedas.length, 1);
  assert.equal(detail.resumenMonedas[0].saldoInquilino, 100.15);
  const movement = await prisma.movimientoCaja.findUniqueOrThrow({ where: { pagoId: receipt.pagos[0].id } });
  assert.equal(movement.fecha.toISOString().slice(0, 7), '2026-10');
  assert.equal(detail.periodo.slice(0, 7), '2026-11');
  assert.equal(movement.monto.toString(), '0.1');
});
