require('./financial-request-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Decimal } = require('@prisma/client/runtime/library');
assert.match(process.env.DATABASE_URL || '', /127\.0\.0\.1:55433\/propcontrol_integration(?:\?|$)/);
const { prisma } = require('../dist/prisma');
const base = 'http://127.0.0.1:3100/api';
let session, agency;
async function request(path, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function api(path, method = 'GET', body, expected = 200) {
  const r = await request(path, method, body); const text = await r.text(); const data = text ? JSON.parse(text) : null;
  assert.equal(r.status, expected, JSON.stringify(data)); return data;
}
async function fixture(moneda = 'ARS', agencyId = agency.id) {
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `QA cuotas ${moneda} ${suffix.slice(0, 13)}`, inmobiliariaId: agencyId } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: 'Dueño prueba cuotas', inmobiliariaId: agencyId } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: 'Inquilino prueba cuotas', inmobiliariaId: agencyId } });
  return prisma.contrato.create({ data: { propiedadId: property.id, inmobiliariaId: agencyId, moneda, montoAlquiler: '100000', montoHonorarios: '12500', porcentajeHonorarios: '12.5', pagaHonorarios: 'PROPIETARIO', estado: 'ACTIVO', requiereActualizacion: false, fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2028-12-31'), propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } } } });
}
async function createPlan(contract, total = '100.00', count = 3) {
  const schedule = { contratoId: contract.id, montoTotal: total, cantidadCuotas: count, fechaPrimeraCuota: '2026-12-01' };
  const preview = await api('/planes-cuotas/vista-previa', 'POST', schedule);
  const plan = await api('/planes-cuotas', 'POST', { ...schedule, concepto: 'QA precisión de cuotas', tipoMovimiento: 'INGRESO', esParaInmobiliaria: false }, 201);
  const stored = await prisma.planCuotas.findUniqueOrThrow({ where: { id: plan.id }, include: { cuotas: { orderBy: { numeroCuota: 'asc' } } } });
  assert.deepEqual(stored.cuotas.map(c => ({ numeroCuota: c.numeroCuota, monto: c.monto.toFixed(2), fechaVencimiento: c.fechaVencimiento.toISOString().slice(0, 10) })), preview.cuotas);
  assert.equal(stored.cuotas.reduce((sum, c) => sum.plus(c.monto), new Decimal(0)).toFixed(2), new Decimal(total).toFixed(2));
  assert.equal(preview.moneda, contract.moneda);
  return stored;
}
async function document(id, recipient, version) {
  const r = await request(`/liquidaciones/${id}/${recipient === 'INQUILINO' ? 'pdf' : 'pdf-propietario'}${version ? `?version=${version}` : ''}`);
  assert.equal(r.status, 200, await r.clone().text());
  const buffer = Buffer.from(await r.arrayBuffer());
  const parsed = spawnSync('pdftotext', ['-layout', '-', '-'], { input: buffer, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return { text: parsed.stdout, buffer };
}
const sumMoney = rows => rows.reduce((sum, row) => sum.plus(row.monto), new Decimal(0)).toFixed(2);
async function pay(contract, liq, cuota, amount) {
  const result = await api('/pagos', 'POST', { contratoId: contract.id, liquidacionId: liq.id, moneda: contract.moneda, monto: amount, fechaPago: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date()), metodoPago: 'EFECTIVO', cuotasImputadas: [{ cuotaId: cuota.id, monto: amount }] }, 201);
  return result.pagos[0];
}
async function liquidation(contract, cuota) {
  return api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-12-01', cuotasIds: [cuota.id] }, 201);
}

test.before(async () => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' }) });
  assert.equal(r.status, 200); const body = await r.json();
  session = { cookie: `pc_session=${r.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1]}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
  agency = await prisma.inmobiliaria.findFirstOrThrow();
});
test.after(() => prisma.$disconnect());

test('preview enforces edit permission, contract existence and plan/contract association without writes', async () => {
  const local = await fixture();
  const plan = await createPlan(local);
  const ownOtherContract = await fixture();
  const schedule = { montoTotal: '100', cantidadCuotas: 3, fechaPrimeraCuota: '2026-12-01' };
  const count = await prisma.planCuotas.count();
  await api('/planes-cuotas/vista-previa', 'POST', { ...schedule, contratoId: 2147483647 }, 404);
  await api('/planes-cuotas/vista-previa', 'POST', { ...schedule, contratoId: ownOtherContract.id, planId: plan.id }, 404);
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'liquidaciones.ver' } });
  const role = await prisma.rol.create({ data: { nombre: `Lectura cuotas ${Date.now()}`, inmobiliariaId: agency.id, permisos: { create: { permisoId: permission.id } } } });
  const admin = await prisma.usuario.findUniqueOrThrow({ where: { email: 'admin.integration@example.com' } });
  const user = await prisma.usuario.create({ data: { email: `cuotas-readonly-${Date.now()}@example.com`, nombreCompleto: 'QA consulta', password: admin.password, tipo: 'USUARIO', rolId: role.id, inmobiliariaId: agency.id } });
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'ProdTest!2026_Strong' }) });
  assert.equal(login.status, 200);
  const body = await login.json();
  const cookie = `pc_session=${login.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1]}; pc_csrf=${body.csrfToken}`;
  const denied = await fetch(`${base}/planes-cuotas/vista-previa`, { method: 'POST', headers: { cookie, 'x-csrf-token': body.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ ...schedule, contratoId: local.id }) });
  assert.equal(denied.status, 403);
  await api('/planes-cuotas/vista-previa', 'POST', { ...schedule, contratoId: local.id });
  assert.equal(await prisma.planCuotas.count(), count);
});

for (const moneda of ['ARS', 'USD']) {
  test(`${moneda}: preview and persisted/reloaded installments match exactly, including minimum cents`, async () => {
    const contract = await fixture(moneda);
    for (const [total, count, expected] of [
      ['100.00', 3, ['33.33', '33.33', '33.34']], ['10.00', 6, ['1.66', '1.66', '1.66', '1.66', '1.66', '1.70']],
      ['0.03', 3, ['0.01', '0.01', '0.01']], ['120.00', 3, ['40.00', '40.00', '40.00']]
    ]) {
      const stored = await createPlan(contract, total, count);
      assert.deepEqual(stored.cuotas.map(c => c.monto.toFixed(2)), expected);
      const reloaded = (await api(`/planes-cuotas/contrato/${contract.id}`)).find(p => p.id === stored.id);
      assert.equal(reloaded.resumen.sumaCuotas, total); assert.equal(reloaded.resumen.montoPendienteDisponible, total);
      assert.equal(reloaded.resumen.montoCuotasPagadas, '0.00');
      if (total === '100.00') {
        // The last installment must retain the remainder in the stored movement and both documents.
        const last = stored.cuotas[2];
        const liq = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2027-02-01', cuotasIds: [last.id] }, 201);
        await api(`/liquidaciones/${liq.id}/confirmar`, 'PATCH', { expectedVersion: liq.version });
        const linked = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: last.id }, include: { movimiento: true } });
        assert.equal(linked.movimiento.monto.toFixed(2), '33.34');
        assert.equal(linked.movimiento.moneda, moneda);
        for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
          const doc = await document(liq.id, recipient);
          assert.match(doc.text, /33,34/);
          assert.match(doc.text, recipient === 'INQUILINO' ? /100\.033,34/ : /87\.533,34/);
          require('node:fs').writeFileSync(`/tmp/installments-last-${moneda}-${recipient}.pdf`, doc.buffer);
        }
      }
    }
    const countBefore = await prisma.planCuotas.count({ where: { contratoId: contract.id } });
    for (const total of ['0.02', '1.001', 1.001]) {
      const body = { contratoId: contract.id, montoTotal: total, cantidadCuotas: 3, fechaPrimeraCuota: '2026-12-01', concepto: 'Debe rechazarse', tipoMovimiento: 'INGRESO' };
      await api('/planes-cuotas', 'POST', body, 400);
      await api('/planes-cuotas/vista-previa', 'POST', body, 400);
    }
    assert.equal(await prisma.planCuotas.count({ where: { contratoId: contract.id } }), countBefore);
  });

  test(`${moneda}: plan → draft → release/recreate → partial payments/reversal → document → reschedule`, async () => {
    const contract = await fixture(moneda); const plan = await createPlan(contract); const cuota = plan.cuotas[0];
    let liq = await liquidation(contract, cuota);
    const linked = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id }, include: { movimiento: true } });
    assert.equal(linked.movimiento.monto.toFixed(2), '33.33'); assert.equal(linked.movimiento.moneda, moneda);
    const before = await api(`/planes-cuotas/contrato/${contract.id}`);
    assert.equal(before[0].resumen.montoPendienteDisponible, '66.67');
    assert.equal(before[0].resumen.montoPendienteVinculado, '33.33');
    const blocked = await api(`/planes-cuotas/${plan.id}/reprogramar`, 'POST', { motivo: 'No debe modificar cuotas vinculadas', montoTotal: '66.67', cantidadCuotas: 2, fechaPrimeraCuota: '2027-01-01' }, 409);
    assert.equal(blocked.code, 'INSTALLMENT_ALREADY_CLAIMED');
    // Saving another draft with the same installment is rejected without duplicates.
    const duplicate = await request('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2027-01-01', cuotasIds: [cuota.id] });
    assert.equal(duplicate.status, 409, await duplicate.text());
    assert.equal(await prisma.movimiento.count({ where: { cuota: { id: cuota.id } } }), 1);
    await api(`/liquidaciones/${liq.id}`, 'DELETE');
    const detached = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } });
    assert.equal(detached.liquidacionId, null); assert.equal(detached.movimientoId, null); assert.equal(detached.monto.toFixed(2), '33.33');
    liq = await liquidation(contract, cuota);
    const movementToRemove = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } });
    await api(`/liquidaciones/movimientos/${movementToRemove.movimientoId}`, 'DELETE');
    assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } })).movimientoId, null);
    await api(`/liquidaciones/${liq.id}`, 'DELETE');
    liq = await liquidation(contract, cuota);
    const reattached = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id }, include: { movimiento: true } });
    assert.equal(reattached.monto.toFixed(2), '33.33'); assert.equal(reattached.movimiento.monto.toFixed(2), '33.33');
    await api(`/liquidaciones/${liq.id}/confirmar`, 'PATCH', { expectedVersion: liq.version });
    let detail = await api(`/liquidaciones/${liq.id}`);
    assert.equal(Number(detail.netoACobrar), 100033.33); assert.equal(Number(detail.montoPropietario), 87533.33);
    const version = detail.comprobantes[0].version;
    for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
      const doc = await document(liq.id, recipient, version);
      assert.match(doc.text, /QA precisión de cuotas/); assert.match(doc.text, /33,33/);
      assert.match(doc.text, recipient === 'INQUILINO' ? /100\.033,33/ : /87\.533,33/);
      if (moneda === 'USD') assert.match(doc.text, /US\$/);
      require('node:fs').writeFileSync(`/tmp/installments-${moneda}-${recipient}.pdf`, doc.buffer);
    }
    const first = await pay(contract, liq, cuota, '10.10');
    assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } })).estado, 'PENDIENTE');
    const second = await pay(contract, liq, cuota, '23.23');
    assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } })).estado, 'PAGADA');
    await api(`/pagos/${second.id}/anular`, 'POST', { motivo: 'Anulación de prueba conservando cuota y centavos' });
    assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id } })).estado, 'PENDIENTE');
    const replacement = await pay(contract, liq, cuota, '23.23');
    const paidSnapshot = await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id }, include: { imputacionesPago: true } });
    assert.equal(paidSnapshot.estado, 'PAGADA');
    const activePayments = await prisma.pago.findMany({ where: { liquidacionId: liq.id, anuladoEn: null } });
    assert.equal(sumMoney(activePayments), '33.33');
    assert.deepEqual(activePayments.map(p => p.id).sort(), [first.id, replacement.id].sort());
    detail = await api(`/liquidaciones/${liq.id}`);
    const latest = Math.max(...detail.comprobantes.map(c => c.version));
    const finalDoc = await document(liq.id, 'INQUILINO', latest);
    assert.match(finalDoc.text, /33,33/); assert.match(finalDoc.text, /100\.000,00/);
    // Rescheduling takes only the unlinked pending 66.67, preserving every paid row.
    const previewInput = { contratoId: contract.id, planId: plan.id, montoTotal: '66.67', cantidadCuotas: 2, fechaPrimeraCuota: '2027-01-01' };
    const preview = await api('/planes-cuotas/vista-previa', 'POST', previewInput);
    assert.equal(preview.resumen.montoCuotasPagadas, '33.33'); assert.equal(preview.resumen.montoPendienteDisponible, '66.67');
    await api(`/planes-cuotas/${plan.id}/reprogramar`, 'POST', { ...previewInput, montoPendienteEsperado: '100.00', motivo: 'Saldo desactualizado de otra pestaña' }, 409);
    await api(`/planes-cuotas/${plan.id}/reprogramar`, 'POST', { ...previewInput, montoTotal: '66.671', motivo: 'Precisión inválida debe rechazarse' }, 400);
    const result = await api(`/planes-cuotas/${plan.id}/reprogramar`, 'POST', { ...previewInput, montoPendienteEsperado: '66.67', motivo: 'Conservar el saldo pendiente sin modificar cobros' }, 201);
    const successor = await prisma.planCuotas.findUniqueOrThrow({ where: { id: result.successor.id }, include: { cuotas: { orderBy: { numeroCuota: 'asc' } } } });
    assert.equal(sumMoney(successor.cuotas), '66.67'); assert.equal(successor.planOrigenId, plan.id);
    assert.deepEqual(successor.cuotas.map(c => c.monto.toFixed(2)), ['33.33', '33.34']);
    assert.deepEqual(await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: cuota.id }, include: { imputacionesPago: true } }), paidSnapshot);
    assert.deepEqual(await prisma.pago.findMany({ where: { liquidacionId: liq.id, anuladoEn: null } }), activePayments);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entidad: 'PlanCuotas', entidadId: plan.id, accion: 'REPROGRAMAR_PLAN_CUOTAS' } });
    assert.equal(JSON.parse(audit.detalle).pendienteAnterior, '66.67');
    assert.equal(JSON.parse(audit.detalle).variacionTotal, '0.00');
  });
}
