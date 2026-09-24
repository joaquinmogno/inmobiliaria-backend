const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let propertyId;
let personIds = [];

async function adminSession() {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const sessionCookie = setCookies.join(',').match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(sessionCookie);
  return { csrfToken: body.csrfToken, cookie: `pc_session=${sessionCookie}; pc_csrf=${body.csrfToken}` };
}

async function jsonRequest(method, path, body, session) {
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

test.after(async () => {
  if (propertyId) await prisma.contrato.deleteMany({ where: { propiedadId: propertyId } });
  if (propertyId) await prisma.propiedad.deleteMany({ where: { id: propertyId } });
  if (personIds.length) await prisma.persona.deleteMany({ where: { id: { in: personIds } } });
  await prisma.$disconnect();
});

test('property dossier exposes relationships, notes, services, keys and protected files', async () => {
  const session = await adminSession();
  const agency = await prisma.inmobiliaria.findFirstOrThrow();

  const creation = await jsonRequest('POST', '/propiedades', {
    direccion: `PC026 Calle Dossier ${runId}`,
    piso: '3',
    departamento: 'B',
    tipo: 'DEPARTAMENTO',
    estado: 'ALQUILADO',
    servicios: 'Luz: medidor 12345. Gas: cuenta 9988.',
    llaves: 'Dos juegos: casillero 4 y titular.',
    observaciones: 'Ingreso por puerta lateral.'
  }, session);
  assert.equal(creation.response.status, 201);
  propertyId = creation.payload.id;

  const people = await Promise.all(['Titular', 'Ocupante'].map(nombreCompleto => prisma.persona.create({
    data: { nombreCompleto: `PC026 ${nombreCompleto} ${runId}`, inmobiliariaId: agency.id }
  })));
  personIds = people.map(person => person.id);

  const contract = await prisma.contrato.create({
    data: {
      fechaInicio: new Date('2026-01-01T00:00:00.000Z'),
      fechaFin: new Date('2027-12-31T00:00:00.000Z'),
      estado: 'ACTIVO',
      montoAlquiler: 250000,
      montoHonorarios: 0,
      moneda: 'ARS',
      propiedadId: propertyId,
      inmobiliariaId: agency.id,
      requiereActualizacion: false,
      propietarios: { create: { personaId: people[0].id, esPrincipal: true } },
      inquilinos: { create: { personaId: people[1].id, esPrincipal: true } }
    }
  });

  const note = await jsonRequest('POST', `/propiedades/${propertyId}/notas`, {
    contenido: 'El 02/09 se entregó el segundo juego de llaves.'
  }, session);
  assert.equal(note.response.status, 201);
  assert.equal(note.payload.creadoPor.nombreCompleto, 'Administrador Integration');

  const form = new FormData();
  form.append('tipo', 'FOTO');
  form.append('nombreArchivo', 'Frente del inmueble');
  form.append('archivo', new Blob([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
  ], { type: 'image/png' }), 'frente.png');
  const uploadedResponse = await fetch(`${apiBase}/propiedades/${propertyId}/adjuntos`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
    body: form
  });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json();

  const detail = await jsonRequest('GET', `/propiedades/${propertyId}`, undefined, session);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.servicios, 'Luz: medidor 12345. Gas: cuenta 9988.');
  assert.equal(detail.payload.llaves, 'Dos juegos: casillero 4 y titular.');
  assert.equal(detail.payload.contratoVigente.id, contract.id);
  assert.equal(detail.payload.titularesRegistrados[0].persona.id, people[0].id);
  assert.equal(detail.payload.ocupantesActuales[0].persona.id, people[1].id);
  assert.equal(detail.payload.notas[0].contenido, 'El 02/09 se entregó el segundo juego de llaves.');
  assert.equal(detail.payload.adjuntos[0].nombreArchivo, 'Frente del inmueble');

  const fileResponse = await fetch(`${apiBase}/files/${uploaded.rutaArchivo}`, {
    headers: { cookie: session.cookie }
  });
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('content-type'), 'image/png');

  const deletion = await jsonRequest('DELETE', `/propiedades/${propertyId}/adjuntos/${uploaded.id}`, undefined, session);
  assert.equal(deletion.response.status, 200);
  assert.equal((await fetch(`${apiBase}/files/${uploaded.rutaArchivo}`, { headers: { cookie: session.cookie } })).status, 404);

  const auditActions = await prisma.auditLog.findMany({
    where: { entidad: 'Propiedad', entidadId: propertyId },
    select: { accion: true }
  });
  assert.ok(auditActions.some(item => item.accion === 'AGREGAR_NOTA_PROPIEDAD'));
  assert.ok(auditActions.some(item => item.accion === 'AGREGAR_ADJUNTO_PROPIEDAD'));
  assert.ok(auditActions.some(item => item.accion === 'ELIMINAR_ADJUNTO_PROPIEDAD'));
});
