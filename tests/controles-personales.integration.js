process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'personal-control-integration-test-session-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const { spawnSync } = require('node:child_process');
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;

const clients = [
  { slug: 'teodoro', title: 'Teodoro', scope: 'TEODORO' },
  { slug: 'daniel', title: 'Daniel', scope: 'DANIEL' }
];

for (const { slug, title, scope } of clients) {
  const { slug: peerSlug, title: peerTitle, scope: peerScope } = clients.find(client => client.scope !== scope);
  test(`${title}: operaciones completas con permisos y datos independientes de Control interno`, async t => {
    const unique = `${slug}-${Date.now()}`;
    const clientPath = `/${slug}`;
    const peerPath = `/${peerSlug}`;
    const existingAgency = await prisma.inmobiliaria.findFirst();
    const agency = existingAgency || await prisma.inmobiliaria.create({ data: { nombre: unique } });
    const password = 'PersonalTest!2026_Strong';
    const hash = await bcrypt.hash(password, 10);
    const roles = [];
    const users = [];
    const makeUser = async (name, keys, tipo = 'USUARIO') => {
      const permissions = await prisma.permiso.findMany({ where: { clave: { in: keys } } });
      assert.equal(permissions.length, keys.length);
      const role = await prisma.rol.create({ data: { nombre: `${unique}-${name}`, inmobiliariaId: agency.id, permisos: { create: permissions.map(permiso => ({ permisoId: permiso.id })) } } });
      roles.push(role);
      const user = await prisma.usuario.create({ data: { email: `${unique}-${name.toLowerCase()}@example.com`, password: hash, nombreCompleto: name, tipo, rolId: tipo === 'ADMIN' ? null : role.id, inmobiliariaId: agency.id } });
      users.push(user);
      return user;
    };
    const actions = ['ver', 'crear', 'editar', 'anular', 'reportes'];
    const adminUser = await makeUser('Admin', [], 'ADMIN');
    const internalUser = await makeUser('Interno', actions.map(action => `control_interno.${action}`));
    const clientUser = await makeUser(`${title}`, actions.map(action => `${slug}.${action}`));
    const peerUser = await makeUser(peerTitle, actions.map(action => `${peerSlug}.${action}`));
    const viewerUser = await makeUser('Consulta', [`${slug}.ver`]);
    const bank = await prisma.cuentaBancaria.create({ data: { nombre: unique, banco: 'Banco de la inmobiliaria', inmobiliariaId: agency.id } });
    const baseline = {};
    for (const model of ['movimientoCaja', 'pago', 'pagoPropietario', 'liquidacion']) baseline[model] = await prisma[model].count({ where: { inmobiliariaId: agency.id } });
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const login = async user => {
      const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      const token = response.headers.getSetCookie().join(',').match(/pc_session=([^;,\s]+)/)?.[1];
      return { cookie: `pc_session=${token}; pc_csrf=${body.csrfToken}`, csrf: body.csrfToken };
    };
    const api = (session, url, method = 'GET', body) => fetch(`${base}${url}`, {
      method, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) })
    });
    const json = async response => {
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const pdf = Buffer.from('%PDF-1.4\nRecibo de prueba\n%%EOF');
    const attachForm = (version, content = pdf) => {
      const form = new FormData();
      form.append('version', String(version));
      form.append('comprobantes', new Blob([content], { type: 'application/pdf' }), 'recibo.pdf');
      return form;
    };
    const input = { fecha: '2026-11-04', tipo: 'GASTO', detalle: `${unique} Pago de ${title}`, monto: '2500.50', moneda: 'ARS', categoria: `${unique} Servicios`, metodoPago: `${unique} Transferencia`, cuentaPago: `${unique} Cuenta personal` };
    const selection = `periodo=2026-11&creadoPorId=${clientUser.id}`;
    try {
      const admin = await login(adminUser);
      const internal = await login(internalUser);
      const client = await login(clientUser);
      const viewer = await login(viewerUser);
      const peer = await login(peerUser);
      const create = async (session, route, data) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(data)) form.append(key, String(value));
        form.append('comprobantes', new Blob([pdf], { type: 'application/pdf' }), 'recibo.pdf');
        const response = await api(session, route, 'POST', form);
        assert.equal(response.status, 201, await response.clone().text());
        return response.json();
      };
      const internalRecord = await create(internal, '/control-interno', { ...input, detalle: `${unique} Registro privado interno`, categoria: `${unique} Oficina`, metodoPago: `${unique} Cheque`, cuentaPago: `${unique} Cuenta interna`, monto: '999999', ambito: scope });
      const peerRecord = await create(peer, peerPath, { ...input, detalle: `${unique} Registro del otro cliente`, categoria: `${unique} Categoría ajena`, metodoPago: `${unique} Medio ajeno`, cuentaPago: `${unique} Cuenta ajena`, monto: '777777', ambito: scope });
      let record = await create(client, clientPath, { ...input, ambito: 'INTERNO' });
      await create(client, clientPath, { ...input, tipo: 'INGRESO', monto: '10000', detalle: `${unique} Ingreso` });
      await create(client, clientPath, { ...input, moneda: 'USD', monto: '25', detalle: `${unique} Gasto USD` });
      await create(client, clientPath, { ...input, fecha: '2026-12-01', monto: '900000', detalle: `${unique} Otro mes` });

      await t.test('cada ruta fija el ámbito y exige sus propios permisos para todas las operaciones', async () => {
        assert.equal(internalRecord.ambito, 'INTERNO');
        assert.equal(record.ambito, scope);
        assert.equal(peerRecord.ambito, peerScope);
        for (const [session, route, target] of [[internal, clientPath, record], [client, '/control-interno', internalRecord], [peer, clientPath, record], [client, peerPath, peerRecord]]) {
          for (const path of ['', '/opciones', '/reportes/excel?periodo=2026-11', '/reportes/pdf?periodo=2026-11', `/adjuntos/${target.adjuntos[0].id}/archivo`]) {
            assert.equal((await api(session, `${route}${path}`)).status, 403);
          }
          assert.equal((await api(session, route, 'POST', input)).status, 403);
          assert.equal((await api(session, `${route}/${target.id}`, 'PUT', { ...input, version: target.version })).status, 403);
          assert.equal((await api(session, `${route}/${target.id}/adjuntos`, 'POST', attachForm(target.version))).status, 403);
          assert.equal((await api(session, `${route}/${target.id}/anular`, 'POST', { version: target.version, motivo: 'Prueba de permisos' })).status, 403);
        }
        assert.equal((await api(viewer, clientPath, 'POST', input)).status, 403);
        assert.equal((await api(viewer, `${clientPath}/${record.id}`, 'PUT', { ...input, version: record.version })).status, 403);
        assert.equal((await api(viewer, `${clientPath}/${record.id}/adjuntos`, 'POST', attachForm(record.version))).status, 403);
        assert.equal((await api(viewer, `${clientPath}/${record.id}/anular`, 'POST', { version: record.version, motivo: 'No autorizado' })).status, 403);
        for (const format of ['excel', 'pdf']) assert.equal((await api(viewer, `${clientPath}/reportes/${format}?${selection}`)).status, 403);
      });

      await t.test('listados, totales, categorías, cuentas y autores quedan separados', async () => {
        const list = await json(await api(viewer, `${clientPath}?${selection}&limit=1&ambito=INTERNO`));
        assert.equal(list.meta.total, 3);
        const allAuthors = await json(await api(admin, `${clientPath}?periodo=2026-11&search=${unique}`));
        assert.equal(allAuthors.meta.total, 3);
        assert.deepEqual(allAuthors.resumen, list.resumen);
        assert.equal(list.data.length, 1);
        assert.ok(list.data.every(row => row.ambito === scope));
        assert.deepEqual(list.resumen, [{ moneda: 'ARS', ingresos: 10000, gastos: 2500.5, diferencia: 7499.5 }, { moneda: 'USD', ingresos: 0, gastos: 25, diferencia: -25 }]);
        const internalList = await json(await api(admin, `/control-interno?periodo=2026-11&creadoPorId=${internalUser.id}&ambito=${scope}`));
        assert.deepEqual(internalList.data.map(row => row.id), [internalRecord.id]);
        for (const [route, own, other, user] of [[clientPath, record, internalRecord, clientUser], ['/control-interno', internalRecord, record, internalUser]]) {
          const options = await json(await api(admin, `${route}/opciones`));
          for (const [key, field] of [['categorias', 'categoria'], ['mediosPago', 'metodoPago'], ['cuentasPago', 'cuentaPago']]) {
            assert.ok(options[key].includes(own[field]));
            assert.ok(!options[key].includes(other[field]));
          }
          assert.ok(options.usuarios.some(author => author.id === user.id));
          assert.ok(!options.usuarios.some(author => author.id === (user.id === internalUser.id ? clientUser.id : internalUser.id)));
        }
        const options = await json(await api(admin, `${clientPath}/opciones`));
        for (const [key, field] of [['categorias', 'categoria'], ['mediosPago', 'metodoPago'], ['cuentasPago', 'cuentaPago']]) assert.ok(!options[key].includes(peerRecord[field]));
        assert.ok(!options.usuarios.some(author => author.id === peerUser.id));
        const peerOptions = await json(await api(admin, `${peerPath}/opciones`));
        assert.ok(!peerOptions.cuentasPago.includes(record.cuentaPago));
        assert.ok(!options.cuentasPago.some(name => name.includes(bank.banco)));
      });

      await t.test('ni un administrador puede cruzar comprobantes, ediciones, adjuntos o anulaciones entre rutas', async () => {
        for (const [route, other] of [[clientPath, internalRecord], ['/control-interno', record], [clientPath, peerRecord], [peerPath, record]]) {
          assert.equal((await api(admin, `${route}/adjuntos/${other.adjuntos[0].id}/archivo`)).status, 404);
          assert.equal((await api(admin, `${route}/${other.id}`, 'PUT', { ...input, version: other.version })).status, 404);
          assert.equal((await api(admin, `${route}/${other.id}/adjuntos`, 'POST', attachForm(other.version))).status, 404);
          assert.equal((await api(admin, `${route}/${other.id}/anular`, 'POST', { version: other.version, motivo: 'Intento cruzado' })).status, 404);
        }
        const response = await api(viewer, `${clientPath}/adjuntos/${record.adjuntos[0].id}/archivo`);
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
      });

      await t.test(`Excel y PDF identifican ${title} y contienen exclusivamente su selección mensual`, async () => {
        const response = await api(client, `${clientPath}/reportes/excel?${selection}`);
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('content-disposition').includes(`${slug}-2026-11.xlsx`));
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
        const sheet = book.getWorksheet('Movimientos');
        assert.equal(sheet.getCell('A1').value, `${agency.nombre} · ${title}`);
        assert.equal(sheet.rowCount, 8);
        assert.equal(book.getWorksheet('Resumen').getCell('A1').value, `${title}`);
        assert.equal(book.getWorksheet('Resumen').getCell('C3').value, 2500.5);
        for (let row = 6; row <= 8; row++) {
          assert.notEqual(sheet.getCell(`D${row}`).value, internalRecord.detalle);
          assert.notEqual(sheet.getCell(`D${row}`).value, peerRecord.detalle);
        }
        const pdfResponse = await api(client, `${clientPath}/reportes/pdf?${selection}`);
        assert.equal(pdfResponse.status, 200);
        assert.ok(pdfResponse.headers.get('content-disposition').includes(`${slug}-2026-11.pdf`));
        const parsed = spawnSync('pdftotext', ['-', '-'], { input: Buffer.from(await pdfResponse.arrayBuffer()), encoding: 'utf8' });
        assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
        assert.ok(parsed.stdout.includes(title));
        assert.ok(!parsed.stdout.includes('Registro privado interno'));
        assert.ok(!parsed.stdout.includes('Otro mes'));
        assert.ok(!parsed.stdout.includes('Registro del otro cliente'));
        const internalResponse = await api(internal, `/control-interno/reportes/excel?periodo=2026-11&creadoPorId=${internalUser.id}`);
        await book.xlsx.load(Buffer.from(await internalResponse.arrayBuffer()));
        assert.equal(book.getWorksheet('Movimientos').getCell('A1').value, `${agency.nombre} · Control interno`);
        assert.equal(book.getWorksheet('Movimientos').rowCount, 6);
      });

      await t.test('editar y adjuntar mantienen el ámbito, validan archivos y rechazan versiones obsoletas', async () => {
        const body = { ...input, monto: '3000', version: record.version, ambito: 'INTERNO' };
        record = await json(await api(client, `${clientPath}/${record.id}`, 'PUT', body));
        assert.equal(record.ambito, scope);
        assert.equal(record.version, 2);
        assert.equal((await api(client, `${clientPath}/${record.id}`, 'PUT', body)).status, 409);
        assert.equal((await api(client, `${clientPath}/${record.id}/adjuntos`, 'POST', attachForm(record.version, 'PDF falsificado'))).status, 400);
        const version = record.version;
        record = await json(await api(client, `${clientPath}/${record.id}/adjuntos`, 'POST', attachForm(version)));
        assert.equal(record.adjuntos.length, 2);
        assert.equal(record.version, 3);
        assert.equal((await api(client, `${clientPath}/${record.id}/adjuntos`, 'POST', attachForm(version))).status, 409);
      });

      await t.test('anular conserva los comprobantes e historial y excluye el gasto de los totales', async () => {
        const version = record.version;
        record = await json(await api(client, `${clientPath}/${record.id}/anular`, 'POST', { version, motivo: 'Cargado por duplicado' }));
        assert.ok(record.anuladoEn);
        assert.equal(record.motivoAnulacion, 'Cargado por duplicado');
        assert.equal(record.adjuntos.length, 2);
        assert.equal((await api(viewer, `${clientPath}/adjuntos/${record.adjuntos[0].id}/archivo`)).status, 200);
        const list = await json(await api(viewer, `${clientPath}?${selection}&estado=TODOS`));
        assert.equal(list.meta.total, 3);
        assert.equal(list.resumen[0].gastos, 0);
        assert.equal(list.resumen[1].gastos, 25);
        assert.equal((await api(client, `${clientPath}/${record.id}`, 'PUT', { ...input, version: record.version })).status, 409);
        assert.equal((await api(client, `${clientPath}/${record.id}/anular`, 'POST', { version, motivo: 'Segundo intento' })).status, 409);
        const untouched = await prisma.movimientoInterno.findUniqueOrThrow({ where: { id: internalRecord.id } });
        assert.equal(untouched.anuladoEn, null);
        assert.equal(untouched.version, 1);
        const untouchedPeer = await prisma.movimientoInterno.findUniqueOrThrow({ where: { id: peerRecord.id } });
        assert.equal(untouchedPeer.anuladoEn, null);
        assert.equal(untouchedPeer.version, 1);
      });

      await t.test(`audita ${title} por separado y conserva los saldos y permisos existentes`, async () => {
        const audit = await prisma.auditLog.findMany({ where: { entidad: `Movimiento${title}`, entidadId: record.id } });
        for (const action of [`CREAR_MOVIMIENTO_${scope}`, `EDITAR_MOVIMIENTO_${scope}`, `ADJUNTAR_COMPROBANTE_${scope}`, `ANULAR_MOVIMIENTO_${scope}`]) assert.ok(audit.some(row => row.accion === action), action);
        const exports = await prisma.auditLog.findMany({ where: { usuarioId: clientUser.id, entidad: title } });
        assert.equal(exports.length, 2);
        assert.ok(exports.every(row => row.accion === `EXPORTAR_${scope}`));
        for (const model of Object.keys(baseline)) assert.equal(await prisma[model].count({ where: { inmobiliariaId: agency.id } }), baseline[model], model);
        assert.equal(await prisma.rolPermiso.count({ where: { rolId: internalUser.rolId } }), 5);
        assert.equal(await prisma.rolPermiso.count({ where: { rolId: viewerUser.rolId } }), 1);
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
      const userIds = users.map(user => user.id);
      const roleIds = roles.map(role => role.id);
      const ownRecords = { inmobiliariaId: agency.id, creadoPorId: { in: userIds } };
      const files = await prisma.adjuntoMovimientoInterno.findMany({ where: { movimientoInterno: ownRecords }, select: { rutaArchivo: true } });
      const { removeUploadedFile } = require('../dist/middlewares/upload.middleware');
      await Promise.all(files.map(file => removeUploadedFile(file.rutaArchivo)));
      await prisma.adjuntoMovimientoInterno.deleteMany({ where: { movimientoInterno: ownRecords } });
      await prisma.movimientoInterno.deleteMany({ where: ownRecords });
      await prisma.userSession.deleteMany({ where: { usuarioId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { usuarioId: { in: userIds } } });
      await prisma.rolPermiso.deleteMany({ where: { rolId: { in: roleIds } } });
      await prisma.usuario.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rol.deleteMany({ where: { id: { in: roleIds } } });
      await prisma.cuentaBancaria.delete({ where: { id: bank.id } });
      if (!existingAgency) await prisma.inmobiliaria.delete({ where: { id: agency.id } });
      await prisma.$disconnect();
    }
  });
}
