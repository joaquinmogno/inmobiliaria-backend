const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '../../inmobiliaria-frontend/src');

test('the dashboard advance alert reaches the liquidation API with its adelantos filter', () => {
  const alertDefinitions = fs.readFileSync(path.resolve(__dirname, '../src/services/operational-alerts.service.ts'), 'utf8');
  const liquidationClient = fs.readFileSync(path.join(frontendRoot, 'services/liquidaciones.service.ts'), 'utf8');
  const liquidationView = fs.readFileSync(path.join(frontendRoot, 'pages/Liquidaciones.tsx'), 'utf8');

  assert.match(alertDefinitions, /enlace:\s*'\/liquidaciones\?view=HISTORIAL&adelantos=true'/);
  assert.match(liquidationClient, /filters\.adelantos\s*\?\s*\{\s*adelantos:\s*'true'\s*\}/);
  assert.match(liquidationView, /'adelantos'/);
});
