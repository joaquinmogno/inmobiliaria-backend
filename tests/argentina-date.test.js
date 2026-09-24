const test = require('node:test');
const assert = require('node:assert/strict');

const {
  argentinaDateOnly,
  argentinaYearMonth,
  argentinaDayRange,
  assertOperationalDateIsNotFuture,
  parseDateOnly
} = require('../dist/utils/argentina-date');

test('Argentina civil date does not jump to the next UTC day after 21:00', () => {
  const utcNextDay = new Date('2026-10-01T01:30:00.000Z');
  assert.equal(argentinaDateOnly(utcNextDay), '2026-09-30');
  assert.equal(argentinaYearMonth(utcNextDay), '2026-09');
});

test('Argentina civil date advances at midnight in Buenos Aires', () => {
  assert.equal(argentinaDateOnly(new Date('2026-09-01T02:59:59.999Z')), '2026-08-31');
  assert.equal(argentinaDateOnly(new Date('2026-09-01T03:00:00.000Z')), '2026-09-01');
});

test('date-only values remain exact and Argentina timestamp filters use local day limits', () => {
  assert.equal(parseDateOnly('2026-09-01').toISOString(), '2026-09-01T00:00:00.000Z');
  const range = argentinaDayRange('2026-09-01');
  assert.equal(range.start.toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-09-02T03:00:00.000Z');
});

test('invalid civil dates are rejected instead of being normalized to another month', () => {
  assert.throws(() => parseDateOnly('2026-02-30'), /inválida/i);
  assert.throws(() => parseDateOnly('01/09/2026'), /YYYY-MM-DD/);
});

test('financial operations cannot use a future Argentine civil date', () => {
  const now = new Date('2026-09-24T15:00:00.000Z');
  assert.doesNotThrow(() => assertOperationalDateIsNotFuture(parseDateOnly('2026-09-24'), 'La fecha de cobro', now));
  assert.throws(
    () => assertOperationalDateIsNotFuture(parseDateOnly('2026-09-25'), 'La fecha de cobro', now),
    error => error.code === 'FUTURE_OPERATION_DATE' && error.statusCode === 422
  );
});
