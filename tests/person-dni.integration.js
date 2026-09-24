const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function adminSession() {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'admin.integration@example.com',
      password: 'ProdTest!2026_Strong'
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const sessionCookie = setCookies.join(',').match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(sessionCookie);
  return {
    csrfToken: body.csrfToken,
    cookie: `pc_session=${sessionCookie}; pc_csrf=${body.csrfToken}`
  };
}

async function request(method, path, body, session) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

test.after(async () => {
  await prisma.persona.deleteMany({
    where: { nombreCompleto: { startsWith: `PC025 ${runId}` } }
  });
  await prisma.$disconnect();
});

test('editing and concurrent creation cannot duplicate a normalized DNI', async () => {
  const session = await adminSession();
  const agency = await prisma.inmobiliaria.findFirstOrThrow();

  const first = await request('POST', '/personas', {
    nombreCompleto: `PC025 ${runId} original`,
    dni: '12.345.678',
    estado: 'ACTIVO'
  }, session);
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.dni, '12345678');

  const editable = await request('POST', '/personas', {
    nombreCompleto: `PC025 ${runId} editable`,
    dni: '',
    estado: 'ACTIVO'
  }, session);
  assert.equal(editable.response.status, 201);
  assert.equal(editable.payload.dni, null);

  const duplicateEdit = await request('PUT', `/personas/${editable.payload.id}`, {
    nombreCompleto: editable.payload.nombreCompleto,
    dni: '12-345-678',
    estado: 'ACTIVO',
    version: editable.payload.version
  }, session);
  assert.equal(duplicateEdit.response.status, 409);
  assert.equal(duplicateEdit.payload.code, 'PERSON_DUPLICATE_DNI');
  assert.equal((await prisma.persona.findUniqueOrThrow({ where: { id: editable.payload.id } })).dni, null);

  await assert.rejects(
    prisma.persona.create({
      data: {
        nombreCompleto: `PC025 ${runId} acceso directo duplicado`,
        dni: '12345678',
        inmobiliariaId: agency.id
      }
    }),
    error => error?.code === 'P2002'
  );

  const concurrentDni = `${String(Date.now()).slice(-7)}9`;
  const concurrent = await Promise.all([
    request('POST', '/personas', {
      nombreCompleto: `PC025 ${runId} concurrente A`,
      dni: `${concurrentDni.slice(0, 2)}.${concurrentDni.slice(2, 5)}.${concurrentDni.slice(5)}`,
      estado: 'ACTIVO'
    }, session),
    request('POST', '/personas', {
      nombreCompleto: `PC025 ${runId} concurrente B`,
      dni: concurrentDni,
      estado: 'ACTIVO'
    }, session)
  ]);

  assert.deepEqual(concurrent.map(result => result.response.status).sort(), [201, 409]);
  assert.equal(concurrent.find(result => result.response.status === 409).payload.code, 'PERSON_DUPLICATE_DNI');
  assert.equal(await prisma.persona.count({ where: { inmobiliariaId: agency.id, dni: concurrentDni } }), 1);

  const anotherWithoutDni = await request('POST', '/personas', {
    nombreCompleto: `PC025 ${runId} sin DNI`,
    estado: 'ACTIVO'
  }, session);
  assert.equal(anotherWithoutDni.response.status, 201);
});
