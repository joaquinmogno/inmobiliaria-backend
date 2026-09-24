const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const created = { personas: [], propiedades: [], contratos: [], sueldos: [], roles: [] };

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
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

function assertConflict(result, submittedVersion, currentVersion) {
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'STALE_WRITE');
  assert.equal(result.payload.details.submittedVersion, submittedVersion);
  assert.equal(result.payload.details.currentVersion, currentVersion);
  assert.match(result.payload.message, /otro usuario modificó/i);
}

test.after(async () => {
  if (created.contratos.length) await prisma.contrato.deleteMany({ where: { id: { in: created.contratos } } });
  if (created.sueldos.length) {
    await prisma.movimientoCaja.deleteMany({ where: { pagoSueldoId: { in: created.sueldos } } });
    await prisma.pagoSueldo.deleteMany({ where: { id: { in: created.sueldos } } });
  }
  if (created.propiedades.length) await prisma.propiedad.deleteMany({ where: { id: { in: created.propiedades } } });
  if (created.personas.length) await prisma.persona.deleteMany({ where: { id: { in: created.personas } } });
  if (created.roles.length) await prisma.rol.deleteMany({ where: { id: { in: created.roles } } });
  await prisma.$disconnect();
});

test('two sessions cannot overwrite stale personas, properties, contracts, salaries or roles', async () => {
  const [sessionA, sessionB] = await Promise.all([adminSession(), adminSession()]);
  const agency = await prisma.inmobiliaria.findFirstOrThrow();

  const personCreation = await request('POST', '/personas', {
    nombreCompleto: `PC030 Persona ${runId}`,
    estado: 'ACTIVO'
  }, sessionA);
  assert.equal(personCreation.response.status, 201);
  const person = personCreation.payload;
  created.personas.push(person.id);
  const personFirst = await request('PUT', `/personas/${person.id}`, {
    nombreCompleto: `PC030 Persona guardada A ${runId}`,
    estado: 'ACTIVO',
    version: person.version
  }, sessionA);
  assert.equal(personFirst.response.status, 200);
  assert.equal(personFirst.payload.version, person.version + 1);
  const personStale = await request('PUT', `/personas/${person.id}`, {
    nombreCompleto: `PC030 Persona pisada B ${runId}`,
    estado: 'ACTIVO',
    version: person.version
  }, sessionB);
  assertConflict(personStale, person.version, person.version + 1);
  assert.equal((await prisma.persona.findUniqueOrThrow({ where: { id: person.id } })).nombreCompleto, `PC030 Persona guardada A ${runId}`);

  const propertyCreation = await request('POST', '/propiedades', {
    direccion: `PC030 Propiedad ${runId}`,
    tipo: 'DEPARTAMENTO',
    estado: 'DISPONIBLE'
  }, sessionA);
  assert.equal(propertyCreation.response.status, 201);
  const property = propertyCreation.payload;
  created.propiedades.push(property.id);
  const propertyFirst = await request('PUT', `/propiedades/${property.id}`, {
    direccion: `PC030 Propiedad guardada A ${runId}`,
    tipo: property.tipo,
    estado: property.estado,
    version: property.version
  }, sessionA);
  assert.equal(propertyFirst.response.status, 200);
  const propertyStale = await request('PUT', `/propiedades/${property.id}`, {
    direccion: `PC030 Propiedad pisada B ${runId}`,
    tipo: property.tipo,
    estado: property.estado,
    version: property.version
  }, sessionB);
  assertConflict(propertyStale, property.version, property.version + 1);
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).direccion, `PC030 Propiedad guardada A ${runId}`);

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
  created.contratos.push(contract.id);
  const contractFirst = await request('PUT', `/contratos/${contract.id}`, {
    observaciones: `PC030 Contrato guardado A ${runId}`,
    version: contract.version
  }, sessionA);
  assert.equal(contractFirst.response.status, 200);
  const contractStale = await request('PUT', `/contratos/${contract.id}`, {
    observaciones: `PC030 Contrato pisado B ${runId}`,
    version: contract.version
  }, sessionB);
  assertConflict(contractStale, contract.version, contract.version + 1);
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).observaciones, `PC030 Contrato guardado A ${runId}`);

  let salaryPeriod;
  for (let year = 2099; year >= 2090 && !salaryPeriod; year -= 1) {
    for (let month = 12; month >= 1; month -= 1) {
      const candidate = `${year}-${String(month).padStart(2, '0')}`;
      const exists = await prisma.pagoSueldo.findFirst({
        where: { inmobiliariaId: agency.id, usuarioId: sessionA.userId, periodo: candidate, moneda: 'ARS' }
      });
      if (!exists) {
        salaryPeriod = candidate;
        break;
      }
    }
  }
  assert.ok(salaryPeriod);
  const salaryCreation = await request('POST', '/sueldos', {
    usuarioId: sessionA.userId,
    monto: 1000,
    moneda: 'ARS',
    fecha: '2026-09-02',
    periodo: salaryPeriod,
    metodoPago: 'EFECTIVO',
    observaciones: `PC030 ${runId}`
  }, sessionA);
  assert.equal(salaryCreation.response.status, 201);
  const salary = salaryCreation.payload;
  created.sueldos.push(salary.id);
  const salaryFirst = await request('PUT', `/sueldos/${salary.id}`, {
    observaciones: `PC030 Sueldo guardado A ${runId}`,
    version: salary.version
  }, sessionA);
  assert.equal(salaryFirst.response.status, 200);
  const salaryStale = await request('PUT', `/sueldos/${salary.id}`, {
    observaciones: `PC030 Sueldo pisado B ${runId}`,
    version: salary.version
  }, sessionB);
  assertConflict(salaryStale, salary.version, salary.version + 1);
  assert.equal((await prisma.pagoSueldo.findUniqueOrThrow({ where: { id: salary.id } })).observaciones, `PC030 Sueldo guardado A ${runId}`);

  const roleCreation = await request('POST', '/roles', {
    nombre: `PC030 Rol ${runId}`,
    descripcion: 'Versión inicial',
    permisos: []
  }, sessionA);
  assert.equal(roleCreation.response.status, 201);
  const role = roleCreation.payload;
  created.roles.push(role.id);
  const roleFirst = await request('PUT', `/roles/${role.id}`, {
    descripcion: `PC030 Rol guardado A ${runId}`,
    version: role.version
  }, sessionA);
  assert.equal(roleFirst.response.status, 200);
  const roleStale = await request('PUT', `/roles/${role.id}`, {
    descripcion: `PC030 Rol pisado B ${runId}`,
    version: role.version
  }, sessionB);
  assertConflict(roleStale, role.version, role.version + 1);
  assert.equal((await prisma.rol.findUniqueOrThrow({ where: { id: role.id } })).descripcion, `PC030 Rol guardado A ${runId}`);
});
