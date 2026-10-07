const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';

test('alquiler manual y honorarios del propietario conservan cada período', async () => {
  const login = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' })
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const cookieValue = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie')).match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(cookieValue);
  const cookie = `pc_session=${cookieValue}; pc_csrf=${auth.csrfToken}`;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };

  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Alquiler manual ${suffix}`, inmobiliariaId: agency.id, estado: 'ALQUILADO' } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2026-01-01T00:00:00.000Z'), fechaFin: new Date('2027-12-31T00:00:00.000Z'),
    estado: 'ACTIVO', montoAlquiler: 450000, montoHonorarios: 0, porcentajeHonorarios: 5,
    pagaHonorarios: 'PROPIETARIO', moneda: 'ARS', propiedadId: property.id, inmobiliariaId: agency.id,
    requiereActualizacion: true, fechaProximaActualizacion: new Date('2026-08-01T00:00:00.000Z'),
    propietarios: { create: { personaId: owner.id, esPrincipal: true } },
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });

  const august = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-08-01' });
  const september = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-09-01' });
  const october = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-10-01' });
  for (const created of [august, september, october]) assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(Number(september.data.netoACobrar), 450000);
  assert.equal(Number(september.data.montoHonorarios), 22500);
  assert.equal(Number(september.data.montoPropietario), 427500);
  assert.equal(september.data.pagaHonorarios, 'PROPIETARIO');
  const beforeIpcUpdate = await api(`/liquidaciones/${august.data.id}/confirmar`, 'PATCH', {});
  assert.equal(beforeIpcUpdate.status, 409);
  assert.equal(beforeIpcUpdate.data.code, 'RENT_UPDATE_REQUIRED');

  const oneMonth = await api(`/liquidaciones/${september.data.id}/alquiler`, 'PATCH', {
    montoNuevo: 470000, alcance: 'SOLO_PERIODO', motivo: 'Acuerdo excepcional de septiembre', expectedVersion: september.data.version
  });
  assert.equal(oneMonth.status, 200, JSON.stringify(oneMonth.data));
  assert.equal(Number(oneMonth.data.liquidacion.montoAlquilerBase), 470000);
  assert.equal(Number(oneMonth.data.liquidacion.montoHonorarios), 23500);
  assert.equal(Number(oneMonth.data.liquidacion.netoACobrar), 470000);
  assert.equal(Number(oneMonth.data.liquidacion.montoPropietario), 446500);
  assert.equal(oneMonth.data.liquidacion.alquilerExcepcional, true);
  assert.equal(Number((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).montoAlquiler), 450000);
  const exceptionBeforeIpcUpdate = await api(`/liquidaciones/${september.data.id}/confirmar`, 'PATCH', {});
  assert.equal(exceptionBeforeIpcUpdate.status, 409);
  assert.equal(exceptionBeforeIpcUpdate.data.code, 'RENT_UPDATE_REQUIRED');

  const fromAugust = await api(`/liquidaciones/${august.data.id}/alquiler`, 'PATCH', {
    montoNuevo: 500000, alcance: 'DESDE_PERIODO', motivo: 'Actualización manual según IPC',
    fechaProximaNueva: '2027-01-01', porcentajeAplicado: 11.1111,
    expectedVersion: august.data.version, expectedContractVersion: contract.version
  });
  assert.equal(fromAugust.status, 200, JSON.stringify(fromAugust.data));
  assert.equal(fromAugust.data.borradoresActualizados, 2);
  assert.equal(Number((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).montoAlquiler), 500000);
  assert.equal(Number((await prisma.liquidacion.findUniqueOrThrow({ where: { id: october.data.id } })).montoHonorarios), 25000);
  assert.equal(Number((await prisma.liquidacion.findUniqueOrThrow({ where: { id: september.data.id } })).montoAlquilerBase), 470000);
  const update = await prisma.actualizacionContrato.findFirstOrThrow({ where: { contratoId: contract.id }, orderBy: { id: 'desc' } });
  assert.equal(update.fechaVigencia.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(Number(update.porcentajeAplicado), 11.1111);
  const correctedIpc = await api(`/liquidaciones/${august.data.id}/alquiler`, 'PATCH', {
    montoNuevo: 510000, alcance: 'DESDE_PERIODO', motivo: 'Corrección del importe IPC antes de confirmar',
    fechaProximaNueva: '2027-01-01', porcentajeAplicado: 13.3333,
    expectedVersion: fromAugust.data.liquidacion.version, expectedContractVersion: fromAugust.data.contratoVersion
  });
  assert.equal(correctedIpc.status, 200, JSON.stringify(correctedIpc.data));
  assert.equal(correctedIpc.data.borradoresActualizados, 2);
  assert.equal(await prisma.actualizacionContrato.count({ where: { contratoId: contract.id } }), 1);
  const correctedUpdate = await prisma.actualizacionContrato.findFirstOrThrow({ where: { contratoId: contract.id } });
  assert.equal(Number(correctedUpdate.montoAnterior), 450000);
  assert.equal(Number(correctedUpdate.montoNuevo), 510000);
  assert.equal(Number((await prisma.liquidacion.findUniqueOrThrow({ where: { id: october.data.id } })).montoHonorarios), 25500);
  const previousPeriod = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-07-01' });
  const followingPeriod = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-11-01' });
  assert.equal(previousPeriod.status, 201, JSON.stringify(previousPeriod.data));
  assert.equal(followingPeriod.status, 201, JSON.stringify(followingPeriod.data));
  assert.equal(Number(previousPeriod.data.montoAlquilerBase), 450000);
  assert.equal(Number(followingPeriod.data.montoAlquilerBase), 510000);
  const confirmedException = await api(`/liquidaciones/${september.data.id}/confirmar`, 'PATCH', {});
  assert.equal(confirmedException.status, 200, JSON.stringify(confirmedException.data));

  const confirmed = await api(`/liquidaciones/${october.data.id}/confirmar`, 'PATCH', {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(await prisma.movimientoCaja.count({ where: { liquidacionId: october.data.id } }), 0);
  const retroactive = await api(`/liquidaciones/${august.data.id}/alquiler`, 'PATCH', {
    montoNuevo: 520000, alcance: 'DESDE_PERIODO', motivo: 'Actualización fuera de secuencia',
    fechaProximaNueva: '2027-03-01', expectedVersion: correctedIpc.data.liquidacion.version,
    expectedContractVersion: correctedIpc.data.contratoVersion
  });
  assert.equal(retroactive.status, 409);
  assert.equal(retroactive.data.code, 'CONFIRMED_RENT_PERIOD_REQUIRES_REVIEW');

  const secondProperty = await prisma.propiedad.create({ data: { direccion: `Honorarios variables ${suffix}`, inmobiliariaId: agency.id, estado: 'ALQUILADO' } });
  const variableFeeContract = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2026-01-01T00:00:00.000Z'), fechaFin: new Date('2027-12-31T00:00:00.000Z'),
    estado: 'ACTIVO', montoAlquiler: 300000, montoHonorarios: 0, porcentajeHonorarios: 7.5,
    pagaHonorarios: 'PROPIETARIO', moneda: 'ARS', propiedadId: secondProperty.id, inmobiliariaId: agency.id,
    propietarios: { create: { personaId: owner.id, esPrincipal: true } },
    inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  const variableFee = await api('/liquidaciones', 'POST', { contratoId: variableFeeContract.id, periodo: '2026-09-01' });
  assert.equal(variableFee.status, 201, JSON.stringify(variableFee.data));
  assert.equal(Number(variableFee.data.montoHonorarios), 22500);
  assert.equal(Number(variableFee.data.netoACobrar), 300000);
  assert.equal(Number(variableFee.data.montoPropietario), 277500);
});
