process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://integration:integration_password@127.0.0.1:55433/propcontrol_integration?schema=public';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');
const { createUserWithPermissions } = require('../dist/services/users.service');

test('user creation rolls back when permission association fails', async () => {
  const email = `rollback-${Date.now()}@integration.local`;
  const agency = await prisma.inmobiliaria.create({ data: { nombre: `Rollback ${Date.now()}` } });
  const permission = await prisma.permiso.upsert({ where: { clave: 'integration.rollback' }, update: {}, create: { clave: 'integration.rollback', descripcion: 'Integration rollback trigger' } });
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_user_permission_for_rollback() RETURNS trigger AS $$ BEGIN IF EXISTS (SELECT 1 FROM "Usuario" WHERE id = NEW."usuarioId" AND email = '${email}') THEN RAISE EXCEPTION 'forced permission failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS integration_user_permission_failure ON "UsuarioPermiso"');
  await prisma.$executeRawUnsafe('CREATE TRIGGER integration_user_permission_failure BEFORE INSERT ON "UsuarioPermiso" FOR EACH ROW EXECUTE FUNCTION fail_user_permission_for_rollback()');

  try {
    await assert.rejects(() => createUserWithPermissions({ email, hashedPassword: 'not-used-in-login', nombreCompleto: 'Rollback Test', rol: 'AGENTE', inmobiliariaId: agency.id, permissions: [permission.clave], deniedPermissions: [], catalog: [permission] }), /forced permission failure/);
    assert.equal(await prisma.usuario.count({ where: { email } }), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS integration_user_permission_failure ON "UsuarioPermiso"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_user_permission_for_rollback()');
    await prisma.inmobiliaria.delete({ where: { id: agency.id } });
  }
});

test.after(async () => prisma.$disconnect());
