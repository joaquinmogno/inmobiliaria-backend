process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'prepayment-integration-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;
const { calculateCashLedger, getMonthlyReportPeriod } = require('../dist/services/financial-reporting.service');
const { generateMonthlyLiquidations } = require('../dist/services/liquidation-workflow.service');
const { registerRentPrepayment } = require('../dist/services/rent-prepayment.service');
const { getContractOutstandingObligations, hasContractOutstandingObligations } = require('../dist/services/contract-financial-integrity.service');

test('alquiler anticipado: registro, cobros, gastos, versiones y caja reales', async t => {
    const unique = `advance-${Date.now()}`;
    const agency = await prisma.inmobiliaria.findFirst() || await prisma.inmobiliaria.create({ data: { nombre: unique } });
    const password = 'AdvanceRent!2026_Strong';
    const user = await prisma.usuario.create({ data: { email: `${unique}@example.com`, nombreCompleto: unique, password: await bcrypt.hash(password, 10), tipo: 'ADMIN', inmobiliariaId: agency.id } });
    const property = await prisma.propiedad.create({ data: { direccion: unique, inmobiliariaId: agency.id } });
    const owner = await prisma.persona.create({ data: { nombreCompleto: 'Propietario anticipado', inmobiliariaId: agency.id } });
    const tenant = await prisma.persona.create({ data: { nombreCompleto: 'Inquilino anticipado', inmobiliariaId: agency.id } });
    const contract = await prisma.contrato.create({ data: { propiedadId: property.id, inmobiliariaId: agency.id, fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), montoAlquiler: 2300, montoHonorarios: 23, porcentajeHonorarios: 1, moneda: 'USD', requiereActualizacion: false, propietarios: { create: { personaId: owner.id, esPrincipal: true } }, inquilinos: { create: { personaId: tenant.id, esPrincipal: true } } } });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    let cookie, csrf;
    const request = async (path, method = 'GET', body, key = randomUUID()) => {
        const r = await fetch(base + path, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json() };
    };
    const ok = async (path, method = 'GET', body, key) => { const r = await request(path, method, body, key); assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
    const create = period => ok('/liquidaciones', 'POST', { contratoId: contract.id, periodo: `2026-${period}-01` });
    const confirm = id => ok(`/liquidaciones/${id}/confirmar`, 'PATCH', {});
    const detail = id => ok(`/liquidaciones/${id}`);
    const cashCount = () => prisma.movimientoCaja.count({ where: { contratoId: contract.id } });
    let november, advance, payment;
    try {
        const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
        assert.equal(login.status, 200); const auth = await login.json(); csrf = auth.csrfToken;
        cookie = `pc_session=${login.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1]}; pc_csrf=${csrf}`;
        await t.test('aplica 13.800 a seis meses y conserva el comprobante previo', async () => {
            november = await create('11'); await confirm(november.id);
            const old = await prisma.comprobanteLiquidacion.findFirst({ where: { liquidacionId: november.id }, orderBy: { version: 'asc' } });
            const data = { periodoDesde: '2026-06-01', meses: 6, fechaPago: '2026-05-30', montoMensual: 2300, moneda: 'USD', observaciones: 'Transferencia recibida directamente por propietario', recibidoPorPropietario: true };
            const key = randomUUID(); advance = await ok(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', data, key);
            assert.equal(Number(advance.montoTotal), 13800); assert.equal((await ok(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', data, key)).id, advance.id);
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', data)).status, 409);
            const d = await detail(november.id); const s = d.resumenMonedas[0];
            assert.equal(s.saldoInquilino, 0); assert.equal(s.saldoPropietario, 0); assert.equal(s.saldoACobrarPropietario, 23);
            assert.equal(d.estadoPagoPropietario, 'PENDIENTE'); assert.equal(await cashCount(), 0);
            assert.deepEqual((await prisma.comprobanteLiquidacion.findUnique({ where: { id: old.id } })).fotografia, old.fotografia);
            assert.equal(d.comprobantes.length, 2);
            assert.equal(hasContractOutstandingObligations(await getContractOutstandingObligations(prisma, contract.id)), true);
            for (const suffix of ['pdf', 'pdf-propietario']) {
                const pdf = await fetch(`${base}/liquidaciones/${november.id}/${suffix}?version=2`, { headers: { cookie } });
                assert.equal(pdf.status, 200);
                const parsed = spawnSync('pdftotext', ['-layout', '-', '-'], { input: Buffer.from(await pdf.arrayBuffer()), encoding: 'utf8' });
                assert.equal(parsed.status, 0, parsed.stderr);
                assert.match(parsed.stdout, /ANTICIPADO|ANTICIPO AL PROPIETARIO/);
                if (suffix === 'pdf-propietario') {
                    assert.match(parsed.stdout, /PENDIENTES DEL PROPIETARIO[\s\S]*23,00/);
                    assert.match(parsed.stdout, /NETO A TRANSFERIR AL PROPIETARIO[^\n]*0,00/);
                } else assert.match(parsed.stdout, /NETO A PAGAR[^\n]*0,00/);
            }
        });
        await t.test('no permite volver a cobrar ni transferir el alquiler cubierto', async () => {
            assert.equal((await request('/pagos', 'POST', { contratoId: contract.id, liquidacionId: november.id, monto: 2300, moneda: 'USD', fechaPago: '2026-11-10', metodoPago: 'EFECTIVO' })).status, 409);
            assert.equal((await request(`/liquidaciones/${november.id}/pagar-propietario`, 'PATCH', { monto: 2277, moneda: 'USD', propietarioId: owner.id, fechaPago: '2026-11-10', metodoPago: 'EFECTIVO' })).status, 409);
            assert.equal(await cashCount(), 0);
        });
        await t.test('cobra parcialmente los honorarios con idempotencia, cierra y revierte', async () => {
            const key = randomUUID(); const data = { monto: 10, moneda: 'USD', fechaPago: '2026-11-10', metodoPago: 'EFECTIVO' };
            const concurrent = await Promise.all([request(`/liquidaciones/${november.id}/cobros-propietario`, 'POST', data, key), request(`/liquidaciones/${november.id}/cobros-propietario`, 'POST', data, key)]);
            assert.ok(concurrent.some(r => r.status === 201));
            payment = await ok(`/liquidaciones/${november.id}/cobros-propietario`, 'POST', data, key);
            assert.equal(await cashCount(), 1); assert.equal((await detail(november.id)).resumenMonedas[0].saldoACobrarPropietario, 13);
            assert.equal((await request(`/liquidaciones/${november.id}/cobros-propietario`, 'POST', { ...data, monto: 14 })).status, 409);
            await ok(`/liquidaciones/${november.id}/cobros-propietario`, 'POST', { ...data, monto: 13 });
            assert.equal((await detail(november.id)).estadoPagoPropietario, 'PAGADO');
            await ok(`/liquidaciones/${november.id}/cobros-propietario/${payment.id}/anular`, 'POST', { motivo: 'Corrección de cobro duplicado informado' });
            assert.equal((await detail(november.id)).resumenMonedas[0].saldoACobrarPropietario, 10);
            const movements = await prisma.movimientoCaja.findMany({ where: { contratoId: contract.id }, include: { reversionDe: true } });
            assert.equal(calculateCashLedger(movements, getMonthlyReportPeriod(2026, 11)).saldoAlCierre.USD.saldo, 13);
            assert.equal((await request(`/liquidaciones/anticipos/${advance.id}/anular`, 'POST', { motivo: 'Revisar anticipo con operaciones' })).status, 409);
        });
        await t.test('nuevos meses aplican anticipo automáticamente y mantienen servicios en pesos', async () => {
            const july = await create('07'); assert.equal(Number(july.montoAlquilerAnticipado), 2300);
            await ok(`/liquidaciones/${july.id}/movimientos`, 'POST', { tipo: 'INGRESO', concepto: 'Expensas', monto: 80000, moneda: 'ARS', esParaInmobiliaria: false });
            const movement = await prisma.movimiento.findFirstOrThrow({ where: { liquidacionId: july.id, concepto: 'Expensas' } });
            const plan = await prisma.planCuotas.create({ data: { inmobiliariaId: agency.id, contratoId: contract.id, concepto: 'Expensas en pesos', montoTotal: 80000, moneda: 'ARS', tipoMovimiento: 'INGRESO' } });
            const quota = await prisma.cuotaPlan.create({ data: { planId: plan.id, numeroCuota: 1, fechaVencimiento: new Date('2026-07-10'), monto: 80000, moneda: 'ARS', liquidacionId: july.id, movimientoId: movement.id } });
            await confirm(july.id);
            const d = await detail(july.id); assert.equal(d.resumenMonedas.find(s => s.moneda === 'ARS').saldoInquilino, 80000);
            await ok('/pagos', 'POST', { contratoId: contract.id, liquidacionId: july.id, monto: 40000, moneda: 'ARS', fechaPago: '2026-07-10', metodoPago: 'EFECTIVO' });
            const paid = await detail(july.id); assert.equal(paid.resumenMonedas.find(s => s.moneda === 'ARS').saldoInquilino, 40000); assert.equal(paid.resumenMonedas.find(s => s.moneda === 'USD').saldoACobrarPropietario, 23);
            assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } })).estado, 'PENDIENTE');
            await ok('/pagos', 'POST', { contratoId: contract.id, liquidacionId: july.id, monto: 40000, moneda: 'ARS', fechaPago: '2026-07-10', metodoPago: 'EFECTIVO' });
            assert.equal((await prisma.cuotaPlan.findUniqueOrThrow({ where: { id: quota.id } })).estado, 'PAGADA');
        });
        await t.test('gastos a cargo del propietario conservan su deuda por moneda', async () => {
            const august = await create('08');
            await ok(`/liquidaciones/${august.id}/movimientos`, 'POST', { tipo: 'DESCUENTO', concepto: 'ABL pagado por administración', monto: 1500, moneda: 'ARS', esParaInmobiliaria: true });
            await confirm(august.id);
            const d = await detail(august.id); assert.equal(d.resumenMonedas.find(s => s.moneda === 'ARS').saldoACobrarPropietario, 1500);
            await ok(`/liquidaciones/${august.id}/cobros-propietario`, 'POST', { monto: 1500, moneda: 'ARS', fechaPago: '2026-08-10', metodoPago: 'EFECTIVO' });
            const paid = await detail(august.id); assert.equal(paid.resumenMonedas.find(s => s.moneda === 'USD').saldoACobrarPropietario, 23); assert.equal(paid.estadoPagoPropietario, 'PARCIAL');
        });
        await t.test('el mes siguiente al anticipo vuelve al circuito habitual', async () => {
            const december = await create('12'); await confirm(december.id); const d = await detail(december.id);
            assert.equal(Number(d.montoAlquilerAnticipado), 0); assert.equal(d.resumenMonedas[0].saldoInquilino, 2300); assert.equal(d.resumenMonedas[0].saldoPropietario, 2277); assert.equal(d.resumenMonedas[0].saldoACobrarPropietario, 0);
        });
        await t.test('valida permisos, fechas, cobertura y aislamiento de la inmobiliaria', async () => {
            const data = { periodoDesde: '2027-01-01', meses: 2, fechaPago: '2026-11-10', montoMensual: 2300, moneda: 'USD', observaciones: 'Anticipo siguiente', recibidoPorPropietario: true };
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { ...data, recibidoPorPropietario: false })).status, 400);
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { ...data, moneda: 'ARS' })).status, 409);
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { ...data, fechaPago: '2099-01-01' })).status, 422);
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { ...data, periodoDesde: '2028-01-01' })).status, 409);
            await assert.rejects(prisma.$transaction(tx => registerRentPrepayment(tx, { inmobiliariaId: agency.id + 1, usuarioId: user.id, contratoId: contract.id }, data)), /no encontrado/);
            const role = await prisma.rol.create({ data: { nombre: `${unique}-consulta`, inmobiliariaId: agency.id, permisos: { create: { permiso: { connect: { clave: 'liquidaciones.ver' } } } } } });
            const restricted = await prisma.usuario.create({ data: { email: `${unique}-viewer@example.com`, nombreCompleto: 'Consulta', rolId: role.id, password: await bcrypt.hash(password, 10), tipo: 'USUARIO', inmobiliariaId: agency.id } });
            const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: restricted.email, password }) });
            const auth = await login.json(); const session = login.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)[1];
            const denied = await fetch(`${base}/liquidaciones/contrato/${contract.id}/anticipos`, { method: 'POST', headers: { cookie: `pc_session=${session}; pc_csrf=${auth.csrfToken}`, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data) });
            assert.equal(denied.status, 403);
        });
        await t.test('la generación mensual aplica el anticipo y anularlo conserva comprobantes sin tocar caja', async () => {
            const before = await cashCount();
            const advance = await ok(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { periodoDesde: '2027-01-01', meses: 2, fechaPago: '2026-11-10', montoMensual: 2300, moneda: 'USD', observaciones: 'Prueba de anticipo siguiente', recibidoPorPropietario: true });
            await generateMonthlyLiquidations({ inmobiliariaId: agency.id, usuarioId: user.id, period: new Date('2027-01-01'), contratoIds: [contract.id] });
            const january = await prisma.liquidacion.findFirstOrThrow({ where: { contratoId: contract.id, periodo: new Date('2027-01-01') } });
            assert.equal(january.montoAlquilerAnticipado.toNumber(), 2300); await confirm(january.id);
            const old = await prisma.comprobanteLiquidacion.findFirstOrThrow({ where: { liquidacionId: january.id } });
            await ok(`/liquidaciones/anticipos/${advance.id}/anular`, 'POST', { motivo: 'Este anticipo fue informado por error' });
            const restored = await detail(january.id); assert.equal(restored.resumenMonedas[0].saldoInquilino, 2300); assert.equal(restored.resumenMonedas[0].saldoPropietario, 2277);
            assert.equal(await cashCount(), before); assert.deepEqual((await prisma.comprobanteLiquidacion.findUniqueOrThrow({ where: { id: old.id } })).fotografia, old.fotografia);
        });
        await t.test('no aplica un anticipo sobre cobros existentes ni altera la caja al rechazarlo', async () => {
            const december = await prisma.liquidacion.findFirstOrThrow({ where: { contratoId: contract.id, periodo: new Date('2026-12-01') } });
            await ok('/pagos', 'POST', { contratoId: contract.id, liquidacionId: december.id, monto: 100, moneda: 'USD', fechaPago: '2026-11-10', metodoPago: 'EFECTIVO' });
            const before = await cashCount();
            assert.equal((await request(`/liquidaciones/contrato/${contract.id}/anticipos`, 'POST', { periodoDesde: '2026-12-01', meses: 1, fechaPago: '2026-11-10', montoMensual: 2300, moneda: 'USD', observaciones: 'Anticipo mal informado sobre cobro existente', recibidoPorPropietario: true })).status, 409);
            assert.equal(await cashCount(), before); assert.equal((await detail(december.id)).resumenMonedas[0].saldoInquilino, 2200);
        });
    } finally { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); }
});
