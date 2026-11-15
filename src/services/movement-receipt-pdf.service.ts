import PDFDocument from 'pdfkit';
import type { ReceiptSnapshot, ReceiptStatus } from './movement-receipt.service';

const dateLabel = (value: string) => value.slice(0, 10).split('-').reverse().join('/');
const amountLabel = (value: string, currency: string) => `${currency === 'USD' ? 'US$' : '$'} ${Number(value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${currency})`;
export function buildMovementReceiptPdf(snapshot: ReceiptSnapshot, identity: { numero: string; version: number; fechaEmision: Date; estado: ReceiptStatus | 'BORRADOR' }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 48, left: 48, right: 48, bottom: 90 }, bufferPages: true, info: { Title: `Recibo ${identity.numero} · v${identity.version}`, Author: snapshot.emisor.nombre } });
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        try {
            const width = doc.page.width - 96;
            const { emisor, datos, movimiento } = snapshot;
            let headerX = 48;
            if (emisor.logo) {
                try { doc.image(Buffer.from(emisor.logo, 'base64'), 48, 48, { fit: [65, 55] }); headerX = 130; } catch { /* Keep the agency's textual identity if its historic image is corrupt. */ }
            }
            doc.fillColor('#312e81').font('Helvetica-Bold').fontSize(17).text(emisor.nombre, headerX, 48, { width: width - (headerX - 48) });
            doc.moveDown(0.35).fillColor('#475569').font('Helvetica').fontSize(9);
            for (const line of [emisor.cuit ? `CUIT ${emisor.cuit}` : '', emisor.direccion, emisor.contacto].filter(Boolean)) doc.text(line!, { width: width - (headerX - 48) });
            doc.y = Math.max(doc.y + 26, 130);
            doc.x = 48;
            doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(23).text('RECIBO DE PAGO');
            doc.moveDown(0.35).fontSize(11).text(identity.estado === 'BORRADOR' ? 'VISTA PREVIA · SIN EMITIR' : `${identity.numero} · Versión ${identity.version}`);
            doc.moveDown(0.5).font('Helvetica').fontSize(10).fillColor('#475569').text(`Fecha del pago: ${dateLabel(movimiento.fecha)}`);
            const issued = identity.fechaEmision.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
            doc.text(`${identity.estado === 'BORRADOR' ? 'Vista previa' : 'Emitido'}: ${issued}`);
            doc.moveDown(1.2);
            const statusText = {
                VIGENTE: '', BORRADOR: 'VISTA PREVIA — SIN EMITIR', ANULADO: 'ANULADO — EL MOVIMIENTO FUE ANULADO',
                REEMPLAZADO: 'REEMPLAZADO — EXISTE UNA VERSIÓN POSTERIOR', DESACTUALIZADO: 'DESACTUALIZADO — EL MOVIMIENTO FUE MODIFICADO'
            }[identity.estado];
            if (statusText) {
                doc.fillColor('#991b1b').font('Helvetica-Bold').fontSize(11).text(statusText, { width });
                doc.moveDown(0.8);
            }
            const field = (label: string, value: string) => {
                doc.fillColor('#475569').font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), 48, doc.y, { width });
                doc.moveDown(0.25).fillColor('#0f172a').font('Helvetica').fontSize(11).text(value, { width, lineGap: 2 });
                doc.moveDown(0.8);
            };
            field('Entrega el dinero', datos.pagador);
            field('Recibe el dinero', datos.receptor + (datos.documentoReceptor ? ` · DNI/CUIT: ${datos.documentoReceptor}` : ''));
            if (datos.inmueble) field('Inmueble', datos.inmueble);
            field('Concepto', datos.descripcion);
            const ensureSpace = (height: number) => { if (doc.y + height > doc.page.height - 85) doc.addPage(); };
            ensureSpace(92);
            const amountY = doc.y;
            doc.roundedRect(48, amountY, width, 68, 8).fill('#eef2ff');
            doc.fillColor('#312e81').font('Helvetica-Bold').fontSize(10).text('IMPORTE RECIBIDO', 64, amountY + 13, { width: width - 32 });
            doc.fontSize(22).text(amountLabel(movimiento.monto, movimiento.moneda), 64, amountY + 31, { width: width - 32 });
            doc.y = amountY + 82; doc.x = 48;
            field('Medio de pago', movimiento.metodoPago?.replace(/_/g, ' ') || 'No informado');
            ensureSpace(135);
            doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#475569').text('Dejo constancia de haber recibido el importe indicado por el concepto detallado.', { width });
            doc.moveDown(3);
            const signY = doc.y;
            doc.strokeColor('#94a3b8').moveTo(48, signY).lineTo(275, signY).stroke();
            doc.moveTo(320, signY).lineTo(48 + width, signY).stroke();
            doc.fontSize(9).text('Firma de quien recibe', 48, signY + 7, { width: 227 });
            doc.text('Aclaración y DNI/CUIT', 320, signY + 7, { width: width - 272 });
            const pages = doc.bufferedPageRange();
            for (let i = pages.start; i < pages.start + pages.count; i++) {
                doc.switchToPage(i);
                // Stamp every page, including long descriptions and a separate signature page.
                // Temporarily allow drawing in the reserved footer; otherwise PDFKit inserts extra pages.
                const bottomMargin = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                const bottom = doc.page.height - 48;
                const footer = identity.estado === 'BORRADOR' ? statusText : `${identity.numero} · Versión ${identity.version}${statusText ? ` · ${statusText}` : ''}`;
                doc.font('Helvetica-Bold').fontSize(8).fillColor(statusText ? '#991b1b' : '#475569').text(footer, 48, bottom - 16, { width, lineBreak: false });
                doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(`Movimiento #${movimiento.id} · ${dateLabel(movimiento.fecha)} · Página ${i + 1} de ${pages.count}`, 48, bottom, { width, lineBreak: false });
                doc.page.margins.bottom = bottomMargin;
            }
            doc.end();
        } catch (error) { reject(error); doc.end(); }
    });
}
