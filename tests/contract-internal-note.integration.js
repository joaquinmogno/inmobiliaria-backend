const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');

// Sólo se permite ejecutar esta suite contra la instalación descartable.
assert.match(process.env.DATABASE_URL || '', /\/propcontrol_integration(?:\?|$)/);
const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let session;

async function login(email, password) {
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const auth = await res.json();
  const cookies = res.headers.getSetCookie().join(',');
  const token = cookies.match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(token);
  return { cookie: `pc_session=${token}; pc_csrf=${auth.csrfToken}`, csrf: auth.csrfToken };
}

async function request(path, method = 'GET', body, auth = session) {
  return fetch(`${apiBase}${path}`, {
    method, headers: { cookie: auth.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': auth.csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(path, method = 'GET', body, auth = session) {
  const res = await request(path, method, body, auth);
  return { status: res.status, data: await res.json() };
}

async function detail(id, auth = session) {
  const res = await json(`/liquidaciones/${id}`, 'GET', undefined, auth);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function period(contractId, month) {
  const result = await json('/liquidaciones', 'POST', { contratoId: contractId, periodo: month });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return detail(result.data.id);
}

async function fixture(propertyId) {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = propertyId ? { id: propertyId } : await prisma.propiedad.create({ data: { direccion: `Notas internas ${suffix}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: 'Propietario Notas Internas', inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: 'Inquilino Notas Internas', inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', moneda: 'USD',
    montoAlquiler: 1000, montoHonorarios: 50, porcentajeHonorarios: 5, pagaHonorarios: 'PROPIETARIO',
    fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), requiereActualizacion: false,
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }, propietarios: { create: { personaId: owner.id, esPrincipal: true } },
  } });
  return { contract, property, liq: await period(contract.id, '2026-10-01') };
}

const save = (liq, texto, version = liq.notaInternaContrato.version, auth = session) =>
  json(`/liquidaciones/${liq.id}/nota-interna`, 'PATCH', { texto, expectedVersion: version }, auth);
const internalAudit = liq => liq.auditLogs.filter(row => row.accion.endsWith('_NOTA_INTERNA_CONTRATO'));

async function pdf(id, recipient, version) {
  const res = await request(`/liquidaciones/${id}/${recipient === 'INQUILINO' ? 'pdf' : 'pdf-propietario'}${version ? `?version=${version}` : ''}`);
  assert.equal(res.status, 200);
  const parsed = spawnSync('pdftotext', ['-', '-'], { input: Buffer.from(await res.arrayBuffer()), encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
  return parsed.stdout;
}

test.before(async () => { session = await login('admin.integration@example.com', 'ProdTest!2026_Strong'); });
test.after(async () => prisma.$disconnect());

test('una única nota se comparte con meses existentes y nuevos; al eliminarla deja de aparecer y queda en auditoría', async () => {
  const { contract, liq } = await fixture();
  const november = await period(contract.id, '2026-11-01');
  assert.equal(liq.notaInternaContrato.texto, null);
  const text = 'Pedir expensas antes de confirmar.\nConsultar uso del SUM.';
  const saved = await save(liq, `  ${text}  `);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.texto, text);
  assert.equal(saved.data.version, 2);
  assert.ok(saved.data.actualizadaEn);
  assert.equal(saved.data.actualizadaPor.nombreCompleto, 'Administrador Integration');
  for (const month of [await detail(liq.id), await detail(november.id), await period(contract.id, '2026-12-01')]) {
    assert.deepEqual(month.notaInternaContrato, saved.data);
    assert.equal(internalAudit(month).length, 1);
    assert.equal(internalAudit(month)[0].entidadId, contract.id);
  }
  const changed = await save(november, 'Recordar revisar el SUM todos los meses', saved.data.version);
  assert.equal(changed.status, 200);
  assert.equal((await detail(liq.id)).notaInternaContrato.texto, changed.data.texto);
  const noChange = await save(liq, changed.data.texto, changed.data.version);
  assert.deepEqual(noChange.data, changed.data);
  assert.equal(internalAudit(await detail(november.id)).length, 2);
  const removed = await save(november, null, changed.data.version);
  assert.equal(removed.status, 200);
  for (const month of [await detail(liq.id), await detail(november.id), await period(contract.id, '2027-01-01')]) {
    assert.equal(month.notaInternaContrato.texto, null);
    assert.equal(internalAudit(month).length, 3);
    assert.equal(internalAudit(month)[0].accion, 'ELIMINAR_NOTA_INTERNA_CONTRATO');
    assert.deepEqual(JSON.parse(internalAudit(month)[0].detalle)['Nota interna'], { anterior: changed.data.texto, nuevo: null });
  }
  const stale = await save(liq, 'No debe reaparecer', changed.data.version);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'STALE_WRITE');
  assert.equal((await detail(liq.id)).notaInternaContrato.texto, null);
});

test('la nota interna no modifica finanzas, aclaraciones, versiones ni PDFs de borradores y confirmadas', async () => {
  const { liq } = await fixture();
  const externalText = 'Aclaración para propietario e inquilino';
  const external = await json(`/liquidaciones/${liq.id}/nota`, 'PATCH', {
    notaLiquidacion: externalText, destinatarioNotaLiquidacion: 'AMBOS', expectedVersion: liq.version,
  });
  assert.equal(external.status, 200);
  const before = await prisma.liquidacion.findUniqueOrThrow({ where: { id: liq.id }, include: { movimientos: true, pagos: true } });
  const privateText = 'RECORDATORIO SOLO EQUIPO SUM 2871';
  assert.equal((await save(liq, privateText)).status, 200);
  assert.deepEqual(await prisma.liquidacion.findUniqueOrThrow({ where: { id: liq.id }, include: { movimientos: true, pagos: true } }), before);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(liq.id, recipient);
    assert.ok(text.includes(externalText));
    assert.ok(!text.includes(privateText));
    assert.doesNotMatch(text, /NOTA INTERNA/);
  }
  const confirmation = await json(`/liquidaciones/${liq.id}/confirmar`, 'PATCH', { expectedVersion: before.version });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.data));
  const confirmed = await prisma.liquidacion.findUniqueOrThrow({ where: { id: liq.id } });
  const vouchers = await prisma.comprobanteLiquidacion.findMany({ where: { liquidacionId: liq.id } });
  assert.ok(!JSON.stringify(vouchers).includes(privateText));
  const edited = await save(await detail(liq.id), `${privateText} ACTUALIZADO`);
  assert.equal(edited.status, 200);
  assert.deepEqual(await prisma.liquidacion.findUniqueOrThrow({ where: { id: liq.id } }), confirmed);
  assert.deepEqual(await prisma.comprobanteLiquidacion.findMany({ where: { liquidacionId: liq.id } }), vouchers);
  assert.equal((await detail(liq.id)).notaLiquidacion, externalText);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
    const text = await pdf(liq.id, recipient, 1);
    assert.ok(text.includes(externalText));
    assert.ok(!text.includes(privateText));
  }
  assert.equal(await prisma.movimientoCaja.count({ where: { liquidacionId: liq.id } }), 0);
});

test('dos ediciones desde meses diferentes no se pisan y rechaza datos inválidos sin cambiar la nota', async () => {
  const { liq, contract } = await fixture();
  const second = await period(contract.id, '2026-11-01');
  const results = await Promise.all([save(liq, 'Cambio desde octubre'), save(second, 'Cambio desde noviembre')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = await detail(liq.id);
  assert.equal(current.notaInternaContrato.texto, results.find(result => result.status === 200).data.texto);
  assert.equal(internalAudit(current).length, 1);
  const valid = { texto: 'Texto válido', expectedVersion: current.notaInternaContrato.version };
  for (const changes of [{ texto: 'x'.repeat(3001) }, { texto: 17 }, { expectedVersion: undefined }, { expectedVersion: 0 }, { contratoId: 99999 }]) {
    const result = await json(`/liquidaciones/${liq.id}/nota-interna`, 'PATCH', { ...valid, ...changes });
    assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  assert.equal((await json('/liquidaciones/2147483647/nota-interna', 'PATCH', valid)).status, 404);
  assert.equal((await json('/liquidaciones/invalida/nota-interna', 'PATCH', valid)).status, 400);
  assert.deepEqual((await detail(liq.id)).notaInternaContrato, current.notaInternaContrato);
});

test('sólo usuarios con edición pueden cambiar la nota y un nuevo contrato del inmueble no la hereda', async () => {
  const { liq, contract, property } = await fixture();
  assert.equal((await save(liq, 'Nota del contrato anterior')).status, 200);
  await prisma.contrato.update({ where: { id: contract.id }, data: { estado: 'FINALIZADO' } });
  const other = await fixture(property.id);
  assert.equal(other.liq.notaInternaContrato.texto, null);
  assert.equal(internalAudit(other.liq).length, 0);
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'liquidaciones.ver' } });
  const suffix = `${Date.now()}-${Math.random()}`;
  const role = await prisma.rol.create({ data: { nombre: `Lector nota interna ${suffix}`, inmobiliariaId: contract.inmobiliariaId, permisos: { create: { permisoId: permission.id } } } });
  const password = 'Internal-Note-Reader-2026!';
  const user = await prisma.usuario.create({ data: {
    email: `internal-note-${suffix}@example.test`, nombreCompleto: 'Lector de notas internas', tipo: 'USUARIO', rolId: role.id,
    inmobiliariaId: contract.inmobiliariaId, password: await bcrypt.hash(password, 10),
  } });
  const reader = await login(user.email, password);
  const visible = await detail(liq.id, reader);
  assert.equal(visible.notaInternaContrato.texto, 'Nota del contrato anterior');
  assert.equal((await save(visible, 'Cambio no autorizado', visible.notaInternaContrato.version, reader)).status, 403);
  assert.equal((await save(visible, null, visible.notaInternaContrato.version, reader)).status, 403);
  assert.equal((await detail(liq.id)).notaInternaContrato.texto, 'Nota del contrato anterior');
});
