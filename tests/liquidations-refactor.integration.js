const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';

test('una cuota se salda con un cobro parcial de la liquidación y se reabre al anularlo', async () => {
  const login = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin.integration@example.com', password: 'ProdTest!2026_Strong' })
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const sessionCookie = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie')).match(/pc_session=([^;,\s]+)/)?.[1];
  assert.ok(sessionCookie);
  const cookie = `pc_session=${sessionCookie}; pc_csrf=${auth.csrfToken}`;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { cookie, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };

  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const suffix = `${Date.now()}-${Math.random()}`;
  const property = await prisma.propiedad.create({ data: { direccion: `Cuotas ${suffix}`, inmobiliariaId: agency.id, estado: 'ALQUILADO' } });
  const owner = await prisma.persona.create({ data: { nombreCompleto: `Propietario ${suffix}`, inmobiliariaId: agency.id } });
  const tenant = await prisma.persona.create({ data: { nombreCompleto: `Inquilino ${suffix}`, inmobiliariaId: agency.id } });
  const agreedAccount = await prisma.cuentaBancaria.create({ data: { nombre: `Cobros ${suffix}`, banco: 'Banco de prueba', moneda: 'ARS', inmobiliariaId: agency.id } });
  const contract = await prisma.contrato.create({
    data: {
      fechaInicio: new Date('2026-01-01T00:00:00.000Z'), fechaFin: new Date('2027-12-31T00:00:00.000Z'),
      estado: 'ACTIVO', montoAlquiler: 450000, montoHonorarios: 0, pagaHonorarios: 'INQUILINO',
      moneda: 'ARS', propiedadId: property.id, inmobiliariaId: agency.id, requiereActualizacion: false,
      modalidadCobroInquilino: 'TRANSFERENCIA', modalidadPagoPropietario: 'CHEQUE',
      cuentaCobroAcordadaId: agreedAccount.id,
      propietarios: { create: { personaId: owner.id, esPrincipal: true } },
      inquilinos: { create: { personaId: tenant.id, esPrincipal: true } }
    }
  });
  const plan = await api('/planes-cuotas', 'POST', {
    contratoId: contract.id, concepto: 'Recupero de reparación', montoTotal: 200000,
    cantidadCuotas: 2, fechaPrimeraCuota: '2026-09-01', tipoMovimiento: 'INGRESO', esParaInmobiliaria: true
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  const quota = await prisma.cuotaPlan.findFirstOrThrow({ where: { planId: plan.data.id, numeroCuota: 1 } });
  const created = await api('/liquidaciones', 'POST', { contratoId: contract.id, periodo: '2026-09-01', cuotasIds: [quota.id] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(Number(created.data.netoACobrar), 550000);
  const liquidationId = created.data.id;
  const confirmed = await api(`/liquidaciones/${liquidationId}/confirmar`, 'PATCH', {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(await prisma.movimientoCaja.count({ where: { liquidacionId: liquidationId } }), 0);

  const collected = await api('/pagos', 'POST', {
    contratoId: contract.id, liquidacionId: liquidationId, monto: 100000, fechaPago: '2026-09-30',
    metodoPago: 'EFECTIVO', comprobante: 'Recibo de reparación', cuotasImputadas: [{ cuotaId: quota.id, monto: 100000 }]
  });
  assert.equal(collected.status, 201, JSON.stringify(collected.data));
  assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } })).estado, 'PAGADA');
  const detail = await api(`/liquidaciones/${liquidationId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.resumenOperativo.saldoInquilino, 450000);
  assert.equal(detail.data.pagos[0].comprobante, 'Recibo de reparación');
  assert.equal(detail.data.pagos[0].imputacionesCuotas[0].cuotaId, quota.id);
  assert.equal(detail.data.comprobantes.length, 2);
  assert.equal(detail.data.comprobantes[0].evento, 'COBRO_INQUILINO');

  const reversed = await api(`/pagos/${collected.data.pagos[0].id}/anular`, 'POST', { motivo: 'Cobro registrado por error' });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
  assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } })).estado, 'PENDIENTE');
  const latest = await api(`/liquidaciones/${liquidationId}`);
  assert.equal(latest.data.resumenOperativo.saldoInquilino, 550000);
  assert.equal(latest.data.comprobantes.length, 3);
  assert.equal(latest.data.comprobantes[0].evento, 'ANULACION_COBRO');
  const firstVoucher = await prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: liquidationId, version: 1 } });
  assert.equal(firstVoucher.fotografia.pagos.length, 0);
  assert.equal(firstVoucher.fotografia.contrato.cuentaCobroAcordada.nombre, agreedAccount.nombre);

  const timeline = await api(`/liquidaciones/contrato/${contract.id}/periodos?periodo=2026-10-01`);
  assert.equal(timeline.status, 200);
  assert.equal(timeline.data.defaultPeriod, '2026-09-01');
  assert.equal(timeline.data.contrato.cuentaCobroAcordada.nombre, agreedAccount.nombre);
  assert.equal(timeline.data.periodos.find(period => period.periodo === '2026-09-01').estado, 'EN_MORA');
  const overdueHistory = await api(`/liquidaciones?contratoId=${contract.id}&estado=EN_MORA`);
  assert.equal(overdueHistory.status, 200);
  assert.equal(overdueHistory.data.meta.total, 1);
  const finishedHistory = await api(`/liquidaciones?contratoId=${contract.id}&estado=FINALIZADA`);
  assert.equal(finishedHistory.status, 200);
  assert.equal(finishedHistory.data.meta.total, 0);

  const switchedToCash = await api(`/contratos/${contract.id}`, 'PUT', { version: contract.version, modalidadCobroInquilino: 'EFECTIVO', cuentaCobroAcordadaId: null });
  assert.equal(switchedToCash.status, 200, JSON.stringify(switchedToCash.data));
  const refreshedContract = await api(`/contratos/${contract.id}`);
  assert.equal(refreshedContract.data.cuentaCobroAcordadaId, null);
  const missingAccount = await api(`/contratos/${contract.id}`, 'PUT', { version: refreshedContract.data.version, modalidadCobroInquilino: 'TRANSFERENCIA' });
  assert.equal(missingAccount.status, 400);
  const restoredTransfer = await api(`/contratos/${contract.id}`, 'PUT', { version: refreshedContract.data.version, modalidadCobroInquilino: 'TRANSFERENCIA', cuentaCobroAcordadaId: agreedAccount.id });
  assert.equal(restoredTransfer.status, 200, JSON.stringify(restoredTransfer.data));
  assert.equal((await prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: liquidationId, version: 1 } })).fotografia.contrato.cuentaCobroAcordada.nombre, agreedAccount.nombre);
});
