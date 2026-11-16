const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, financialError } = require('../dist/services/financial-operation.service');
const { assertBackupClientVersion } = require('../dist/services/backup-compatibility.service');

test('financial operation identity is independent of JSON property order, preserves arrays and amounts', () => {
  assert.equal(canonicalJson({ monto: 10000.50, cuotas: [{ cuotaId: 3, monto: 0.01 }], unused: undefined }), canonicalJson({ cuotas: [{ monto: 0.01, cuotaId: 3 }], monto: 10000.50 }));
  assert.notEqual(canonicalJson({ monto: 10000.50 }), canonicalJson({ monto: 10000.51 }));
});

test('serialization and deadlock errors become safe 409 responses; unknown driver errors are not exposed', () => {
  for (const error of [{ code: 'P2034' }, { code: '40P01' }, { code: 'P2010', meta: { code: '40P01' } }, { code: '40001' }]) {
    const result = financialError({ ...error, message: 'prisma secret query database password' });
    assert.equal(result.statusCode, 409); assert.equal(result.code, 'TRANSACTION_CONFLICT');
    assert.doesNotMatch(result.message, /prisma|secret|query|password/);
  }
  assert.equal(financialError({ name: 'PrismaClientUnknownRequestError', message: 'ConnectorError(PostgresError { code: "40P01", message: "deadlock detected" })' }).statusCode, 409);
  assert.equal(financialError(new Error('internal query')).statusCode, 500);
  const business = { statusCode: 409, code: 'PAYMENT_EXCEEDS_DEBT', message: 'Saldo insuficiente' };
  assert.equal(financialError(business), business);
});

test('backup must use a matching PostgreSQL major version; minor security updates are allowed', () => {
  assert.doesNotThrow(() => assertBackupClientVersion('pg_dump (PostgreSQL) 16.16', '160010'));
  for (const version of ['pg_dump (PostgreSQL) 18.6', 'pg_dump (PostgreSQL) 15.9', 'unknown']) {
    assert.throws(() => assertBackupClientVersion(version, '160010'), { code: 'BACKUP_CLIENT_VERSION_MISMATCH', statusCode: 503 });
  }
});
