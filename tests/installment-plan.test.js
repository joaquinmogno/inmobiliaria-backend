const test = require('node:test');
const assert = require('node:assert/strict');

const { distributeInstallmentAmounts } = require('../dist/services/installment-plan.service');

test('installment distribution assigns the cent remainder to the last installment', () => {
  const amounts = distributeInstallmentAmounts('100.00', 3);

  assert.deepEqual(amounts.map(amount => amount.toFixed(2)), ['33.33', '33.33', '33.34']);
  assert.equal(amounts.reduce((sum, amount) => sum.plus(amount), amounts[0].minus(amounts[0])).toFixed(2), '100.00');
});

test('installment distribution also corrects an accumulated rounding excess', () => {
  const amounts = distributeInstallmentAmounts('10.00', 6);

  assert.deepEqual(amounts.map(amount => amount.toFixed(2)), ['1.66', '1.66', '1.66', '1.66', '1.66', '1.70']);
  assert.equal(amounts.reduce((sum, amount) => sum.plus(amount)).toFixed(2), '10.00');
});
