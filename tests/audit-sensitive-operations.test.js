process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-audit-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propcontrol-audit-files-'));
process.env.UPLOAD_DIR = uploadRoot;

const { prisma } = require('../dist/prisma');
const permissionsService = require('../dist/services/permissions.service');
const { auditService } = require('../dist/services/audit.service');
const { logger } = require('../dist/services/logger.service');
const { requestContext } = require('../dist/middlewares/request-context.middleware');
const { authenticateToken } = require('../dist/middlewares/auth.middleware');
const { requirePermission } = require('../dist/middlewares/permissions.middleware');
const { SESSION_COOKIE, CSRF_COOKIE, sha256 } = require('../dist/services/security.service');
const authRouter = require('../dist/routes/auth.routes').default;
const filesRouter = require('../dist/routes/files.routes').default;
const inmobiliariaRouter = require('../dist/routes/inmobiliaria.routes').default;

const SESSION_TOKEN = 'audit-session-token';
const CSRF_TOKEN = 'audit-csrf-token';

const authHeaders = requestId => ({
  Cookie: `${SESSION_COOKIE}=${SESSION_TOKEN}; ${CSRF_COOKIE}=${CSRF_TOKEN}`,
  'X-CSRF-Token': CSRF_TOKEN,
  'X-Request-Id': requestId,
  'User-Agent': 'PropControl-PC036-Test'
});

function installSessionMock(t, tipo = 'ADMIN') {
  const originalFindUnique = prisma.userSession.findUnique;
  const originalUpdate = prisma.userSession.update;
  prisma.userSession.findUnique = async ({ where }) => {
    if (where.tokenHash !== sha256(SESSION_TOKEN)) return null;
    return {
      id: 71,
      csrfTokenHash: sha256(CSRF_TOKEN),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      sessionVersion: 0,
      authenticatedAt: new Date(),
      createdAt: new Date(),
      usuario: {
        id: 901,
        email: 'auditoria@propcontrol.local',
        tipo,
        inmobiliariaId: 1,
        activo: true,
        mustChangePassword: false,
        sessionVersion: 0,
        inmobiliaria: { id: 1, activa: true }
      }
    };
  };
  prisma.userSession.update = async () => undefined;
  t.after(() => {
    prisma.userSession.findUnique = originalFindUnique;
    prisma.userSession.update = originalUpdate;
  });
}

function captureAuditWrites(t) {
  const originalCreate = prisma.auditLog.create;
  const events = [];
  prisma.auditLog.create = async ({ data }) => {
    events.push(data);
    return { id: events.length, ...data };
  };
  t.after(() => { prisma.auditLog.create = originalCreate; });
  return events;
}

function createApp(route, router) {
  const app = express();
  app.set('trust proxy', false);
  app.use(requestContext);
  app.use(cookieParser());
  app.use(express.json());
  app.use(route, router);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  return app;
}

async function withServer(app, callback) {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('permission denials are attributable and correlated', async t => {
  installSessionMock(t, 'USUARIO');
  const events = captureAuditWrites(t);
  const originalHasPermission = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async () => false;
  t.after(() => { permissionsService.userHasPermission = originalHasPermission; });

  const router = express.Router();
  router.get('/protected', authenticateToken, requirePermission('sueldos.ver'), (_req, res) => res.sendStatus(204));

  await withServer(createApp('/api', router), async baseUrl => {
    const response = await fetch(`${baseUrl}/api/protected`, { headers: authHeaders('pc036-permission-denied') });
    assert.equal(response.status, 403);
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].accion, 'ACCESO_DENEGADO');
  assert.equal(events[0].resultado, 'FALLIDO');
  assert.equal(events[0].requestId, 'pc036-permission-denied');
  assert.match(events[0].ipAddress, /127\.0\.0\.1/);
  assert.deepEqual(JSON.parse(events[0].detalle), {
    permission: 'sueldos.ver',
    reason: 'PERMISSION_MISSING',
    method: 'GET',
    path: '/api/protected'
  });
});

test('failed and successful reauthentication attempts are audited', async t => {
  installSessionMock(t);
  const events = captureAuditWrites(t);
  const originalFindUnique = prisma.usuario.findUnique;
  const passwordHash = await bcrypt.hash('ClaveCorrecta!2026', 4);
  prisma.usuario.findUnique = async () => ({ id: 901, inmobiliariaId: 1, password: passwordHash });
  t.after(() => { prisma.usuario.findUnique = originalFindUnique; });

  await withServer(createApp('/api/auth', authRouter), async baseUrl => {
    const failed = await fetch(`${baseUrl}/api/auth/reauthenticate`, {
      method: 'POST',
      headers: { ...authHeaders('pc036-reauth-failed'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'ClaveIncorrecta!2026' })
    });
    assert.equal(failed.status, 401);

    const successful = await fetch(`${baseUrl}/api/auth/reauthenticate`, {
      method: 'POST',
      headers: { ...authHeaders('pc036-reauth-success'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'ClaveCorrecta!2026' })
    });
    assert.equal(successful.status, 200);
  });

  assert.deepEqual(events.map(event => [event.accion, event.resultado, event.requestId]), [
    ['REAUTENTICACION_FALLIDA', 'FALLIDO', 'pc036-reauth-failed'],
    ['REAUTENTICACION_EXITOSA', 'EXITO', 'pc036-reauth-success']
  ]);
});

test('agency profile changes preserve previous value and request metadata', async t => {
  installSessionMock(t);
  const events = captureAuditWrites(t);
  const originalHasPermission = permissionsService.userHasPermission;
  const originalFindUnique = prisma.inmobiliaria.findUnique;
  const originalUpdate = prisma.inmobiliaria.update;
  permissionsService.userHasPermission = async () => true;
  prisma.inmobiliaria.findUnique = async () => ({ nombre: 'Inmobiliaria anterior' });
  prisma.inmobiliaria.update = async () => ({ id: 1, nombre: 'Inmobiliaria nueva' });
  t.after(() => {
    permissionsService.userHasPermission = originalHasPermission;
    prisma.inmobiliaria.findUnique = originalFindUnique;
    prisma.inmobiliaria.update = originalUpdate;
  });

  await withServer(createApp('/api/inmobiliaria', inmobiliariaRouter), async baseUrl => {
    const response = await fetch(`${baseUrl}/api/inmobiliaria/me`, {
      method: 'PUT',
      headers: { ...authHeaders('pc036-profile-update'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Inmobiliaria nueva' })
    });
    assert.equal(response.status, 200);
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].accion, 'ACTUALIZAR_PERFIL_INMOBILIARIA');
  assert.equal(events[0].entidadId, 1);
  assert.equal(events[0].requestId, 'pc036-profile-update');
  assert.deepEqual(JSON.parse(events[0].detalle), {
    cambios: {
      nombre: {
        anterior: 'Inmobiliaria anterior',
        nuevo: 'Inmobiliaria nueva'
      }
    }
  });
});

test('successful file consultation is audited after transfer completion', async t => {
  installSessionMock(t, 'USUARIO');
  const events = captureAuditWrites(t);
  const originalHasPermission = permissionsService.userHasPermission;
  const originalContractFind = prisma.contrato.findFirst;
  const originalPropertyFind = prisma.adjuntoPropiedad.findFirst;
  permissionsService.userHasPermission = async (_userId, _role, permission) => permission === 'contratos.archivos.ver';
  prisma.contrato.findFirst = async () => ({ id: 501 });
  prisma.adjuntoPropiedad.findFirst = async () => null;
  t.after(() => {
    permissionsService.userHasPermission = originalHasPermission;
    prisma.contrato.findFirst = originalContractFind;
    prisma.adjuntoPropiedad.findFirst = originalPropertyFind;
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  });

  const agencyDirectory = path.join(uploadRoot, 'inmobiliaria-1');
  fs.mkdirSync(agencyDirectory, { recursive: true });
  fs.writeFileSync(path.join(agencyDirectory, 'contrato-pc036.pdf'), 'archivo auditado');

  await withServer(createApp('/api/files', filesRouter), async baseUrl => {
    const response = await fetch(`${baseUrl}/api/files/inmobiliaria-1/contrato-pc036.pdf`, {
      headers: authHeaders('pc036-file-read')
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'archivo auditado');
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].accion, 'CONSULTAR_ARCHIVO');
  assert.equal(events[0].resultado, 'EXITO');
  assert.equal(events[0].entidad, 'Contrato');
  assert.equal(events[0].entidadId, 501);
  assert.equal(events[0].requestId, 'pc036-file-read');
});

test('audit sink failures emit a structured alert and do not hide their result', async t => {
  const originalCreate = prisma.auditLog.create;
  const originalLoggerError = logger.error;
  const alerts = [];
  prisma.auditLog.create = async () => { throw new Error('audit database unavailable'); };
  logger.error = (message, metadata) => alerts.push({ message, metadata });
  t.after(() => {
    prisma.auditLog.create = originalCreate;
    logger.error = originalLoggerError;
  });

  const persisted = await auditService.log({
    usuarioId: 901,
    inmobiliariaId: 1,
    accion: 'OPERACION_SENSIBLE',
    entidad: 'Prueba',
    requestId: 'pc036-sink-failure'
  });

  assert.equal(persisted, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].message, 'AUDIT_SINK_FAILURE');
  assert.equal(alerts[0].metadata.alert, true);
  assert.equal(alerts[0].metadata.requestId, 'pc036-sink-failure');
});
