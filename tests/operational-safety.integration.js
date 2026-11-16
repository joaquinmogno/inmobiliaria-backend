require('./financial-request-fixture');
// Ejecutar únicamente con docker-compose.integration.yml, nunca contra una instalación real.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { randomUUID } = require('node:crypto');
assert.match(process.env.DATABASE_URL || '', /127\.0\.0\.1:55433\/propcontrol_integration(?:\?|$)/);
const { prisma } = require('../dist/prisma');
const base = 'http://127.0.0.1:3100/api';
let admin, operators, agency;
const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function login(email, password = 'ProdTest!2026_Strong') {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const token = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(token);
  return { cookie: `pc_session=${token}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
}
async function api(path, method = 'GET', body, session = admin, operationKey) {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...(operationKey ? { 'Idempotency-Key': operationKey } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
function status(result, expected) { assert.equal(result.status, expected, JSON.stringify(result)); return result.data; }
async function bank(moneda = 'ARS') {
  return status(await api('/cuentas-bancarias', 'POST', { banco: 'Prueba aislada', nombre: suffix(), moneda }), 201);
}
async function fixture() {
  const property = await prisma.propiedad.create({ data: { direccion: `Seguridad ${suffix()}`, estado: 'ALQUILADO', inmobiliariaId: agency.id } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix()}`, aliasBancario: 'prueba.propietario', titularidadBancariaVerificada: true, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix()}`, inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({ data: {
    fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), estado: 'ACTIVO', montoAlquiler: 100000,
    montoHonorarios: 0, moneda: 'ARS', requiereActualizacion: false, propiedadId: property.id, inmobiliariaId: agency.id,
    propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
  } });
  return { contract, owner, bank: await bank() };
}
async function liquidation(f, cuotasIds = [], confirm = true) {
  const result = status(await api('/liquidaciones', 'POST', { contratoId: f.contract.id, periodo: '2026-09-01', cuotasIds }), 201);
  if (confirm) status(await api(`/liquidaciones/${result.id}/confirmar`, 'PATCH', {}), 200);
  return result;
}
function payment(f, l, monto = 100000) {
  return { contratoId: f.contract.id, liquidacionId: l.id, monto, moneda: 'ARS', fechaPago: '2026-09-10', metodoPago: 'TRANSFERENCIA', cuentaBancariaId: f.bank.id };
}
test.before(async () => {
  admin = await login('admin.integration@example.com');
  agency = await prisma.inmobiliaria.findFirstOrThrow();
  const keys = ['pagos.crear', 'liquidaciones.confirmar', 'liquidaciones.pagar_propietario'];
  const permissions = await prisma.permiso.findMany({ where: { clave: { in: keys } } });
  assert.equal(permissions.length, keys.length);
  const role = await prisma.rol.create({ data: { nombre: `Operadores ${suffix()}`, inmobiliariaId: agency.id, permisos: { create: permissions.map(p => ({ permisoId: p.id })) } } });
  const password = await bcrypt.hash('ProdTest!2026_Strong', 10);
  operators = [];
  for (let i = 0; i < 2; i++) {
    const user = await prisma.usuario.create({ data: { nombreCompleto: `Operador ${i}`, email: `operator-${suffix()}@example.com`, password, tipo: 'USUARIO', rolId: role.id, inmobiliariaId: agency.id } });
    operators.push(await login(user.email));
  }
});
test.after(() => prisma.$disconnect());

test('transferencias ARS/USD: contrapartidas exactas, rechazo de monedas distintas y misma cuenta', async () => {
  for (const moneda of ['ARS', 'USD']) {
    const origin = await bank(moneda), destination = await bank(moneda), other = await bank(moneda === 'ARS' ? 'USD' : 'ARS');
    const body = { fecha: '2026-09-10', moneda, monto: 1234.56, cuentaOrigenId: origin.id, cuentaDestinoId: destination.id, concepto: 'Transferencia de integración' };
    const transfer = status(await api('/cajachica/transferencias', 'POST', body), 201);
    const movements = await prisma.movimientoCaja.findMany({ where: { transferenciaInternaId: transfer.transferencia.id } });
    assert.equal(movements.length, 2);
    assert.deepEqual(movements.map(m => m.tipo).sort(), ['EGRESO', 'INGRESO']);
    assert.ok(movements.every(m => m.moneda === moneda && Number(m.monto) === 1234.56));
    assert.equal(movements.reduce((sum, m) => sum + (m.tipo === 'INGRESO' ? 1 : -1) * Number(m.monto), 0), 0);
    status(await api('/cajachica/transferencias', 'POST', { ...body, cuentaDestinoId: other.id }), 400);
    status(await api('/cajachica/transferencias', 'POST', { ...body, cuentaDestinoId: origin.id }), 400);
    assert.equal(await prisma.movimientoCaja.count({ where: { cuentaBancariaId: origin.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entidad: 'TransferenciaInterna', entidadId: transfer.transferencia.id, accion: 'TRANSFERIR_ENTRE_CUENTAS' } }), 1);
  }
});

test('cierre, bloqueo de ambas puntas, reapertura y cuenta inactiva conservan historial', async () => {
  const origin = await bank(), destination = await bank();
  const body = { fecha: '2026-09-10', moneda: 'ARS', monto: 10.25, cuentaOrigenId: origin.id, cuentaDestinoId: destination.id, concepto: 'Control de cierre' };
  const closure = status(await api('/cajachica/cierres', 'POST', { periodo: '2026-09-01', cuenta: 'BANCO', cuentaBancariaId: destination.id, moneda: 'ARS', saldoDeclarado: 0 }), 201);
  status(await api('/cajachica/transferencias', 'POST', body), 409);
  status(await api('/cajachica/transferencias', 'POST', { ...body, cuentaOrigenId: destination.id, cuentaDestinoId: origin.id }), 409);
  assert.equal(await prisma.movimientoCaja.count({ where: { cuentaBancariaId: { in: [origin.id, destination.id] } } }), 0);
  status(await api(`/cajachica/cierres/${closure.id}/reabrir`, 'POST', { motivo: 'Reapertura de prueba controlada' }), 200);
  status(await api('/cajachica/transferencias', 'POST', body), 201);
  status(await api(`/cuentas-bancarias/${destination.id}`, 'PUT', { nombre: destination.nombre, banco: destination.banco, moneda: 'USD', activa: true }), 409);
  status(await api(`/cuentas-bancarias/${destination.id}`, 'PUT', { nombre: destination.nombre, banco: destination.banco, moneda: 'ARS', activa: false }), 200);
  status(await api('/cajachica/transferencias', 'POST', body), 400);
  status(await api('/cajachica', 'POST', { tipo: 'INGRESO', concepto: 'Ingreso rechazado', monto: 50, moneda: 'ARS', fecha: '2026-09-10', metodoPago: 'TRANSFERENCIA', cuentaBancariaId: destination.id }), 400);
  assert.equal(await prisma.movimientoCaja.count({ where: { cuentaBancariaId: destination.id } }), 1);
  const closures = status(await api('/cajachica/cierres'), 200);
  assert.equal(closures.find(c => c.id === closure.id).eventos.length, 2);
});

for (const mode of ['dos operadores', 'doble envío de una sesión']) {
for (const action of ['confirmación', 'cobro', 'pago al propietario']) {
  test(`${mode} simultáneos: ${action} no duplica dinero ni documentos`, async () => {
    const f = await fixture(), l = await liquidation(f, [], action !== 'confirmación');
    if (action === 'pago al propietario') status(await api('/pagos', 'POST', payment(f, l)), 201);
    const path = action === 'confirmación' ? `/liquidaciones/${l.id}/confirmar` : action === 'cobro' ? '/pagos' : `/liquidaciones/${l.id}/pagar-propietario`;
    const body = action === 'confirmación' ? {} : action === 'cobro' ? payment(f, l) : { monto: 100000, moneda: 'ARS', fechaPago: '2026-09-10', metodoPago: 'TRANSFERENCIA', cuentaBancariaId: f.bank.id, propietarioId: f.owner.id };
    const sessions = mode === 'dos operadores' ? operators : [operators[0], operators[0]];
    const responses = await Promise.all(sessions.map(session => api(path, action === 'cobro' ? 'POST' : 'PATCH', body, session)));
    const evidence = { responses, payments: await prisma.pago.count({ where: { liquidacionId: l.id } }), payouts: await prisma.pagoPropietario.count({ where: { liquidacionId: l.id } }), vouchers: await prisma.comprobanteLiquidacion.count({ where: { liquidacionId: l.id } }), cash: await prisma.movimientoCaja.count({ where: { contratoId: f.contract.id } }) };
    console.log(JSON.stringify({ scenario: `${mode}: ${action}`, ...evidence, responses: responses.map(r => ({ status: r.status, code: r.data?.code, message: r.data?.message })) }));
    assert.equal(evidence.payments, action === 'confirmación' ? 0 : 1);
    assert.equal(evidence.payouts, action === 'pago al propietario' ? 1 : 0);
    assert.equal(evidence.vouchers, action === 'confirmación' ? 1 : action === 'cobro' ? 2 : 3);
    assert.equal(evidence.cash, action === 'confirmación' ? 0 : action === 'cobro' ? 1 : 2);
    const auditAction = action === 'confirmación' ? 'CONFIRMAR_LIQUIDACION' : action === 'cobro' ? 'REGISTRAR_PAGO_LIQUIDACION' : 'PAGO_PROPIETARIO';
    assert.equal(await prisma.auditLog.count({ where: { entidad: 'Liquidacion', entidadId: l.id, accion: auditAction, resultado: 'EXITO' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entidad: 'Liquidacion', entidadId: l.id, accion: auditAction, resultado: 'FALLIDO' } }), 1);
    assert.equal(responses.filter(r => r.status >= 200 && r.status < 300).length, 1);
    assert.ok(responses.every(r => [200, 201, 409].includes(r.status)), 'El conflicto debe resolverse con 409, sin errores internos');
  });
}
}

test('reintento idéntico de un cobro parcial no debe cobrar dos veces', async () => {
  const f = await fixture(), l = await liquidation(f), body = { ...payment(f, l, 10000.50), comprobante: `Reintento ${suffix()}` };
  const key = randomUUID();
  const first = await api('/pagos', 'POST', body, operators[0], key);
  status(first, 201);
  const retry = await api('/pagos', 'POST', body, operators[0], key);
  assert.deepEqual(retry, first);
  const payments = await prisma.pago.findMany({ where: { liquidacionId: l.id } });
  console.log(JSON.stringify({ scenario: 'reintento parcial', statuses: [first.status, retry.status], ids: payments.map(p => p.id), total: payments.reduce((s, p) => s + Number(p.monto), 0) }));
  assert.equal(payments.length, 1, 'Un reintento de la misma operación produjo dos cobros persistidos');
});

test('reintento idéntico de un pago parcial al propietario no debe pagar dos veces', async () => {
  const f = await fixture(), l = await liquidation(f);
  status(await api('/pagos', 'POST', payment(f, l)), 201);
  const body = { monto: 10000.50, moneda: 'ARS', fechaPago: '2026-09-10', metodoPago: 'TRANSFERENCIA', cuentaBancariaId: f.bank.id, propietarioId: f.owner.id };
  const key = randomUUID();
  const first = await api(`/liquidaciones/${l.id}/pagar-propietario`, 'PATCH', body, operators[0], key);
  status(first, 200);
  const retry = await api(`/liquidaciones/${l.id}/pagar-propietario`, 'PATCH', body, operators[0], key);
  assert.deepEqual(retry, first);
  const payouts = await prisma.pagoPropietario.findMany({ where: { liquidacionId: l.id } });
  console.log(JSON.stringify({ scenario: 'reintento pago propietario parcial', statuses: [first.status, retry.status], ids: payouts.map(p => p.id), total: payouts.reduce((s, p) => s + Number(p.monto), 0) }));
  assert.equal(payouts.length, 1, 'Un reintento de la misma operación produjo dos pagos persistidos');
});

for (const operation of ['cancelar', 'condonar', 'reprogramar']) {
  test(`plan con primera cuota cobrada: ${operation} preserva imputaciones y sólo modifica pendientes`, async () => {
    const f = await fixture();
    const plan = status(await api('/planes-cuotas', 'POST', { contratoId: f.contract.id, concepto: 'Plan parcialmente cobrado', montoTotal: 3000.03, cantidadCuotas: 3, fechaPrimeraCuota: '2026-09-01', tipoMovimiento: 'INGRESO', esParaInmobiliaria: false }), 201);
    const quota = await prisma.cuotaPlan.findFirstOrThrow({ where: { planId: plan.id, numeroCuota: 1 } });
    const l = await liquidation(f, [quota.id]);
    status(await api('/pagos', 'POST', { ...payment(f, l, 1001), cuotasImputadas: [{ cuotaId: quota.id, monto: 1000.01 }] }), 201);
    const before = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } });
    assert.equal(before.estado, 'PAGADA');
    const body = { motivo: 'Acuerdo sobre cuotas aún pendientes', ...(operation === 'reprogramar' ? { montoTotal: 2000.02, cantidadCuotas: 2, fechaPrimeraCuota: '2026-10-01' } : {}) };
    const result = status(await api(`/planes-cuotas/${plan.id}/${operation}`, 'POST', body), operation === 'reprogramar' ? 201 : 200);
    assert.deepEqual(await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } }), before);
    assert.equal(await prisma.pago.count({ where: { liquidacionId: l.id, anuladoEn: null } }), 1);
    assert.equal(await prisma.movimientoCaja.count({ where: { contratoId: f.contract.id } }), 1);
    const pending = await prisma.cuotaPlan.findMany({ where: { planId: plan.id, numeroCuota: { gt: 1 } } });
    assert.ok(pending.every(q => q.estado === { cancelar: 'CANCELADA', condonar: 'CONDONADA', reprogramar: 'REPROGRAMADA' }[operation]));
    if (operation === 'reprogramar') {
      const successor = await prisma.planCuotas.findUniqueOrThrow({ where: { id: result.successor.id }, include: { cuotas: true } });
      assert.equal(successor.planOrigenId, plan.id);
      assert.equal(successor.cuotas.reduce((s, q) => s + Math.round(Number(q.monto) * 100), 0), 200002);
    }
  });
}

for (const action of ['cobro', 'pago al propietario']) {
  test(`${action}: clave persistente, payload distinto, actor distinto y nueva operación legítima`, async () => {
    const f = await fixture(), l = await liquidation(f);
    if (action !== 'cobro') status(await api('/pagos', 'POST', payment(f, l)), 201);
    const path = action === 'cobro' ? '/pagos' : `/liquidaciones/${l.id}/pagar-propietario`;
    const method = action === 'cobro' ? 'POST' : 'PATCH';
    const success = action === 'cobro' ? 201 : 200;
    const body = action === 'cobro' ? payment(f, l, 10000.50) : { monto: 10000.50, moneda: 'ARS', fechaPago: '2026-09-10', metodoPago: 'TRANSFERENCIA', cuentaBancariaId: f.bank.id, propietarioId: f.owner.id };
    const key = randomUUID();
    const [a, b] = await Promise.all([api(path, method, body, operators[0], key), api(path, method, body, operators[0], key)]);
    assert.ok([a, b].some(r => r.status === success));
    assert.ok([a, b].every(r => [success, 409].includes(r.status)));
    const result = status(await api(path, method, body, operators[0], key), success);
    const receipt = await prisma.operacionFinanciera.findUniqueOrThrow({ where: { inmobiliariaId_clave: { inmobiliariaId: agency.id, clave: key } } });
    assert.deepEqual(receipt.respuesta, result);
    const changed = await api(path, method, { ...body, monto: 10001.50 }, operators[0], key);
    assert.equal(changed.status, 409); assert.equal(changed.data.code, 'IDEMPOTENCY_KEY_REUSED');
    const actor = await api(path, method, body, operators[1], key);
    assert.equal(actor.status, 409); assert.equal(actor.data.code, 'IDEMPOTENCY_KEY_REUSED');
    const model = action === 'cobro' ? prisma.pago : prisma.pagoPropietario;
    assert.equal(await model.count({ where: { liquidacionId: l.id } }), 1);
    assert.equal(await prisma.comprobanteLiquidacion.count({ where: { liquidacionId: l.id } }), action === 'cobro' ? 2 : 3);
    assert.equal(await prisma.movimientoCaja.count({ where: { contratoId: f.contract.id } }), action === 'cobro' ? 1 : 2);
    const auditAction = action === 'cobro' ? 'REGISTRAR_PAGO_LIQUIDACION' : 'PAGO_PROPIETARIO';
    assert.equal(await prisma.auditLog.count({ where: { entidadId: l.id, entidad: 'Liquidacion', accion: auditAction, resultado: 'EXITO' } }), 1);
    // An identical amount/date with a NEW key is a legitimate second operation.
    status(await api(path, method, body, operators[0], randomUUID()), success);
    const payments = await model.findMany({ where: { liquidacionId: l.id } });
    assert.equal(payments.length, 2); assert.equal(payments.reduce((sum, p) => sum + Math.round(Number(p.monto) * 100), 0), 2000100);
    // A prior success remains replayable even after its payment has been reversed.
    const paymentId = action === 'cobro' ? result.pagos[0].id : result.pagoPropietarioId;
    const reversal = action === 'cobro' ? `/pagos/${paymentId}/anular` : `/liquidaciones/${l.id}/pagos-propietario/${paymentId}/anular`;
    status(await api(reversal, 'POST', { motivo: 'Anular sin permitir que un reintento cobre nuevamente' }), 200);
    assert.deepEqual(status(await api(path, method, body, operators[0], key), success), result);
    assert.equal(await model.count({ where: { liquidacionId: l.id } }), 2);
  });
}

test('sin clave no se registra dinero; un fallo no consume la clave ni deja efectos parciales', async () => {
  const f = await fixture(), l = await liquidation(f), body = payment(f, l, 10000.50);
  const { rawFetch } = require('./financial-request-fixture');
  const missing = await rawFetch(`${base}/pagos`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(missing.status, 400); assert.equal((await missing.json()).code, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = randomUUID();
  status(await api('/pagos', 'POST', { ...body, monto: 200000 }, admin, key), 409);
  assert.equal(await prisma.operacionFinanciera.count({ where: { clave: key } }), 0);
  assert.equal(await prisma.pago.count({ where: { liquidacionId: l.id } }), 0);
  assert.equal(await prisma.movimientoCaja.count({ where: { contratoId: f.contract.id } }), 0);
  status(await api('/pagos', 'POST', body, admin, key), 201);
});
