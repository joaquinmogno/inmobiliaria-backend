const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const safeFailureStatuses = new Set([400, 401, 403, 404, 409, 413, 422, 429]);
let requestCounter = 1;

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return values.map(value => value.split(';')[0]).filter(Boolean).join('; ');
}

async function jsonRequest(baseUrl, path, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-forwarded-for': `10.20.${Math.floor(requestCounter / 250)}.${(requestCounter++ % 249) + 1}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, payload, response };
}

test('campaña destructiva HTTP y concurrencia', { timeout: 120_000 }, async t => {
  process.env.NODE_ENV = 'test';
  process.env.FRONTEND_URL = 'http://127.0.0.1:5173';
  const app = require('../dist/app').default;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const agency = await prisma.inmobiliaria.create({ data: { nombre: `QA Destructiva ${Date.now()}` } });
  const password = 'Destructive!2026_Strong';
  const owner = await prisma.usuario.create({
    data: {
      email: `qa.owner.${Date.now()}@example.com`,
      password: await bcrypt.hash(password, 4),
      nombreCompleto: 'QA Owner Destructivo',
      rol: 'OWNER',
      inmobiliariaId: agency.id,
      mustChangePassword: false
    }
  });
  const employee = await prisma.usuario.create({
    data: {
      email: `qa.employee.${Date.now()}@example.com`,
      password: await bcrypt.hash(password, 4),
      nombreCompleto: 'QA Employee',
      rol: 'AGENTE',
      inmobiliariaId: agency.id,
      mustChangePassword: false
    }
  });

  const login = await jsonRequest(baseUrl, '/api/auth/login', { method: 'POST', body: { email: owner.email, password } });
  assert.equal(login.status, 200);
  const cookie = cookieHeader(login.response);
  const csrf = login.payload.csrfToken;
  const auth = { cookie, csrf };

  const loginCases = [
    ['email ausente', { password }], ['password ausente', { email: owner.email }], ['objeto vacío', {}],
    ['email null', { email: null, password }], ['password null', { email: owner.email, password: null }],
    ['email numérico', { email: 12, password }], ['password numérico', { email: owner.email, password: 12 }],
    ['email inválido', { email: 'no-es-email', password }], ['email con NUL', { email: 'a\0@b.com', password }],
    ['email enorme', { email: `${'a'.repeat(255)}@x.com`, password }], ['password vacío', { email: owner.email, password: '' }],
    ['password enorme', { email: owner.email, password: 'x'.repeat(129) }], ['array', []],
    ['string', 'credenciales'], ['booleano', true]
  ];
  for (const [name, body] of loginCases) {
    await t.test(`auth rechaza ${name}`, async () => {
      const result = await jsonRequest(baseUrl, '/api/auth/login', { method: 'POST', body });
      assert.ok(safeFailureStatuses.has(result.status), `status inesperado ${result.status}`);
    });
  }

  const protectedRoutes = [
    '/api/propiedades', '/api/personas', '/api/contratos', '/api/contratos/alertas', '/api/liquidaciones',
    '/api/liquidaciones/filtros', '/api/pagos', '/api/cajachica', '/api/cajachica/resumen', '/api/sueldos',
    '/api/usuarios', '/api/usuarios/opciones', '/api/inmobiliaria/me', '/api/inmobiliaria/logs', '/api/reportes/dashboard'
  ];
  for (const path of protectedRoutes) {
    await t.test(`sin sesión bloquea ${path}`, async () => {
      const result = await jsonRequest(baseUrl, path);
      assert.ok(result.status === 401 || result.status === 403, `status inesperado ${result.status}`);
    });
  }

  const csrfCases = [
    ['crear propiedad', '/api/propiedades', 'POST', { direccion: 'CSRF 1' }],
    ['crear persona', '/api/personas', 'POST', { nombreCompleto: 'CSRF Persona' }],
    ['crear caja', '/api/cajachica', 'POST', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-01-01' }],
    ['crear sueldo', '/api/sueldos', 'POST', { usuarioId: employee.id, monto: 1, fecha: '2026-01-01', periodo: '2026-01' }],
    ['crear liquidación', '/api/liquidaciones', 'POST', { contratoId: 1, periodo: '2026-01-01' }],
    ['crear plan', '/api/planes-cuotas', 'POST', {}],
    ['editar propiedad', '/api/propiedades/1', 'PUT', { direccion: 'x' }],
    ['eliminar propiedad', '/api/propiedades/1', 'DELETE'],
    ['cerrar sesión', '/api/auth/logout', 'POST'],
    ['cambiar contraseña', '/api/auth/change-password', 'POST', { currentPassword: password, newPassword: 'Another!2026_Strong' }]
  ];
  for (const [name, path, method, body] of csrfCases) {
    await t.test(`CSRF bloquea ${name}`, async () => {
      const result = await jsonRequest(baseUrl, path, { method, body, cookie });
      assert.equal(result.status, 403);
    });
  }

  await t.test('JSON mayor a 10 KB se rechaza sin 500', async () => {
    const result = await jsonRequest(baseUrl, '/api/propiedades', { method: 'POST', body: { direccion: 'x', observaciones: 'x'.repeat(20_000) }, ...auth });
    assert.notEqual(result.status, 500, JSON.stringify(result.payload));
    assert.ok(result.status === 400 || result.status === 413);
  });

  for (const [name, size, filename, type] of [
    ['archivo de 31 MB', 31 * 1024 * 1024, 'huge.pdf', 'application/pdf'],
    ['ejecutable renombrado', 32, 'malware.exe', 'application/octet-stream'],
    ['PDF vacío', 0, 'empty.pdf', 'application/pdf']
  ]) {
    await t.test(`upload rechaza ${name}`, async () => {
      const form = new FormData();
      form.append('pdf', new Blob([new Uint8Array(size)], { type }), filename);
      const response = await fetch(`${baseUrl}/api/contratos`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, 'x-forwarded-for': `10.30.0.${requestCounter++}` },
        body: form
      });
      assert.notEqual(response.status, 500);
      assert.ok([400, 413, 415].includes(response.status), `status inesperado ${response.status}`);
    });
  }

  const invalidBodies = [
    ...[
      ['sin dirección', {}], ['dirección vacía', { direccion: '' }], ['dirección espacios', { direccion: '   ' }],
      ['dirección null', { direccion: null }], ['dirección numérica', { direccion: 4 }],
      ['dirección enorme', { direccion: 'x'.repeat(181) }], ['tipo inválido', { direccion: 'x', tipo: 'GALPON' }],
      ['estado inválido', { direccion: 'x', estado: 'BORRADA' }], ['observación enorme', { direccion: 'x', observaciones: 'x'.repeat(1001) }],
      ['array como body', []]
    ].map(([name, body]) => [`propiedad ${name}`, '/api/propiedades', body]),
    ...[
      ['sin nombre', {}], ['nombre vacío', { nombreCompleto: '' }], ['nombre espacios', { nombreCompleto: '  ' }],
      ['nombre null', { nombreCompleto: null }], ['nombre numérico', { nombreCompleto: 1 }],
      ['nombre enorme', { nombreCompleto: 'x'.repeat(181) }], ['email inválido', { nombreCompleto: 'Persona', email: 'x' }],
      ['estado inválido', { nombreCompleto: 'Persona', estado: 'BORRADO' }], ['teléfono inválido', { nombreCompleto: 'Persona', telefono: 'abc' }],
      ['array como body', []]
    ].map(([name, body]) => [`persona ${name}`, '/api/personas', body]),
    ...[
      ['vacía', {}], ['monto cero', { tipo: 'INGRESO', concepto: 'x', monto: 0, fecha: '2026-01-01' }],
      ['monto negativo', { tipo: 'INGRESO', concepto: 'x', monto: -1, fecha: '2026-01-01' }],
      ['monto NaN', { tipo: 'INGRESO', concepto: 'x', monto: 'NaN', fecha: '2026-01-01' }],
      ['monto infinito', { tipo: 'INGRESO', concepto: 'x', monto: 'Infinity', fecha: '2026-01-01' }],
      ['monto enorme', { tipo: 'INGRESO', concepto: 'x', monto: '999999999999999999', fecha: '2026-01-01' }],
      ['tipo inválido', { tipo: 'ROBO', concepto: 'x', monto: 1, fecha: '2026-01-01' }],
      ['concepto vacío', { tipo: 'INGRESO', concepto: '', monto: 1, fecha: '2026-01-01' }],
      ['concepto enorme', { tipo: 'INGRESO', concepto: 'x'.repeat(256), monto: 1, fecha: '2026-01-01' }],
      ['fecha imposible', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-02-30' }],
      ['fecha texto', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: 'mañana' }],
      ['moneda inválida', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-01-01', moneda: 'EUR' }],
      ['cuenta inválida', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-01-01', cuenta: 'CRIPTO' }],
      ['método inválido', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-01-01', metodoPago: 'BITCOIN' }],
      ['observación enorme', { tipo: 'INGRESO', concepto: 'x', monto: 1, fecha: '2026-01-01', observaciones: 'x'.repeat(1001) }]
    ].map(([name, body]) => [`caja ${name}`, '/api/cajachica', body]),
    ...[
      ['vacío', {}], ['usuario cero', { usuarioId: 0, monto: 1, fecha: '2026-01-01', periodo: '2026-01' }],
      ['usuario negativo', { usuarioId: -1, monto: 1, fecha: '2026-01-01', periodo: '2026-01' }],
      ['monto cero', { usuarioId: employee.id, monto: 0, fecha: '2026-01-01', periodo: '2026-01' }],
      ['monto negativo', { usuarioId: employee.id, monto: -1, fecha: '2026-01-01', periodo: '2026-01' }],
      ['fecha imposible', { usuarioId: employee.id, monto: 1, fecha: '2026-02-30', periodo: '2026-01' }],
      ['periodo inválido', { usuarioId: employee.id, monto: 1, fecha: '2026-01-01', periodo: 'enero' }],
      ['moneda inválida', { usuarioId: employee.id, monto: 1, fecha: '2026-01-01', periodo: '2026-01', moneda: 'EUR' }],
      ['método inválido', { usuarioId: employee.id, monto: 1, fecha: '2026-01-01', periodo: '2026-01', metodoPago: 'ORO' }],
      ['observación enorme', { usuarioId: employee.id, monto: 1, fecha: '2026-01-01', periodo: '2026-01', observaciones: 'x'.repeat(1001) }]
    ].map(([name, body]) => [`sueldo ${name}`, '/api/sueldos', body]),
    ...[
      ['vacía', {}], ['contrato cero', { contratoId: 0, periodo: '2026-01-01' }],
      ['contrato negativo', { contratoId: -1, periodo: '2026-01-01' }], ['contrato texto', { contratoId: 'x', periodo: '2026-01-01' }],
      ['periodo imposible', { contratoId: 1, periodo: '2026-02-30' }], ['periodo texto', { contratoId: 1, periodo: 'enero' }],
      ['honorario negativo', { contratoId: 1, periodo: '2026-01-01', montoHonorarios: -1 }],
      ['porcentaje negativo', { contratoId: 1, periodo: '2026-01-01', porcentajeHonorarios: -1 }],
      ['porcentaje enorme', { contratoId: 1, periodo: '2026-01-01', porcentajeHonorarios: 100000 }],
      ['cuotas repetidas', { contratoId: 1, periodo: '2026-01-01', cuotasIds: [1, 1] }]
    ].map(([name, body]) => [`liquidación ${name}`, '/api/liquidaciones', body]),
    ...[
      ['vacío', {}], ['email inválido', { email: 'x', nombreCompleto: 'QA', rol: 'AGENTE' }],
      ['nombre vacío', { email: `x${Date.now()}@x.com`, nombreCompleto: '', rol: 'AGENTE' }],
      ['rol inválido', { email: `x${Date.now()}@x.com`, nombreCompleto: 'QA', rol: 'SUPERADMIN' }],
      ['permiso inventado', { email: `x${Date.now()}@x.com`, nombreCompleto: 'QA', rol: 'AGENTE', permissions: ['root.all'] }],
      ['denegación inventada', { email: `x${Date.now()}@x.com`, nombreCompleto: 'QA', rol: 'AGENTE', deniedPermissions: ['root.all'] }],
      ['email enorme', { email: `${'x'.repeat(250)}@x.com`, nombreCompleto: 'QA', rol: 'AGENTE' }],
      ['nombre enorme', { email: `x${Date.now()}@x.com`, nombreCompleto: 'x'.repeat(121), rol: 'AGENTE' }],
      ['permissions no array', { email: `x${Date.now()}@x.com`, nombreCompleto: 'QA', rol: 'AGENTE', permissions: 'x' }],
      ['body array', []]
    ].map(([name, body]) => [`usuario ${name}`, '/api/usuarios', body])
  ];

  for (const [name, path, body] of invalidBodies) {
    await t.test(`rechaza ${name}`, async () => {
      const result = await jsonRequest(baseUrl, path, { method: 'POST', body, ...auth });
      assert.notEqual(result.status, 500, JSON.stringify(result.payload));
      assert.ok(safeFailureStatuses.has(result.status), `entrada inválida aceptada con ${result.status}: ${JSON.stringify(result.payload)}`);
    });
  }

  const invalidIds = ['0', '-1', 'abc', '1.5', '999999999', 'NaN'];
  const idRoutes = [
    ['propiedad', id => `/api/propiedades/${id}`, 'DELETE'],
    ['persona', id => `/api/personas/${id}`, 'DELETE'],
    ['contrato', id => `/api/contratos/${id}`, 'DELETE'],
    ['liquidación', id => `/api/liquidaciones/${id}`, 'DELETE']
  ];
  for (const [entity, pathFor, method] of idRoutes) {
    for (const id of invalidIds) {
      await t.test(`${entity} tolera ID hostil ${id} sin 500`, async () => {
        const result = await jsonRequest(baseUrl, pathFor(id), { method, ...auth });
        assert.notEqual(result.status, 500, JSON.stringify(result.payload));
        assert.ok(safeFailureStatuses.has(result.status), `status inesperado ${result.status}`);
      });
    }
  }

  const paginationCases = ['?page=0', '?page=-1', '?page=abc', '?page=999999999', '?limit=0', '?limit=-1', '?limit=abc', '?limit=999999999', '?page=1.5', '?search=%00'];
  for (const query of paginationCases) {
    await t.test(`listado resiste query ${query}`, async () => {
      const result = await jsonRequest(baseUrl, `/api/personas${query}`, { cookie });
      assert.notEqual(result.status, 500, JSON.stringify(result.payload));
      assert.equal(result.status, 200);
    });
  }

  await t.test('alta concurrente con el mismo DNI crea como máximo una persona', async () => {
    const dni = `QA-${Date.now()}`;
    const body = { nombreCompleto: 'Persona concurrente', dni };
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      jsonRequest(baseUrl, '/api/personas', { method: 'POST', body, ...auth })
    ));
    assert.equal(results.filter(result => result.status === 201).length, 1, results.map(result => result.status).join(','));
    assert.equal(await prisma.persona.count({ where: { inmobiliariaId: agency.id, dni } }), 1);
  });

  await t.test('doble pago de sueldo concurrente crea como máximo uno', async () => {
    const body = { usuarioId: employee.id, monto: 12345, moneda: 'ARS', fecha: '2026-07-01', periodo: '2099-12', metodoPago: 'TRANSFERENCIA' };
    const results = await Promise.all(Array.from({ length: 10 }, () => jsonRequest(baseUrl, '/api/sueldos', { method: 'POST', body, ...auth })));
    assert.equal(results.filter(result => result.status === 201).length, 1, results.map(result => result.status).join(','));
    assert.equal(await prisma.pagoSueldo.count({ where: { inmobiliariaId: agency.id, usuarioId: employee.id, periodo: '2099-12', moneda: 'ARS' } }), 1);
  });

  await prisma.inmobiliaria.delete({ where: { id: agency.id } }).catch(() => {});
  await prisma.$disconnect();
  await new Promise(resolve => server.close(resolve));
});
