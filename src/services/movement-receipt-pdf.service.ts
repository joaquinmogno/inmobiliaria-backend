import PDFDocument from 'pdfkit';
import type { ReceiptSnapshot, ReceiptStatus } from './movement-receipt.service';
import { formatArgentinaDateTime } from '../utils/argentina-date';

const dateLabel = (value: string) => value.slice(0, 10).split('-').reverse().join('/');
const numberLabel = (value: string) => Number(value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amountLabel = (value: string, currency: string) => `${currency === 'USD' ? 'US$' : '$'} ${numberLabel(value)} (${currency})`;
const colors = { ink: '#182235', muted: '#526073', violet: '#55418b', line: '#d9dce4', tint: '#f7f5fa', danger: '#9b2929' };

export function buildMovementReceiptPdf(snapshot: ReceiptSnapshot, identity: { numero: string; version: number; fechaEmision: Date; estado: ReceiptStatus | 'BORRADOR' }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        // The installation's default application name is not the agency's identity.
        // Only presentation changes: retain the saved participants and snapshot verbatim.
        const agencyName = /^prop\s*control$/i.test(snapshot.emisor.nombre.trim()) ? '' : snapshot.emisor.nombre;
        // Subsequent pages reserve space for a compact identification header.
        const doc = new PDFDocument({ size: 'A4', margins: { top: 94, left: 42, right: 42, bottom: 70 }, bufferPages: true, info: { Title: `Recibo ${identity.numero} · v${identity.version}`, Author: agencyName } });
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        try {
            const { emisor, datos, movimiento, contexto } = snapshot;
            const left = 42, width = doc.page.width - 84, right = left + width;
            const bottom = doc.page.height - 70;
            let y = 42;
            const draft = identity.estado === 'BORRADOR';
            const documentRef = draft ? 'BORRADOR' : identity.numero;
            const status = {
                BORRADOR: 'VISTA PREVIA · SIN EMITIR', VIGENTE: '',
                ANULADO: 'ANULADO · El movimiento fue anulado',
                REEMPLAZADO: 'REEMPLAZADO · Existe una versión posterior',
                DESACTUALIZADO: 'DESACTUALIZADO · El movimiento fue modificado'
            }[identity.estado];
            const font = (size = 10, bold = false, color = colors.ink) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
            const text = (value: string, x: number, top: number, w: number, size = 10, bold = false, color = colors.ink, align: 'left' | 'right' = 'left') => {
                font(size, bold, color).text(value, x, top, { width: w, lineGap: 2, align });
                return doc.y;
            };
            const height = (value: string, w: number, size = 10, bold = false) => {
                font(size, bold);
                return doc.heightOfString(value, { width: w, lineGap: 2 });
            };
            const rule = (top: number, x = left, w = width) => doc.strokeColor(colors.line).lineWidth(0.6).moveTo(x, top).lineTo(x + w, top).stroke();
            const ensure = (space: number) => {
                if (y + space <= bottom) return false;
                doc.addPage(); y = 94; return true;
            };
            // Explicit wrapping lets every line and signature stay inside the print area,
            // including unbroken identifiers and user-entered newlines.
            const lines = (value: string, w: number, size = 10) => {
                font(size);
                const result: string[] = [];
                for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
                    let line = '';
                    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                        if (doc.widthOfString(line ? `${line} ${word}` : word) <= w) { line = line ? `${line} ${word}` : word; continue; }
                        if (line) { result.push(line); line = ''; }
                        for (const char of word) {
                            if (line && doc.widthOfString(line + char) > w) { result.push(line); line = ''; }
                            line += char;
                        }
                    }
                    result.push(line);
                }
                return result;
            };
            const flowField = (label: string, value: string, keepLast = 0) => {
                const wrapped = lines(value, width, 10.5);
                ensure(35 + (wrapped.length <= 2 ? keepLast : 0));
                text(label, left, y, width, 8.5, true, colors.muted); y += 16;
                wrapped.forEach((line, index) => {
                    const required = 14 + (wrapped.length - index <= 2 ? keepLast + (wrapped.length - index - 1) * 14 : 0);
                    if (ensure(required)) { text(`${label} · Continuación`, left, y, width, 8.5, true, colors.muted); y += 16; }
                    text(line || ' ', left, y, width, 10.5); y += 14;
                });
                y += 14;
            };

            // Agency identity and document identity share one header, without a large empty band.
            const agencyWidth = width - 174;
            let agencyEnd = y;
            let hasLogo = false;
            if (emisor.logo) {
                try {
                    doc.image(Buffer.from(emisor.logo, 'base64'), left, y, { fit: [168, 64] });
                    agencyEnd = y + 72;
                    hasLogo = true;
                }
                catch { /* Historic missing/corrupt logos retain the textual agency identity. */ }
            }
            if (agencyName) agencyEnd = text(agencyName, left, agencyEnd, agencyWidth, hasLogo ? 10 : 15, !hasLogo, hasLogo ? colors.muted : colors.ink);
            for (const line of [emisor.cuit ? `CUIT ${emisor.cuit}` : '', emisor.direccion, emisor.contacto].filter(Boolean)) {
                agencyEnd = text(line!, left, agencyEnd + 4, agencyWidth, 9, false, colors.muted);
            }
            const identityX = right - 158;
            let identityEnd = text('RECIBO DE PAGO', identityX, y, 158, 15, true, colors.ink, 'right');
            identityEnd = text(documentRef, identityX, identityEnd + 8, 158, 12, true, colors.violet, 'right');
            identityEnd = text(`${draft ? 'Versión propuesta' : 'Versión'} ${identity.version}`, identityX, identityEnd + 4, 158, 9, false, colors.muted, 'right');
            y = Math.max(agencyEnd, identityEnd) + 16;
            rule(y); y += 12;
            if (status) {
                const h = height(status, width - 20, 9, true) + 16;
                doc.rect(left, y, width, h).fill(draft ? colors.tint : '#fcf3f3');
                text(status, left + 10, y + 8, width - 20, 9, true, draft ? colors.violet : colors.danger);
                y += h + 12;
            }
            const dateY = y;
            text('FECHA DEL PAGO', left, dateY, 180, 8.5, true, colors.muted);
            text(dateLabel(movimiento.fecha), left, dateY + 15, 180, 10.5);
            text(draft ? 'GENERADO' : 'EMITIDO', left + 208, dateY, width - 208, 8.5, true, colors.muted);
            const dateEnd = text(`${formatArgentinaDateTime(identity.fechaEmision)} · Hora de Buenos Aires`, left + 208, dateY + 15, width - 208, 9.5);
            y = Math.max(dateY + 30, dateEnd) + 16;

            const colWidth = (width - 24) / 2;
            const recipient = datos.receptor;
            const participantHeight = Math.max(height(datos.pagador, colWidth, 11, true), height(recipient, colWidth, 11, true) + (datos.documentoReceptor ? height(`DNI/CUIT: ${datos.documentoReceptor}`, colWidth, 9) + 6 : 0)) + 22;
            ensure(participantHeight + 12);
            text('ENTREGA EL DINERO', left, y, colWidth, 8.5, true, colors.muted);
            text('RECIBE EL DINERO', left + colWidth + 24, y, colWidth, 8.5, true, colors.muted);
            text(datos.pagador, left, y + 17, colWidth, 11, true);
            const receiverEnd = text(recipient, left + colWidth + 24, y + 17, colWidth, 11, true);
            if (datos.documentoReceptor) text(`DNI/CUIT: ${datos.documentoReceptor}`, left + colWidth + 24, receiverEnd + 6, colWidth, 9, false, colors.muted);
            y += participantHeight + 12;

            const amount = amountLabel(movimiento.monto, movimiento.moneda);
            const method = movimiento.metodoPago?.replace(/_/g, ' ') || 'No informado';
            const paymentHeight = height(`Medio de pago: ${method}`, width - 28, 9) + 70;
            ensure(paymentHeight + 12);
            doc.rect(left, y, width, paymentHeight).fillAndStroke(colors.tint, colors.line);
            doc.rect(left, y, 3, paymentHeight).fill(colors.violet);
            text('IMPORTE DE ESTE RECIBO', left + 14, y + 12, width - 28, 8.5, true, colors.violet);
            text(amount, left + 14, y + 29, width - 28, 23, true, colors.ink);
            text(`Medio de pago: ${method}`, left + 14, y + 62, width - 28, 9, false, colors.muted);
            y += paymentHeight + 16;

            if (datos.inmueble) flowField('INMUEBLE', datos.inmueble);
            if (contexto) {
                const tenant = contexto.operacion === 'COBRO_INQUILINO';
                const note = `Situación de esta liquidación al ${draft ? 'generar la vista' : 'emitir el recibo'}: ${formatArgentinaDateTime(contexto.fechaConsulta)} (Buenos Aires). Incluye este pago y los demás registros vigentes. No representa el saldo de otros períodos.`;
                const contextHeight = 78 + contexto.monedas.length * 26 + height(note, width, 8.5);
                ensure(contextHeight);
                text(tenant ? 'COBRO DE INQUILINO' : 'PAGO AL PROPIETARIO', left, y, width, 8.5, true, colors.violet); y += 16;
                text(`Contrato #${contexto.contratoId} · Liquidación #${contexto.liquidacionId} · Período ${contexto.periodo.slice(5, 7)}/${contexto.periodo.slice(0, 4)}`, left, y, width, 9.5); y += 23;
                const columns = tenant ? [58, 110, 110, 110, width - 388] : [58, 151, 151, width - 360];
                const headers = tenant ? ['Moneda', 'Total a cobrar', 'Cobrado', 'Crédito aplicado', 'Pendiente'] : ['Moneda', 'Total propietario', 'Pagado', 'Pendiente'];
                let x = left;
                headers.forEach((label, i) => { text(label, x + 4, y, columns[i] - 8, 8.5, true, colors.muted, i ? 'right' : 'left'); x += columns[i]; });
                y += 18; rule(y); y += 6;
                for (const row of contexto.monedas) {
                    const values = tenant ? [row.moneda, row.total, row.registrado, row.creditoAplicado, row.pendiente] : [row.moneda, row.total, row.registrado, row.pendiente];
                    x = left;
                    values.forEach((value, i) => { text(i ? numberLabel(value) : value, x + 4, y, columns[i] - 8, 9, i === values.length - 1, colors.ink, i ? 'right' : 'left'); x += columns[i]; });
                    y += 20; rule(y); y += 6;
                }
                y = text(note, left, y + 2, width, 8.5, false, colors.muted) + 16;
            }
            // Keep the last lines of the concept with the acknowledgement and signature area.
            flowField('CONCEPTO', datos.descripcion, 138);
            ensure(124);
            text('Dejo constancia de haber recibido el importe indicado por el concepto detallado.', left, y, width, 9.5, false, colors.muted);
            y += 80;
            rule(y, left, colWidth); rule(y, left + colWidth + 24, colWidth);
            text('Firma de quien recibe', left, y + 8, colWidth, 9, false, colors.muted);
            text('Aclaración y DNI/CUIT', left + colWidth + 24, y + 8, colWidth, 9, false, colors.muted);

            const pages = doc.bufferedPageRange();
            const scope = { CAJA: 'Gestión financiera', INTERNO: 'Control interno', TEODORO: 'Teodoro', DANIEL: 'Daniel' }[movimiento.ambito];
            for (let i = pages.start; i < pages.start + pages.count; i++) {
                doc.switchToPage(i);
                const margin = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                if (i > 0) {
                    // One preview/status label per page, never repeated in body and footer.
                    text('RECIBO DE PAGO · Continuación', left, 38, width - 190, 11, true);
                    text(`${documentRef} · Versión ${identity.version}`, right - 188, 38, 188, 9, true, colors.violet, 'right');
                    if (status) text(status, left, 59, width, 8.5, true, draft ? colors.violet : colors.danger);
                    rule(79);
                }
                rule(doc.page.height - 52);
                text(`Movimiento #${movimiento.id} · ${scope} · ${dateLabel(movimiento.fecha)}`, left, doc.page.height - 42, width - 100, 8, false, colors.muted);
                text(`Página ${i + 1} de ${pages.count}`, right - 95, doc.page.height - 42, 95, 8, false, colors.muted, 'right');
                doc.page.margins.bottom = margin;
            }
            doc.end();
        } catch (error) { reject(error); doc.end(); }
    });
}
