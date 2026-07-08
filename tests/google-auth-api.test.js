process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-google-auth-api-suite';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'google-client-test.apps.googleusercontent.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const { prisma } = require('../dist/prisma');
const { auditService } = require('../dist/services/audit.service');
const googleAuthService = require('../dist/services/google-auth.service');
const authRoutes = require('../dist/routes/auth.routes').default;

const baseUser = {
  id: 1001,
  email: 'admin@propcontrol.test',
  password: 'hashed-password',
  googleId: null,
  authProvider: 'LOCAL',
  nombreCompleto: 'Admin PropControl',
  rol: 'ADMIN',
  activo: true,
  sessionVersion: 0,
  mustChangePassword: false,
  inmobiliariaId: 55,
  inmobiliaria: { id: 55, nombre: 'PropControl Test', activa: true },
};

let usersByEmail;
let updates;
let sessions;

function installMocks(user = null) {
  usersByEmail = user ? new Map([[user.email, { ...user }]]) : new Map();
  updates = [];
  sessions = [];

  googleAuthService.verifyGoogleIdToken = async () => ({
    googleId: 'google-sub-123',
    email: 'admin@propcontrol.test',
  });

  prisma.usuario = {
    findUnique: async ({ where }) => {
      if (where.email) return usersByEmail.get(where.email) || null;
      if (where.id) return Array.from(usersByEmail.values()).find((item) => item.id === where.id) || null;
      return null;
    },
    update: async ({ where, data }) => {
      const userToUpdate = Array.from(usersByEmail.values()).find((item) => item.id === where.id);
      Object.assign(userToUpdate, data);
      updates.push({ where, data });
      return userToUpdate;
    },
  };

  prisma.userSession = {
    create: async ({ data }) => {
      sessions.push(data);
      return { id: sessions.length, ...data };
    },
  };

  prisma.rolPermiso = { findMany: async () => [] };
  prisma.usuarioPermiso = { findMany: async () => [] };
  prisma.usuarioPermisoDenegado = { findMany: async () => [] };

  auditService.log = async () => ({ id: 1 });
}

async function withServer(run) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function googleLogin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'valid-google-token' }),
  });

  const body = await response.json();
  return { response, body };
}

test('Google login rejects valid Google accounts without a local user', async () => {
  installMocks(null);

  await withServer(async (baseUrl) => {
    const { response, body } = await googleLogin(baseUrl);

    assert.equal(response.status, 403);
    assert.equal(body.message, 'No existe una cuenta autorizada para este correo. Comuníquese con el administrador.');
    assert.equal(updates.length, 0);
    assert.equal(sessions.length, 0);
  });
});

test('Google login links an existing local user and creates the normal session', async () => {
  installMocks(baseUser);

  await withServer(async (baseUrl) => {
    const { response, body } = await googleLogin(baseUrl);

    assert.equal(response.status, 200);
    assert.equal(body.user.email, baseUser.email);
    assert.equal(body.user.id, baseUser.id);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].data, {
      googleId: 'google-sub-123',
      authProvider: 'LOCAL_GOOGLE',
    });
    assert.equal(sessions.length, 1);
    assert.match(response.headers.get('set-cookie') || '', /pc_session=/);
  });
});

test('Google login rejects an existing user linked to another Google account', async () => {
  installMocks({ ...baseUser, googleId: 'another-google-sub', authProvider: 'LOCAL_GOOGLE' });

  await withServer(async (baseUrl) => {
    const { response, body } = await googleLogin(baseUrl);

    assert.equal(response.status, 403);
    assert.equal(body.message, 'La cuenta de Google no coincide con el usuario autorizado.');
    assert.equal(updates.length, 0);
    assert.equal(sessions.length, 0);
  });
});
