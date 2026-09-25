const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/prisma');
const { syncContractLifecycle } = require('../dist/services/contract-lifecycle.service');

test('installation has an unrestricted administrator without a role', async () => {
  const admin = await prisma.usuario.findFirst({ where: { tipo: 'ADMIN', activo: true } });
  assert.ok(admin);
  assert.equal(admin.rolId, null);
});

test('a user receives permissions only through one reusable role', async () => {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const permission = await prisma.permiso.findUniqueOrThrow({ where: { clave: 'propiedades.ver' } });
  const role = await prisma.rol.create({
    data: { nombre: 'Integración', inmobiliariaId: agency.id, permisos: { create: { permisoId: permission.id } } }
  });
  const user = await prisma.usuario.create({
    data: { email: 'role.integration@example.com', password: 'unused-hash', nombreCompleto: 'Rol Integración', tipo: 'USUARIO', rolId: role.id, inmobiliariaId: agency.id }
  });
  const loaded = await prisma.usuario.findUniqueOrThrow({ where: { id: user.id }, include: { rol: { include: { permisos: { include: { permiso: true } } } } } });
  assert.equal(loaded.rol.id, role.id);
  assert.deepEqual(loaded.rol.permisos.map(item => item.permiso.clave), ['propiedades.ver']);

  await assert.rejects(() => prisma.rol.update({ where: { id: role.id }, data: { activo: false } }), /rol asignado/i);
});

test('database refuses to disable the last active administrator', async () => {
  const admin = await prisma.usuario.findFirstOrThrow({ where: { tipo: 'ADMIN', activo: true } });
  await assert.rejects(() => prisma.usuario.update({ where: { id: admin.id }, data: { activo: false } }), /administrador activo/i);
});

test('contract lifecycle activates and finalizes contracts while synchronizing the property', async () => {
  const agency = await prisma.inmobiliaria.findFirstOrThrow();
  const property = await prisma.propiedad.create({
    data: {
      direccion: `Ciclo de vida ${Date.now()}`,
      inmobiliariaId: agency.id,
      estado: 'DISPONIBLE'
    }
  });
  const contract = await prisma.contrato.create({
    data: {
      fechaInicio: new Date('2030-02-01T00:00:00.000Z'),
      fechaFin: new Date('2030-02-28T00:00:00.000Z'),
      estado: 'PROGRAMADO',
      montoAlquiler: 1000,
      montoHonorarios: 0,
      propiedadId: property.id,
      inmobiliariaId: agency.id,
      requiereActualizacion: false
    }
  });

  const activated = await syncContractLifecycle(agency.id, new Date('2030-02-10T12:00:00.000Z'));
  assert.equal(activated.activated, 1);
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'ACTIVO');
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).estado, 'ALQUILADO');

  const finalized = await syncContractLifecycle(agency.id, new Date('2030-03-01T12:00:00.000Z'));
  assert.equal(finalized.finalized, 1);
  assert.equal((await prisma.contrato.findUniqueOrThrow({ where: { id: contract.id } })).estado, 'FINALIZADO');
  assert.equal((await prisma.propiedad.findUniqueOrThrow({ where: { id: property.id } })).estado, 'DISPONIBLE');
});

test.after(async () => prisma.$disconnect());
