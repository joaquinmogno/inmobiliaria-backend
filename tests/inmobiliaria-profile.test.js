const test = require('node:test');
const assert = require('node:assert/strict');

const { agencyProfileSchema } = require('../dist/validation/inmobiliaria.schemas.js');

const baseProfile = { nombre: 'PropControl Gestión' };

test('an agency can keep only its commercial identity when legal data is not informed', () => {
  const parsed = agencyProfileSchema.safeParse(baseProfile);

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.condicionIva, 'NO_INFORMADO');
});

test('partial fiscal data is rejected to prevent inconsistent invoices', () => {
  const parsed = agencyProfileSchema.safeParse({
    ...baseProfile,
    cuit: '20-12345678-6'
  });

  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error.issues.map(issue => issue.path.join('.')).sort(),
    ['condicionIva', 'razonSocial']
  );
});

test('a complete institutional profile normalizes legal and contact data', () => {
  const parsed = agencyProfileSchema.safeParse({
    ...baseProfile,
    razonSocial: ' PropControl S.R.L. ',
    cuit: '20-12345678-6',
    condicionIva: 'MONOTRIBUTISTA',
    ingresosBrutos: ' 12345678901 ',
    puntoVenta: '7',
    inicioActividades: '2024-01-15',
    email: ' ADMINISTRACION@EXAMPLE.COM ',
    telefono: '+54 9 11 5555 1234',
    logoUrl: 'https://example.com/logo.png'
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.cuit, '20123456786');
  assert.equal(parsed.data.ingresosBrutos, '12345678901');
  assert.equal(parsed.data.puntoVenta, 7);
  assert.equal(parsed.data.email, 'administracion@example.com');
  assert.equal(parsed.data.telefono, '+5491155551234');
});

test('the logo must use an absolute web URL', () => {
  const parsed = agencyProfileSchema.safeParse({ ...baseProfile, logoUrl: 'logo.png' });

  assert.equal(parsed.success, false);
  assert.match(parsed.error.issues[0].message, /URL del logo/i);
});
