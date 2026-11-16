const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');
assert.match(process.env.DATABASE_URL || '', /@127\.0\.0\.1:55433\/propcontrol_integration(?:\?|$)/);
const base = 'http://127.0.0.1:3100/api';
let session, admin, agency;
const password = 'DraftTest!2026_Strong';
const empty = () => ({
  form: {
    address: '', floor: '', unit: '', startDate: '', endDate: '', updateDate: '',
    montoAlquiler: '', moneda: 'ARS', montoHonorarios: '', porcentajeHonorarios: '5',
    porcentajeActualizacion: '', pagaHonorarios: 'PROPIETARIO', diaVencimiento: '10',
    modalidadCobroInquilino: '', modalidadPagoPropietario: '', cuentaCobroAcordadaId: '', serviciosGastos: [],
    tipoAjuste: '', observacionDocumento: '', observations: '', tipoArchivosAdicionales: 'ADJUNTO',
    administrado: true, requiereActualizacion: true, frecuenciaActualizacion: '3',
    honorarioInicial: '', monedaHonorarioInicial: 'ARS', honorarioInicialMetodoPago: '', honorarioInicialCuentaBancariaId: ''
  }, selectedProperty: null, owners: [], tenants: []
});
async function login(email, pass) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  return { cookie: `pc_session=${res.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1]}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}
async function request(path, method = 'GET', body, auth = session) {
  return fetch(`${base}${path}`, { method, headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf,
    ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
}
async function json(path, method = 'GET', body, auth = session) {
  const res = await request(path, method, body, auth);
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
async function draft(datos = empty(), auth = session) {
  const result = await json('/contratos/borradores', 'POST', { datos }, auth);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF';
async function upload(id, name = 'contrato.pdf', tipo = 'CONTRATO_PRINCIPAL', content = pdf, auth = session) {
  const form = new FormData(); form.append('tipo', tipo); form.append('archivo', new Blob([content], { type: 'application/pdf' }), name);
  return json(`/contratos/borradores/${id}/adjuntos`, 'POST', form, auth);
}
async function fixture(auth = session) {
  const property = await prisma.propiedad.create({ data: { direccion: `Borrador ${Date.now()}-${Math.random()}`, inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Dueño ${property.id}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${property.id}`, inmobiliariaId: agency.id } });
  const datos = empty();
  Object.assign(datos.form, { address: property.direccion, montoAlquiler: '1000.25', moneda: 'USD', startDate: '2026-01-01', endDate: '2027-12-31', requiereActualizacion: false,
    modalidadCobroInquilino: 'EFECTIVO', modalidadPagoPropietario: 'CHEQUE', honorarioInicial: '50.10', honorarioInicialMetodoPago: 'EFECTIVO',
    serviciosGastos: [{ concepto: 'Expensas', responsable: 'INQUILINO' }], observations: 'Conservar observación', observacionDocumento: 'Documento del acuerdo' });
  datos.selectedProperty = { id: property.id, direccion: property.direccion, piso: null, departamento: null };
  datos.owners = [{ id: owner.id, nombreCompleto: owner.nombreCompleto, telefono: '' }];
  datos.tenants = [{ id: tenant.id, nombreCompleto: tenant.nombreCompleto, telefono: '' }];
  const saved = await draft(datos, auth);
  return { saved, payload: {
    borradorId: saved.id, borradorVersion: saved.version, propiedadId: property.id, propietarios: [{ id: owner.id }], inquilinos: [{ id: tenant.id }],
    fechaInicio: '2026-01-01', fechaFin: '2027-12-31', requiereActualizacion: false,
    montoAlquiler: '1000.25', moneda: 'USD', porcentajeHonorarios: 5, modalidadCobroInquilino: 'EFECTIVO', modalidadPagoPropietario: 'CHEQUE',
    honorarioInicial: '50.10', monedaHonorarioInicial: 'ARS', honorarioInicialMetodoPago: 'EFECTIVO', serviciosGastos: datos.form.serviciosGastos,
    observaciones: datos.form.observations, observacionDocumento: datos.form.observacionDocumento
  }, property, owner, tenant };
}
test.before(async () => {
  session = await login('admin.integration@example.com', 'ProdTest!2026_Strong');
  admin = await prisma.usuario.findUniqueOrThrow({ where: { email: 'admin.integration@example.com' } });
  agency = await prisma.inmobiliaria.findUniqueOrThrow({ where: { id: admin.inmobiliariaId } });
});
test.after(() => prisma.$disconnect());

test('empty, partial and current forms roundtrip with agreements, selected entities, services and cents', async () => {
  const blank = await draft();
  assert.deepEqual((await json(`/contratos/borradores/${blank.id}`)).data.datos, empty());
  const { saved } = await fixture();
  const datos = structuredClone(saved.datos);
  Object.assign(datos.form, { modalidadCobroInquilino: 'TRANSFERENCIA', cuentaCobroAcordadaId: '42', updateDate: '2026-09-17', montoHonorarios: '1.23' });
  datos.form.serviciosGastos.push({ concepto: '', responsable: 'PROPIETARIO' }); // deliberately incomplete
  const result = await json(`/contratos/borradores/${saved.id}`, 'PUT', { datos, version: saved.version });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual((await json(`/contratos/borradores/${saved.id}`)).data.datos, datos);
  assert.equal(result.data.version, saved.version + 1);
  const legacy = empty();
  for (const name of ['modalidadCobroInquilino', 'modalidadPagoPropietario', 'cuentaCobroAcordadaId', 'serviciosGastos']) delete legacy.form[name];
  const old = await prisma.borradorContrato.create({ data: { datos: legacy, inmobiliariaId: agency.id, creadoPorId: admin.id } });
  assert.deepEqual((await json(`/contratos/borradores/${old.id}`)).data.datos, legacy);
  const updated = await json(`/contratos/borradores/${old.id}`, 'PUT', { version: old.version, datos: legacy });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.datos, empty());
});

test('two simultaneous saves have one winner and a 409; stale conversion preserves the draft', async () => {
  const { saved, payload } = await fixture();
  const results = await Promise.all(['Primera pestaña', 'Segunda pestaña'].map(observations => json(`/contratos/borradores/${saved.id}`, 'PUT', {
    datos: { ...saved.datos, form: { ...saved.datos.form, observations } }, version: saved.version
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results.find(r => r.status === 200).data;
  assert.equal((await json(`/contratos/borradores/${saved.id}`)).data.datos.form.observations, winner.datos.form.observations);
  const stale = await json('/contratos', 'POST', payload);
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.code, 'DRAFT_CHANGED');
  assert.equal(await prisma.contrato.count({ where: { propiedadId: payload.propiedadId } }), 0);
});

test('failed upload leaves data and previous attachments intact; retries including simultaneous repeats do not duplicate', async () => {
  const saved = await draft();
  const first = await upload(saved.id);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const failed = await upload(saved.id, 'invalido.pdf', 'ADJUNTO', 'not a pdf');
  assert.equal(failed.status, 400);
  assert.equal((await json(`/contratos/borradores/${saved.id}`)).data.adjuntos.length, 1);
  const retries = await Promise.all([upload(saved.id, 'adenda.pdf', 'ADENDA'), upload(saved.id, 'adenda.pdf', 'ADENDA')]);
  assert.deepEqual(retries.map(r => r.status).sort(), [200, 201]);
  assert.equal(retries[0].data.id, retries[1].data.id);
  assert.equal((await json(`/contratos/borradores/${saved.id}`)).data.adjuntos.length, 2);
  const changed = await upload(saved.id, 'contrato.pdf', 'CONTRATO_PRINCIPAL', `${pdf}\n%changed`);
  assert.equal(changed.status, 201);
  const current = (await json(`/contratos/borradores/${saved.id}`)).data;
  assert.equal(current.adjuntos.length, 2);
  assert.equal(current.adjuntos.filter(a => a.tipo === 'CONTRATO_PRINCIPAL').length, 1);
  assert.notEqual(changed.data.id, first.data.id);
});

test('conversion rollback restores draft, documents, property and cash when fee validation fails', async () => {
  const { saved, payload } = await fixture();
  await upload(saved.id);
  const before = await prisma.borradorContrato.findUniqueOrThrow({ where: { id: saved.id }, include: { adjuntos: true } });
  const failed = await json('/contratos', 'POST', { ...payload, honorarioInicialMetodoPago: 'TRANSFERENCIA', honorarioInicialCuentaBancariaId: 2147483647 });
  assert.equal(failed.status, 400, JSON.stringify(failed.data));
  assert.equal(failed.data.code, 'BANK_ACCOUNT_REQUIRED');
  assert.deepEqual(await prisma.borradorContrato.findUniqueOrThrow({ where: { id: saved.id }, include: { adjuntos: true } }), before);
  assert.equal(await prisma.contrato.count({ where: { propiedadId: payload.propiedadId } }), 0);
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: payload.propiedadId } })).estado, 'DISPONIBLE');
  const ok = await json('/contratos', 'POST', payload);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(await prisma.movimientoCaja.count({ where: { contratoId: ok.data.id } }), 1);
});

test('double conversion creates one contract, reuses selected entities and carries documents and fee exactly once', async () => {
  const { saved, payload, property, owner, tenant } = await fixture();
  const principal = await upload(saved.id);
  const annex = await upload(saved.id, 'adenda.pdf', 'ADENDA');
  const results = await Promise.all([json('/contratos', 'POST', payload), json('/contratos', 'POST', payload)]);
  assert.equal(results.filter(r => r.status === 201).length, 1, JSON.stringify(results));
  assert.ok(results.some(r => [404, 409].includes(r.status)), JSON.stringify(results));
  const contracts = await prisma.contrato.findMany({ where: { propiedadId: property.id }, include: { propietarios: true, inquilinos: true, adjuntos: true, serviciosGastos: true } });
  assert.equal(contracts.length, 1);
  const contract = contracts[0];
  assert.equal(contract.propietarios[0].personaId, owner.id);
  assert.equal(contract.inquilinos[0].personaId, tenant.id);
  assert.equal(contract.montoAlquiler.toString(), '1000.25');
  assert.equal(contract.modalidadPagoPropietario, 'CHEQUE');
  assert.equal(contract.serviciosGastos[0].concepto, 'Expensas');
  assert.equal(contract.observaciones, 'Conservar observación');
  assert.equal(contract.adjuntos.length, 2);
  assert.equal(contract.adjuntos.find(a => a.tipo === 'CONTRATO_PRINCIPAL').observacion, 'Documento del acuerdo');
  assert.deepEqual(contract.adjuntos.map(a => a.rutaArchivo).sort(), [principal.data.rutaArchivo, annex.data.rutaArchivo].sort());
  const fee = await prisma.movimientoCaja.findMany({ where: { contratoId: contract.id } });
  assert.equal(fee.length, 1); assert.equal(fee[0].monto.toString(), '50.1'); assert.equal(fee[0].moneda, 'ARS');
  assert.equal(await prisma.borradorContrato.count({ where: { id: saved.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { entidad: 'Contrato', entidadId: contract.id, accion: 'CREAR_CONTRATO' } }), 1);
  const again = await json('/contratos', 'POST', payload); assert.equal(again.status, 404);
});

async function operator(inmobiliariaId, withPermission = true, tipo = 'USUARIO') {
  const suffix = `${Date.now()}-${Math.random()}`;
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'contratos.crear' } });
  const role = await prisma.rol.create({ data: { nombre: `Borradores ${suffix}`, inmobiliariaId, ...(withPermission ? { permisos: { create: { permisoId: permission.id } } } : {}) } });
  const user = await prisma.usuario.create({ data: { email: `draft-${suffix}@test.local`, nombreCompleto: 'Operador borradores', password: await bcrypt.hash(password, 10), inmobiliariaId, rolId: role.id, tipo } });
  return login(user.email, password);
}
test('operators cannot access another creator or agency, including attachments and conversion', async () => {
  const ownerSession = await operator(agency.id);
  const peer = await operator(agency.id);
  const noPermission = await operator(agency.id, false);
  const { saved, payload } = await fixture(ownerSession);
  const attachment = await upload(saved.id, 'privado.pdf', 'ADJUNTO', pdf, ownerSession);
  assert.equal(attachment.status, 201, JSON.stringify(attachment.data));
  for (const auth of [peer, noPermission]) {
    const denied = auth === noPermission ? 403 : 404;
    assert.equal((await json(`/contratos/borradores/${saved.id}`, 'GET', undefined, auth)).status, denied);
    assert.equal((await json(`/contratos/borradores/${saved.id}`, 'PUT', { datos: saved.datos, version: saved.version }, auth)).status, denied);
    assert.equal((await upload(saved.id, 'intruso.pdf', 'ADJUNTO', pdf, auth)).status, denied);
    assert.equal((await json(`/contratos/borradores/${saved.id}/adjuntos/${attachment.data.id}`, 'DELETE', undefined, auth)).status, denied);
    assert.equal((await json('/contratos', 'POST', payload, auth)).status, denied);
    assert.equal((await json(`/contratos/borradores/${saved.id}`, 'DELETE', undefined, auth)).status, denied);
    assert.equal((await request(`/files/${attachment.data.rutaArchivo}`, 'GET', undefined, auth)).status, 404);
  }
  assert.equal((await json(`/contratos/borradores/${saved.id}`, 'GET', undefined, ownerSession)).status, 200);
  const fileResponse = await request(`/files/${attachment.data.rutaArchivo}`, 'GET', undefined, ownerSession);
  assert.equal(fileResponse.status, 200); assert.equal(await fileResponse.text(), pdf);
  assert.equal((await json(`/contratos/borradores/${saved.id}`)).status, 200); // admin in same agency
  // This product enforces one agency per installation in PostgreSQL. Exercise
  // the actual SQL scope with a foreign agency context, without relaxing it.
  const { lockContractDraft, draftScope } = require('../dist/services/contract-draft.service');
  const foreignUser = { ...admin, inmobiliariaId: agency.id + 10000 };
  await assert.rejects(prisma.$transaction(tx => lockContractDraft(tx, saved.id, foreignUser)), error => error.code === 'DRAFT_NOT_FOUND');
  assert.equal(await prisma.borradorContrato.count({ where: { id: saved.id, ...draftScope(foreignUser) } }), 0);
});
