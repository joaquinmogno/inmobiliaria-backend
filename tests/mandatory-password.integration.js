const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');

const API_URL = 'http://127.0.0.1:3100/api';

const readCookies = response => {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map(cookie => cookie.split(';')[0]).join('; ');
};

test('a temporary-password user cannot navigate or reuse it and is enabled after changing it', async () => {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const email = `pc014-${unique}@example.test`;
  const temporaryPassword = 'Temporal!2026_Segura';
  const personalPassword = 'Personal!2026_Segura';
  const role = await prisma.rol.create({
    data: { nombre: `PC014 ${unique}`, inmobiliariaId: agency.id }
  });
  const user = await prisma.usuario.create({
    data: {
      email,
      password: await bcrypt.hash(temporaryPassword, 10),
      nombreCompleto: 'Usuario PC014',
      tipo: 'USUARIO',
      rolId: role.id,
      inmobiliariaId: agency.id,
      mustChangePassword: true
    }
  });

  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: temporaryPassword })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.user.mustChangePassword, true);
  const cookies = readCookies(login);

  const blockedNavigation = await fetch(`${API_URL}/propiedades`, { headers: { Cookie: cookies } });
  assert.equal(blockedNavigation.status, 403);
  assert.equal((await blockedNavigation.json()).code, 'PASSWORD_CHANGE_REQUIRED');

  const reusedPassword = await fetch(`${API_URL}/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies,
      'X-CSRF-Token': loginBody.csrfToken
    },
    body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: temporaryPassword })
  });
  assert.equal(reusedPassword.status, 400);
  assert.match((await reusedPassword.json()).message, /debe ser diferente/i);
  assert.equal((await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword, true);

  const changePassword = await fetch(`${API_URL}/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies,
      'X-CSRF-Token': loginBody.csrfToken
    },
    body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: personalPassword })
  });
  assert.equal(changePassword.status, 200);
  const updatedUser = await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.mustChangePassword, false);
  assert.equal(updatedUser.sessionVersion, 1);

  const oldPasswordLogin = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: temporaryPassword })
  });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: personalPassword })
  });
  assert.equal(newPasswordLogin.status, 200);
  assert.equal((await newPasswordLogin.json()).user.mustChangePassword, false);
});

test.after(async () => prisma.$disconnect());
