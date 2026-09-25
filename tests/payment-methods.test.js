const test = require('node:test');
const assert = require('node:assert/strict');

const { paymentMethodSchema } = require('../dist/middlewares/validation.middleware');

test('only cash, transfer and cheque are accepted as payment methods', () => {
  for (const method of ['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE']) {
    assert.equal(paymentMethodSchema.safeParse(method).success, true);
  }

  for (const method of ['DEPOSITO', 'OTROS']) {
    assert.equal(paymentMethodSchema.safeParse(method).success, false);
  }
});
