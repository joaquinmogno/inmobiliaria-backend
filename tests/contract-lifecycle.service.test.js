const test = require('node:test');
const assert = require('node:assert/strict');

const { getContractStateForDates } = require('../dist/services/contract-lifecycle.service');
const { parseDateOnly } = require('../dist/utils/argentina-date');

test('a contract is finalized automatically only after its contractual end date', () => {
  const today = new Date('2026-09-24T15:00:00.000Z');

  assert.equal(
    getContractStateForDates(parseDateOnly('2026-01-01'), parseDateOnly('2026-09-24'), today),
    'ACTIVO'
  );
  assert.equal(
    getContractStateForDates(parseDateOnly('2026-01-01'), parseDateOnly('2026-09-23'), today),
    'FINALIZADO'
  );
  assert.equal(
    getContractStateForDates(parseDateOnly('2026-10-01'), parseDateOnly('2027-09-30'), today),
    'PROGRAMADO'
  );
});
