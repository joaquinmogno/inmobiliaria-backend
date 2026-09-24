process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');

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
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'El archivo supera el límite máximo de 30 MB', code: 'FILE_TOO_LARGE' });
    }
    res.status(400).json({ message: err.message, code: err.code });
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

async function uploadFile(baseUrl, route, field, filename, type, contents = 'test file') {
  const formData = new FormData();
  formData.append(field, new Blob([contents], { type }), filename);

  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    body: formData,
  });

  const body = await response.json();
  return { status: response.status, body };
}

const temporaryFiles = () => fs.readdirSync(path.join(uploadRoot, '.tmp')).sort();

async function abortUpload(baseUrl) {
  const target = new URL(baseUrl);
  const boundary = `----propcontrol-abort-${Date.now()}`;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Multer procesa el evento aborted de forma asíncrona y debe borrar el
      // archivo temporal que pudo haber alcanzado a crear.
      setTimeout(resolve, 150);
    };
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/attachment',
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' }
    });
    request.once('error', finish);
    request.once('close', finish);
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="archivo"; filename="corte.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`);
    request.write(Buffer.alloc(256 * 1024, 0x61));
    setTimeout(() => request.destroy(), 15);
    setTimeout(() => {
      if (!settled) {
        request.destroy();
        finish();
      }
    }, 1_000);
  });
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

test('rejects oversized and aborted uploads without leaving temporary files', async () => {
  await withServer(async (baseUrl) => {
    const beforeOversized = temporaryFiles();
    const oversized = await uploadFile(
      baseUrl,
      '/attachment',
      'archivo',
      'demasiado-grande.pdf',
      'application/pdf',
      new Uint8Array((30 * 1024 * 1024) + 1)
    );
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'FILE_TOO_LARGE');
    assert.deepEqual(temporaryFiles(), beforeOversized);

    const beforeAbort = temporaryFiles();
    await abortUpload(baseUrl);
    assert.deepEqual(temporaryFiles(), beforeAbort);
  });
});
