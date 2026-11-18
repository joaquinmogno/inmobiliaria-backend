process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'credit-card-integration-session-secret';
require('./financial-request-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;
const { PERMISSION_CAPABILITIES } = require('../dist/config/permissions.catalog');
const { getCashLedgerReport, getMonthlyReportPeriod } = require('../dist/services/financial-reporting.service');

// This suite writes fixtures and must be explicitly pointed at a test database.
assert.match(new URL(process.env.DATABASE_URL || 'postgresql://localhost/none').pathname, /^\/propcontrol_(integration|cards)$/, 'Use an isolated test DATABASE_URL');

test('own credit cards: scopes, permissions, reports, outgoing payments and reversals', async t => {
  const stamp = `cards-${Date.now()}`;
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const password = 'CardsTest!2026_Strong';
  const hash = await bcrypt.hash(password, 10);
  for (const capability of PERMISSION_CAPABILITIES) {
    await prisma.permiso.upsert({ where: { clave: capability.key }, update: {}, create: { clave: capability.key, descripcion: capability.label, modulo: capability.group, accion: capability.key.split('.').at(-1) } });
  }
  const users = [], roles = [];
  const makeUser = async (name, keys, tipo = 'USUARIO') => {
    const permissions = await prisma.permiso.findMany({ where: { clave: { in: keys } } });
    const role = await prisma.rol.create({ data: { nombre: `${stamp}-${name}`, inmobiliariaId: agency.id, permisos: { create: permissions.map(p => ({ permisoId: p.id })) } } });
    roles.push(role.id);
    const user = await prisma.usuario.create({ data: { email: `${stamp}-${name}@example.com`, nombreCompleto: name, password: hash, tipo, rolId: tipo === 'ADMIN' ? null : role.id, inmobiliariaId: agency.id } });
    users.push(user.id); return user;
  };
  const adminUser = await makeUser('admin', [], 'ADMIN');
  const viewerUser = await makeUser('viewer', ['daniel.ver']);
  const editorUser = await makeUser('editor', ['daniel.ver', 'daniel.crear']);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = async user => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    const token = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)?.[1];
    return { cookie: `pc_session=${token}; pc_csrf=${body.csrfToken}`, 'x-csrf-token': body.csrfToken };
  };
  const api = (session, path, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: { ...session, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async response => { assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const pdfText = async response => { assert.equal(response.status, 200, await response.clone().text()); const output = spawnSync('pdftotext', ['-', '-'], { input: Buffer.from(await response.arrayBuffer()) }); assert.equal(output.status, 0); return output.stdout.toString(); };
  const cards = {};
  let contract, property, owner, liquidation;
  try {
    const admin = await login(adminUser), viewer = await login(viewerUser), editor = await login(editorUser);
    const cardData = { nombre: `${stamp} Visa`, banco: 'Banco Galicia', ultimosCuatro: '0012' };
    await t.test('catalogs are separate, read-only access cannot mutate and full card details are rejected', async () => {
      for (const scope of ['CAJA', 'INTERNO', 'TEODORO', 'DANIEL']) cards[scope] = await json(await api(admin, `/tarjetas/${scope}`, 'POST', cardData));
      assert.equal((await api(viewer, '/tarjetas/DANIEL')).status, 200);
      assert.equal((await api(viewer, '/tarjetas/DANIEL', 'POST', cardData)).status, 403);
      assert.equal((await api(viewer, `/tarjetas/DANIEL/${cards.DANIEL.id}`, 'PATCH', { activa: false, version: 1 })).status, 403);
      for (const scope of ['CAJA', 'INTERNO', 'TEODORO']) assert.equal((await api(editor, `/tarjetas/${scope}`)).status, 403);
      assert.equal((await api(admin, '/tarjetas/DANIEL', 'POST', { ...cardData, ultimosCuatro: '1234123412341234' })).status, 400);
      assert.equal((await api(admin, '/tarjetas/DANIEL', 'POST', { ...cardData, cvv: '123' })).status, 400);
      assert.equal((await api(admin, '/tarjetas/DANIEL', 'POST', cardData)).status, 409);
      assert.equal((await api(admin, `/tarjetas/DANIEL/${cards.TEODORO.id}`, 'PATCH', { activa: false, version: 1 })).status, 409);
      const other = await json(await api(admin, '/tarjetas/DANIEL', 'POST', { ...cardData, nombre: `${stamp} Mastercard` }));
      assert.notEqual(other.id, cards.DANIEL.id, 'same last four are not an identity'); cards.OTHER = other;
    });
    await t.test('card resolution also checks the agency against the database', async () => {
      const { resolvePaymentCard } = require('../dist/services/credit-card.service');
      await assert.rejects(prisma.$transaction(tx => resolvePaymentCard(tx, {
        inmobiliariaId: agency.id + 100000, ambito: 'DANIEL', metodoPago: 'Tarjeta', tarjetaId: cards.DANIEL.id
      })), { code: 'INVALID_CREDIT_CARD' });
    });
    const personalInput = { fecha: '2026-11-04', tipo: 'GASTO', detalle: `${stamp} Reparación`, monto: '150000.25', moneda: 'ARS', metodoPago: 'Tarjeta de crédito' };
    let personal;
    await t.test('create/edit validate the scope; filters and full-month PDF/Excel contain only the selected card', async () => {
      assert.equal((await api(editor, '/daniel', 'POST', personalInput)).status, 400);
      assert.equal((await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.TEODORO.id })).status, 400);
      assert.equal((await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.DANIEL.id, tipo: 'INGRESO' })).status, 400);
      personal = await json(await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.DANIEL.id }));
      assert.match(personal.tarjetaDescripcion, /0012/);
      await json(await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.DANIEL.id, moneda: 'USD', monto: '25.50' }));
      await json(await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.OTHER.id, detalle: 'EXCLUIR OTRA TARJETA', monto: '999999' }));
      await json(await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.DANIEL.id, fecha: '2026-10-01', detalle: 'EXCLUIR OTRO MES' }));
      const query = `periodo=2026-11&tarjetaId=${cards.DANIEL.id}`;
      const list = await json(await api(viewer, `/daniel?${query}&limit=1`));
      assert.equal(list.data.length, 1); assert.equal(list.meta.total, 2);
      assert.equal(list.resumen.find(r => r.moneda === 'ARS').gastos, 150000.25);
      assert.equal(list.resumen.find(r => r.moneda === 'USD').gastos, 25.5);
      const text = await pdfText(await api(admin, `/daniel/reportes/pdf?${query}`));
      assert.match(text, /0012/); assert.match(text, /150\.000,25/); assert.doesNotMatch(text, /EXCLUIR/);
      const excel = await api(admin, `/daniel/reportes/excel?${query}`);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await excel.arrayBuffer()));
      const cells = []; workbook.worksheets.forEach(sheet => sheet.eachRow(row => cells.push(JSON.stringify(row.values))));
      assert.match(cells.join(' '), /0012/); assert.doesNotMatch(cells.join(' '), /EXCLUIR/);
      const context = await json(await api(admin, `/daniel/${personal.id}/recibos`));
      assert.match(context.movimiento.tarjetaDescripcion, /0012/);
    });
    await t.test('deactivation blocks new payments but preserves historic edits, reports and references', async () => {
      cards.DANIEL = await json(await api(admin, `/tarjetas/DANIEL/${cards.DANIEL.id}`, 'PATCH', { activa: false, version: 1 }));
      assert.equal((await api(editor, '/daniel', 'POST', { ...personalInput, tarjetaId: cards.DANIEL.id })).status, 400);
      personal = await json(await api(admin, `/daniel/${personal.id}`, 'PUT', { ...personalInput, tarjetaId: cards.DANIEL.id, version: personal.version, observaciones: 'Conservar tarjeta histórica' }));
      assert.equal(personal.tarjetaId, cards.DANIEL.id);
      assert.equal((await api(admin, `/tarjetas/DANIEL/${cards.DANIEL.id}`, 'PATCH', { activa: true, version: 1 })).status, 409);
      const list = await json(await api(viewer, '/tarjetas/DANIEL'));
      assert.equal(list.find(card => card.id === cards.DANIEL.id).activa, false);
    });
    let cashMovement;
    const cashInput = { fecha: '2026-11-04', tipo: 'EGRESO', concepto: `${stamp} Materiales`, monto: 5000.25, moneda: 'ARS', metodoPago: 'TARJETA_CREDITO', tarjetaId: cards.CAJA.id };
    await t.test('financial expenses are filterable without reducing cash/bank balances; incoming cards remain disabled', async () => {
      const before = await getCashLedgerReport(prisma, agency.id, getMonthlyReportPeriod(2026, 11));
      assert.equal((await api(admin, '/cajachica', 'POST', { ...cashInput, tipo: 'INGRESO' })).status, 400);
      assert.equal((await api(admin, '/cajachica', 'POST', { ...cashInput, tarjetaId: cards.TEODORO.id })).status, 400);
      cashMovement = await json(await api(admin, '/cajachica', 'POST', cashInput));
      assert.equal(cashMovement.cuenta, 'TARJETA'); assert.equal(cashMovement.cuentaBancariaId, null);
      const after = await getCashLedgerReport(prisma, agency.id, getMonthlyReportPeriod(2026, 11));
      assert.equal(after.saldoAlCierre.ARS.saldo, before.saldoAlCierre.ARS.saldo);
      assert.equal(after.movimientosDelPeriodo.ARS.gastosTarjeta - before.movimientosDelPeriodo.ARS.gastosTarjeta, 5000.25);
      const list = await json(await api(admin, `/cajachica?mes=11&anio=2026&tarjetaId=${cards.CAJA.id}`));
      assert.equal(list.meta.total, 1); assert.equal(list.gastosTarjetaFiltrados.ARS, 5000.25);
      const incoming = await json(await api(admin, `/cajachica?mes=11&anio=2026&tarjetaId=${cards.CAJA.id}&tipo=INGRESO`));
      assert.equal(incoming.meta.total, 0); assert.equal(incoming.gastosTarjetaFiltrados.ARS, 0);
      const reversed = await json(await api(admin, `/cajachica/${cashMovement.id}/anular`, 'POST', { motivo: 'Compra cargada por error' }));
      assert.equal(reversed.reversion.tarjetaId, cards.CAJA.id);
      assert.equal(reversed.reversion.tarjetaDescripcion, cashMovement.tarjetaDescripcion);
      const cancelled = await json(await api(admin, `/cajachica?mes=11&anio=2026&tarjetaId=${cards.CAJA.id}`));
      assert.equal(cancelled.gastosTarjetaFiltrados.ARS, 0);
    });
    await t.test('owner payouts and refunds retain card identity, voucher snapshots and correct settlement balances', async () => {
      owner = await prisma.persona.create({ data: { inmobiliariaId: agency.id, nombreCompleto: `${stamp} Dueño` } });
      property = await prisma.propiedad.create({ data: { inmobiliariaId: agency.id, direccion: stamp, estado: 'ALQUILADO' } });
      contract = await prisma.contrato.create({ data: { inmobiliariaId: agency.id, propiedadId: property.id, estado: 'ACTIVO', fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), montoAlquiler: 1000, montoHonorarios: 0, moneda: 'ARS', requiereActualizacion: false, propietarios: { create: { personaId: owner.id, esPrincipal: true } } } });
      liquidation = await prisma.liquidacion.create({ data: { inmobiliariaId: agency.id, contratoId: contract.id, periodo: new Date('2026-11-01'), estado: 'CONFIRMADA', montoAlquilerBase: 1000, totalIngresos: 1000, totalDescuentos: 0, netoACobrar: 1000, montoPropietario: 1000, montoHonorarios: 0, moneda: 'ARS', propietarioPagoId: owner.id } });
      await prisma.pago.create({ data: { inmobiliariaId: agency.id, contratoId: contract.id, liquidacionId: liquidation.id, monto: 1000, moneda: 'ARS', fechaPago: new Date('2026-11-02'), metodoPago: 'EFECTIVO' } });
      const payment = await json(await api(admin, `/liquidaciones/${liquidation.id}/pagar-propietario`, 'PATCH', { monto: 300, moneda: 'ARS', fechaPago: '2026-11-04', metodoPago: 'TARJETA_CREDITO', tarjetaId: cards.CAJA.id, propietarioId: owner.id }));
      assert.equal(Number(payment.saldoPropietario), 700);
      const detail = await json(await api(admin, `/liquidaciones/${liquidation.id}`));
      assert.ok(JSON.stringify(detail).includes('0012'));
      const ownerPdf = await pdfText(await api(admin, `/liquidaciones/${liquidation.id}/pdf-propietario`));
      assert.match(ownerPdf, /0012/);
      const reversed = await json(await api(admin, `/liquidaciones/${liquidation.id}/pagos-propietario/${payment.pagoPropietarioId}/anular`, 'POST', { motivo: 'Entrega cargada por error' }));
      const reversal = await prisma.movimientoCaja.findFirstOrThrow({ where: { reversionDeId: payment.pagoPropietarioMovimientoId } });
      assert.equal(reversal.tarjetaId, cards.CAJA.id);
      assert.equal(Number(reversed.liquidacion.montoPagadoPropietario), 0);
      await json(await api(admin, `/liquidaciones/${liquidation.id}/ajustes`, 'POST', { tipo: 'CREDITO', concepto: 'Corrección expensas', motivo: 'Rectificación de importe cobrado', montoInquilino: 100, montoPropietario: 100, destinoCredito: 'DEVOLUCION', fechaDevolucion: '2026-11-05', metodoDevolucion: 'TARJETA_CREDITO', tarjetaIdDevolucion: cards.CAJA.id }));
      const refund = await prisma.movimientoCaja.findFirstOrThrow({ where: { liquidacionId: liquidation.id, concepto: { startsWith: 'Devolución' } } });
      assert.equal(refund.tarjetaId, cards.CAJA.id); assert.equal(refund.cuenta, 'TARJETA');
      assert.equal((await api(admin, '/pagos', 'POST', { contratoId: contract.id, monto: 1, moneda: 'ARS', fechaPago: '2026-11-05', metodoPago: 'TARJETA_CREDITO', tarjetaId: cards.CAJA.id })).status, 400);
    });
    await t.test('card changes are audited', async () => {
      const logs = await prisma.auditLog.findMany({ where: { entidad: 'TarjetaCredito', entidadId: cards.DANIEL.id } });
      assert.ok(logs.some(row => row.accion === 'CREAR_TARJETA'));
      assert.ok(logs.some(row => row.accion === 'DESACTIVAR_TARJETA'));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    try {
      await prisma.$transaction(async tx => {
        if (liquidation) {
          await tx.liquidacion.update({ where: { id: liquidation.id }, data: { pagoPropietarioMovimientoId: null } });
          await tx.creditoInquilino.deleteMany({ where: { liquidacionOrigenId: liquidation.id } });
          await tx.ajusteLiquidacion.deleteMany({ where: { liquidacionId: liquidation.id } });
          await tx.comprobanteLiquidacion.deleteMany({ where: { liquidacionId: liquidation.id } });
          await tx.pagoPropietario.deleteMany({ where: { liquidacionId: liquidation.id } });
        }
        const ownMovements = { inmobiliariaId: agency.id, creadoPorId: { in: users } };
        await tx.movimientoCaja.updateMany({ where: ownMovements, data: { reversionDeId: null } });
        await tx.movimientoCaja.deleteMany({ where: ownMovements });
        if (liquidation) {
          await tx.pago.deleteMany({ where: { liquidacionId: liquidation.id } });
          await tx.liquidacion.delete({ where: { id: liquidation.id } });
        }
        if (contract) await tx.contrato.delete({ where: { id: contract.id } });
        if (property) await tx.propiedad.delete({ where: { id: property.id } });
        if (owner) await tx.persona.delete({ where: { id: owner.id } });
        await tx.movimientoInterno.deleteMany({ where: ownMovements });
        await tx.tarjetaCredito.deleteMany({ where: { inmobiliariaId: agency.id, nombre: { startsWith: stamp } } });
        await tx.userSession.deleteMany({ where: { usuarioId: { in: users } } });
        await tx.operacionFinanciera.deleteMany({ where: { usuarioId: { in: users } } });
        await tx.auditLog.deleteMany({ where: { usuarioId: { in: users } } });
        await tx.usuario.deleteMany({ where: { id: { in: users } } });
        await tx.rol.deleteMany({ where: { id: { in: roles } } });
      });
    } finally { await prisma.$disconnect(); }
  }
});
