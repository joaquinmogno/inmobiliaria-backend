process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'movement-receipts-integration-session-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
assert.match(process.env.DATABASE_URL || '', /\/propcontrol_integration(?:\?|$)/, 'Usar únicamente la base descartable de integración');
const uploads = mkdtempSync(path.join(tmpdir(), 'movement-receipts-'));
process.env.UPLOAD_DIR = uploads;
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;

const parsePdf = bytes => {
    const result = spawnSync('pdftotext', ['-layout', '-', '-'], { input: bytes, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
};
test('recibos de movimientos: emisión, historial, acceso y efecto contable', async t => {
    const agency = await prisma.inmobiliaria.findFirstOrThrow();
    const originalLogo = agency.logoArchivo;
    const suffix = `recibos-${Date.now()}`;
    const password = 'ReceiptsTest!2026_Strong';
    const hash = await bcrypt.hash(password, 10);
    const users = [], roles = [], records = [];
    const makeUser = async (name, permissions = [], tipo = 'USUARIO') => {
        const ids = [];
        for (const clave of permissions) ids.push((await prisma.permiso.upsert({ where: { clave }, update: {}, create: { clave, descripcion: clave, modulo: clave.split('.')[0], accion: clave.split('.')[1] } })).id);
        const role = await prisma.rol.create({ data: { nombre: `${suffix}-${name}`, inmobiliariaId: agency.id, permisos: { create: ids.map(permisoId => ({ permisoId })) } } });
        roles.push(role.id);
        const user = await prisma.usuario.create({ data: { nombreCompleto: name, email: `${suffix}-${name}@example.com`, password: hash, tipo, rolId: tipo === 'ADMIN' ? null : role.id, inmobiliariaId: agency.id } });
        users.push(user.id); return user;
    };
    const admin = await makeUser('admin', [], 'ADMIN');
    const viewer = await makeUser('viewer', ['teodoro.ver']);
    const other = await makeUser('other', ['control_interno.ver', 'control_interno.editar']);
    const editor = await makeUser('editor', ['daniel.ver', 'daniel.editar']);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const login = async user => {
        const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
        assert.equal(response.status, 200, await response.clone().text());
        const auth = await response.json();
        return { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: auth.csrfToken };
    };
    const sessions = await Promise.all([admin, viewer, other, editor].map(login));
    const request = (url, method = 'GET', body, session = sessions[0]) => fetch(`${base}${url}`, {
        method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const json = async (...args) => {
        const response = await request(...args);
        assert.ok(response.ok, await response.clone().text());
        return response.json();
    };
    const pdf = async (record, version = 1) => {
        const response = await request(`${record.url}/${version}/pdf`);
        assert.equal(response.status, 200, await response.clone().text());
        assert.match(response.headers.get('cache-control'), /no-store/);
        return Buffer.from(await response.arrayBuffer());
    };
    const input = context => ({ ...context.datos, pagador: 'Daniel Pérez', receptor: 'José Albañil', documentoReceptor: '20-12345678-3', inmueble: 'Cabildo 1532', huellaMovimiento: context.huellaMovimiento, ultimaVersion: context.ultimaVersion, motivo: '' });
    try {
        const dir = path.join(uploads, `inmobiliaria-${agency.id}`);
        mkdirSync(dir, { recursive: true });
        await sharp({ create: { width: 80, height: 30, channels: 3, background: '#4338ca' } }).webp().toFile(path.join(dir, 'logo.webp'));
        await prisma.inmobiliaria.update({ where: { id: agency.id }, data: { logoArchivo: `inmobiliaria-${agency.id}/logo.webp` } });
        for (const [scope, slug, moneda] of [['CAJA', 'cajachica', 'ARS'], ['INTERNO', 'control-interno', 'USD'], ['TEODORO', 'teodoro', 'ARS'], ['DANIEL', 'daniel', 'USD']]) {
            const shared = { inmobiliariaId: agency.id, creadoPorId: admin.id, fecha: new Date('2026-10-12'), monto: '135760.25', moneda, metodoPago: 'EFECTIVO', observaciones: 'NOTA PRIVADA NO DEBE SALIR' };
            const row = scope === 'CAJA' ? await prisma.movimientoCaja.create({ data: { ...shared, tipo: 'EGRESO', concepto: 'Reparación de baño' } })
                : await prisma.movimientoInterno.create({ data: { ...shared, ambito: scope, tipo: 'GASTO', detalle: 'Reparación de baño', cuentaPago: 'CUENTA PRIVADA NO DEBE SALIR' } });
            records.push({ ...row, scope, url: `/${slug}/${row.id}/recibos` });
        }
        const [cash, internal, teodoro, daniel] = records;
        await t.test('vista previa en los cuatro módulos, sin emitir ni modificar movimientos; respeta monedas y privacidad', async () => {
            const beforeCount = await prisma.reciboMovimiento.count();
            for (const record of records) {
                const context = await json(record.url);
                assert.equal(context.movimiento.moneda, record.moneda);
                if (record.scope === 'TEODORO' || record.scope === 'DANIEL') assert.equal(context.datos.pagador, record.scope === 'TEODORO' ? 'Teodoro' : 'Daniel');
                assert.equal(context.movimiento.fecha, '2026-10-12');
                const preview = await json(`${record.url}/vista-previa`, 'POST', input(context));
                const text = parsePdf(Buffer.from(preview.pdf, 'base64'));
                assert.match(text, /VISTA PREVIA/); assert.match(text, /SIN EMITIR/);
                assert.ok(text.includes('135.760,25')); assert.ok(text.includes(`(${record.moneda})`));
                assert.match(text, /José Albañil/); assert.match(text, /Firma de quien recibe/);
                assert.doesNotMatch(text, /PRIVADA/); assert.doesNotMatch(JSON.stringify(context), /PRIVADA/);
                if (record.moneda === 'ARS') assert.doesNotMatch(text, /US\$/);
            }
            assert.equal(await prisma.reciboMovimiento.count(), beforeCount);
        });
        await t.test('emisión y reintentos concurrentes usan el mismo número y versión, sin duplicar pagos ni saldos', async () => {
            const baseline = { cash: await prisma.movimientoCaja.findMany({ where: { creadoPorId: admin.id } }), internal: await prisma.movimientoInterno.findMany({ where: { creadoPorId: admin.id } }), payments: await prisma.pago.count() };
            for (const record of records) {
                const context = await json(record.url);
                const bodies = await Promise.all([json(record.url, 'POST', input(context)), json(record.url, 'POST', input(context))]);
                assert.equal(bodies[0].numero, bodies[1].numero); assert.equal(bodies[0].version, 1); assert.equal(bodies[1].version, 1);
                assert.equal(bodies.filter(item => item.creada).length, 1);
                const history = await json(record.url);
                assert.equal(history.versiones.length, 1); assert.equal(history.versiones[0].estado, 'VIGENTE');
                const bytes = await pdf(record);
                const text = parsePdf(bytes);
                assert.ok(text.includes(history.numero)); assert.doesNotMatch(text, /VISTA PREVIA|PRIVADA/);
                if (record === cash) writeFileSync('/tmp/recibo-movimiento-verificado.pdf', bytes);
            }
            assert.deepEqual(await prisma.movimientoCaja.findMany({ where: { creadoPorId: admin.id } }), baseline.cash);
            assert.deepEqual(await prisma.movimientoInterno.findMany({ where: { creadoPorId: admin.id } }), baseline.internal);
            assert.equal(await prisma.pago.count(), baseline.payments);
            assert.equal(await prisma.auditLog.count({ where: { usuarioId: admin.id, accion: 'EMITIR_RECIBO_MOVIMIENTO' } }), 4);
            const parent = await prisma.reciboMovimiento.findUniqueOrThrow({ where: { movimientoCajaId: cash.id }, include: { versiones: true } });
            const logo = parent.versiones[0].fotografia.emisor.logo;
            assert.ok(logo); assert.equal((await sharp(Buffer.from(logo, 'base64')).metadata()).format, 'png');
            rmSync(path.join(dir, 'logo.webp'));
            assert.ok(parsePdf(await pdf(cash)).includes('José Albañil'), 'La reimpresión no depende del logo borrado');
        });
        await t.test('permisos de cada ámbito, consulta sin emisión y edición sin permiso de creación', async () => {
            assert.equal((await request(teodoro.url, 'GET', undefined, sessions[1])).status, 200);
            assert.equal((await request(`${teodoro.url}/1/pdf`, 'GET', undefined, sessions[1])).status, 200);
            const data = input(await json(teodoro.url));
            for (const suffix of ['', '/vista-previa']) assert.equal((await request(teodoro.url + suffix, 'POST', data, sessions[1])).status, 403);
            for (const suffix of ['', '/1/pdf']) assert.equal((await request(teodoro.url + suffix, 'GET', undefined, sessions[2])).status, 403);
            assert.equal((await request(`/control-interno/${teodoro.id}/recibos`)).status, 404);
            assert.equal((await request(`/daniel/${teodoro.id}/recibos/1/pdf`)).status, 404);
            const edit = { ...input(await json(daniel.url)), receptor: 'Receptor corregido', motivo: 'Corrección de nombre' };
            assert.equal((await request(daniel.url, 'POST', edit, sessions[3])).status, 201);
            assert.equal((await request('/teodoro/0/recibos')).status, 400);
            assert.equal((await request(teodoro.url, 'POST', { ...data, monto: 1, moneda: 'USD' })).status, 400);
            assert.equal((await request(teodoro.url, 'POST', { ...data, receptor: ' ' })).status, 400);
        });
        await t.test('corregir el movimiento invalida el PDF anterior; reemitir conserva las fotografías y exige motivo', async () => {
            const stale = input(await json(teodoro.url));
            const changed = await json(`/teodoro/${teodoro.id}`, 'PUT', { version: 1, fecha: '2026-10-12', tipo: 'GASTO', detalle: 'Reparación ampliada del baño', monto: '145760.50', moneda: 'ARS', metodoPago: 'TRANSFERENCIA', observaciones: 'PRIVADA NUEVA' });
            assert.equal(changed.version, 2);
            const context = await json(teodoro.url);
            assert.equal(context.versiones[0].estado, 'DESACTUALIZADO');
            const historic = parsePdf(await pdf(teodoro));
            assert.match(historic, /DESACTUALIZADO/); assert.match(historic, /135\.760,25/);
            assert.equal((await request(teodoro.url, 'POST', stale)).status, 409);
            assert.equal((await request(`${teodoro.url}/vista-previa`, 'POST', stale)).status, 409);
            assert.equal((await request(teodoro.url, 'POST', input(context))).status, 400);
            const emitted = await json(teodoro.url, 'POST', { ...input(context), motivo: 'Corrección del costo del arreglo', descripcion: 'Reparación ampliada del baño' });
            assert.equal(emitted.version, 2); assert.equal(emitted.numero, context.numero);
            assert.match(parsePdf(await pdf(teodoro, 1)), /REEMPLAZADO/);
            assert.match(parsePdf(await pdf(teodoro, 2)), /145\.760,50/);
            assert.equal((await request(teodoro.url, 'POST', { ...input(context), receptor: 'Otro receptor', motivo: 'Pestaña anterior' })).status, 409);
        });
        await t.test('observaciones internas y adjuntos no invalidan un recibo; el ingreso identifica a quien recibe', async () => {
            await prisma.movimientoInterno.update({ where: { id: internal.id }, data: { observaciones: 'Nueva nota privada', version: { increment: 1 } } });
            const upload = new FormData(); upload.append('version', '2'); upload.append('comprobantes', new Blob([readFileSync('/tmp/recibo-movimiento-verificado.pdf')], { type: 'application/pdf' }), 'recibo-firmado.pdf');
            const response = await fetch(`${base}/control-interno/${internal.id}/adjuntos`, { method: 'POST', headers: { cookie: sessions[0].cookie, 'x-csrf-token': sessions[0].csrf }, body: upload });
            assert.equal(response.status, 201, await response.clone().text());
            assert.equal((await json(internal.url)).versiones[0].estado, 'VIGENTE');
            await prisma.movimientoInterno.update({ where: { id: internal.id }, data: { tipo: 'INGRESO' } });
            assert.equal((await json(internal.url)).versiones[0].estado, 'DESACTUALIZADO');
            const row = await prisma.movimientoInterno.create({ data: { inmobiliariaId: agency.id, creadoPorId: admin.id, ambito: 'TEODORO', tipo: 'INGRESO', fecha: new Date('2026-10-12'), detalle: 'Ingreso de fondos', monto: 100, moneda: 'ARS' } });
            const context = await json(`/teodoro/${row.id}/recibos`);
            assert.equal(context.datos.pagador, ''); assert.equal(context.datos.receptor, 'Teodoro');
        });
        await t.test('una reemisión con motivo conserva los datos del pago aunque no cambie el destinatario', async () => {
            const context = await json(daniel.url);
            const data = { ...context.datos, huellaMovimiento: context.huellaMovimiento, ultimaVersion: context.ultimaVersion, motivo: 'Nueva copia con datos del emisor actualizados' };
            const issued = await json(daniel.url, 'POST', data);
            assert.equal(issued.version, context.ultimaVersion + 1);
            const retried = await json(daniel.url, 'POST', data);
            assert.equal(retried.version, issued.version); assert.equal(retried.creada, false);
            assert.match(parsePdf(await pdf(daniel, issued.version)), /135\.760,25/);
        });
        await t.test('recibos de cobros y pagos parciales congelan contexto y saldos separados por moneda', async () => {
            const { liquidation: sampleLiquidation } = require('./fixtures/receipt-design');
            let property, contract, owner, liquidation;
            try {
                property = await prisma.propiedad.create({ data: { direccion: 'Inmueble de prueba de recibos', inmobiliariaId: agency.id } });
                contract = await prisma.contrato.create({ data: { propiedadId: property.id, inmobiliariaId: agency.id, fechaInicio: new Date('2026-01-01'), fechaFin: new Date('2027-12-31'), montoAlquiler: '100', montoHonorarios: '0', moneda: 'USD' } });
                owner = await prisma.persona.create({ data: { nombreCompleto: 'Propietario de prueba', inmobiliariaId: agency.id } });
                liquidation = await prisma.liquidacion.create({ data: { contratoId: contract.id, inmobiliariaId: agency.id, periodo: new Date('2026-11-01'), estado: 'CONFIRMADA', moneda: 'USD', netoACobrar: '100', montoPropietario: '100', movimientos: { create: sampleLiquidation.movimientos.map(row => ({ ...row, concepto: 'Concepto de prueba' })) } } });
                const shared = { inmobiliariaId: agency.id, creadoPorId: admin.id, liquidacionId: liquidation.id, fechaPago: new Date('2026-11-12'), metodoPago: 'EFECTIVO' };
                const collection = await prisma.pago.create({ data: { ...shared, contratoId: contract.id, monto: '50000.25', moneda: 'ARS' } });
                await prisma.pago.create({ data: { ...shared, contratoId: contract.id, monto: '100', moneda: 'USD' } });
                const cashData = { inmobiliariaId: agency.id, creadoPorId: admin.id, contratoId: contract.id, liquidacionId: liquidation.id, fecha: shared.fechaPago, metodoPago: 'EFECTIVO', moneda: 'ARS', concepto: 'Pago parcial de prueba' };
                const incoming = await prisma.movimientoCaja.create({ data: { ...cashData, tipo: 'INGRESO', monto: '50000.25', pagoId: collection.id } });
                const outgoing = await prisma.movimientoCaja.create({ data: { ...cashData, tipo: 'EGRESO', monto: '50000', esPagoPropietario: true } });
                await prisma.pagoPropietario.create({ data: { ...shared, propietarioId: owner.id, movimientoCajaId: outgoing.id, monto: '50000', moneda: 'ARS', cuenta: 'CAJA', montoFondosCobrados: '50000' } });
                const contexts = [];
                for (const [movement, direction, expectedPending] of [[incoming, 'COBRO_INQUILINO', '64999.75'], [outgoing, 'PAGO_PROPIETARIO', '55000.00']]) {
                    const url = `/cajachica/${movement.id}/recibos`;
                    const context = await json(url);
                    const data = { ...input(context), pagador: direction === 'COBRO_INQUILINO' ? 'Inquilina de prueba' : agency.nombre, receptor: direction === 'COBRO_INQUILINO' ? agency.nombre : owner.nombreCompleto };
                    await json(url, 'POST', data);
                    const saved = await prisma.versionReciboMovimiento.findFirstOrThrow({ where: { recibo: { movimientoCajaId: movement.id } } });
                    assert.equal(saved.fotografia.contexto.operacion, direction);
                    assert.equal(saved.fotografia.contexto.contratoId, contract.id);
                    assert.equal(saved.fotografia.contexto.monedas.find(row => row.moneda === 'ARS').pendiente, expectedPending);
                    assert.equal(saved.fotografia.contexto.monedas.find(row => row.moneda === 'USD').pendiente, direction === 'COBRO_INQUILINO' ? '0.00' : '100.00');
                    const beforePdf = parsePdf(await pdf({ url }));
                    assert.match(beforePdf, /Pendiente/);
                    assert.ok(beforePdf.includes(direction === 'COBRO_INQUILINO' ? '64.999,75' : '55.000,00'));
                    contexts.push({ url, saved, beforePdf });
                }
                await prisma.pago.create({ data: { ...shared, contratoId: contract.id, monto: '64999.75', moneda: 'ARS' } });
                await prisma.pagoPropietario.create({ data: { ...shared, propietarioId: owner.id, monto: '55000', moneda: 'ARS', cuenta: 'CAJA', montoFondosCobrados: '55000' } });
                for (const { url, saved, beforePdf } of contexts) {
                    assert.equal(parsePdf(await pdf({ url })), beforePdf, 'La reimpresión no debe recalcular saldos actuales');
                    assert.deepEqual((await prisma.versionReciboMovimiento.findUniqueOrThrow({ where: { id: saved.id } })).fotografia, saved.fotografia);
                    const context = await json(url);
                    assert.equal(context.versiones[0].estado, 'VIGENTE');
                    const preview = await json(`${url}/vista-previa`, 'POST', { ...input(context), motivo: 'Nueva revisión de contexto' });
                    const text = parsePdf(Buffer.from(preview.pdf, 'base64'));
                    assert.ok(text.includes('VISTA PREVIA'));
                    assert.ok(!text.includes(saved.fotografia.contexto.operacion === 'COBRO_INQUILINO' ? '64.999,75' : '55.000,00'));
                }
            } finally {
                if (liquidation) {
                    const where = { movimientoCaja: { liquidacionId: liquidation.id } };
                    await prisma.versionReciboMovimiento.deleteMany({ where: { recibo: where } });
                    await prisma.reciboMovimiento.deleteMany({ where });
                    await prisma.pagoPropietario.deleteMany({ where: { liquidacionId: liquidation.id } });
                    await prisma.movimientoCaja.deleteMany({ where: { liquidacionId: liquidation.id } });
                    await prisma.pago.deleteMany({ where: { liquidacionId: liquidation.id } });
                    await prisma.movimiento.deleteMany({ where: { liquidacionId: liquidation.id } });
                    await prisma.liquidacion.delete({ where: { id: liquidation.id } });
                }
                if (contract) await prisma.contrato.delete({ where: { id: contract.id } });
                if (property) await prisma.propiedad.delete({ where: { id: property.id } });
                if (owner) await prisma.persona.delete({ where: { id: owner.id } });
            }
        });
        await t.test('PDF extenso identifica la versión y el estado en cada hoja', async () => {
            const { buildMovementReceiptPdf } = require('../dist/services/movement-receipt-pdf.service');
            const saved = await prisma.versionReciboMovimiento.findFirstOrThrow({ where: { recibo: { movimientoInternoId: daniel.id } }, orderBy: { version: 'desc' } });
            const snapshot = saved.fotografia;
            snapshot.datos.descripcion = 'Detalle del arreglo y materiales del baño.\n'.repeat(35).trim();
            const bytes = await buildMovementReceiptPdf(snapshot, { numero: 'REC-123456', version: 3, fechaEmision: saved.fechaEmision, estado: 'ANULADO' });
            const pages = parsePdf(bytes).split('\f').filter(page => page.trim());
            assert.equal(pages.length, 2);
            pages.forEach((page, index) => {
                assert.match(page, /ANULADO/);
                assert.match(page, /REC-123456/);
                assert.match(page, /Versión 3/);
                assert.ok(page.includes(`Página ${index + 1} de 2`));
            });
        });
        await t.test('anular un movimiento conserva todos los PDFs marcados como anulados y bloquea nuevas emisiones', async () => {
            await json(`/teodoro/${teodoro.id}/anular`, 'POST', { version: 2, motivo: 'Pago anulado para prueba' });
            const context = await json(teodoro.url);
            assert.equal(context.puedeEmitir, false);
            assert.ok(context.versiones.every(row => row.estado === 'ANULADO'));
            for (const version of [1, 2]) assert.match(parsePdf(await pdf(teodoro, version)), /ANULADO/);
            assert.equal((await request(teodoro.url, 'POST', { ...input(context), motivo: 'Intento anulado' })).status, 409);
        });
        await t.test('una reversión también anula el recibo cuando el asiento original permanece en un mes cerrado', async () => {
            await prisma.movimientoCaja.create({ data: { inmobiliariaId: agency.id, creadoPorId: admin.id, fecha: new Date('2026-11-15'), monto: cash.monto, moneda: cash.moneda, tipo: 'INGRESO', concepto: `Reversión #${cash.id}`, reversionDeId: cash.id } });
            assert.equal((await prisma.movimientoCaja.findUniqueOrThrow({ where: { id: cash.id } })).anuladoEn, null);
            assert.equal((await json(cash.url)).versiones[0].estado, 'ANULADO');
            assert.match(parsePdf(await pdf(cash)), /ANULADO/);
            const inverse = await prisma.movimientoCaja.findUniqueOrThrow({ where: { reversionDeId: cash.id } });
            const context = await json(`/cajachica/${inverse.id}/recibos`);
            assert.equal(context.puedeEmitir, false);
            assert.equal((await request(`/cajachica/${inverse.id}/recibos`, 'POST', input(context))).status, 409);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        await prisma.inmobiliaria.update({ where: { id: agency.id }, data: { logoArchivo: originalLogo } });
        const receiptWhere = { OR: [{ movimientoCaja: { creadoPorId: { in: users } } }, { movimientoInterno: { creadoPorId: { in: users } } }] };
        await prisma.versionReciboMovimiento.deleteMany({ where: { recibo: receiptWhere } });
        await prisma.reciboMovimiento.deleteMany({ where: receiptWhere });
        await prisma.adjuntoMovimientoInterno.deleteMany({ where: { creadoPorId: { in: users } } });
        await prisma.movimientoInterno.deleteMany({ where: { creadoPorId: { in: users } } });
        await prisma.movimientoCaja.deleteMany({ where: { creadoPorId: { in: users }, reversionDeId: { not: null } } });
        await prisma.movimientoCaja.deleteMany({ where: { creadoPorId: { in: users } } });
        await prisma.auditLog.deleteMany({ where: { usuarioId: { in: users } } });
        await prisma.usuario.deleteMany({ where: { id: { in: users } } });
        await prisma.rol.deleteMany({ where: { id: { in: roles } } });
        await prisma.$disconnect(); rmSync(uploads, { recursive: true, force: true });
    }
});
