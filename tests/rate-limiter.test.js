process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-rate-limiter-suite';
process.env.BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || 'test-backup-encryption-key-with-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getApiRateLimitKey,
  getLoginThrottleKey,
  loginBackoffSeconds,
} = require('../dist/middlewares/rateLimiter.middleware');

function request({ ip = '192.0.2.10', email, session, userId, sessionId } = {}) {
  return {
    ip,
    socket: { remoteAddress: ip },
    body: email === undefined ? {} : { email },
    cookies: session === undefined ? {} : { pc_session: session },
    ...(userId && sessionId ? { user: { id: userId }, sessionId } : {}),
  };
}

test('login throttle isolates accounts sharing the same office IP and hides identifiers', () => {
  const first = getLoginThrottleKey(request({ email: ' Usuario@Example.com ' }));
  const normalized = getLoginThrottleKey(request({ email: 'usuario@example.com' }));
  const otherAccount = getLoginThrottleKey(request({ email: 'otra@example.com' }));

  assert.equal(first, normalized);
  assert.notEqual(first, otherAccount);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes('usuario'), false);
  assert.equal(first.includes('192.0.2.10'), false);
});

test('authenticated API quotas are isolated by session instead of office IP', () => {
  const firstSession = getApiRateLimitKey(request({ session: 'session-one', userId: 7, sessionId: 10 }));
  const secondSession = getApiRateLimitKey(request({ session: 'session-two', userId: 7, sessionId: 11 }));
  const sameSessionElsewhere = getApiRateLimitKey(request({ ip: '192.0.2.99', session: 'other-token', userId: 7, sessionId: 10 }));

  assert.notEqual(firstSession, secondSession);
  assert.equal(firstSession, sameSessionElsewhere);
  assert.equal(firstSession, 'user:7:session:10');
});

test('login failures use bounded exponential backoff', () => {
  assert.deepEqual(
    [1, 4, 5, 6, 7, 8, 9, 10, 20].map(loginBackoffSeconds),
    [0, 0, 30, 60, 120, 240, 480, 900, 900]
  );
});
