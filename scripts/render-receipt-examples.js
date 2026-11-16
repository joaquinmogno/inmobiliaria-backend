// Demo artifacts only: no database, no issuance or accounting writes.
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { buildMovementReceiptPdf } = require('../dist/services/movement-receipt-pdf.service');
const { examples } = require('../tests/fixtures/receipt-design');
(async () => {
    const output = path.resolve(process.argv[2] || '../informes/recibo-institucional-2026-11-16');
    mkdirSync(output, { recursive: true });
    // Fictional sample agency mark, deliberately not the application's logo.
    const logo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96" viewBox="0 0 128 96"><path d="M12 45 L64 10 L116 45 M25 38 V83 H103 V38 M52 83 V55 H76 V83" fill="none" stroke="#55418b" stroke-width="5"/><path d="M12 91 H116" stroke="#aaa0bd" stroke-width="2"/></svg>')).png().toBuffer();
    for (const item of examples) {
        const file = path.join(output, `${item.name}.pdf`);
        writeFileSync(file, await buildMovementReceiptPdf({ ...item.snapshot, emisor: { ...item.snapshot.emisor, logo: logo.toString('base64') } }, item.identity));
        execFileSync('pdftoppm', ['-scale-to', '1400', '-png', file, path.join(output, item.name)]);
        writeFileSync(path.join(output, `${item.name}.txt`), execFileSync('pdftotext', ['-layout', file, '-']));
        console.log(file);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
