const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');

// Esta suite sólo escribe datos ficticios en la instalación descartable.
assert.match(process.env.DATABASE_URL || '', /\/propcontrol_integration(?:\?|$)/);
const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let session;

async function login(email, password) {
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const auth = await res.json();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie().join(',') : res.headers.get('set-cookie');
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

async function pdf(id, recipient, version) {
  const res = await request(`/liquidaciones/${id}/${recipient === 'INQUILINO' ? 'pdf' : 'pdf-propietario'}${version ? `?version=${version}` : ''}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/pdf/);
  const parsed = spawnSync('pdftotext', ['-', '-'], { input: Buffer.from(await res.arrayBuffer()), encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
  return parsed.stdout;
}

async function createLiquidation(period = '2026-10-01') {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Notas ${suffix}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Dueño ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', moneda: 'USD',
    montoAlquiler: 2300, montoHonorarios: 115, porcentajeHonorarios: 5, pagaHonorarios: 'PROPIETARIO',
    fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), requiereActualizacion: false,
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }, propietarios: { create: { personaId: owner.id, esPrincipal: true } },
  } });
  const created = await json('/liquidaciones', 'POST', { contratoId: contract.id, periodo: period });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

async function saveNote(liq, text, recipient = 'AMBOS') {
  const result = await json(`/liquidaciones/${liq.id}/nota`, 'PATCH', {
    notaLiquidacion: text, destinatarioNotaLiquidacion: recipient, expectedVersion: liq.version,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.liquidacion;
}

const financialState = liq => Object.fromEntries([
  'netoACobrar', 'totalIngresos', 'totalDescuentos', 'montoAlquilerBase', 'montoHonorarios',
  'montoPropietario', 'montoPagadoPropietario', 'estado', 'estadoCobroInquilino', 'estadoPagoPropietario',
].map(key => [key, key.startsWith('estado') ? liq[key] : Number(liq[key])]));

test.before(async () => { session = await login('admin.integration@example.com', 'ProdTest!2026_Strong'); });
test.after(async () => { await prisma.$disconnect(); });

test('una nota del borrador se guarda, se imprime según destinatario y no genera movimientos ni totales', async () => {
  const original = await createLiquidation();
  const text = 'Cotización utilizada: $1.250 por dólar.\nUSD 2.300 equivale a $2.875.000.';
  let current = await saveNote(original, text);
  assert.deepEqual(financialState(current), financialState(original));
  const reloaded = await json(`/liquidaciones/${current.id}`);
  assert.equal(reloaded.data.notaLiquidacion, text);
  assert.equal(reloaded.data.comprobantes.length, 0);
  assert.equal(reloaded.data.movimientos.length, 1);
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) assert.match(await pdf(current.id, recipient), /USD 2\.300 equivale a \$2\.875\.000/);
  current = await saveNote(current, 'Aclaración solo para el propietario', 'PROPIETARIO');
  assert.doesNotMatch(await pdf(current.id, 'INQUILINO'), /Aclaración solo para el propietario|ACLARACIONES/);
  assert.match(await pdf(current.id, 'PROPIETARIO'), /Aclaración solo para el propietario/);
  current = await saveNote(current, 'Aclaración solo para el inquilino', 'INQUILINO');
  assert.match(await pdf(current.id, 'INQUILINO'), /Aclaración solo para el inquilino/);
  assert.doesNotMatch(await pdf(current.id, 'PROPIETARIO'), /Aclaración solo para el inquilino|ACLARACIONES/);
  current = await saveNote(current, null);
  assert.equal(current.notaLiquidacion, null);
  assert.doesNotMatch(await pdf(current.id, 'PROPIETARIO'), /ACLARACIONES/);
  assert.equal(await prisma.movimientoCaja.count({ where: { liquidacionId: current.id } }), 0);
});

test('editar o quitar una nota confirmada emite versiones sin modificar los comprobantes anteriores', async () => {
  const draft = await createLiquidation();
  const confirmation = await json(`/liquidaciones/${draft.id}/confirmar`, 'PATCH', { expectedVersion: draft.version });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.data));
  let current = confirmation.data;
  const original = financialState(current);
  const v1 = await prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: current.id, version: 1 } });
  current = await saveNote(current, 'Cotización exclusiva del propietario: $1.250', 'PROPIETARIO');
  let detail = (await json(`/liquidaciones/${current.id}`)).data;
  assert.equal(detail.comprobantes[0].evento, 'NOTA_LIQUIDACION');
  assert.equal(detail.comprobantes[0].version, 2);
  assert.match(await pdf(current.id, 'PROPIETARIO', 2), /Cotización exclusiva del propietario/);
  assert.doesNotMatch(await pdf(current.id, 'INQUILINO', 2), /Cotización exclusiva|ACLARACIONES/);
  assert.doesNotMatch(await pdf(current.id, 'PROPIETARIO', 1), /Cotización exclusiva|ACLARACIONES/);
  const noChange = await saveNote(current, current.notaLiquidacion, 'PROPIETARIO');
  assert.equal(noChange.version, current.version);
  assert.equal(await prisma.comprobanteLiquidacion.count({ where: { liquidacionId: current.id } }), 2);
  current = await saveNote(current, 'Nueva aclaración compartida', 'AMBOS');
  for (const recipient of ['INQUILINO', 'PROPIETARIO']) assert.match(await pdf(current.id, recipient, 3), /Nueva aclaración compartida/);
  current = await saveNote(current, null);
  assert.doesNotMatch(await pdf(current.id, 'PROPIETARIO', 4), /ACLARACIONES/);
  assert.match(await pdf(current.id, 'PROPIETARIO', 3), /Nueva aclaración compartida/);
  assert.deepEqual(await prisma.comprobanteLiquidacion.findUniqueOrThrow({ where: { id: v1.id } }), v1);
  assert.deepEqual(financialState(current), original);
  detail = (await json(`/liquidaciones/${current.id}`)).data;
  assert.equal(detail.comprobantes.length, 4);
  assert.equal(detail.movimientos.length, 1);
  assert.equal(detail.pagos.length, 0);
  assert.equal(detail.historialPagosPropietario.length, 0);
  assert.equal(await prisma.movimientoCaja.count({ where: { liquidacionId: current.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { entidad: 'Liquidacion', entidadId: current.id, accion: { in: ['GUARDAR_NOTA_LIQUIDACION', 'QUITAR_NOTA_LIQUIDACION'] } } }), 3);
});

test('validación, permisos, registros inexistentes y bloqueo de versiones y anulaciones', async () => {
  const original = await createLiquidation();
  const body = { notaLiquidacion: 'Nota de prueba', destinatarioNotaLiquidacion: 'AMBOS', expectedVersion: original.version };
  for (const override of [{ notaLiquidacion: 'a'.repeat(3001) }, { destinatarioNotaLiquidacion: 'INTERNO' }, { expectedVersion: undefined }]) {
    assert.equal((await json(`/liquidaciones/${original.id}/nota`, 'PATCH', { ...body, ...override })).status, 400);
  }
  const current = await saveNote(original, 'Nota actual');
  assert.equal((await json(`/liquidaciones/${original.id}/nota`, 'PATCH', body)).status, 409);
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'liquidaciones.ver' } });
  const suffix = `${Date.now()}-${Math.random()}`;
  const role = await prisma.rol.create({ data: { nombre: `Solo lectura notas ${suffix}`, inmobiliariaId: agency.id, permisos: { create: { permisoId: permission.id } } } });
  const password = 'Notas-Permisos-2026!';
  const reader = await prisma.usuario.create({ data: { email: `notas-${suffix}@example.test`, nombreCompleto: 'Lector de notas', tipo: 'USUARIO', rolId: role.id, inmobiliariaId: agency.id, password: await bcrypt.hash(password, 10) } });
  const readerSession = await login(reader.email, password);
  assert.equal((await json(`/liquidaciones/${original.id}/nota`, 'PATCH', { ...body, expectedVersion: current.version }, readerSession)).status, 403);
  assert.equal((await json('/liquidaciones/2147483647/nota', 'PATCH', body)).status, 404);
  await prisma.liquidacion.update({ where: { id: original.id }, data: { estado: 'ANULADA' } });
  assert.equal((await json(`/liquidaciones/${original.id}/nota`, 'PATCH', { ...body, expectedVersion: current.version })).status, 409);
  assert.equal((await prisma.liquidacion.findUniqueOrThrow({ where: { id: original.id } })).notaLiquidacion, 'Nota actual');
});

test('las notas extensas conservan saltos de línea y no se cortan en el PDF', async () => {
  const draft = await createLiquidation();
  const note = Array.from({ length: 120 }, (_, index) => `Renglón ${index + 1}`).join('\n');
  await saveNote(draft, note);
  const text = await pdf(draft.id, 'INQUILINO');
  assert.match(text, /Renglón 1\n/);
  assert.match(text, /Renglón 120/);
});
