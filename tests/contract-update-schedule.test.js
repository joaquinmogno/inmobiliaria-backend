const test = require('node:test');
const assert = require('node:assert/strict');
const { addContractMonths, nextContractUpdateDate } = require('../dist/utils/contract-update-schedule');

test('la frecuencia mantiene el calendario pactado aunque se cargue tarde', () => {
  const scheduled = new Date('2026-04-15T00:00:00.000Z');
  assert.equal(nextContractUpdateDate(scheduled, 3, new Date('2026-04-01')).toISOString().slice(0, 10), '2026-07-15');
  assert.equal(nextContractUpdateDate(scheduled, 3, new Date('2026-08-01')).toISOString().slice(0, 10), '2026-10-15');
});

test('las fechas de fin de mes no se desbordan ni pierden el día original', () => {
  const scheduled = new Date('2026-01-31T00:00:00.000Z');
  assert.equal(addContractMonths(scheduled, 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(nextContractUpdateDate(scheduled, 1, new Date('2026-02-01')).toISOString().slice(0, 10), '2026-03-31');
});
