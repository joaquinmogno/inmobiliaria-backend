const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODULE_PERMISSIONS,
  SUELDOS_PERMISSIONS,
  resolveEffectivePermissions,
  isAdminRole,
} = require('../dist/services/permissions.service');

test('manual denials override inherited and direct permissions', () => {
  const effective = resolveEffectivePermissions(
    ['sueldos.ver', 'sueldos.eliminar'],
    ['sueldos.crear'],
    ['sueldos.eliminar']
  );

  assert.deepEqual(effective.sort(), ['sueldos.crear', 'sueldos.ver'].sort());
});

test('direct permissions are additive when not denied', () => {
  const effective = resolveEffectivePermissions(
    ['contratos.ver'],
    ['contratos.crear', 'contratos.editar'],
    []
  );

  assert.deepEqual(effective.sort(), ['contratos.crear', 'contratos.editar', 'contratos.ver'].sort());
});

test('salary permissions are present in the module catalog', () => {
  for (const permission of SUELDOS_PERMISSIONS) {
    assert.ok(MODULE_PERMISSIONS.includes(permission), `${permission} should be in MODULE_PERMISSIONS`);
  }
});

test('module catalog contains requested access domains', () => {
  const requiredPrefixes = [
    'contratos',
    'caja_chica',
    'liquidaciones',
    'pagos',
    'propiedades',
    'personas',
    'configuracion',
    'reportes',
    'sueldos',
  ];

  for (const prefix of requiredPrefixes) {
    assert.ok(
      MODULE_PERMISSIONS.some((permission) => permission.startsWith(`${prefix}.`)),
      `${prefix} permissions should exist`
    );
  }
});

test('admin role helper includes owner and jefe roles', () => {
  assert.equal(isAdminRole('OWNER'), true);
  assert.equal(isAdminRole('JEFE'), true);
  assert.equal(isAdminRole('ADMIN'), true);
  assert.equal(isAdminRole('AGENTE'), false);
});
