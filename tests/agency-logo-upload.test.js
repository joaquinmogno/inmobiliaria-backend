const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENCY_LOGO_MAX_FILE_SIZE_MB,
  isAllowedAgencyLogoFile,
} = require('../dist/middlewares/upload.middleware.js');

test('agency logos accept only supported image MIME types and use a seven megabyte limit', () => {
  assert.equal(AGENCY_LOGO_MAX_FILE_SIZE_MB, 7);
  assert.equal(isAllowedAgencyLogoFile('marca.JPG', 'image/jpeg'), true);
  assert.equal(isAllowedAgencyLogoFile('marca.png', 'image/png'), true);
  assert.equal(isAllowedAgencyLogoFile('marca.webp', 'image/webp'), true);
  assert.equal(isAllowedAgencyLogoFile('marca.svg', 'image/svg+xml'), false);
  assert.equal(isAllowedAgencyLogoFile('marca.pdf', 'application/pdf'), false);
  assert.equal(isAllowedAgencyLogoFile('marca.jpg', 'application/pdf'), false);
});
