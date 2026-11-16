// Match the public API contract: a fresh key for each intentional financial
// operation. Retry tests explicitly provide the SAME key across requests.
const { randomUUID } = require('node:crypto');
const rawFetch = global.fetch;
global.fetch = (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || 'GET').toUpperCase();
  if ((url.pathname === '/api/pagos' && method === 'POST') || (/\/api\/liquidaciones\/\d+\/pagar-propietario$/.test(url.pathname) && method === 'PATCH')) {
    const headers = new Headers(init.headers);
    if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', randomUUID());
    init = { ...init, headers };
  }
  return rawFetch(input, init);
};
module.exports = { rawFetch };
