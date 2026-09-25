process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-permissions-api-suite';
process.env.BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || 'test-backup-encryption-key-with-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const TEST_BACKUPS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'propcontrol-backup-api-'));
process.env.BACKUPS_DIR = TEST_BACKUPS_ROOT;

const permissionsService = require('../dist/services/permissions.service');
const { prisma } = require('../dist/prisma');
const { authenticateToken } = require('../dist/middlewares/auth.middleware');
const { requirePermission } = require('../dist/middlewares/permissions.middleware');
const { SESSION_COOKIE, CSRF_COOKIE, sha256 } = require('../dist/services/security.service');
const { encryptFile } = require('../dist/services/security.service');
const { auditService } = require('../dist/services/audit.service');
const { requestContext } = require('../dist/middlewares/request-context.middleware');
const backupsRouter = require('../dist/routes/backups.routes').default;

const SESSION_TOKEN = 'permissions-session-token';
const CSRF_TOKEN = 'permissions-csrf-token';

function installSessionMock(tipo = 'USUARIO', mustChangePassword = false) {
  prisma.userSession = {
    findUnique: async ({ where }) => {
      if (where.tokenHash !== sha256(SESSION_TOKEN)) return null;
      return {
        id: 1,
        tokenHash: where.tokenHash,
        csrfTokenHash: sha256(CSRF_TOKEN),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
          sessionVersion: 0,
          authenticatedAt: new Date(),
          createdAt: new Date(),
          usuario: {
          id: 9001,
          email: 'permisos.test@inmobiliaria.local',
          tipo,
          inmobiliariaId: 1,
          activo: true,
          mfaEnabled: true,
          mustChangePassword,
          sessionVersion: 0,
          inmobiliaria: { id: 1, activa: true },
        },
      };
    },
    update: async () => undefined,
  };
}

function createBackupsApp() {
  const app = express();
  app.use(requestContext);
  app.use(cookieParser());
  app.use('/api/backups', backupsRouter);
  return app;
}

function authHeaders() {
  return {
    Cookie: `${SESSION_COOKIE}=${SESSION_TOKEN}; ${CSRF_COOKIE}=${CSRF_TOKEN}`,
    'X-CSRF-Token': CSRF_TOKEN,
  };
}

function createUser() {
  return {
      id: 9001,
      email: 'permisos.test@inmobiliaria.local',
      tipo: 'USUARIO',
      inmobiliariaId: 1,
  };
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createPermissionsApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  app.get('/api/sueldos', authenticateToken, requirePermission('sueldos.ver'), (_req, res) => {
    res.json([{ id: 1, concepto: 'Sueldo de prueba' }]);
  });

  app.get('/api/auth/me', authenticateToken, async (req, res) => {
    const permissions = await permissionsService.getUserPermissions(req.user.id);
    res.json({
      id: req.user.id,
      tipo: req.user.tipo,
      permissions,
    });
  });

  return app;
}

test('HTTP permissions: user without sueldos.ver receives 403', async () => {
  installSessionMock();
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async () => false;

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sueldos`, {
      headers: authHeaders(),
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).message, 'No tiene permisos para realizar esta acción');
  });

  permissionsService.userHasPermission = original;
});

test('HTTP permissions: user with sueldos.ver can access endpoint', async () => {
  installSessionMock();
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async (_userId, _role, permission) => permission === 'sueldos.ver';

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sueldos`, {
      headers: authHeaders(),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 1, concepto: 'Sueldo de prueba' }]);
  });

  permissionsService.userHasPermission = original;
});

test('HTTP permissions: a role without the permission is denied', async () => {
  installSessionMock();
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async () => false;

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sueldos`, {
      headers: authHeaders(),
    });

    assert.equal(response.status, 403);
  });

  permissionsService.userHasPermission = original;
});

test('HTTP auth/me returns refreshed permissions on each request', async () => {
  installSessionMock();
  const original = permissionsService.getUserPermissions;
  let permissions = ['contratos.ver'];
  permissionsService.getUserPermissions = async () => permissions;

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const headers = authHeaders();

    const first = await fetch(`${baseUrl}/api/auth/me`, { headers });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).permissions, ['contratos.ver']);

    permissions = ['contratos.ver', 'sueldos.ver'];
    const second = await fetch(`${baseUrl}/api/auth/me`, { headers });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).permissions, ['contratos.ver', 'sueldos.ver']);
  });

  permissionsService.getUserPermissions = original;
});

test('HTTP mandatory password change blocks business APIs but keeps account maintenance available', async () => {
  installSessionMock('USUARIO', true);
  const originalHasPermission = permissionsService.userHasPermission;
  const originalGetPermissions = permissionsService.getUserPermissions;
  permissionsService.userHasPermission = async () => true;
  permissionsService.getUserPermissions = async () => [];

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/api/sueldos`, { headers: authHeaders() });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), {
      message: 'Debe cambiar la contraseña para continuar',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });

    const accountStatus = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders() });
    assert.equal(accountStatus.status, 200);
  });

  permissionsService.userHasPermission = originalHasPermission;
  permissionsService.getUserPermissions = originalGetPermissions;
});

test('HTTP backups: only ADMIN accounts can access', async () => {
  installSessionMock('ADMIN');

  await withServer(createBackupsApp(), async (baseUrl) => {
    const permitted = await fetch(`${baseUrl}/api/backups`, { headers: authHeaders() });
    assert.equal(permitted.status, 200);
    assert.ok(Array.isArray(await permitted.json()));
  });
});

test('HTTP backup download audits the real transfer result and correlates failures', async () => {
  installSessionMock('ADMIN');
  const dbDirectory = path.join(TEST_BACKUPS_ROOT, 'db');
  fs.mkdirSync(dbDirectory, { recursive: true });
  const plainPath = path.join(TEST_BACKUPS_ROOT, 'pc013.sql');
  const filename = 'pc013.sql.enc';
  fs.writeFileSync(plainPath, 'backup de prueba PC-013');
  await encryptFile(plainPath, path.join(dbDirectory, filename));
  fs.unlinkSync(plainPath);

  const originalAuditLog = auditService.log;
  const originalDownload = express.response.download;
  const auditEvents = [];
  auditService.log = async event => auditEvents.push(event);

  try {
    express.response.download = function (_path, _filename, callback) {
      setImmediate(() => callback(Object.assign(new Error('simulated transfer failure'), { code: 'EPIPE' })));
      return this;
    };

    await withServer(createBackupsApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/backups/download/db/${filename}`, {
        headers: { ...authHeaders(), 'X-Request-Id': 'pc013-send-failure' },
      });
      assert.equal(response.status, 500);
      assert.equal((await response.json()).requestId, 'pc013-send-failure');
    });

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].accion, 'DESCARGAR_BACKUP');
    assert.equal(auditEvents[0].resultado, 'FALLIDO');
    assert.match(auditEvents[0].detalle, /requestId=pc013-send-failure/);
    assert.match(auditEvents[0].detalle, /errorCode=EPIPE/);

    express.response.download = originalDownload;
    auditEvents.length = 0;

    await withServer(createBackupsApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/backups/download/db/${filename}`, {
        headers: { ...authHeaders(), 'X-Request-Id': 'pc013-send-success' },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'backup de prueba PC-013');
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].accion, 'DESCARGAR_BACKUP');
    assert.equal(auditEvents[0].resultado, 'EXITO');
    assert.match(auditEvents[0].detalle, /requestId=pc013-send-success/);
    assert.doesNotMatch(auditEvents[0].detalle, /errorCode=/);

    auditEvents.length = 0;
    await withServer(createBackupsApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/backups/download/db/inexistente.sql.enc`, {
        headers: { ...authHeaders(), 'X-Request-Id': 'pc013-not-found' },
      });
      assert.equal(response.status, 404);
    });

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].accion, 'DESCARGAR_BACKUP');
    assert.equal(auditEvents[0].resultado, 'FALLIDO');
    assert.match(auditEvents[0].detalle, /requestId=pc013-not-found/);
    assert.match(auditEvents[0].detalle, /errorCode=BACKUP_NOT_FOUND/);
  } finally {
    express.response.download = originalDownload;
    auditService.log = originalAuditLog;
    fs.rmSync(TEST_BACKUPS_ROOT, { recursive: true, force: true });
  }
});
