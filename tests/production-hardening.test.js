process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-hardening-suite';
process.env.BACKUP_ENCRYPTION_KEY = 'test-backup-encryption-key-with-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { encryptFile, decryptFileToFile } = require('../dist/services/security.service');
const { parsePagination } = require('../dist/utils/pagination');
const { prisma } = require('../dist/prisma');
const app = require('../dist/app').default;

async function withServer(run) {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('backup encryption streams preserve the PCBK1 format and contents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propcontrol-backup-'));
  const source = path.join(directory, 'source.bin');
  const encrypted = path.join(directory, 'source.enc');
  const restored = path.join(directory, 'restored.bin');
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x5a);

  try {
    await fs.writeFile(source, payload);
    await encryptFile(source, encrypted);
    const header = await fs.readFile(encrypted);
    assert.equal(header.subarray(0, 5).toString(), 'PCBK1');

    await decryptFileToFile(encrypted, restored);
    assert.deepEqual(await fs.readFile(restored), payload);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('tampered encrypted backups are rejected and leave no plaintext file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propcontrol-tampered-'));
  const source = path.join(directory, 'source.txt');
  const encrypted = path.join(directory, 'source.enc');
  const restored = path.join(directory, 'restored.txt');

  try {
    await fs.writeFile(source, 'contenido sensible');
    await encryptFile(source, encrypted);
    const payload = await fs.readFile(encrypted);
    payload[payload.length - 1] ^= 1;
    await fs.writeFile(encrypted, payload);

    await assert.rejects(() => decryptFileToFile(encrypted, restored));
    await assert.rejects(() => fs.access(restored));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('pagination rejects invalid values and caps page size', () => {
  assert.deepEqual(parsePagination('-5', '999'), { page: 1, limit: 100, skip: 0 });
  assert.deepEqual(parsePagination('3', '25'), { page: 3, limit: 25, skip: 50 });
  assert.deepEqual(parsePagination('abc', 'abc'), { page: 1, limit: 25, skip: 0 });
});

test('liveness is independent and readiness reflects database availability', async () => {
  const originalQueryRaw = prisma.$queryRaw;
  try {
    await withServer(async baseUrl => {
      prisma.$queryRaw = async () => [{ '?column?': 1 }];
      assert.equal((await fetch(`${baseUrl}/health/live`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);

      prisma.$queryRaw = async () => { throw new Error('database unavailable'); };
      const unavailable = await fetch(`${baseUrl}/health/ready`);
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).database, 'unavailable');
    });
  } finally {
    prisma.$queryRaw = originalQueryRaw;
  }
});
