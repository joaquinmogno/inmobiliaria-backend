const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let sessionPromise;

async function adminSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const response = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin.integration@example.com',
          password: 'ProdTest!2026_Strong',
        }),
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
        cookie: `pc_session=${sessionCookie}; pc_csrf=${body.csrfToken}`,
      };
    })();
  }
  return sessionPromise;
}

async function api(path, { method = 'GET', body } = {}) {
  const session = await adminSession();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(method !== 'GET' ? {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

async function userSession(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

async function apiAs(session, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

async function createContract(overrides = {}) {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({
    data: {
      direccion: `Liquidaciones ${suffix}`,
      inmobiliariaId: agency.id,
      estado: 'ALQUILADO',
    },
  });
  const owner = await prisma.persona.create({
    data: {
      nombreCompleto: `Propietario ${suffix}`,
      inmobiliariaId: agency.id,
    },
  });
  const tenant = await prisma.persona.create({
    data: {
      nombreCompleto: `Inquilino ${suffix}`,
      inmobiliariaId: agency.id,
    },
  });

  return prisma.contrato.create({
    data: {
      fechaInicio: new Date('2026-01-01T00:00:00.000Z'),
      fechaFin: new Date('2027-12-31T00:00:00.000Z'),
      estado: 'ACTIVO',
      montoAlquiler: 100000,
      montoHonorarios: 0,
      pagaHonorarios: 'INQUILINO',
      moneda: 'ARS',
      propiedadId: property.id,
      inmobiliariaId: agency.id,
      requiereActualizacion: false,
      propietarios: { create: { personaId: owner.id, esPrincipal: true } },
      inquilinos: { create: { personaId: tenant.id, esPrincipal: true } },
      ...overrides,
    },
    include: { propietarios: true },
  });
}

test('LIQ-001/002/003: canonical totals are identical and confirmed liquidations are immutable', async () => {
  const contract = await createContract({
    montoAlquiler: 100000,
    montoHonorarios: 5000,
    porcentajeHonorarios: 5,
    pagaHonorarios: 'INQUILINO',
  });

  const creation = await api('/liquidaciones', {
    method: 'POST',
    body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  assert.equal(creation.response.status, 201, JSON.stringify(creation.payload));
  assert.equal(Number(creation.payload.netoACobrar), 105000);
  assert.equal(Number(creation.payload.montoPropietario), 100000);
  assert.equal(Number(creation.payload.montoAlquilerBase), 100000);
  assert.equal(creation.payload.pagaHonorarios, 'INQUILINO');

  const liquidationId = creation.payload.id;
  const confirmation = await api(`/liquidaciones/${liquidationId}/confirmar`, { method: 'PATCH', body: {} });
  assert.equal(confirmation.response.status, 200);
  // El detalle se actualiza con esta respuesta, sin una recarga posterior: el
  // saldo debe reflejar de inmediato el importe recién confirmado.
  assert.deepEqual(confirmation.payload.resumenOperativo, {
    cobradoInquilino: 0,
    creditoAplicadoInquilino: 0,
    saldoInquilino: 105000,
    pagadoPropietario: 0,
    saldoPropietario: 100000,
    capitalPropioExpuesto: 0,
  });

  const movementAfterConfirmation = await api(`/liquidaciones/${liquidationId}/movimientos`, {
    method: 'POST',
    body: { tipo: 'INGRESO', concepto: 'No debe aplicarse', monto: 20000 },
  });
  assert.equal(movementAfterConfirmation.response.status, 409);
  assert.equal(movementAfterConfirmation.payload.code, 'LIQUIDATION_NOT_EDITABLE');

  const feeAfterConfirmation = await api(`/liquidaciones/${liquidationId}/honorarios`, {
    method: 'PATCH',
    body: { montoHonorarios: 10000 },
  });
  assert.equal(feeAfterConfirmation.response.status, 409);

  const payment = await api('/pagos', {
    method: 'POST',
    body: {
      contratoId: contract.id,
      liquidacionId: liquidationId,
      monto: 105000,
      moneda: 'ARS',
      fechaPago: '2026-09-04',
      metodoPago: 'TRANSFERENCIA',
    },
  });
  assert.equal(payment.response.status, 201);
  assert.equal(payment.payload.modoAplicacion, 'LIQUIDACION_ESPECIFICA');

  const detail = await api(`/liquidaciones/${liquidationId}`);
  assert.equal(detail.response.status, 200);
  assert.equal(Number(detail.payload.montoPropietario), 100000);

  const list = await api(`/liquidaciones?contratoId=${contract.id}`);
  assert.equal(list.response.status, 200);
  assert.equal(Number(list.payload.data[0].montoPropietario), 100000);

  const ownerPayment = await api(`/liquidaciones/${liquidationId}/pagar-propietario`, {
    method: 'PATCH',
    body: { monto: 100000, fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA', propietarioId: contract.propietarios[0].personaId },
  });
  assert.equal(ownerPayment.response.status, 200);
  assert.equal(Number(ownerPayment.payload.montoPropietario), 100000);

  const ownerCashEntry = await prisma.movimientoCaja.findFirstOrThrow({
    where: { liquidacionId: liquidationId, tipo: 'EGRESO' },
  });
  assert.equal(Number(ownerCashEntry.monto), 100000);
});

test('LIQ-004: API rejects periods outside the contract validity', async () => {
  const contract = await createContract({
    fechaInicio: new Date('2026-11-01T00:00:00.000Z'),
    fechaFin: new Date('2027-01-31T00:00:00.000Z'),
    estado: 'PROGRAMADO',
  });

  const result = await api('/liquidaciones', {
    method: 'POST',
    body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'LIQUIDATION_PERIOD_OUTSIDE_CONTRACT');
  assert.equal(await prisma.liquidacion.count({ where: { contratoId: contract.id } }), 0);
});

test('LIQ-005: historical liquidations use the rent effective in their period', async () => {
  const contract = await createContract({ montoAlquiler: 150000 });
  await prisma.actualizacionContrato.create({
    data: {
      contratoId: contract.id,
      fechaActualizacion: new Date('2026-08-15T12:00:00.000Z'),
      montoAnterior: 100000,
      montoNuevo: 150000,
      moneda: 'ARS',
      fechaProximaNueva: new Date('2027-02-01T00:00:00.000Z'),
    },
  });

  const july = await api('/liquidaciones', {
    method: 'POST',
    body: { contratoId: contract.id, periodo: '2026-07-01' },
  });
  const september = await api('/liquidaciones', {
    method: 'POST',
    body: { contratoId: contract.id, periodo: '2026-09-01' },
  });


  assert.equal(july.response.status, 201);
  assert.equal(september.response.status, 201);
  assert.equal(Number(july.payload.montoAlquilerBase), 100000);
  assert.equal(Number(july.payload.netoACobrar), 100000);
  assert.equal(Number(september.payload.montoAlquilerBase), 150000);
  assert.equal(Number(september.payload.netoACobrar), 150000);
});

test('LIQ-006: a payment initiated from a detail targets that liquidation only', async () => {
  const contract = await createContract();
  const july = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-07-01' },
  });
  const august = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-08-01' },
  });
  assert.equal(july.response.status, 201);
  assert.equal(august.response.status, 201);
  await api(`/liquidaciones/${july.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  await api(`/liquidaciones/${august.payload.id}/confirmar`, { method: 'PATCH', body: {} });

  const payment = await api('/pagos', {
    method: 'POST',
    body: {
      contratoId: contract.id,
      liquidacionId: august.payload.id,
      monto: 100000,
      moneda: 'ARS',
      fechaPago: '2026-09-04',
      metodoPago: 'EFECTIVO',
    },
  });
  assert.equal(payment.response.status, 201);
  assert.equal(payment.payload.pagos.length, 1);
  assert.equal(payment.payload.pagos[0].liquidacionId, august.payload.id);

  const [julyPayments, augustPayments] = await Promise.all([
    prisma.pago.count({ where: { liquidacionId: july.payload.id, anuladoEn: null } }),
    prisma.pago.count({ where: { liquidacionId: august.payload.id, anuladoEn: null } }),
  ]);
  assert.equal(julyPayments, 0);
  assert.equal(augustPayments, 1);
});

test('LIQ-007/014: owner payout identifies its recipient and can be reversed atomically', async () => {
  const contract = await createContract();
  const ownerId = contract.propietarios[0].personaId;
  const creation = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  assert.equal(creation.response.status, 201);
  await api(`/liquidaciones/${creation.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  await api('/pagos', {
    method: 'POST',
    body: {
      contratoId: contract.id, liquidacionId: creation.payload.id, monto: 100000,
      moneda: 'ARS', fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA',
    },
  });

  const wrongRecipient = await api(`/liquidaciones/${creation.payload.id}/pagar-propietario`, {
    method: 'PATCH',
    body: { monto: 100000, fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA', propietarioId: ownerId + 999999 },
  });
  assert.equal(wrongRecipient.response.status, 409);
  assert.equal(wrongRecipient.payload.code, 'OWNER_RECIPIENT_MISMATCH');

  const payout = await api(`/liquidaciones/${creation.payload.id}/pagar-propietario`, {
    method: 'PATCH',
    body: { monto: 100000, fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA', propietarioId: ownerId },
  });
  assert.equal(payout.response.status, 200);
  assert.equal(payout.payload.propietarioPagoId, ownerId);
  assert.ok(payout.payload.pagoPropietarioMovimientoId);

  const reversal = await api(`/liquidaciones/${creation.payload.id}/anular-pago-propietario`, {
    method: 'POST', body: { motivo: 'Transferencia cargada por error' },
  });
  assert.equal(reversal.response.status, 200);
  assert.equal(reversal.payload.liquidacion.estado, 'PAGADA_POR_INQUILINO');

  const [original, reverseEntry, persisted] = await Promise.all([
    prisma.movimientoCaja.findUniqueOrThrow({ where: { id: payout.payload.pagoPropietarioMovimientoId } }),
    prisma.movimientoCaja.findFirstOrThrow({ where: { reversionDeId: payout.payload.pagoPropietarioMovimientoId } }),
    prisma.liquidacion.findUniqueOrThrow({ where: { id: creation.payload.id } }),
  ]);
  assert.ok(original.anuladoEn);
  assert.equal(reverseEntry.tipo, 'INGRESO');
  assert.equal(Number(reverseEntry.monto), Number(original.monto));
  assert.equal(persisted.pagoPropietarioMovimientoId, null);
  assert.equal(persisted.propietarioPagoId, ownerId);
  assert.match(persisted.propietarioNombre, /Propietario/);
});

test('LIQ-008: deleting a draft installment movement releases it, but the plan is cancelled instead of erased', async () => {
  const contract = await createContract();
  const plan = await api('/planes-cuotas', {
    method: 'POST',
    body: {
      contratoId: contract.id, concepto: 'Arreglo financiado', montoTotal: 3000,
      cantidadCuotas: 1, fechaPrimeraCuota: '2026-09-01', tipoMovimiento: 'DESCUENTO', esParaInmobiliaria: false,
    },
  });
  assert.equal(plan.response.status, 201);
  const installment = await prisma.cuotaPlan.findFirstOrThrow({ where: { planId: plan.payload.id } });
  const creation = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01', cuotasIds: [installment.id] },
  });
  assert.equal(creation.response.status, 201);
  const movement = await prisma.movimiento.findFirstOrThrow({ where: { liquidacionId: creation.payload.id, cuota: { isNot: null } } });

  const deletion = await api(`/liquidaciones/movimientos/${movement.id}`, { method: 'DELETE' });
  assert.equal(deletion.response.status, 200);
  const released = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: installment.id } });
  assert.equal(released.liquidacionId, null);
  assert.equal(released.movimientoId, null);
  const deletionAttempt = await api(`/planes-cuotas/${plan.payload.id}`, { method: 'DELETE' });
  assert.equal(deletionAttempt.response.status, 409);
  assert.equal(deletionAttempt.payload.code, 'INSTALLMENT_PLAN_DELETION_REPLACED');

  const cancelled = await api(`/planes-cuotas/${plan.payload.id}/cancelar`, {
    method: 'POST', body: { motivo: 'Acuerdo cancelado por las partes' },
  });
  assert.equal(cancelled.response.status, 200);
  const preserved = await prisma.planCuotas.findUniqueOrThrow({ where: { id: plan.payload.id }, include: { cuotas: true } });
  assert.equal(preserved.estado, 'CANCELADO');
  assert.equal(preserved.cuotas[0].estado, 'CANCELADA');
});

test('installment plans preserve cancellation, forgiveness and rescheduling history, and become fulfilled when collected', async () => {
  const contract = await createContract();
  const createPlan = (concepto, montoTotal = 3000, cantidadCuotas = 1) => api('/planes-cuotas', {
    method: 'POST',
    body: {
      contratoId: contract.id, concepto, montoTotal, cantidadCuotas,
      fechaPrimeraCuota: '2026-09-01', tipoMovimiento: 'INGRESO', esParaInmobiliaria: false,
    },
  });

  const cancellable = await createPlan('Acuerdo a cancelar');
  const cancelled = await api(`/planes-cuotas/${cancellable.payload.id}/cancelar`, {
    method: 'POST', body: { motivo: 'Las partes dejaron sin efecto el acuerdo' },
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
  const cancelledPlan = await prisma.planCuotas.findUniqueOrThrow({ where: { id: cancellable.payload.id }, include: { cuotas: true } });
  assert.equal(cancelledPlan.estado, 'CANCELADO');
  assert.deepEqual(cancelledPlan.cuotas.map(cuota => cuota.estado), ['CANCELADA']);

  const forgivable = await createPlan('Saldo condonado');
  const forgiven = await api(`/planes-cuotas/${forgivable.payload.id}/condonar`, {
    method: 'POST', body: { motivo: 'Se condona el saldo por acuerdo comercial' },
  });
  assert.equal(forgiven.response.status, 200, JSON.stringify(forgiven.payload));
  const forgivenPlan = await prisma.planCuotas.findUniqueOrThrow({ where: { id: forgivable.payload.id }, include: { cuotas: true } });
  assert.equal(forgivenPlan.estado, 'CONDONADO');
  assert.deepEqual(forgivenPlan.cuotas.map(cuota => cuota.estado), ['CONDONADA']);

  const original = await createPlan('Deuda reprogramada', 3000, 2);
  const rescheduled = await api(`/planes-cuotas/${original.payload.id}/reprogramar`, {
    method: 'POST', body: {
      motivo: 'Se unifican las cuotas pendientes en un nuevo acuerdo',
      montoTotal: 2400, cantidadCuotas: 3, fechaPrimeraCuota: '2026-10-01',
    },
  });
  assert.equal(rescheduled.response.status, 201, JSON.stringify(rescheduled.payload));
  const originalPlan = await prisma.planCuotas.findUniqueOrThrow({ where: { id: original.payload.id }, include: { cuotas: true } });
  const successor = await prisma.planCuotas.findUniqueOrThrow({ where: { id: rescheduled.payload.successor.id }, include: { cuotas: true } });
  assert.equal(originalPlan.estado, 'REPROGRAMADO');
  assert.deepEqual(originalPlan.cuotas.map(cuota => cuota.estado), ['REPROGRAMADA', 'REPROGRAMADA']);
  assert.equal(successor.planOrigenId, originalPlan.id);
  assert.equal(successor.estado, 'VIGENTE');
  assert.equal(successor.cuotas.length, 3);

  const collectible = await createPlan('Cuota a cobrar', 1000);
  const cuota = await prisma.cuotaPlan.findFirstOrThrow({ where: { planId: collectible.payload.id } });
  const liquidation = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01', cuotasIds: [cuota.id] },
  });
  assert.equal(liquidation.response.status, 201, JSON.stringify(liquidation.payload));
  assert.equal((await api(`/liquidaciones/${liquidation.payload.id}/confirmar`, { method: 'PATCH', body: {} })).response.status, 200);
  const payment = await api('/pagos', {
    method: 'POST', body: {
      contratoId: contract.id, liquidacionId: liquidation.payload.id, monto: 101000,
      moneda: 'ARS', fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA',
    },
  });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.payload));
  const fulfilledPlan = await prisma.planCuotas.findUniqueOrThrow({ where: { id: collectible.payload.id }, include: { cuotas: true } });
  assert.equal(fulfilledPlan.estado, 'CUMPLIDO');
  assert.equal(fulfilledPlan.cuotas[0].estado, 'PAGADA');
});

test('LIQ-009/011/012: invalid owner totals and unmanaged contracts are blocked; due date is preserved', async () => {
  const excessiveFees = await createContract({ pagaHonorarios: 'PROPIETARIO', montoHonorarios: 120000, diaVencimiento: 31 });
  const invalid = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: excessiveFees.id, periodo: '2026-09-01' },
  });
  assert.equal(invalid.response.status, 409);
  assert.equal(invalid.payload.code, 'NEGATIVE_OWNER_TOTAL');
  assert.equal(await prisma.liquidacion.count({ where: { contratoId: excessiveFees.id } }), 0);

  const unmanaged = await createContract({ administrado: false });
  const unmanagedResult = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: unmanaged.id, periodo: '2026-09-01' },
  });
  assert.equal(unmanagedResult.response.status, 409);
  assert.equal(unmanagedResult.payload.code, 'CONTRACT_NOT_MANAGED');

  const valid = await createContract({ diaVencimiento: 31 });
  const february = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: valid.id, periodo: '2027-02-01' },
  });
  assert.equal(february.response.status, 201);
  assert.equal(february.payload.fechaVencimiento.slice(0, 10), '2027-02-28');
});

test('LIQ-010/015: monthly preparation categorizes contracts and bulk generation is idempotent', async () => {
  const ready = await createContract();
  const unmanaged = await createContract({ administrado: false });
  const plan = await api('/planes-cuotas', {
    method: 'POST',
    body: {
      contratoId: ready.id, concepto: 'Seguro mensual', montoTotal: 2500,
      cantidadCuotas: 1, fechaPrimeraCuota: '2026-10-01', tipoMovimiento: 'INGRESO', esParaInmobiliaria: false,
    },
  });
  assert.equal(plan.response.status, 201);
  const preparation = await api('/liquidaciones/preparacion?periodo=2026-10-01');
  assert.equal(preparation.response.status, 200);
  assert.equal(preparation.payload.data.find(row => row.contratoId === ready.id).status, 'LISTA');
  assert.equal(preparation.payload.data.find(row => row.contratoId === unmanaged.id).status, 'NO_ELEGIBLE');

  const generated = await api('/liquidaciones/generar-periodo', {
    method: 'POST', body: { periodo: '2026-10-01', contratoIds: [ready.id] },
  });
  assert.equal(generated.response.status, 201);
  assert.equal(generated.payload.created.length, 1);
  const generatedInstallment = await prisma.cuotaPlan.findFirstOrThrow({ where: { planId: plan.payload.id } });
  assert.equal(generatedInstallment.liquidacionId, generated.payload.created[0].liquidacionId);
  assert.ok(generatedInstallment.movimientoId);

  const repeated = await api('/liquidaciones/generar-periodo', {
    method: 'POST', body: { periodo: '2026-10-01', contratoIds: [ready.id] },
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.created.length, 0);
  assert.equal(repeated.payload.skipped[0].status, 'GENERADA');
  assert.equal(await prisma.liquidacion.count({ where: { contratoId: ready.id, periodo: new Date('2026-10-01T00:00:00.000Z') } }), 1);
});

test('monthly workspace separates overdue installments, records omissions and resists concurrent generation', async () => {
  const contract = await createContract();
  const plan = await api('/planes-cuotas', {
    method: 'POST',
    body: {
      contratoId: contract.id, concepto: 'Reparación en cuotas', montoTotal: 2000,
      cantidadCuotas: 2, fechaPrimeraCuota: '2026-09-01', tipoMovimiento: 'INGRESO', esParaInmobiliaria: false,
    },
  });
  assert.equal(plan.response.status, 201, JSON.stringify(plan.payload));

  const preparation = await api('/liquidaciones/preparacion?periodo=2026-10-01');
  const row = preparation.payload.data.find(item => item.contratoId === contract.id);
  assert.equal(row.status, 'REVISAR');
  assert.equal(row.cuotasPeriodo.length, 1);
  assert.equal(row.cuotasVencidas.length, 1);
  assert.equal(row.puedeGenerarseAlResolverCuotas, true);

  const generated = await api('/liquidaciones/generar-periodo', {
    method: 'POST',
    body: {
      periodo: '2026-10-01',
      selecciones: [{
        contratoId: contract.id,
        contratoVersion: row.contratoVersion,
        cuotasVencidasRevisadas: true,
        cuotasVencidasIds: [],
      }],
    },
  });
  assert.equal(generated.response.status, 201);
  const installments = await prisma.cuotaPlan.findMany({ where: { planId: plan.payload.id }, orderBy: { numeroCuota: 'asc' } });
  assert.equal(installments[0].liquidacionId, null);
  assert.equal(installments[1].liquidacionId, generated.payload.created[0].liquidacionId);

  const omittedContract = await createContract({ administrado: false });
  const omitted = await api('/liquidaciones/preparacion/descartar', {
    method: 'POST', body: { contratoId: omittedContract.id, periodo: '2026-10-01', motivo: 'No corresponde administrar este mes' },
  });
  assert.equal(omitted.response.status, 200);
  const afterOmission = await api('/liquidaciones/preparacion?periodo=2026-10-01');
  assert.equal(afterOmission.payload.data.find(item => item.contratoId === omittedContract.id).descartada, true);
  assert.equal((await api('/liquidaciones/preparacion/reabrir', {
    method: 'POST', body: { contratoId: omittedContract.id, periodo: '2026-10-01' },
  })).response.status, 200);

  const concurrent = await createContract();
  const [first, second] = await Promise.all([
    api('/liquidaciones/generar-periodo', { method: 'POST', body: { periodo: '2026-11-01', contratoIds: [concurrent.id] } }),
    api('/liquidaciones/generar-periodo', { method: 'POST', body: { periodo: '2026-11-01', contratoIds: [concurrent.id] } }),
  ]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 201]);
  assert.equal(await prisma.liquidacion.count({ where: { contratoId: concurrent.id, periodo: new Date('2026-11-01T00:00:00.000Z') } }), 1);
});

test('LIQ-016: PDF endpoint returns an actual PDF response', async () => {
  const contract = await createContract();
  const creation = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  const session = await adminSession();
  const response = await fetch(`${apiBase}/liquidaciones/${creation.payload.id}/pdf`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^application\/pdf/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
});

test('liquidation confirmation is enforced independently from draft editing', async () => {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const permissions = await prisma.permiso.findMany({
    where: { clave: { in: ['liquidaciones.ver', 'liquidaciones.editar', 'liquidaciones.confirmar'] } },
  });
  const byKey = new Map(permissions.map(permission => [permission.clave, permission]));
  const suffix = `${Date.now()}-${Math.random()}`;
  const role = await prisma.rol.create({
    data: {
      nombre: `Liquidador limitado ${suffix}`,
      inmobiliariaId: agency.id,
      permisos: {
        create: ['liquidaciones.ver', 'liquidaciones.editar'].map(clave => ({ permisoId: byKey.get(clave).id })),
      },
    },
  });
  const password = 'Permisos-Liquidaciones-2026!';
  const user = await prisma.usuario.create({
    data: {
      email: `liquidaciones-permisos-${suffix}@example.test`,
      password: await bcrypt.hash(password, 10),
      nombreCompleto: 'Operador sin confirmación',
      tipo: 'USUARIO',
      rolId: role.id,
      inmobiliariaId: agency.id,
    },
  });
  const session = await userSession(user.email, password);
  const contract = await createContract();
  const creation = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  assert.equal(creation.response.status, 201, JSON.stringify(creation.payload));

  const denied = await apiAs(session, `/liquidaciones/${creation.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  assert.equal(denied.response.status, 403);

  await prisma.rolPermiso.create({
    data: { rolId: role.id, permisoId: byKey.get('liquidaciones.confirmar').id },
  });
  const allowed = await apiAs(session, `/liquidaciones/${creation.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
});

test('LIQ-017: a credit after an overpayment is returned or applied without duplicating tenant debt', async () => {
  const contract = await createContract();
  const source = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-09-01' },
  });
  const target = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: contract.id, periodo: '2026-10-01' },
  });
  assert.equal(source.response.status, 201);
  assert.equal(target.response.status, 201);
  await api(`/liquidaciones/${source.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  await api(`/liquidaciones/${target.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  const paid = await api('/pagos', {
    method: 'POST',
    body: {
      contratoId: contract.id, liquidacionId: source.payload.id, monto: 100000,
      moneda: 'ARS', fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA',
    },
  });
  assert.equal(paid.response.status, 201, JSON.stringify(paid.payload));

  const credit = await api(`/liquidaciones/${source.payload.id}/ajustes`, {
    method: 'POST',
    body: {
      tipo: 'CREDITO', concepto: 'Bonificación acordada', motivo: 'Se cobró un importe mayor al correcto',
      monto: 10000, impactoInquilino: -10000, impactoPropietario: 0,
      destinoCredito: 'SALDO_A_FAVOR',
    },
  });
  assert.equal(credit.response.status, 201, JSON.stringify(credit.payload));
  assert.equal(Number(credit.payload.liquidacion.netoACobrar), 90000);
  const persistedCredit = await prisma.creditoInquilino.findUniqueOrThrow({
    where: { ajusteLiquidacionId: credit.payload.adjustment.id },
  });
  assert.equal(Number(persistedCredit.montoOriginal), 10000);
  assert.equal(Number(persistedCredit.saldoPendiente), 10000);
  assert.equal(persistedCredit.estado, 'DISPONIBLE');

  const application = await api(`/liquidaciones/creditos-inquilino/${persistedCredit.id}/aplicar`, {
    method: 'POST', body: { liquidacionDestinoId: target.payload.id, monto: 10000 },
  });
  assert.equal(application.response.status, 201, JSON.stringify(application.payload));
  const [appliedCredit, targetDetail, debt] = await Promise.all([
    prisma.creditoInquilino.findUniqueOrThrow({ where: { id: persistedCredit.id } }),
    prisma.liquidacion.findUniqueOrThrow({
      where: { id: target.payload.id }, include: { aplicacionesCredito: true },
    }),
    api(`/pagos/deuda/contrato/${contract.id}`),
  ]);
  assert.equal(Number(appliedCredit.saldoPendiente), 0);
  assert.equal(appliedCredit.estado, 'APLICADO');
  assert.equal(Number(targetDetail.aplicacionesCredito[0].monto), 10000);
  assert.equal(debt.response.status, 200);
  assert.equal(debt.payload.detalle.find(item => item.id === target.payload.id).deuda, 90000);

  const refundContract = await createContract();
  const refundSource = await api('/liquidaciones', {
    method: 'POST', body: { contratoId: refundContract.id, periodo: '2026-09-01' },
  });
  await api(`/liquidaciones/${refundSource.payload.id}/confirmar`, { method: 'PATCH', body: {} });
  await api('/pagos', {
    method: 'POST',
    body: {
      contratoId: refundContract.id, liquidacionId: refundSource.payload.id, monto: 100000,
      moneda: 'ARS', fechaPago: '2026-09-04', metodoPago: 'TRANSFERENCIA',
    },
  });
  const refund = await api(`/liquidaciones/${refundSource.payload.id}/ajustes`, {
    method: 'POST',
    body: {
      tipo: 'CREDITO', concepto: 'Corrección de alquiler', motivo: 'El alquiler correcto era menor al cobrado',
      monto: 10000, impactoInquilino: -10000, impactoPropietario: 0,
      destinoCredito: 'DEVOLUCION', fechaDevolucion: '2026-09-05', metodoDevolucion: 'TRANSFERENCIA',
      observacionesDevolucion: 'Transferencia de devolución al inquilino',
    },
  });
  assert.equal(refund.response.status, 201, JSON.stringify(refund.payload));
  const refundedCredit = await prisma.creditoInquilino.findUniqueOrThrow({
    where: { ajusteLiquidacionId: refund.payload.adjustment.id },
    include: { movimientoDevolucion: true },
  });
  assert.equal(refundedCredit.estado, 'DEVUELTO');
  assert.equal(Number(refundedCredit.saldoPendiente), 0);
  assert.equal(refundedCredit.movimientoDevolucion.tipo, 'EGRESO');
  assert.equal(Number(refundedCredit.movimientoDevolucion.monto), 10000);
});

test.after(async () => prisma.$disconnect());
