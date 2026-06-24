process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-permissions-api-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const permissionsService = require('../dist/services/permissions.service');
const { authenticateToken } = require('../dist/middlewares/auth.middleware');
const { requirePermission } = require('../dist/middlewares/permissions.middleware');

function createToken() {
  return jwt.sign(
    {
      id: 9001,
      email: 'permisos.test@inmobiliaria.local',
      role: 'SUPERADMIN',
      inmobiliariaId: 1,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
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
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async () => false;

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sueldos`, {
      headers: { Authorization: `Bearer ${createToken()}` },
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).message, 'No tiene permisos para realizar esta acción');
  });

  permissionsService.userHasPermission = original;
});

test('HTTP permissions: user with sueldos.ver can access endpoint', async () => {
  const original = permissionsService.userHasPermission;
  permissionsService.userHasPermission = async (_userId, _role, permission) => permission === 'sueldos.ver';

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sueldos`, {
      headers: { Authorization: `Bearer ${createToken()}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 1, concepto: 'Sueldo de prueba' }]);
  });

  permissionsService.userHasPermission = original;
});

test('HTTP permissions: explicit denial overrides inherited role permission', async () => {
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
      headers: { Authorization: `Bearer ${createToken()}` },
    });

    assert.equal(response.status, 403);
  });

  permissionsService.userHasPermission = original;
});

test('HTTP auth/me returns refreshed permissions on each request', async () => {
  const original = permissionsService.getUserPermissions;
  let permissions = ['contratos.ver'];
  permissionsService.getUserPermissions = async () => permissions;

  await withServer(createPermissionsApp(), async (baseUrl) => {
    const headers = { Authorization: `Bearer ${createToken()}` };

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
