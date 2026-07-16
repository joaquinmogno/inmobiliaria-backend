process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-permissions-api-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const permissionsService = require('../dist/services/permissions.service');
const { prisma } = require('../dist/prisma');
const { authenticateToken } = require('../dist/middlewares/auth.middleware');
const { requirePermission } = require('../dist/middlewares/permissions.middleware');
const { SESSION_COOKIE, CSRF_COOKIE, sha256 } = require('../dist/services/security.service');
const backupsRouter = require('../dist/routes/backups.routes').default;

const SESSION_TOKEN = 'permissions-session-token';
const CSRF_TOKEN = 'permissions-csrf-token';

function installSessionMock(role = 'SUPERADMIN') {
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
        usuario: {
          id: 9001,
          email: 'permisos.test@inmobiliaria.local',
          rol: role,
          inmobiliariaId: 1,
          activo: true,
          mfaEnabled: true,
          mustChangePassword: false,
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
      role: 'SUPERADMIN',
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
    const permissions = await permissionsService.getUserPermissions(req.user.id, req.user.role);
    res.json({
      id: req.user.id,
      role: req.user.role,
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

test('HTTP permissions: explicit denial overrides inherited role permission', async () => {
  installSessionMock();
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async (_userId, _role, permission) => {
    const effective = permissionsService.resolveEffectivePermissions(
      ['sueldos.ver'],
      [],
      ['sueldos.ver']
    );
    return effective.includes(permission);
  };

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

test('HTTP backups: ADMIN access is controlled by the specific view permission', async () => {
  installSessionMock('ADMIN');
  const original = permissionsService.userHasPermission;
  let allowed = false;
  permissionsService.userHasPermission = async (_userId, role, permission) =>
    role === 'ADMIN' && permission === 'configuracion.backups.ver' && allowed;

  await withServer(createBackupsApp(), async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/backups`, { headers: authHeaders() });
    assert.equal(denied.status, 403);

    allowed = true;
    const permitted = await fetch(`${baseUrl}/api/backups`, { headers: authHeaders() });
    assert.equal(permitted.status, 200);
    assert.ok(Array.isArray(await permitted.json()));
  });

  permissionsService.userHasPermission = original;
});
