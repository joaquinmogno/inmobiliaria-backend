const test = require('node:test');
const assert = require('node:assert/strict');

const { getPersonIdentity } = require('../dist/utils/person-identity.js');
const { contractCreateSchema } = require('../dist/validation/contratos.schemas.js');
const { isValidBankAlias, isValidCbu, isValidCuit, normalizeBankAlias, normalizeCbu } = require('../dist/utils/bank-account.js');

const contractBase = {
  fechaInicio: '2030-01-01',
  fechaFin: '2030-12-31',
  fechaActualizacion: '2030-04-01',
  propiedadId: 1,
  montoAlquiler: 100000,
  montoHonorarios: 0,
  requiereActualizacion: true
};

test('person identity comparison normalizes CUIT, email and phone independently of formatting', () => {
  assert.deepEqual(
    getPersonIdentity({
      dni: '12.345.678',
      cuit: '20-12345678-6',
      email: ' Persona@Example.COM ',
      telefono: '+54 9 11 5555-1234'
    }),
    {
      dni: '12345678',
      cuitNormalizado: '20123456786',
      emailNormalizado: 'persona@example.com',
      telefonoNormalizado: '5491155551234'
    }
  );
});

test('a contract cannot repeat an existing person or assign it both roles', () => {
  const duplicateOwner = contractCreateSchema.safeParse({
    ...contractBase,
    propietarios: [{ id: 10 }],
    inquilinos: [{ id: 10 }]
  });
  assert.equal(duplicateOwner.success, false);
  assert.match(duplicateOwner.error.issues.map(issue => issue.message).join(' '), /propietario e inquilino/);

  const repeatedTenant = contractCreateSchema.safeParse({
    ...contractBase,
    propietarios: [{ id: 11 }],
    inquilinos: [{ id: 12 }, { id: 12 }]
  });
  assert.equal(repeatedTenant.success, false);
  assert.match(repeatedTenant.error.issues.map(issue => issue.message).join(' '), /repetir una persona entre los inquilinos/);
});

test('bank account fields require valid Argentine identifiers and normalize aliases', () => {
  // 12345674 + 1234567890123 + 3: both CBU verifier digits are valid.
  assert.equal(isValidCbu('12345674-1234567890123-3'), true);
  assert.equal(isValidCbu('1234567412345678901234'), false);
  assert.equal(normalizeCbu('1234-5674 1234 5678 9012 33'), '1234567412345678901233');
  assert.equal(isValidCuit('20-12345678-6'), true);
  assert.equal(isValidCuit('20-12345678-5'), false);
  assert.equal(isValidBankAlias('Casa.Renta_01'), true);
  assert.equal(normalizeBankAlias('casa.renta_01'), 'CASA.RENTA_01');
  assert.equal(isValidBankAlias('alias..invalido'), false);
});
