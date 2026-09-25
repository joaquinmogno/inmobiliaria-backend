const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROLE_PERMISSION_CAPABILITIES } = require('../dist/services/permissions.service');

const readTree = (directory, extension) => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const target = path.join(directory, entry.name);
  if (entry.isDirectory()) return readTree(target, extension);
  return entry.name.endsWith(extension) ? [fs.readFileSync(target, 'utf8')] : [];
}).join('\n');

test('each assignable permission is wired to a frontend route/control and backend behavior', () => {
  const repositoryRoot = path.resolve(__dirname, '../..');
  const frontendComponents = readTree(path.join(repositoryRoot, 'inmobiliaria-frontend/src'), '.tsx');
  const appRoutes = fs.readFileSync(path.join(repositoryRoot, 'inmobiliaria-frontend/src/routes/AppRouter.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(repositoryRoot, 'inmobiliaria-frontend/src/layouts/Sidebar.tsx'), 'utf8');
  const backendRoutes = readTree(path.join(repositoryRoot, 'inmobiliaria-backend/src/routes'), '.ts');

  for (const capability of ROLE_PERMISSION_CAPABILITIES) {
    assert.ok(
      appRoutes.includes(capability.route) || sidebar.includes(capability.route),
      `${capability.key} does not have a reachable frontend route (${capability.route})`
    );
    assert.ok(frontendComponents.includes(capability.key), `${capability.key} is not used by a frontend control`);
    assert.ok(backendRoutes.includes(capability.key), `${capability.key} is not enforced by backend behavior`);
  }
});
