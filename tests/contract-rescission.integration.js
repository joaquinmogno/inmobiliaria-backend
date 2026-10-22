const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');
const { assertPropertyAvailableForPeriod } = require('../dist/services/contract-write.service');
const { argentinaTodayAsDate } = require('../dist/utils/argentina-date');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';

test('entrega de llaves, liquidación final y cierre sin reclamos son hitos separados', async () => {
  const login = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }) });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const session = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie')).match(/pc_session=([^;,\s]+)/)?.[1];
  const headers = { cookie: `pc_session=${session}; pc_csrf=${auth.csrfToken}`, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken };
  const request = async (method, path, body) => {
    const response = await fetch(`${apiBase}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };

  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Llaves ${suffix}`, inmobiliariaId: agency.id, estado: 'ALQUILADO' } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const today = argentinaTodayAsDate().toISOString().slice(0, 10);
  const contract = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2026-01-01T00:00:00.000Z'), fechaFin: new Date('2027-12-31T00:00:00.000Z'),
    estado: 'ACTIVO', montoAlquiler: 1000, montoHonorarios: 50, moneda: 'ARS', propiedadId: property.id, inmobiliariaId: agency.id,
    propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  const debt = await prisma.liquidacion.create({ data: {
    periodo: new Date('2026-09-01T00:00:00.000Z'), estado: 'CONFIRMADA', netoACobrar: 1000,
    montoPropietario: 950, contratoId: contract.id, inmobiliariaId: agency.id, moneda: 'ARS'
  } });

  const keyInput = { fechaEntregaLlaves: today, horaEntrega: '15:00', cantidadLlaves: 2, receptorNombre: 'Administrador de prueba', estadoInmueble: 'Desocupado', inmuebleDesocupado: true, version: contract.version };
  const previewKeys = await request('POST', `/contratos/${contract.id}/llaves/vista-previa`, keyInput);
  assert.equal(previewKeys.status, 200, JSON.stringify(previewKeys.data));
  const delivered = await request('POST', `/contratos/${contract.id}/llaves`, { ...keyInput, vistaPreviaHash: previewKeys.data.vistaPreviaHash });
  assert.equal(delivered.status, 201, JSON.stringify(delivered.data));
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'EN_CIERRE');
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).estado, 'DISPONIBLE');
  assert.equal(await prisma.movimientoCaja.count({ where: { contratoId: contract.id } }), 0);
  await prisma.$transaction(tx => assertPropertyAvailableForPeriod(tx, property.id, new Date('2026-11-01'), new Date('2027-11-01')));
  const keyPdf = await fetch(`${apiBase}/contratos/${contract.id}/actas-llaves/1/pdf`, { headers: { cookie: headers.cookie } });
  assert.equal(keyPdf.status, 200);
  assert.ok((await keyPdf.arrayBuffer()).byteLength > 1000);

  const period = `${today.slice(0, 7)}-01`;
  const draft = await request('POST', '/liquidaciones', { contratoId: contract.id, periodo: period });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const unreviewed = await request('PATCH', `/liquidaciones/${draft.data.id}/confirmar`, {});
  assert.equal(unreviewed.status, 409);
  assert.equal(unreviewed.data.code, 'FINAL_RENT_MANUAL_REVIEW_REQUIRED');
  const laterPeriod = new Date(`${period}T00:00:00.000Z`);
  laterPeriod.setUTCMonth(laterPeriod.getUTCMonth() + 1);
  const afterKeysPeriod = await request('POST', '/liquidaciones', { contratoId: contract.id, periodo: laterPeriod.toISOString().slice(0, 10) });
  assert.equal(afterKeysPeriod.status, 409);

  const closureInput = {
    tipoCierre: 'ANTICIPADA_INQUILINO', sinReclamosConfirmado: true, serviciosSaldadosConfirmados: true, depositoResueltoConfirmado: true,
    motivo: 'Decisión anticipada del inquilino', fechaRescision: today, llavesEntregadas: true, fechaEntregaLlaves: today,
    cantidadLlaves: 2, estadoInmueble: 'Desocupado', multaImporte: 0, multaResponsable: null,
    depositoADevolver: 0, depositoRetenido: 0, pendientesManuales: [], version: delivered.data.contratoVersion
  };
  const blocked = await request('POST', `/contratos/${contract.id}/rescision/vista-previa`, closureInput);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'OUTSTANDING_OBLIGATIONS');
  assert.equal(await prisma.actaRescision.count({ where: { contratoId: contract.id } }), 0);

  // El saldo previo se resuelve; el borrador final todavía impide la cláusula sin reclamos.
  await prisma.liquidacion.update({ where: { id: debt.id }, data: { netoACobrar: 0, montoPropietario: 0, estadoCobroInquilino: 'NO_APLICA', estadoPagoPropietario: 'NO_APLICA' } });
  const stillDraft = await request('POST', `/contratos/${contract.id}/rescision/vista-previa`, closureInput);
  assert.equal(stillDraft.status, 409);
  assert.equal(stillDraft.data.code, 'DRAFT_LIQUIDATIONS_PENDING');
  const rent = await request('PATCH', `/liquidaciones/${draft.data.id}/alquiler`, { montoNuevo: 80, alcance: 'SOLO_PERIODO', motivo: 'Importe final acordado por días hasta las llaves', expectedVersion: draft.data.version });
  assert.equal(rent.status, 200, JSON.stringify(rent.data));
  assert.equal(Number((await prisma.movimiento.findFirstOrThrow({ where: { liquidacionId: draft.data.id, concepto: 'Alquiler Mensual' } })).monto), 80);
  const confirmed = await request('PATCH', `/liquidaciones/${draft.data.id}/confirmar`, {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const finalDebt = await request('POST', `/contratos/${contract.id}/rescision/vista-previa`, closureInput);
  assert.equal(finalDebt.status, 409);
  assert.equal(finalDebt.data.code, 'OUTSTANDING_OBLIGATIONS');
  // En este fixture aislado se saldan los importes sin simular dinero en caja.
  await prisma.liquidacion.update({ where: { id: draft.data.id }, data: { netoACobrar: 0, montoPropietario: 0, estadoCobroInquilino: 'NO_APLICA', estadoPagoPropietario: 'NO_APLICA' } });
  const previewClose = await request('POST', `/contratos/${contract.id}/rescision/vista-previa`, closureInput);
  assert.equal(previewClose.status, 200, JSON.stringify(previewClose.data));
  assert.match(previewClose.data.wording.closing, /nada tienen que reclamarse a futuro/);
  const issued = await request('POST', `/contratos/${contract.id}/rescindir`, { ...closureInput, vistaPreviaHash: previewClose.data.vistaPreviaHash });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'RESCINDIDO');
  const afterClosure = await request('POST', '/liquidaciones', { contratoId: contract.id, periodo: period });
  assert.equal(afterClosure.status, 409);
  const lateAdjustment = await request('POST', `/liquidaciones/${debt.id}/ajustes`, {});
  assert.equal(lateAdjustment.status, 409);
  assert.equal(lateAdjustment.data.code, 'CONTRACT_CLOSURE_IMMUTABLE');
  const latePayment = await request('POST', '/pagos', { contratoId: contract.id, liquidacionId: debt.id, monto: 1, fechaPago: today, metodoPago: 'EFECTIVO' });
  assert.equal(latePayment.status, 409);
  assert.equal(latePayment.data.code, 'CONTRACT_CLOSURE_IMMUTABLE');
});

test('vencimiento normal permite liquidar días hasta las llaves y emite cierre por acuerdo', async () => {
  const login = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }) });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const session = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie')).match(/pc_session=([^;,\s]+)/)?.[1];
  const headers = { cookie: `pc_session=${session}; pc_csrf=${auth.csrfToken}`, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken };
  const request = async (method, path, body) => {
    const response = await fetch(`${apiBase}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Vencimiento ${suffix}`, inmobiliariaId: agency.id, estado: 'PENDIENTE_ENTREGA' } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2025-01-01T00:00:00.000Z'), fechaFin: new Date('2026-10-01T00:00:00.000Z'),
    estado: 'FINALIZADO', montoAlquiler: 1000, montoHonorarios: 50, moneda: 'ARS', propiedadId: property.id, inmobiliariaId: agency.id,
    propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  const today = argentinaTodayAsDate().toISOString().slice(0, 10);
  const keys = { fechaEntregaLlaves: today, cantidadLlaves: 1, receptorNombre: 'Encargado', estadoInmueble: 'Desocupado', inmuebleDesocupado: true, version: contract.version };
  const previewKeys = await request('POST', `/contratos/${contract.id}/llaves/vista-previa`, keys);
  assert.equal(previewKeys.status, 200, JSON.stringify(previewKeys.data));
  const delivered = await request('POST', `/contratos/${contract.id}/llaves`, { ...keys, vistaPreviaHash: previewKeys.data.vistaPreviaHash });
  assert.equal(delivered.status, 201, JSON.stringify(delivered.data));
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'EN_CIERRE');
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).estado, 'DISPONIBLE');
  const period = `${today.slice(0, 7)}-01`;
  const preparation = await request('GET', `/liquidaciones/preparacion?periodo=${period}`);
  assert.equal(preparation.status, 200);
  assert.equal(preparation.data.data.find(item => item.contratoId === contract.id)?.status, 'LISTA');
  const generated = await request('POST', '/liquidaciones/generar-periodo', { periodo: period, contratoIds: [contract.id] });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  await prisma.liquidacion.update({ where: { id: generated.data.created[0].liquidacionId }, data: { estado: 'ANULADA' } });
  const close = {
    tipoCierre: 'VENCIMIENTO_ACORDADO', sinReclamosConfirmado: true, serviciosSaldadosConfirmados: true, depositoResueltoConfirmado: true,
    motivo: 'Finalización del plazo, sin renovación', fechaRescision: today, llavesEntregadas: true, fechaEntregaLlaves: today,
    cantidadLlaves: 1, estadoInmueble: 'Desocupado', multaImporte: 0, multaResponsable: null,
    depositoADevolver: 0, depositoRetenido: 0, pendientesManuales: [], version: delivered.data.contratoVersion
  };
  const preview = await request('POST', `/contratos/${contract.id}/rescision/vista-previa`, close);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.match(preview.data.wording.title, /FINALIZACIÓN DE CONTRATO/);
  const issued = await request('POST', `/contratos/${contract.id}/rescindir`, { ...close, vistaPreviaHash: preview.data.vistaPreviaHash });
  assert.equal(issued.status, 201, JSON.stringify(issued.data));
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'FINALIZADO');
});
