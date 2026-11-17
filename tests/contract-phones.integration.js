const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');
assert.match(process.env.DATABASE_URL || '', /@127\.0\.0\.1:55433\/propcontrol_integration(?:\?|$)/);
const base = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let session, agency;
const phoneSeed = Math.floor(20000000 + Math.random() * 60000000);
const phone = offset => `+54911${phoneSeed + offset}`;

async function login(email, password) {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const token = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1];
  return { cookie: `pc_session=${token}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}
async function request(path, method = 'GET', body, auth = session) {
  const multipart = body instanceof FormData;
  const response = await fetch(`${base}${path}`, { method,
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, ...(body && !multipart ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function fixture() {
  const property = await prisma.propiedad.create({ data: { direccion: `Teléfonos ${Date.now()}-${Math.random()}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: 'Propietario', inmobiliariaId: agency.id, email: 'correo@ejemplo.test', direccion: 'Domicilio del propietario' } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: 'Inquilino', inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', montoAlquiler: 1000, montoHonorarios: 50,
    fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), requiereActualizacion: false,
    propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  return { owner, tenant, contract };
}
const contact = (person, telefono) => ({ personaId: person.id, version: person.version, telefono });
const save = (contract, telefonosPersonas, auth = session, extra = {}) => request(`/contratos/${contract.id}`, 'PUT', { version: contract.version, telefonosPersonas, ...extra }, auth);
const getPerson = id => prisma.persona.findUniqueOrThrow({ where: { id } });
test.before(async () => {
  session = await login('admin.integration@example.com', 'ProdTest!2026_Strong');
  agency = await prisma.inmobiliaria.findFirstOrThrow();
});
test.after(() => prisma.$disconnect());

test('completa ambos teléfonos por multipart, los comparte con Personas y otros contratos y audita el cambio', async () => {
  const { owner, tenant, contract } = await fixture();
  const shared = await fixture();
  await prisma.contratoPropietario.create({ data: { contratoId: shared.contract.id, personaId: owner.id } });
  const form = new FormData();
  form.append('version', String(contract.version));
  form.append('telefonosPersonas', JSON.stringify([contact(owner, phone(1).replace('+54911', '011 15-')), contact(tenant, phone(2))]));
  const result = await request(`/contratos/${contract.id}`, 'PUT', form);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.propietarios[0].persona.telefono, phone(1));
  assert.equal(result.data.inquilinos[0].persona.telefono, phone(2));
  const stored = await getPerson(owner.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.telefonoNormalizado, phone(1).slice(1));
  assert.equal(stored.nombreCompleto, owner.nombreCompleto);
  assert.equal(stored.email, owner.email);
  assert.equal(stored.direccion, owner.direccion);
  assert.equal((await request(`/personas?search=${encodeURIComponent(stored.telefono)}`)).data.data.find(person => person.id === owner.id).telefono, stored.telefono);
  const linked = await request(`/contratos/${shared.contract.id}`);
  assert.equal(linked.data.propietarios.find(party => party.persona.id === owner.id).persona.telefono, stored.telefono);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entidad: 'Persona', entidadId: owner.id, accion: 'ACTUALIZAR_PERSONA' } });
  assert.deepEqual(JSON.parse(audit.detalle).telefono, { anterior: null, nuevo: stored.telefono });
  assert.equal(JSON.parse(audit.detalle).contratoId, contract.id);
  const contractAudit = await prisma.auditLog.findFirstOrThrow({ where: { entidad: 'Contrato', entidadId: contract.id, accion: 'ACTUALIZAR_CONTRATO' } });
  assert.ok(contractAudit.detalle.includes('telefonosPersonas'));
  const cleared = await save(result.data, [contact(stored, null)]);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal((await getPerson(owner.id)).telefono, null);
  assert.equal((await getPerson(owner.id)).telefonoNormalizado, null);
  assert.equal((await getPerson(tenant.id)).telefono, phone(2));
});

test('una persona modificada por otro usuario revierte todos los cambios del contrato y los teléfonos', async () => {
  const { owner, tenant, contract } = await fixture();
  await prisma.persona.update({ where: { id: owner.id }, data: { telefono: phone(3), version: { increment: 1 } } });
  const result = await save(contract, [contact(tenant, phone(4)), contact(owner, phone(5))], session, { observaciones: 'No guardar parcialmente' });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'STALE_WRITE');
  assert.equal((await getPerson(tenant.id)).telefono, null);
  assert.equal((await getPerson(owner.id)).telefono, phone(3));
  const stored = await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } });
  assert.equal(stored.version, contract.version);
  assert.equal(stored.observaciones, null);
  assert.equal(await prisma.auditLog.count({ where: { entidad: 'Persona', entidadId: tenant.id, accion: 'ACTUALIZAR_PERSONA' } }), 0);
});

test('rechaza contactos ajenos al contrato, teléfonos inválidos, versiones ausentes e IDs repetidos', async () => {
  const { owner, contract } = await fixture();
  const unrelated = await fixture();
  for (const updates of [
    [contact(unrelated.owner, phone(6))],
    [contact(owner, '123')],
    [{ personaId: owner.id, telefono: phone(6) }],
    [{ personaId: owner.id, version: owner.version }],
    [contact(owner, phone(6)), contact(owner, phone(7))],
    [{ ...contact(owner, phone(6)), nombreCompleto: 'No modificar' }]
  ]) {
    assert.equal((await save(contract, updates)).status, 400);
    assert.equal((await getPerson(owner.id)).telefono, null);
  }
});

test('conserva teléfonos antiguos no editados y rechaza un número que pertenece a otra persona', async () => {
  const { owner, tenant, contract } = await fixture();
  await prisma.persona.update({ where: { id: owner.id }, data: { telefono: 'Número antiguo incompleto' } });
  const unrelated = await fixture();
  await prisma.persona.update({ where: { id: unrelated.owner.id }, data: { telefono: phone(8), telefonoNormalizado: phone(8).slice(1) } });
  const duplicate = await save(contract, [contact(tenant, phone(8))]);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'PERSON_IDENTITY_DUPLICATE');
  const valid = await save(contract, [contact(tenant, phone(9))]);
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  assert.equal((await getPerson(owner.id)).telefono, 'Número antiguo incompleto');
  assert.equal((await getPerson(owner.id)).version, owner.version);
});

test('editar teléfonos respeta el permiso de Personas sin impedir editar otros datos del contrato', async () => {
  const { contract, owner } = await fixture();
  const permissions = await prisma.permiso.findMany({ where: { clave: { in: ['contratos.ver', 'contratos.editar'] } } });
  const suffix = `${Date.now()}-${Math.random()}`;
  const role = await prisma.rol.create({ data: { nombre: `Contrato sin contactos ${suffix}`, inmobiliariaId: agency.id, permisos: { create: permissions.map(p => ({ permisoId: p.id })) } } });
  const user = await prisma.usuario.create({ data: { email: `phones-${suffix}@example.test`, nombreCompleto: 'Editor de contratos', inmobiliariaId: agency.id, tipo: 'USUARIO', rolId: role.id, password: await bcrypt.hash('PhonesTest!2026_Strong', 10) } });
  const auth = await login(user.email, 'PhonesTest!2026_Strong');
  assert.equal((await save(contract, [contact(owner, phone(10))], auth)).status, 403);
  assert.equal((await getPerson(owner.id)).telefono, null);
  const unchanged = await request(`/contratos/${contract.id}`, 'PUT', { version: contract.version, observaciones: 'Edición permitida' }, auth);
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.data));
});
