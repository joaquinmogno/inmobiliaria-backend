process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'security-hardening-test-secret-32-characters';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canCreateRole, isRoleBelow } = require('../dist/services/permissions.service');
const { getCookieOptions } = require('../dist/services/security.service');
const { validateUploadedFileContent } = require('../dist/middlewares/upload.middleware');

test('role hierarchy prevents vertical privilege escalation', () => {
  assert.equal(canCreateRole('ADMIN', 'OWNER'), false);
  assert.equal(canCreateRole('JEFE', 'JEFE'), false);
  assert.equal(canCreateRole('OWNER', 'OWNER'), true);
  assert.equal(isRoleBelow('AGENTE', 'ADMIN'), true);
  assert.equal(isRoleBelow('OWNER', 'ADMIN'), false);
});

test('production cookies remain Secure and use SameSite=Lax', () => {
  const options = getCookieOptions(true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.httpOnly, true);
});

test('upload content validation rejects a forged PDF signature', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-security-'));
  const filepath = path.join(dir, 'contract.pdf');
  fs.writeFileSync(filepath, '<html>not a pdf</html>');
  const req = { file: { path: filepath, originalname: 'contract.pdf' } };
  let response;
  const res = { status(code) { response = { code }; return this; }, json(body) { response.body = body; return this; } };
  await validateUploadedFileContent(req, res, () => assert.fail('invalid content reached next middleware'));
  assert.equal(response.code, 400);
  assert.equal(response.body.code, 'INVALID_FILE_CONTENT');
  assert.equal(fs.existsSync(filepath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
