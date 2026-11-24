process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'cash-personal-copy-integration-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');
const { copyCashMovement } = require('../dist/services/cash-personal-copy.service');
const app = require('../dist/app').default;

test('copias de Gestión financiera: caja intacta, concurrencia, permisos y trazabilidad', async t => {
    const unique = `copy-${Date.now()}`;
    const existingAgency = await prisma.inmobiliaria.findFirst();
    const agency = existingAgency || await prisma.inmobiliaria.create({ data: { nombre: unique } });
    const password = 'CopyMovement!2026_Strong';
    const hash = await bcrypt.hash(password, 10);
    const users = [], roles = [];
    const makeUser = async (name, permissions, tipo = 'USUARIO') => {
        const role = await prisma.rol.create({ data: { nombre: `${unique}-${name}`, inmobiliariaId: agency.id,
            permisos: { create: permissions.map(clave => ({ permiso: { connect: { clave } } })) } } });
        roles.push(role.id);
        const user = await prisma.usuario.create({ data: { email: `${unique}-${name}@example.com`, nombreCompleto: name, password: hash, tipo, rolId: tipo === 'ADMIN' ? null : role.id, inmobiliariaId: agency.id } });
        users.push(user.id); return user;
    };
    const adminUser = await makeUser('admin', [], 'ADMIN');
    const viewerUser = await makeUser('viewer', ['caja_chica.ver', 'teodoro.ver']);
    const writerUser = await makeUser('writer', ['caja_chica.ver', 'teodoro.ver', 'teodoro.crear']);
    const noCashUser = await makeUser('nocash', ['teodoro.ver', 'teodoro.crear']);
    const property = await prisma.propiedad.create({ data: { direccion: unique, inmobiliariaId: agency.id } });
    const contract = await prisma.contrato.create({ data: { propiedadId: property.id, inmobiliariaId: agency.id, fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), montoAlquiler: '100', montoHonorarios: '0', moneda: 'USD' } });
    const liquidation = await prisma.liquidacion.create({ data: { contratoId: contract.id, inmobiliariaId: agency.id, periodo: new Date('2026-11-01'), estado: 'CONFIRMADA', netoACobrar: '100', moneda: 'USD' } });
    const bank = await prisma.cuentaBancaria.create({ data: { nombre: unique, banco: 'Nación', moneda: 'USD', inmobiliariaId: agency.id } });
    const common = { inmobiliariaId: agency.id, creadoPorId: adminUser.id, fecha: new Date('2026-11-12'), concepto: unique, monto: '100.25', tipo: 'INGRESO', moneda: 'USD' };
    const payment = await prisma.pago.create({ data: { inmobiliariaId: agency.id, creadoPorId: adminUser.id, contratoId: contract.id, liquidacionId: liquidation.id, fechaPago: common.fecha, metodoPago: 'TRANSFERENCIA', monto: common.monto, moneda: 'USD' } });
    const source = await prisma.movimientoCaja.create({ data: { ...common, contratoId: contract.id, liquidacionId: liquidation.id, pagoId: payment.id, cuenta: 'BANCO', cuentaBancariaId: bank.id, metodoPago: 'TRANSFERENCIA', observaciones: 'Cobro parcial del alquiler' } });
    const expense = await prisma.movimientoCaja.create({ data: { ...common, tipo: 'EGRESO', moneda: 'ARS', monto: '1234.56', concepto: `${unique} gasto` } });
    const canceled = await prisma.movimientoCaja.create({ data: { ...common, anuladoEn: new Date() } });
    const reversed = await prisma.movimientoCaja.create({ data: common });
    const reversal = await prisma.movimientoCaja.create({ data: { ...common, tipo: 'EGRESO', reversionDeId: reversed.id } });
    const baseline = await prisma.movimientoCaja.findMany({ where: { creadoPorId: adminUser.id }, orderBy: { id: 'asc' } });
    const baselineLiquidation = await prisma.liquidacion.findUnique({ where: { id: liquidation.id } });
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const login = async user => {
        const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json();
        const token = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)?.[1];
        return { cookie: `pc_session=${token}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
    };
    const api = (session, path, method = 'GET', body) => fetch(`${base}${path}`, { method,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const copyPath = (id, target = 'teodoro') => `/cajachica/${id}/duplicar/${target}`;
    let copy;
    try {
        const [admin, viewer, writer, noCash] = await Promise.all([adminUser, viewerUser, writerUser, noCashUser].map(login));
        await t.test('exige acceso a caja y consulta/alta del destino, valida ID y no admite alterar el importe', async () => {
            assert.equal((await api(viewer, copyPath(source.id), 'POST', {})).status, 403);
            assert.equal((await api(noCash, copyPath(source.id), 'POST', {})).status, 403);
            assert.equal((await api(writer, copyPath(source.id, 'daniel'), 'POST', {})).status, 403);
            assert.equal((await api(admin, copyPath('incorrecto'), 'POST', {})).status, 400);
            assert.equal((await api(admin, copyPath(2147483647), 'POST', {})).status, 404);
            assert.equal((await api(writer, copyPath(source.id), 'POST', { monto: 1 })).status, 400);
            await assert.rejects(copyCashMovement({ movimientoId: source.id, inmobiliariaId: agency.id + 1, usuarioId: adminUser.id, destino: 'TEODORO' }), /no encontrado/);
        });
        await t.test('varias solicitudes simultáneas crean exactamente una copia con centavos y vínculo al cobro', async () => {
            const responses = await Promise.all(Array.from({ length: 5 }, () => api(writer, copyPath(source.id), 'POST', {})));
            assert.equal(responses.filter(response => response.status === 201).length, 1);
            assert.equal(responses.filter(response => response.status === 200).length, 4);
            const bodies = await Promise.all(responses.map(response => response.json()));
            assert.equal(new Set(bodies.map(body => body.copia.id)).size, 1);
            copy = await prisma.movimientoInterno.findUniqueOrThrow({ where: { id: bodies[0].copia.id } });
            assert.equal(copy.movimientoCajaOrigenId, source.id);
            assert.equal(copy.monto.toFixed(2), '100.25');
            assert.equal(copy.moneda, 'USD'); assert.equal(copy.tipo, 'INGRESO');
            assert.equal(copy.fecha.toISOString(), source.fecha.toISOString());
            assert.equal(copy.detalle, source.concepto); assert.equal(copy.metodoPago, 'TRANSFERENCIA');
            assert.equal(copy.cuentaPago, `Nación · ${unique} (USD)`);
            assert.equal(copy.observaciones, source.observaciones);
            assert.equal(await prisma.auditLog.count({ where: { entidadId: copy.id, accion: 'DUPLICAR_MOVIMIENTO_CAJA_TEODORO' } }), 1);
        });
        await t.test('permite una copia en cada carpeta y mantiene el tipo de los egresos', async () => {
            assert.equal((await api(admin, copyPath(source.id, 'daniel'), 'POST', {})).status, 201);
            const response = await api(admin, copyPath(expense.id, 'daniel'), 'POST', {});
            assert.equal(response.status, 201);
            const record = await prisma.movimientoInterno.findUniqueOrThrow({ where: { id: (await response.json()).copia.id } });
            assert.equal(record.tipo, 'GASTO'); assert.equal(record.moneda, 'ARS'); assert.equal(record.monto.toFixed(2), '1234.56');
            const list = await (await api(writer, `/cajachica?search=${unique}`)).json();
            assert.deepEqual(list.data.find(row => row.id === source.id).copiasPersonales.map(row => row.ambito), ['TEODORO']);
            const personal = await (await api(writer, `/teodoro?periodo=2026-11&search=${unique}`)).json();
            assert.equal(personal.data[0].movimientoCajaOrigen.id, source.id);
            assert.equal(personal.resumen.find(row => row.moneda === 'USD').ingresos, 100.25);
        });
        await t.test('no duplica anulados ni asientos de reversión', async () => {
            for (const record of [canceled, reversed, reversal]) assert.equal((await api(admin, copyPath(record.id), 'POST', {})).status, 409);
        });
        await t.test('la caja, el cobro y la liquidación quedan exactamente iguales', async () => {
            assert.deepEqual(await prisma.movimientoCaja.findMany({ where: { creadoPorId: adminUser.id }, orderBy: { id: 'asc' } }), baseline);
            assert.deepEqual(await prisma.liquidacion.findUnique({ where: { id: liquidation.id } }), baselineLiquidation);
            assert.deepEqual(await prisma.pago.findUnique({ where: { id: payment.id } }), payment);
        });
        await t.test('anular una copia no altera el original ni permite recrearla por reintento', async () => {
            const response = await api(admin, `/teodoro/${copy.id}/anular`, 'POST', { version: 1, motivo: 'Esta copia no corresponde' });
            assert.equal(response.status, 200);
            const retried = await api(admin, copyPath(source.id), 'POST', {});
            assert.equal(retried.status, 200);
            const body = await retried.json(); assert.equal(body.creada, false); assert.ok(body.copia.anuladoEn);
            assert.equal(await prisma.movimientoInterno.count({ where: { movimientoCajaOrigenId: source.id, ambito: 'TEODORO' } }), 1);
            assert.equal((await prisma.movimientoCaja.findUnique({ where: { id: source.id } })).anuladoEn, null);
        });
        await t.test('si se anula el original la carpeta conserva su copia y expone el aviso de origen', async () => {
            await prisma.movimientoCaja.update({ where: { id: source.id }, data: { anuladoEn: new Date() } });
            const personal = await (await api(admin, `/daniel?periodo=2026-11&search=${unique}`)).json();
            const row = personal.data.find(record => record.movimientoCajaOrigenId === source.id);
            assert.ok(row.movimientoCajaOrigen.anuladoEn); assert.equal(row.anuladoEn, null);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        await prisma.movimientoInterno.deleteMany({ where: { creadoPorId: { in: users } } });
        await prisma.movimientoCaja.delete({ where: { id: reversal.id } });
        await prisma.movimientoCaja.deleteMany({ where: { creadoPorId: adminUser.id } });
        await prisma.pago.delete({ where: { id: payment.id } });
        await prisma.liquidacion.delete({ where: { id: liquidation.id } });
        await prisma.contrato.delete({ where: { id: contract.id } });
        await prisma.propiedad.delete({ where: { id: property.id } });
        await prisma.cuentaBancaria.delete({ where: { id: bank.id } });
        await prisma.userSession.deleteMany({ where: { usuarioId: { in: users } } });
        await prisma.auditLog.deleteMany({ where: { usuarioId: { in: users } } });
        await prisma.usuario.deleteMany({ where: { id: { in: users } } });
        await prisma.rolPermiso.deleteMany({ where: { rolId: { in: roles } } });
        await prisma.rol.deleteMany({ where: { id: { in: roles } } });
        if (!existingAgency) await prisma.inmobiliaria.delete({ where: { id: agency.id } });
        await prisma.$disconnect();
    }
});
