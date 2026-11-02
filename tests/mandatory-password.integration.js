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

test('mandatory password changes use recent login; later changes still require the current password', async () => {
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
  let cookies = readCookies(login);
  let csrfToken = loginBody.csrfToken;
  const change = (body, headers = { Cookie: cookies, 'X-CSRF-Token': csrfToken }) => fetch(`${API_URL}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

  const unauthenticated = await change({ newPassword: personalPassword }, {});
  assert.equal(unauthenticated.status, 401);
  const missingCsrf = await change({ newPassword: personalPassword }, { Cookie: cookies });
  assert.equal(missingCsrf.status, 403);

  const blockedNavigation = await fetch(`${API_URL}/propiedades`, { headers: { Cookie: cookies } });
  assert.equal(blockedNavigation.status, 403);
  assert.equal((await blockedNavigation.json()).code, 'PASSWORD_CHANGE_REQUIRED');

  const reusedPassword = await change({ newPassword: temporaryPassword });
  assert.equal(reusedPassword.status, 400);
  assert.match((await reusedPassword.json()).message, /debe ser diferente/i);
  assert.equal((await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword, true);

  const weakPassword = await change({ newPassword: 'abcdefghijklmnop' });
  assert.equal(weakPassword.status, 400);
  assert.match((await weakPassword.json()).message, /política de seguridad/i);

  await prisma.userSession.updateMany({
    where: { usuarioId: user.id, revokedAt: null },
    data: { authenticatedAt: new Date(Date.now() - 16 * 60 * 1000) }
  });
  const staleLogin = await change({ newPassword: personalPassword });
  assert.equal(staleLogin.status, 401);
  assert.equal((await staleLogin.json()).code, 'RECENT_LOGIN_REQUIRED');
  const unchangedUser = await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(unchangedUser.mustChangePassword, true);
  assert.equal(unchangedUser.password, user.password);

  const freshLogin = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: temporaryPassword })
  });
  assert.equal(freshLogin.status, 200);
  cookies = readCookies(freshLogin);
  csrfToken = (await freshLogin.json()).csrfToken;

  const changePassword = await change({ newPassword: personalPassword });
  assert.equal(changePassword.status, 200);
  const updatedUser = await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updatedUser.mustChangePassword, false);
  assert.equal(updatedUser.sessionVersion, 1);
  assert.ok(await bcrypt.compare(personalPassword, updatedUser.password));
  const revokedSession = await fetch(`${API_URL}/auth/me`, { headers: { Cookie: cookies } });
  assert.equal(revokedSession.status, 401);
  assert.equal(await prisma.userSession.count({ where: { usuarioId: user.id, revokedAt: null } }), 0);

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
  const personalLoginBody = await newPasswordLogin.json();
  assert.equal(personalLoginBody.user.mustChangePassword, false);
  cookies = readCookies(newPasswordLogin);
  csrfToken = personalLoginBody.csrfToken;
  const nextPassword = 'OtraClave!2026_Segura';

  const missingCurrent = await change({ newPassword: nextPassword });
  assert.equal(missingCurrent.status, 400);
  assert.match((await missingCurrent.json()).message, /contraseña actual es requerida/i);
  const forgedMandatoryChange = await change({ newPassword: nextPassword, mustChangePassword: true });
  assert.equal(forgedMandatoryChange.status, 400);
  const wrongCurrent = await change({ currentPassword: temporaryPassword, newPassword: nextPassword });
  assert.equal(wrongCurrent.status, 400);
  assert.match((await wrongCurrent.json()).message, /contraseña actual incorrecta/i);
  const reusedPersonal = await change({ currentPassword: personalPassword, newPassword: personalPassword });
  assert.equal(reusedPersonal.status, 400);
  assert.match((await reusedPersonal.json()).message, /debe ser diferente/i);

  await prisma.userSession.updateMany({
    where: { usuarioId: user.id, revokedAt: null },
    data: { authenticatedAt: new Date(Date.now() - 16 * 60 * 1000) }
  });
  const regularChange = await change({ currentPassword: personalPassword, newPassword: nextPassword });
  assert.equal(regularChange.status, 200);
  const finalUser = await prisma.usuario.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(await bcrypt.compare(nextPassword, finalUser.password));
  assert.equal(finalUser.mustChangePassword, false);
  assert.equal(finalUser.sessionVersion, 2);
});

test.after(async () => prisma.$disconnect());
