const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODULE_PERMISSIONS,
  SUELDOS_PERMISSIONS,
  ROLE_ASSIGNABLE_PERMISSIONS,
  ROLE_PERMISSION_CAPABILITIES,
  getMissingPermissionDependencies,
} = require('../dist/services/permissions.service');

test('roles cannot receive administrator-only permissions', () => {
  assert.equal(ROLE_ASSIGNABLE_PERMISSIONS.some(permission => permission.startsWith('usuarios.')), false);
  assert.equal(ROLE_ASSIGNABLE_PERMISSIONS.some(permission => permission.startsWith('configuracion.')), false);
});

test('permission catalog omits operations without a real UI and API capability', () => {
  for (const obsolete of ['pagos.editar', 'caja_chica.editar']) {
    assert.equal(MODULE_PERMISSIONS.includes(obsolete), false);
    assert.equal(ROLE_ASSIGNABLE_PERMISSIONS.includes(obsolete), false);
  }
  assert.ok(ROLE_ASSIGNABLE_PERMISSIONS.includes('pagos.eliminar'));
  assert.ok(ROLE_ASSIGNABLE_PERMISSIONS.includes('caja_chica.eliminar'));
});

test('every assignable capability has route, UI control, API and valid dependencies', () => {
  assert.equal(new Set(MODULE_PERMISSIONS).size, MODULE_PERMISSIONS.length);
  assert.equal(new Set(ROLE_ASSIGNABLE_PERMISSIONS).size, ROLE_ASSIGNABLE_PERMISSIONS.length);
  for (const capability of ROLE_PERMISSION_CAPABILITIES) {
    assert.ok(capability.route.startsWith('/'), `${capability.key} needs a route`);
    assert.ok(capability.control.length > 2, `${capability.key} needs a UI control`);
    assert.ok(capability.api.length > 0, `${capability.key} needs an API operation`);
    for (const dependency of capability.requires) {
      assert.ok(ROLE_ASSIGNABLE_PERMISSIONS.includes(dependency), `${capability.key} has invalid dependency ${dependency}`);
    }
  }
});

test('cross-module and navigation dependencies are explicit', () => {
  assert.deepEqual(getMissingPermissionDependencies(['contratos.restaurar']), [
    { key: 'contratos.restaurar', required: 'contratos.ver' },
  ]);
  assert.deepEqual(getMissingPermissionDependencies(['pagos.ver', 'pagos.crear']), [
    { key: 'pagos.crear', required: 'liquidaciones.ver' },
  ]);
  assert.deepEqual(getMissingPermissionDependencies(['reportes.financieros.ver']), [
    { key: 'reportes.financieros.ver', required: 'reportes.dashboard.ver' },
  ]);
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
