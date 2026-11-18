import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { argentinaDateOnly, formatArgentinaDateTime } from '../utils/argentina-date';
import { formatCurrency } from '../utils/currency';
import { formatDatePdf } from './liquidacion-pdf.service';
import { internalReportFilterLabel, internalReportMonthLabel, summarizeInternalMovements, type InternalMovementRow } from './control-interno.service';
import type { FiltroControlInterno } from '../validation/control-interno.schemas';

type InternalReport = { rows: InternalMovementRow[]; filters: FiltroControlInterno; agency: string; title?: string };
const state = (row: InternalMovementRow) => row.anuladoEn ? 'Anulado' : 'Vigente';

export async function buildInternalExcel({ rows, filters, agency, title = 'Finanzas Ricardo' }: InternalReport) {
    const book = new ExcelJS.Workbook();
    book.creator = 'PropControl';
    book.created = new Date();
    const sheet = book.addWorksheet('Movimientos', {
        views: [{ state: 'frozen', ySplit: 5 }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' }
    });
    sheet.columns = [
        { width: 9 }, { width: 14 }, { width: 13 }, { width: 44 }, { width: 23 }, { width: 23 },
        { width: 12 }, { width: 20 }, { width: 30 }, { width: 16 }, { width: 44 }, { width: 55 }, { width: 28 }, { width: 23 }, { width: 36 }
    ];
    sheet.mergeCells('A1:O1');
    sheet.getCell('A1').value = `${agency} · ${title}`;
    sheet.getCell('A1').font = { size: 17, bold: true, color: { argb: 'FF4338CA' } };
    sheet.mergeCells('A2:O2');
    sheet.getCell('A2').value = internalReportFilterLabel(filters);
    sheet.getCell('A2').alignment = { wrapText: true };
    sheet.getRow(2).height = 35;
    sheet.mergeCells('A3:O3');
    sheet.getCell('A3').value = `Emitido: ${formatArgentinaDateTime(book.created)} (hora de Buenos Aires, 24 h). Los anulados se excluyen de los totales. Importes separados por moneda.`;
    sheet.getCell('A3').alignment = { wrapText: true };
    sheet.getRow(3).height = 30;
    const header = sheet.getRow(5);
    header.values = ['ID', 'Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio de pago', 'Moneda', 'Importe', 'Cargado por', 'Estado', 'Motivo de anulación', 'Observaciones', 'Comprobantes', 'Fecha de carga', 'Cuenta de origen / destino'];
    header.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
    });
    for (const row of rows) {
        const added = sheet.addRow([
            row.id, row.fecha, row.tipo === 'GASTO' ? 'Gasto' : 'Ingreso', row.detalle, row.categoria || '', [row.metodoPago, row.tarjetaDescripcion].filter(Boolean).join(' · '), row.moneda,
            Number(row.monto), row.creadoPor.nombreCompleto, state(row), row.motivoAnulacion || '', row.observaciones || '',
            row.adjuntos.map(file => file.nombreArchivo).join('\n'), row.fechaCreacion, row.cuentaPago || ''
        ]);
        added.getCell(2).numFmt = 'dd/mm/yyyy';
        added.getCell(8).numFmt = '#,##0.00';
        added.getCell(14).value = formatArgentinaDateTime(row.fechaCreacion, true);
        added.alignment = { vertical: 'top', wrapText: true };
        if (row.anuladoEn) added.font = { color: { argb: 'FF6B7280' } };
    }
    sheet.autoFilter = { from: 'A5', to: `O${Math.max(sheet.rowCount, 5)}` };
    sheet.pageSetup.printArea = `A1:O${Math.max(sheet.rowCount, 5)}`;
    const summary = book.addWorksheet('Resumen', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    summary.columns = [{ width: 18 }, { width: 23 }, { width: 23 }, { width: 23 }];
    summary.addRow([title, internalReportMonthLabel(filters.periodo)]);
    summary.addRow(['Moneda', 'Ingresos', 'Gastos', 'Diferencia']);
    summarizeInternalMovements(rows).forEach(total => summary.addRow([total.moneda, total.ingresos, total.gastos, total.diferencia]));
    summary.getRow(2).font = { bold: true };
    for (const column of [2, 3, 4]) summary.getColumn(column).numFmt = '#,##0.00';
    summary.addRow([]);
    summary.addRow(['Los anulados no suman.']);
    return Buffer.from(await book.xlsx.writeBuffer());
}

// Wrap before drawing so a cell cannot trigger PDFKit's automatic pagination
// independently of the other cells in its row. Long unbroken references and
// explicit newlines are supported without clipping or dropping text.
function wrapReportText(doc: PDFKit.PDFDocument, value: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            const candidate = line ? `${line} ${word}` : word;
            if (doc.widthOfString(candidate) <= width) { line = candidate; continue; }
            if (line) { lines.push(line); line = ''; }
            for (const character of word) {
                if (line && doc.widthOfString(line + character) > width) {
                    lines.push(line);
                    line = '';
                }
                line += character;
            }
        }
        lines.push(line);
    }
    return lines;
}

export function buildInternalPdf({ rows, filters, agency, title = 'Finanzas Ricardo' }: InternalReport): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 38, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const left = 38;
        const width = doc.page.width - 2 * left;
        // Column widths must add up to the printable width, including Adj.
        const weights = [56, 42, 151, 65, 120, 42, 101, 98, 57, 33];
        const totalWeight = weights.reduce((sum, value) => sum + value, 0);
        const columns = weights.map(value => width * value / totalWeight);
        const headers = ['Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio / cuenta', 'Moneda', 'Importe', 'Cargado por', 'Estado', 'Adj.'];
        const contentBottom = doc.page.height - 60;
        const rowLineHeight = 10;
        const cellPadding = 4;
        let y = 0;
        let bodyTop = 0;
        const drawLines = (lines: string[], x: number, top: number, cellWidth: number, lineHeight: number, align: 'left' | 'right' = 'left') => {
            lines.forEach((line, index) => {
                doc.text(line, x, top + index * lineHeight, { width: cellWidth, height: lineHeight, align, lineBreak: false });
            });
        };
        const startPage = () => {
            doc.fillColor('#4338CA').font('Helvetica-Bold').fontSize(16);
            const heading = wrapReportText(doc, `${agency} · ${title}`.replace(/\s+/g, ' '), width);
            drawLines(heading, left, 34, width, 20);
            const filterY = 34 + heading.length * 20 + 7;
            doc.fillColor('#374151').font('Helvetica').fontSize(8);
            const filterLines = wrapReportText(doc, internalReportFilterLabel(filters).replace(/\s+/g, ' '), width);
            drawLines(filterLines, left, filterY, width, 10);
            y = Math.max(91, filterY + filterLines.length * 10 + 12);
            doc.font('Helvetica-Bold').fontSize(7);
            const headerLines = headers.map((header, index) => wrapReportText(doc, header, columns[index] - 2 * cellPadding));
            const headerHeight = Math.max(23, Math.max(...headerLines.map(lines => lines.length)) * 9 + 12);
            doc.rect(left, y, width, headerHeight).fill('#4338CA');
            let x = left;
            headerLines.forEach((lines, index) => {
                doc.fillColor('white');
                drawLines(lines, x + cellPadding, y + 6, columns[index] - 2 * cellPadding, 9, index === 6 ? 'right' : 'left');
                x += columns[index];
            });
            y += headerHeight + 4;
            bodyTop = y;
        };
        const nextPage = () => { doc.addPage(); startPage(); };
        startPage();
        for (const row of rows) {
            const paymentDetails = [row.metodoPago || 'Medio sin especificar', row.tarjetaDescripcion, row.cuentaPago ? `Cuenta: ${row.cuentaPago}` : null].filter(Boolean).join('\n');
            const values = [formatDatePdf(row.fecha), row.tipo === 'GASTO' ? 'Gasto' : 'Ingreso', row.detalle, row.categoria || '—', paymentDetails, row.moneda,
                formatCurrency(Number(row.monto), row.moneda), row.creadoPor.nombreCompleto, state(row), String(row.adjuntos.length)];
            doc.font('Helvetica').fontSize(8);
            const cells = values.map((value, index) => wrapReportText(doc, value, columns[index] - 2 * cellPadding));
            const lineCount = Math.max(...cells.map(lines => lines.length));
            const fullHeight = Math.max(25, lineCount * rowLineHeight + 12);
            // Keep normal rows together; only rows taller than a whole page
            // are split, with an explicit continuation label on each new page.
            if (y + fullHeight > contentBottom && y > bodyTop) nextPage();
            let offset = 0;
            while (offset < lineCount) {
                const continuationHeight = offset > 0 ? 14 : 0;
                if (contentBottom - y < continuationHeight + 25) nextPage();
                const capacity = Math.floor((contentBottom - y - continuationHeight - 12) / rowLineHeight);
                const count = Math.min(lineCount - offset, capacity);
                const height = continuationHeight + Math.max(25, count * rowLineHeight + 12);
                doc.rect(left, y, width, height).fill(row.anuladoEn ? '#F3F4F6' : '#FAFAFF');
                if (offset > 0) {
                    doc.font('Helvetica-Bold').fontSize(7).fillColor('#4B5563');
                    drawLines([`Movimiento #${row.id} · continuación`], left + cellPadding, y + 4, width - 2 * cellPadding, 9);
                }
                doc.font('Helvetica').fontSize(8).fillColor(row.anuladoEn ? '#6B7280' : '#111827');
                let x = left;
                cells.forEach((lines, index) => {
                    drawLines(lines.slice(offset, offset + count), x + cellPadding, y + continuationHeight + 6, columns[index] - 2 * cellPadding, rowLineHeight, index === 6 ? 'right' : 'left');
                    x += columns[index];
                });
                y += height + 3;
                offset += count;
                if (offset < lineCount) nextPage();
            }
        }
        if (!rows.length) {
            doc.fillColor('#4B5563').font('Helvetica').fontSize(10);
            drawLines(['No hay movimientos para los filtros seleccionados.'], left, y + 8, width, 12);
            y += 30;
        }
        doc.font('Helvetica').fontSize(10);
        const totals = summarizeInternalMovements(rows).map(total => wrapReportText(doc,
            `${total.moneda}     Ingresos: ${formatCurrency(total.ingresos, total.moneda)}     Gastos: ${formatCurrency(total.gastos, total.moneda)}     Diferencia: ${formatCurrency(total.diferencia, total.moneda)}`, width));
        const totalsHeight = 12 + 18 + totals.reduce((height, lines) => height + lines.length * 12 + 6, 0);
        if (y + totalsHeight > contentBottom) nextPage();
        y += 12;
        doc.fillColor('#4338CA').font('Helvetica-Bold').fontSize(10);
        drawLines(['TOTALES DE MOVIMIENTOS VIGENTES'], left, y, width, 12);
        y += 18;
        doc.fillColor('#111827').font('Helvetica').fontSize(10);
        totals.forEach(lines => {
            drawLines(lines, left, y, width, 12);
            y += lines.length * 12 + 6;
        });
        const pages = doc.bufferedPageRange();
        for (let index = pages.start; index < pages.start + pages.count; index++) {
            doc.switchToPage(index);
            // The footer is intentionally inside the bottom margin. Temporarily
            // relax it, as in movement receipts, to avoid an implicit new page.
            const bottomMargin = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            doc.fillColor('#6B7280').font('Helvetica').fontSize(7).text(`${title} · Anulados excluidos de totales · ${formatDatePdf(argentinaDateOnly())} · Página ${index + 1} de ${pages.count}`, left, doc.page.height - 35, { width, height: 10, align: 'center', lineBreak: false });
            doc.page.margins.bottom = bottomMargin;
        }
        doc.end();
    });
}
