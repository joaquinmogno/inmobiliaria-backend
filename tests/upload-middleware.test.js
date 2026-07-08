process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propcontrol-uploads-'));
process.env.UPLOAD_DIR = uploadRoot;

const { upload } = require('../dist/middlewares/upload.middleware');

function createApp() {
  const app = express();

  app.use((req, _res, next) => {
    req.user = { inmobiliariaId: 1 };
    next();
  });

  app.post('/main-contract', upload.single('pdf'), (req, res) => {
    res.status(201).json({ filename: req.file.filename, mimetype: req.file.mimetype });
  });

  app.post('/attachment', upload.single('archivo'), (req, res) => {
    res.status(201).json({ filename: req.file.filename, mimetype: req.file.mimetype });
  });

  app.use((err, _req, res, _next) => {
    res.status(400).json({ message: err.message });
  });

  return app;
}

async function withServer(run) {
  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, () => resolve(instance));
  });

  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function uploadFile(baseUrl, route, field, filename, type) {
  const formData = new FormData();
  formData.append(field, new Blob(['test file'], { type }), filename);

  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    body: formData,
  });

  const body = await response.json();
  return { status: response.status, body };
}

test.after(() => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

test('allows Word files as main contract and attachments', async () => {
  await withServer(async (baseUrl) => {
    const mainDoc = await uploadFile(baseUrl, '/main-contract', 'pdf', 'contrato.doc', 'application/msword');
    assert.equal(mainDoc.status, 201);
    assert.equal(mainDoc.body.mimetype, 'application/msword');
    assert.match(mainDoc.body.filename, /\.doc$/);

    const attachmentDocx = await uploadFile(
      baseUrl,
      '/attachment',
      'archivo',
      'anexo.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    assert.equal(attachmentDocx.status, 201);
    assert.equal(attachmentDocx.body.mimetype, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.match(attachmentDocx.body.filename, /\.docx$/);
  });
});

test('rejects mismatched extensions and invalid main contract formats', async () => {
  await withServer(async (baseUrl) => {
    const mismatched = await uploadFile(baseUrl, '/attachment', 'archivo', 'anexo.docx', 'application/pdf');
    assert.equal(mismatched.status, 400);
    assert.match(mismatched.body.message, /Tipo de archivo no permitido/);

    const imageAsMainContract = await uploadFile(baseUrl, '/main-contract', 'pdf', 'contrato.png', 'image/png');
    assert.equal(imageAsMainContract.status, 400);
    assert.match(imageAsMainContract.body.message, /contrato principal/);
  });
});
