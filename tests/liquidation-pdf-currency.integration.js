require('./financial-request-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');

assert.match(process.env.DATABASE_URL || '', /\/propcontrol_integration(?:\?|$)/);
const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let session;

async function request(path, method = 'GET', body) {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: { cookie: session.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': session.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(path, method = 'GET', body) {
  const res = await request(path, method, body);
  const data = await res.json();
  assert.ok(res.ok, `${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function pdf(id, recipient, version) {
  const res = await request(`/liquidaciones/${id}/${recipient === 'INQUILINO' ? 'pdf' : 'pdf-propietario'}${version ? `?version=${version}` : ''}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/pdf/);
  const parsed = spawnSync('pdftotext', ['-layout', '-', '-'], { input: Buffer.from(await res.arrayBuffer()), encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
  return parsed.stdout;
}

async function createLiquidation({ moneda = 'USD', mixed = true, fees = 0 } = {}) {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Comprobante monedas ${suffix}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: 'Propietario Monedas', inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: 'Inquilino Monedas', inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', moneda,
    montoAlquiler: 1000, montoHonorarios: fees, pagaHonorarios: 'PROPIETARIO',
    fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), requiereActualizacion: false,
    modalidadCobroInquilino: 'EFECTIVO', modalidadPagoPropietario: 'EFECTIVO',
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } },
    propietarios: { create: { personaId: owner.id, esPrincipal: true } },
  } });
  let liq = await json('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-10-01' });
  if (mixed) liq = await json(`/liquidaciones/${liq.id}/movimientos`, 'POST', {
    tipo: 'INGRESO', concepto: 'EDESUR', monto: 135760, moneda: 'ARS', expectedVersion: liq.version,
  });
  return { liq, owner, contract };
}

async function confirm(liq) {
  return json(`/liquidaciones/${liq.id}/confirmar`, 'PATCH', { expectedVersion: liq.version });
}

async function pay({ liq, contract }, moneda, monto) {
  const current = await json(`/liquidaciones/${liq.id}`);
  return json('/pagos', 'POST', {
    contratoId: contract.id, liquidacionId: liq.id, moneda, monto, metodoPago: 'EFECTIVO',
    expectedLiquidationVersion: current.version,
  });
}

async function payOwner({ liq, owner }, moneda, monto) {
  const current = await json(`/liquidaciones/${liq.id}`);
  return json(`/liquidaciones/${liq.id}/pagar-propietario`, 'PATCH', {
    propietarioId: owner.id, moneda, monto, metodoPago: 'EFECTIVO', expectedVersion: current.version,
  });
}

async function latestVoucher(id) {
  return prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: id }, orderBy: { version: 'desc' } });
}

async function assertHistoryAmounts(fixture, expected) {
  const detail = await json(`/liquidaciones/${fixture.liq.id}`);
  const list = await json(`/liquidaciones?contratoId=${fixture.contract.id}`);
  const row = list.data.find(item => item.id === fixture.liq.id);
  const timeline = await json(`/liquidaciones/contrato/${fixture.contract.id}/periodos`);
  const period = timeline.periodos.find(item => item.liquidacionId === fixture.liq.id);
  assert.deepEqual(row.resumenMonedas, detail.resumenMonedas);
  assert.deepEqual(period.resumenMonedas, detail.resumenMonedas);
  assert.deepEqual(detail.resumenMonedas.map(item => [item.moneda, item.cobradoInquilino]), expected);
  for (const voucher of detail.comprobantes) {
    assert.deepEqual(voucher.importesPorMoneda.map(item => [item.moneda, item.importeCorregido]), expected);
    assert.deepEqual(voucher.importesPorMoneda.map(item => [item.moneda, item.importePropietarioCorregido]), expected);
  }
}

function assertMixedAmounts(text, recipient, ownerUsd = '1.000,00', ars = '135.760,00') {
  assert.match(text, /Alquiler Mensual\s+US\$1\.000,00/);
  assert.match(text, /EDESUR\s+\$135\.760,00/);
  assert.doesNotMatch(text, /US\$135\.760,00|US\$136\.760,00/);
  assert.match(text, /SUBTOTAL INGRESOS \(USD\)\s+US\$1\.000,00/);
  assert.match(text, /SUBTOTAL INGRESOS \(ARS\)\s+\$135\.760,00/);
  const net = recipient === 'INQUILINO' ? 'NETO A PAGAR' : 'NETO A TRANSFERIR AL PROPIETARIO';
  // El título del propietario puede ocupar dos líneas.
  const normalized = text.replace(/\s+/g, ' ');
  assert.ok(normalized.includes(`${net} (USD) US$${recipient === 'INQUILINO' ? '1.000,00' : ownerUsd}`), text);
  assert.ok(normalized.includes(`${net} (ARS) $${ars}`), text);
}

test.before(async () => {
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const auth = await res.json();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie().join(',') : res.headers.get('set-cookie');
  const token = cookies.match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(token);
  session = { cookie: `pc_session=${token}; pc_csrf=${auth.csrfToken}`, csrf: auth.csrfToken };
});
test.after(async () => prisma.$disconnect());

test('el PDF de borrador y cada versión separan alquiler USD, servicio ARS y saldos por moneda', async () => {
  const fixture = await createLiquidation();
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) assertMixedAmounts(await pdf(fixture.liq.id, recipient), recipient);
  await confirm(fixture.liq);
  const original = await latestVoucher(fixture.liq.id);
  assert.deepEqual(original.fotografia.movimientos.map(row => row.moneda).sort(), ['ARS', 'USD']);
  await pay(fixture, 'ARS', 135760);
  const partial = await latestVoucher(fixture.liq.id);
  const partialText = await pdf(fixture.liq.id, 'INQUILINO', partial.version);
  assertMixedAmounts(partialText, 'INQUILINO');
  assert.match(partialText, /EFECTIVO\s+CAJA\s+\$135\.760,00/);
  assert.match(partialText, /SALDO PENDIENTE\s+US\$1\.000,00/);
  await pay(fixture, 'USD', 1000);
  await payOwner(fixture, 'ARS', 135760);
  await payOwner(fixture, 'USD', 1000);
  await assertHistoryAmounts(fixture, [['USD', 1000], ['ARS', 135760]]);
  const full = await latestVoucher(fixture.liq.id);
  assert.deepEqual(full.fotografia.pagos.map(row => row.moneda), ['ARS', 'USD']);
  assert.deepEqual(full.fotografia.pagosPropietario.map(row => row.moneda), ['ARS', 'USD']);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(fixture.liq.id, recipient, full.version);
    assertMixedAmounts(text, recipient);
    assert.match(text, /EFECTIVO\s+CAJA\s+\$135\.760,00/);
    assert.match(text, /EFECTIVO\s+CAJA\s+US\$1\.000,00/);
    assert.doesNotMatch(text, /SALDO PENDIENTE/);
    if (recipient === 'PROPIETARIO') {
      const deliveries = text.split('ENTREGAS AL PROPIETARIO')[1];
      assert.match(deliveries, /\$135\.760,00/);
      assert.match(deliveries, /US\$1\.000,00/);
    }
  }
  const v1Text = await pdf(fixture.liq.id, 'INQUILINO', 1);
  assert.doesNotMatch(v1Text, /PAGOS REGISTRADOS/);
  assert.match(v1Text, /SALDO PENDIENTE \(USD\)\s+US\$1\.000,00/);
  assert.match(v1Text, /SALDO PENDIENTE \(ARS\)\s+\$135\.760,00/);
  assert.deepEqual(await prisma.comprobanteLiquidacion.findUniqueOrThrow({ where: { id: original.id } }), original);
});

test('los comprobantes ya emitidos recuperan la moneda aun con pagos anulados después, sin reescribir la fotografía', async () => {
  const fixture = await createLiquidation();
  await confirm(fixture.liq);
  await pay(fixture, 'ARS', 135760);
  await payOwner(fixture, 'ARS', 135760);
  const current = await latestVoucher(fixture.liq.id);
  const legacy = structuredClone(current.fotografia);
  legacy.version = current.version + 1;
  for (const key of ['movimientos', 'pagos', 'pagosPropietario']) legacy[key].forEach(row => delete row.moneda);
  const saved = await prisma.comprobanteLiquidacion.create({ data: {
    liquidacionId: fixture.liq.id, version: legacy.version, fotografia: legacy, creadoPorId: current.creadoPorId,
  } });
  // Simula el estado posterior de los registros; la fotografía sigue mostrando
  // los pagos que existían en su fecha de emisión.
  await prisma.pago.update({ where: { id: legacy.pagos[0].id }, data: { anuladoEn: new Date() } });
  await prisma.pagoPropietario.update({ where: { id: legacy.pagosPropietario[0].id }, data: { anuladoEn: new Date() } });
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(fixture.liq.id, recipient, legacy.version);
    assertMixedAmounts(text, recipient);
    assert.match(text, /EFECTIVO\s+CAJA\s+\$135\.760,00/);
    if (recipient === 'PROPIETARIO') assert.match(text.split('ENTREGAS AL PROPIETARIO')[1], /\$135\.760,00/);
  }
  assert.deepEqual(await prisma.comprobanteLiquidacion.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});

test('descuentos en pesos y honorarios en dólares conservan su moneda y los netos correctos', async () => {
  const fixture = await createLiquidation({ fees: 50 });
  fixture.liq = await json(`/liquidaciones/${fixture.liq.id}/movimientos`, 'POST', {
    tipo: 'DESCUENTO', concepto: 'Reintegro servicio', monto: 5760, moneda: 'ARS', expectedVersion: fixture.liq.version,
  });
  await confirm(fixture.liq);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(fixture.liq.id, recipient, 1);
    assertMixedAmounts(text, recipient, '950,00', '130.000,00');
    assert.match(text, /Reintegro servicio\s+\(\$5\.760,00\)/);
    assert.doesNotMatch(text, /US\$5\.760,00/);
    if (recipient === 'PROPIETARIO') assert.match(text, /Abona: PROPIETARIO\s+US\$50,00/);
  }
});

for (const moneda of ['ARS', 'USD']) test(`un comprobante sólo en ${moneda} conserva importes y símbolo`, async () => {
  const fixture = await createLiquidation({ moneda, mixed: false });
  await confirm(fixture.liq);
  await pay(fixture, moneda, 1000);
  await payOwner(fixture, moneda, 1000);
  await assertHistoryAmounts(fixture, [[moneda, 1000]]);
  const voucher = await latestVoucher(fixture.liq.id);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(fixture.liq.id, recipient, voucher.version);
    assert.match(text, moneda === 'ARS' ? /Alquiler Mensual\s+\$1\.000,00/ : /Alquiler Mensual\s+US\$1\.000,00/);
    if (moneda === 'ARS') assert.doesNotMatch(text, /US\$/);
    assert.doesNotMatch(text, /SALDO PENDIENTE/);
  }
});
