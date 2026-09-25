const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
let sessionPromise;

async function adminSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = createAdminSession();
  return sessionPromise;
}

async function createAdminSession() {
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
  assert.ok(sessionCookie, 'login must return the session cookie');

  return {
    csrfToken: body.csrfToken,
    cookie: `pc_session=${sessionCookie}; pc_csrf=${body.csrfToken}`
  };
}

async function post(path, body, session) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

test('payment reversal preserves history, restores debt and balances cash', async () => {
  const session = await adminSession();
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const property = await prisma.propiedad.create({
    data: { direccion: `Reversión pago ${Date.now()}`, inmobiliariaId: agency.id, estado: 'ALQUILADO' }
  });
  const contract = await prisma.contrato.create({
    data: {
      fechaInicio: new Date('2026-01-01T00:00:00.000Z'),
      fechaFin: new Date('2027-12-31T00:00:00.000Z'),
      estado: 'ACTIVO',
      montoAlquiler: 1000,
      montoHonorarios: 0,
      moneda: 'ARS',
      propiedadId: property.id,
      inmobiliariaId: agency.id,
      requiereActualizacion: false
    }
  });
  const liquidation = await prisma.liquidacion.create({
    data: {
      periodo: new Date('2026-09-01T00:00:00.000Z'),
      estado: 'PENDIENTE_PAGO',
      totalIngresos: 1000,
      totalDescuentos: 0,
      netoACobrar: 1000,
      montoHonorarios: 0,
      moneda: 'ARS',
      contratoId: contract.id,
      inmobiliariaId: agency.id
    }
  });

  const creation = await post('/pagos', {
    contratoId: contract.id,
    monto: 400,
    moneda: 'ARS',
    fechaPago: '2026-09-02',
    metodoPago: 'TRANSFERENCIA',
    observaciones: 'Cobro a corregir'
  }, session);
  assert.equal(creation.response.status, 201);
  const paymentId = creation.payload.pagos[0].id;

  const originalMovement = await prisma.movimientoCaja.findUniqueOrThrow({ where: { pagoId: paymentId } });
  assert.equal(originalMovement.tipo, 'INGRESO');
  assert.equal(originalMovement.cuenta, 'BANCO');

  const invalidReason = await post(`/pagos/${paymentId}/anular`, { motivo: 'mal' }, session);
  assert.equal(invalidReason.response.status, 400);

  const reversal = await post(`/pagos/${paymentId}/anular`, {
    motivo: 'Importe ingresado por error'
  }, session);
  assert.equal(reversal.response.status, 200);
  assert.equal(reversal.payload.liquidacion.estado, 'PENDIENTE_PAGO');
  assert.equal(reversal.payload.liquidacion.totalPagado, '0');

  const preservedPayment = await prisma.pago.findUniqueOrThrow({ where: { id: paymentId } });
  assert.ok(preservedPayment.anuladoEn);
  assert.equal(preservedPayment.motivoAnulacion, 'Importe ingresado por error');

  const preservedMovement = await prisma.movimientoCaja.findUniqueOrThrow({
    where: { id: originalMovement.id }, include: { reversion: true }
  });
  assert.ok(preservedMovement.anuladoEn);
  assert.equal(preservedMovement.reversion.tipo, 'EGRESO');
  assert.equal(preservedMovement.reversion.cuenta, 'BANCO');
  assert.equal(Number(preservedMovement.reversion.monto), 400);

  const liquidationAfter = await prisma.liquidacion.findUniqueOrThrow({ where: { id: liquidation.id } });
  assert.equal(liquidationAfter.estado, 'PENDIENTE_PAGO');

  const debtResponse = await fetch(`${apiBase}/pagos/deuda/contrato/${contract.id}`, {
    headers: { cookie: session.cookie }
  });
  assert.equal(debtResponse.status, 200);
  assert.equal((await debtResponse.json()).totalDeuda, 1000);

  const contractLedger = await prisma.movimientoCaja.findMany({ where: { contratoId: contract.id } });
  const netCash = contractLedger.reduce((sum, item) => sum + (item.tipo === 'INGRESO' ? 1 : -1) * Number(item.monto), 0);
  assert.equal(netCash, 0);

  const duplicated = await post(`/pagos/${paymentId}/anular`, { motivo: 'Segundo intento inválido' }, session);
  assert.equal(duplicated.response.status, 409);
  assert.equal(duplicated.payload.code, 'PAYMENT_ALREADY_VOIDED');

  const audit = await prisma.auditLog.findFirst({
    where: { entidad: 'Pago', entidadId: paymentId, accion: 'ANULAR_PAGO' }
  });
  assert.ok(audit);
  assert.match(audit.detalle, /Importe ingresado por error/);
});

test('manual cash reversal creates one audited inverse entry and cannot repeat', async () => {
  const session = await adminSession();

  const creation = await post('/cajachica', {
    tipo: 'EGRESO',
    concepto: 'Gasto cargado por error',
    monto: 275.5,
    moneda: 'ARS',
    fecha: '2026-09-02',
    metodoPago: 'EFECTIVO',
    cuenta: 'CAJA'
  }, session);
  assert.equal(creation.response.status, 201);

  const reversal = await post(`/cajachica/${creation.payload.id}/anular`, {
    motivo: 'El comprobante correspondía a otro período'
  }, session);
  assert.equal(reversal.response.status, 200);
  assert.equal(reversal.payload.reversion.tipo, 'INGRESO');
  assert.equal(reversal.payload.reversion.reversionDeId, creation.payload.id);

  const pair = await prisma.movimientoCaja.findMany({
    where: { OR: [{ id: creation.payload.id }, { reversionDeId: creation.payload.id }] },
    orderBy: { id: 'asc' }
  });
  assert.equal(pair.length, 2);
  assert.ok(pair[0].anuladoEn);
  assert.equal(pair[0].motivoAnulacion, 'El comprobante correspondía a otro período');
  assert.equal(pair.reduce((sum, item) => sum + (item.tipo === 'INGRESO' ? 1 : -1) * Number(item.monto), 0), 0);

  const duplicated = await post(`/cajachica/${creation.payload.id}/anular`, {
    motivo: 'Segundo intento inválido'
  }, session);
  assert.equal(duplicated.response.status, 409);
  assert.equal(duplicated.payload.code, 'CASH_MOVEMENT_ALREADY_VOIDED');

  const inverseAttempt = await post(`/cajachica/${reversal.payload.reversion.id}/anular`, {
    motivo: 'Intento de anular la reversión'
  }, session);
  assert.equal(inverseAttempt.response.status, 409);
  assert.equal(inverseAttempt.payload.code, 'REVERSAL_CANNOT_BE_VOIDED');

  const audit = await prisma.auditLog.findFirst({
    where: { entidad: 'MovimientoCaja', entidadId: creation.payload.id, accion: 'ANULAR_MOVIMIENTO_CAJA' }
  });
  assert.ok(audit);
});

test.after(async () => prisma.$disconnect());
