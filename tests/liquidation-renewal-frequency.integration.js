const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';

test('renovación del mismo inquilino conserva historial y frecuencia de alquiler y honorarios', async () => {
  const login = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }) });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const session = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie')).match(/pc_session=([^;,\s]+)/)?.[1];
  const headers = { cookie: `pc_session=${session}; pc_csrf=${auth.csrfToken}`, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken };
  const api = async (method, path, body) => {
    const response = await fetch(`${apiBase}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };

  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Renovación liquidaciones ${suffix}`, inmobiliariaId: agency.id, estado: 'PENDIENTE_ENTREGA' } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const otherTenant = await prisma.persona.create({ data: { nombreCompleto: `Otro inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const previous = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2025-10-01T00:00:00.000Z'), fechaFin: new Date('2026-09-30T00:00:00.000Z'), estado: 'FINALIZADO',
    montoAlquiler: 400000, montoHonorarios: 20000, porcentajeHonorarios: 5, pagaHonorarios: 'PROPIETARIO',
    propiedadId: property.id, inmobiliariaId: agency.id, moneda: 'ARS',
    propietarios: { create: { personaId: owner.id, esPrincipal: true } },
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  const oldLiquidation = await prisma.liquidacion.create({ data: {
    contratoId: previous.id, inmobiliariaId: agency.id, periodo: new Date('2026-09-01T00:00:00.000Z'),
    estado: 'CONFIRMADA', moneda: 'ARS', netoACobrar: 400000, montoPropietario: 380000,
    montoAlquilerBase: 400000, montoHonorarios: 20000, porcentajeHonorarios: 5, pagaHonorarios: 'PROPIETARIO'
  } });

  const createContract = async (tenantId, renewal) => {
    const form = new FormData();
    const values = {
      fechaInicio: '2026-10-01', fechaFin: '2027-09-30', fechaActualizacion: '2027-01-01',
      frecuenciaActualizacionMeses: '3', propiedadId: String(property.id), montoAlquiler: '500000',
      porcentajeHonorarios: '5', moneda: 'ARS', requiereActualizacion: 'true', administrado: 'true',
      propietarios: JSON.stringify([{ id: owner.id, nombreCompleto: owner.nombreCompleto }]),
      inquilinos: JSON.stringify([{ id: tenantId, nombreCompleto: tenantId === tenant.id ? tenant.nombreCompleto : otherTenant.nombreCompleto }]),
      ...(renewal ? { contratoAnteriorId: String(previous.id) } : {})
    };
    for (const [key, value] of Object.entries(values)) form.append(key, value);
    const response = await fetch(`${apiBase}/contratos`, { method: 'POST', headers: { cookie: headers.cookie, 'x-csrf-token': auth.csrfToken }, body: form });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };

  const differentTenantAsRenewal = await createContract(otherTenant.id, true);
  assert.equal(differentTenantAsRenewal.status, 409, JSON.stringify(differentTenantAsRenewal.data));
  assert.equal(differentTenantAsRenewal.data.code, 'RENEWAL_TENANT_CHANGED');
  const differentTenantAsNew = await createContract(otherTenant.id, false);
  assert.equal(differentTenantAsNew.status, 409, JSON.stringify(differentTenantAsNew.data));
  assert.equal(differentTenantAsNew.data.code, 'PROPERTY_KEYS_PENDING');

  const renewal = await createContract(tenant.id, true);
  assert.equal(renewal.status, 201, JSON.stringify(renewal.data));
  assert.equal(renewal.data.contratoAnteriorId, previous.id);
  assert.equal(renewal.data.frecuenciaActualizacionMeses, 3);
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).estado, 'ALQUILADO');
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: previous.id } })).fechaEntregaLlaves, null);
  assert.equal((await prisma.liquidacion.findUniqueOrThrow({ where: { id: oldLiquidation.id } })).contratoId, previous.id);

  const october = await api('POST', '/liquidaciones', { contratoId: renewal.data.id, periodo: '2026-10-01' });
  assert.equal(october.status, 201, JSON.stringify(october.data));
  assert.equal(Number(october.data.montoHonorarios), 25000);
  assert.equal(Number(october.data.netoACobrar), 500000);
  assert.equal(Number(october.data.montoPropietario), 475000);
  const octoberConfirmed = await api('PATCH', `/liquidaciones/${october.data.id}/confirmar`, {});
  assert.equal(octoberConfirmed.status, 200, JSON.stringify(octoberConfirmed.data));

  const january = await api('POST', '/liquidaciones', { contratoId: renewal.data.id, periodo: '2027-01-01' });
  assert.equal(january.status, 201, JSON.stringify(january.data));
  const due = await api('PATCH', `/liquidaciones/${january.data.id}/confirmar`, {});
  assert.equal(due.status, 409);
  assert.equal(due.data.code, 'RENT_UPDATE_REQUIRED');
  const updated = await api('PATCH', `/liquidaciones/${january.data.id}/alquiler`, {
    montoNuevo: 600000, alcance: 'DESDE_PERIODO', motivo: 'Nuevo importe informado al cumplirse el trimestre',
    expectedVersion: january.data.version, expectedContractVersion: renewal.data.version
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(Number(updated.data.liquidacion.montoHonorarios), 30000);
  assert.equal(Number(updated.data.liquidacion.montoPropietario), 570000);
  const savedContract = await prisma.contrato.findUniqueOrThrow({ where: { id: renewal.data.id } });
  assert.equal(Number(savedContract.montoAlquiler), 600000);
  assert.equal(savedContract.fechaProximaActualizacion.toISOString().slice(0, 10), '2027-04-01');
  assert.equal(Number((await prisma.liquidacion.findUniqueOrThrow({ where: { id: october.data.id } })).montoAlquilerBase), 500000);
});
