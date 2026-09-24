const test = require('node:test');
const assert = require('node:assert/strict');
const { getDashboardPermissionScope } = require('../dist/services/dashboard-cache.service');

const basePermissions = {
  canViewSalaries: false,
  canViewFinancialReports: false,
  canViewContractReports: true,
  canViewDelinquencyReports: true,
  canViewLiquidations: false,
};

test('dashboard cache scope changes when liquidation visibility changes', () => {
  const withoutLiquidations = getDashboardPermissionScope(basePermissions);
  const withLiquidations = getDashboardPermissionScope({ ...basePermissions, canViewLiquidations: true });

  assert.notEqual(withoutLiquidations, withLiquidations);
  assert.match(withLiquidations, /liquidations:1/);
});

test('dashboard cache scope changes for every permission that affects the response', () => {
  const baseline = getDashboardPermissionScope(basePermissions);
  for (const permission of Object.keys(basePermissions)) {
    assert.notEqual(
      baseline,
      getDashboardPermissionScope({ ...basePermissions, [permission]: !basePermissions[permission] }),
      `the scope must change for ${permission}`,
    );
  }
});
