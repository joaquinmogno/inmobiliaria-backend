const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let propertyId;
let contractId;

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
    userId: body.user.id,
    cookie: `pc_session=${sessionCookie}; pc_csrf=${body.csrfToken}`
  };
}

async function get(path, session) {
  const response = await fetch(`${apiBase}${path}`, { headers: { cookie: session.cookie } });
  return { response, payload: await response.json() };
}

test.after(async () => {
  if (contractId) {
    await prisma.auditLog.deleteMany({ where: { entidad: 'Contrato', entidadId: contractId } });
    await prisma.contrato.deleteMany({ where: { id: contractId } });
  }
  if (propertyId) await prisma.propiedad.deleteMany({ where: { id: propertyId } });
  await prisma.$disconnect();
});

test('all growing lists validate pagination and enforce the same maximum page size', async () => {
  const session = await adminSession();
  const endpoints = ['/liquidaciones', '/pagos', '/cajachica', '/personas', '/propiedades', '/contratos', '/sueldos', '/usuarios', '/inmobiliaria/logs'];

  for (const endpoint of endpoints) {
    const invalid = await get(`${endpoint}?page=1.5&limit=25`, session);
    assert.equal(invalid.response.status, 400, endpoint);
    assert.equal(invalid.payload.code, 'INVALID_PAGINATION', endpoint);

    const oversized = await get(`${endpoint}?page=1&limit=999999`, session);
    assert.equal(oversized.response.status, 200, endpoint);
    assert.equal(oversized.payload.meta.limit, 100, endpoint);
    assert.ok(Array.isArray(oversized.payload.data), endpoint);
  }

  const unsafeOffset = await get('/pagos?page=10001&limit=100', session);
  assert.equal(unsafeOffset.response.status, 400);
  assert.equal(unsafeOffset.payload.code, 'INVALID_PAGINATION');
});

test('payment history ignores empty UI placeholders and rejects malformed date filters with 400', async () => {
  const session = await adminSession();

  const placeholders = await get('/pagos?page=1&limit=15&moneda=undefined&metodoPago=undefined&estado=VIGENTE&propietarioId=undefined&inquilinoId=undefined&desde=undefined&hasta=&cuenta=undefined', session);
  assert.equal(placeholders.response.status, 200, JSON.stringify(placeholders.payload));
  assert.ok(Array.isArray(placeholders.payload.data));

  const malformedDate = await get('/pagos?desde=2026-99-99', session);
  assert.equal(malformedDate.response.status, 400);
  assert.equal(malformedDate.payload.code, 'INVALID_PAYMENT_DATE_FILTER');
});

test('entity audit history is bounded and exposes navigable pagination metadata', async () => {
  const session = await adminSession();
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const property = await prisma.propiedad.create({
    data: {
      direccion: `PC031 Propiedad ${runId}`,
      inmobiliariaId: agency.id,
      tipo: 'DEPARTAMENTO',
      estado: 'DISPONIBLE'
    }
  });
  propertyId = property.id;
  const contract = await prisma.contrato.create({
    data: {
      fechaInicio: new Date('2025-01-01T00:00:00.000Z'),
      fechaFin: new Date('2025-12-31T00:00:00.000Z'),
      estado: 'FINALIZADO',
      montoAlquiler: 100000,
      montoHonorarios: 0,
      moneda: 'ARS',
      propiedadId: property.id,
      inmobiliariaId: agency.id,
      requiereActualizacion: false
    }
  });
  contractId = contract.id;
  await prisma.auditLog.createMany({
    data: Array.from({ length: 12 }, (_, index) => ({
      usuarioId: session.userId,
      inmobiliariaId: agency.id,
      accion: `PC031_EVENTO_${String(index + 1).padStart(2, '0')}`,
      entidad: 'Contrato',
      entidadId: contract.id,
      detalle: `Evento ${index + 1}`
    }))
  });

  const firstPage = await get(`/contratos/${contract.id}?auditPage=1&auditLimit=10`, session);
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.payload.auditLogs.length, 10);
  assert.deepEqual(firstPage.payload.auditMeta, { total: 12, page: 1, limit: 10, totalPages: 2 });

  const secondPage = await get(`/contratos/${contract.id}?auditPage=2&auditLimit=10`, session);
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.payload.auditLogs.length, 2);
  assert.deepEqual(secondPage.payload.auditMeta, { total: 12, page: 2, limit: 10, totalPages: 2 });

  const invalidNestedPage = await get(`/contratos/${contract.id}?auditPage=-1`, session);
  assert.equal(invalidNestedPage.response.status, 400);
  assert.equal(invalidNestedPage.payload.code, 'INVALID_PAGINATION');
});
