const test = require('node:test');
const assert = require('node:assert/strict');

const { optionalDni } = require('../dist/middlewares/validation.middleware');
const { normalizePersonDni } = require('../dist/utils/person-dni');

test('DNI and CUIT are stored in a canonical comparable format', () => {
  assert.equal(normalizePersonDni(' 12.345.678 '), '12345678');
  assert.equal(normalizePersonDni('20-12345678-3'), '20123456783');
  assert.equal(normalizePersonDni(' ar 12-345 '), 'AR12345');

  assert.equal(optionalDni().parse(' 12.345.678 '), '12345678');
  assert.equal(optionalDni().parse(''), undefined);
  assert.equal(optionalDni().safeParse('... ---').success, false);
});
