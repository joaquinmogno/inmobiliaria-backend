const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { prisma } = require('../dist/prisma');

const apiBase = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:3100/api';
const password = 'PC020!Password_Segura_2026';
const targetEmail = 'pc020-target@example.test';
const coworkerEmail = 'pc020-coworker@example.test';
let roleId;
let userIds = [];

async function login(email, submittedPassword) {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: submittedPassword })
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const role = await prisma.rol.create({
    data: { nombre: `PC020 ${Date.now()}`, inmobiliariaId: agency.id }
  });
  roleId = role.id;
  const passwordHash = await bcrypt.hash(password, 10);
  const users = await Promise.all([targetEmail, coworkerEmail].map((email, index) => prisma.usuario.create({
    data: {
      email,
      password: passwordHash,
      nombreCompleto: `Usuario PC020 ${index + 1}`,
      tipo: 'USUARIO',
      rolId: role.id,
      inmobiliariaId: agency.id
    }
  })));
  userIds = users.map(user => user.id);
});

test.after(async () => {
  await prisma.loginThrottle.deleteMany();
  if (userIds.length) await prisma.usuario.deleteMany({ where: { id: { in: userIds } } });
  if (roleId) await prisma.rol.deleteMany({ where: { id: roleId } });
  await prisma.$disconnect();
});

test('failed logins block only the targeted account and recover after clearing the bucket', async () => {
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal((await login(targetEmail, 'Contraseña!Incorrecta')).response.status, 401);
  }

  const blockedFailure = await login(targetEmail, 'Contraseña!Incorrecta');
  assert.equal(blockedFailure.response.status, 429);
  assert.equal(blockedFailure.body.code, 'LOGIN_BACKOFF');
  assert.ok(blockedFailure.body.retryAfterSeconds >= 29);
  assert.ok(Number(blockedFailure.response.headers.get('retry-after')) >= 29);

  const targetedCorrectLogin = await login(targetEmail, password);
  assert.equal(targetedCorrectLogin.response.status, 429);

  const coworkerLogin = await login(coworkerEmail, password);
  assert.equal(coworkerLogin.response.status, 200);

  const storedBuckets = await prisma.loginThrottle.findMany();
  assert.equal(storedBuckets.length, 1);
  assert.equal(storedBuckets[0].failureCount, 5);
  assert.match(storedBuckets[0].key, /^[a-f0-9]{64}$/);
  assert.equal(storedBuckets[0].key.includes(targetEmail), false);

  await prisma.loginThrottle.deleteMany();
  const recoveredLogin = await login(targetEmail, password);
  assert.equal(recoveredLogin.response.status, 200);
});
