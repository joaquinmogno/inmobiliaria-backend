process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'internal-control-integration-session-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;

test('control interno: permisos, comprobantes, reportes y aislamiento de caja con PostgreSQL real', async t => {
  const unique = `interno-${Date.now()}`;
  const existingAgency = await prisma.inmobiliaria.findFirst();
  const agency = existingAgency || await prisma.inmobiliaria.create({ data: { nombre: `Control interno ${unique}` } });
  const password = 'TestInternal!2026_Strong';
  const hash = await bcrypt.hash(password, 10);
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'control_interno.ver' } });
  const role = await prisma.rol.create({ data: { nombre: `Consulta ${unique}`, inmobiliariaId: agency.id, permisos: { create: { permisoId: permission.id } } } });
  const deniedRole = await prisma.rol.create({ data: { nombre: `Sin acceso ${unique}`, inmobiliariaId: agency.id } });
  const users = await Promise.all([
    prisma.usuario.create({ data: { email: `${unique}-admin@example.com`, password: hash, nombreCompleto: 'Jefe interno', tipo: 'ADMIN', inmobiliariaId: agency.id } }),
    prisma.usuario.create({ data: { email: `${unique}-viewer@example.com`, password: hash, nombreCompleto: 'Usuario consulta', tipo: 'USUARIO', rolId: role.id, inmobiliariaId: agency.id } }),
    prisma.usuario.create({ data: { email: `${unique}-none@example.com`, password: hash, nombreCompleto: 'Sin acceso', tipo: 'USUARIO', rolId: deniedRole.id, inmobiliariaId: agency.id } })
  ]);
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
  try {
    const [admin, viewer, denied] = await Promise.all(users.map(login));
    await t.test('el permiso de consulta no permite altas, reportes ni acceso a otro módulo', async () => {
      assert.equal((await api(denied, '/control-interno')).status, 403);
      assert.equal((await api(viewer, '/control-interno?periodo=2026-10')).status, 200);
      assert.equal((await api(viewer, '/control-interno', 'POST', {})).status, 403);
      assert.equal((await api(viewer, '/control-interno/reportes/excel?periodo=2026-10')).status, 403);
      assert.equal((await api(viewer, '/control-interno/reportes/pdf?periodo=2026-10')).status, 403);
    });
    const pdf = Buffer.from('%PDF-1.4\nComprobante de prueba\n%%EOF');
    const form = new FormData();
    for (const [key, value] of Object.entries({ fecha: '2026-10-28', tipo: 'GASTO', detalle: 'Artículos de oficina', monto: '25000.50', moneda: 'ARS', categoria: 'Oficina' })) form.append(key, value);
    form.append('comprobantes', new Blob([pdf], { type: 'application/pdf' }), 'Compra oficina.pdf');
    const createdResponse = await api(admin, '/control-interno', 'POST', form);
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    let record = await createdResponse.json();
    await t.test('guarda un comprobante y permite omitir el medio de pago', async () => {
      assert.equal(record.metodoPago, null);
      assert.equal(record.adjuntos.length, 1);
      const attachment = record.adjuntos[0];
      const response = await api(viewer, `/control-interno/adjuntos/${attachment.id}/archivo`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
      assert.equal((await api(denied, `/control-interno/adjuntos/${attachment.id}/archivo`)).status, 403);
      assert.equal((await api(admin, '/control-interno/adjuntos/2147483647/archivo')).status, 404);
    });
    await t.test('rechaza archivos falsificados y formatos ajenos a comprobantes', async () => {
      const data = new FormData();
      data.append('version', String(record.version));
      data.append('comprobantes', new Blob(['documento falso'], { type: 'application/pdf' }), 'falso.pdf');
      const response = await api(admin, `/control-interno/${record.id}/adjuntos`, 'POST', data);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_FILE_CONTENT');
      assert.equal(await prisma.adjuntoMovimientoInterno.count({ where: { movimientoInternoId: record.id } }), 1);
    });
    const createSimple = async (changes = {}) => {
      const data = new FormData();
      for (const [key, value] of Object.entries({ fecha: '2026-10-29', detalle: 'Ingreso de control personal', monto: '50000', moneda: 'ARS', tipo: 'INGRESO', ...changes })) data.append(key, value);
      const response = await api(admin, '/control-interno', 'POST', data);
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    };
    await createSimple();
    await createSimple({ tipo: 'GASTO', moneda: 'USD', monto: '100.25' });
    await createSimple({ fecha: '2026-11-01', monto: '999999' });
    await t.test('filtra por mes y moneda y totaliza toda la selección, no sólo la página', async () => {
      const response = await api(admin, `/control-interno?periodo=2026-10&limit=1&creadoPorId=${users[0].id}`);
      const body = await response.json();
      assert.equal(body.meta.total, 3);
      assert.equal(body.data.length, 1);
      assert.deepEqual(body.resumen, [{ moneda: 'ARS', ingresos: 50000, gastos: 25000.5, diferencia: 24999.5 }, { moneda: 'USD', ingresos: 0, gastos: 100.25, diferencia: -100.25 }]);
    });
    await t.test('los reportes Excel/PDF contienen toda la selección y respetan sus filtros', async () => {
      const response = await api(admin, `/control-interno/reportes/excel?periodo=2026-10&moneda=ARS&creadoPorId=${users[0].id}`);
      assert.equal(response.status, 200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
      assert.equal(workbook.getWorksheet('Movimientos').rowCount, 7);
      assert.equal(workbook.getWorksheet('Resumen').getCell('C3').value, 25000.5);
      const pdfResponse = await api(admin, '/control-interno/reportes/pdf?periodo=2026-10');
      assert.equal(pdfResponse.status, 200);
      assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    });
    await t.test('la edición es versionada y no permite modificar datos ajenos', async () => {
      const body = { fecha: '2026-10-28', detalle: 'Artículos de oficina corregido', monto: '27000', moneda: 'ARS', tipo: 'GASTO', version: record.version };
      assert.equal((await api(admin, '/control-interno/2147483647', 'PUT', body)).status, 404);
      assert.equal((await api(viewer, `/control-interno/${record.id}`, 'PUT', body)).status, 403);
      const response = await api(admin, `/control-interno/${record.id}`, 'PUT', body);
      assert.equal(response.status, 200, await response.clone().text());
      record = await response.json();
      assert.equal(record.version, 2);
      assert.equal((await api(admin, `/control-interno/${record.id}`, 'PUT', body)).status, 409);
    });
    await t.test('la anulación conserva el motivo y comprobantes y excluye el importe de los totales', async () => {
      const response = await api(admin, `/control-interno/${record.id}/anular`, 'POST', { version: record.version, motivo: 'Movimiento cargado por duplicado' });
      assert.equal(response.status, 200);
      const canceled = await response.json();
      assert.ok(canceled.anuladoEn);
      assert.equal(canceled.adjuntos.length, 1);
      assert.equal(canceled.motivoAnulacion, 'Movimiento cargado por duplicado');
      const all = await (await api(admin, `/control-interno?periodo=2026-10&estado=TODOS&creadoPorId=${users[0].id}`)).json();
      assert.equal(all.meta.total, 3);
      assert.equal(all.resumen[0].gastos, 0);
      assert.equal((await api(admin, `/control-interno/${record.id}/adjuntos`, 'POST', new FormData())).status, 400);
    });
    await t.test('ninguna operación del módulo modifica caja, pagos o liquidaciones', async () => {
      for (const model of ['movimientoCaja', 'pago', 'pagoPropietario', 'liquidacion']) assert.equal(await prisma[model].count({ where: { inmobiliariaId: agency.id } }), baseline[model], model);
      assert.equal(await prisma.rolPermiso.count({ where: { rolId: role.id } }), 1);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    const userIds = users.map(user => user.id);
    const ownRecords = { inmobiliariaId: agency.id, creadoPorId: { in: userIds } };
    const files = await prisma.adjuntoMovimientoInterno.findMany({ where: { movimientoInterno: ownRecords }, select: { rutaArchivo: true } });
    const { removeUploadedFile } = require('../dist/middlewares/upload.middleware');
    await Promise.all(files.map(file => removeUploadedFile(file.rutaArchivo)));
    await prisma.adjuntoMovimientoInterno.deleteMany({ where: { movimientoInterno: ownRecords } });
    await prisma.movimientoInterno.deleteMany({ where: ownRecords });
    await prisma.userSession.deleteMany({ where: { usuarioId: { in: users.map(user => user.id) } } });
    await prisma.auditLog.deleteMany({ where: { usuarioId: { in: userIds } } });
    await prisma.rolPermiso.deleteMany({ where: { rolId: role.id } });
    await prisma.usuario.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.rol.delete({ where: { id: role.id } });
    await prisma.rol.delete({ where: { id: deniedRole.id } });
    if (!existingAgency) await prisma.inmobiliaria.delete({ where: { id: agency.id } });
    await prisma.$disconnect();
  }
});
