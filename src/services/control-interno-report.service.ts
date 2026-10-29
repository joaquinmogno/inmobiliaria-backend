import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { argentinaDateOnly } from '../utils/argentina-date';
import { formatCurrency } from '../utils/currency';
import { formatDatePdf } from './liquidacion-pdf.service';
import { internalReportFilterLabel, summarizeInternalMovements, type InternalMovementRow } from './control-interno.service';
import type { FiltroControlInterno } from '../validation/control-interno.schemas';

type InternalReport = { rows: InternalMovementRow[]; filters: FiltroControlInterno; agency: string };
const state = (row: InternalMovementRow) => row.anuladoEn ? 'Anulado' : 'Vigente';

export async function buildInternalExcel({ rows, filters, agency }: InternalReport) {
    const book = new ExcelJS.Workbook();
    book.creator = 'PropControl';
    book.created = new Date();
    const sheet = book.addWorksheet('Movimientos', {
        views: [{ state: 'frozen', ySplit: 5 }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' }
    });
    sheet.columns = [
        { width: 9 }, { width: 14 }, { width: 13 }, { width: 44 }, { width: 23 }, { width: 23 },
        { width: 12 }, { width: 20 }, { width: 30 }, { width: 16 }, { width: 44 }, { width: 55 }, { width: 28 }, { width: 23 }
    ];
    sheet.mergeCells('A1:N1');
    sheet.getCell('A1').value = `${agency} · Control interno`;
    sheet.getCell('A1').font = { size: 17, bold: true, color: { argb: 'FF4338CA' } };
    sheet.mergeCells('A2:N2');
    sheet.getCell('A2').value = internalReportFilterLabel(filters);
    sheet.getCell('A2').alignment = { wrapText: true };
    sheet.getRow(2).height = 35;
    sheet.mergeCells('A3:N3');
    sheet.getCell('A3').value = `Emitido: ${formatDatePdf(argentinaDateOnly())}. Los anulados se muestran para consulta y se excluyen de los totales. Importes separados por moneda.`;
    sheet.getCell('A3').alignment = { wrapText: true };
    sheet.getRow(3).height = 30;
    const header = sheet.getRow(5);
    header.values = ['ID', 'Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio de pago', 'Moneda', 'Importe', 'Cargado por', 'Estado', 'Motivo de anulación', 'Observaciones', 'Comprobantes', 'Fecha de carga'];
    header.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
    });
    for (const row of rows) {
        const added = sheet.addRow([
            row.id, row.fecha, row.tipo === 'GASTO' ? 'Gasto' : 'Ingreso', row.detalle, row.categoria || '', row.metodoPago || '', row.moneda,
            Number(row.monto), row.creadoPor.nombreCompleto, state(row), row.motivoAnulacion || '', row.observaciones || '',
            row.adjuntos.map(file => file.nombreArchivo).join('\n'), row.fechaCreacion
        ]);
        added.getCell(2).numFmt = 'dd/mm/yyyy';
        added.getCell(8).numFmt = '#,##0.00';
        added.getCell(14).value = row.fechaCreacion.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        added.alignment = { vertical: 'top', wrapText: true };
        if (row.anuladoEn) added.font = { color: { argb: 'FF6B7280' } };
    }
    sheet.autoFilter = { from: 'A5', to: `N${Math.max(sheet.rowCount, 5)}` };
    sheet.pageSetup.printArea = `A1:N${Math.max(sheet.rowCount, 5)}`;
    const summary = book.addWorksheet('Resumen', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    summary.columns = [{ width: 18 }, { width: 23 }, { width: 23 }, { width: 23 }];
    summary.addRow(['Control interno', filters.periodo]);
    summary.addRow(['Moneda', 'Ingresos', 'Gastos', 'Diferencia']);
    summarizeInternalMovements(rows).forEach(total => summary.addRow([total.moneda, total.ingresos, total.gastos, total.diferencia]));
    summary.getRow(2).font = { bold: true };
    for (const column of [2, 3, 4]) summary.getColumn(column).numFmt = '#,##0.00';
    summary.addRow([]);
    summary.addRow(['Los anulados no suman.']);
    return Buffer.from(await book.xlsx.writeBuffer());
}

export function buildInternalPdf({ rows, filters, agency }: InternalReport): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 38, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const left = 38;
        const width = doc.page.width - 76;
        const columns = [52, 42, 181, 70, 70, 35, 82, 91, 62, 44];
        const headers = ['Fecha', 'Tipo', 'Detalle', 'Categoría', 'Medio', 'Moneda', 'Importe', 'Cargado por', 'Estado', 'Adj.'];
        let y = 0;
        const startPage = () => {
            doc.fillColor('#4338CA').font('Helvetica-Bold').fontSize(16).text(`${agency} · Control interno`, left, 34, { width });
            const filterY = doc.y + 7;
            doc.fillColor('#374151').font('Helvetica').fontSize(8).text(internalReportFilterLabel(filters), left, filterY, { width });
            y = Math.max(91, doc.y + 12);
            doc.rect(left, y, width, 23).fill('#4338CA');
            let x = left;
            headers.forEach((header, index) => {
                doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(header, x + 4, y + 8, { width: columns[index] - 8 });
                x += columns[index];
            });
            y += 27;
        };
        startPage();
        for (const row of rows) {
            const values = [formatDatePdf(row.fecha), row.tipo === 'GASTO' ? 'Gasto' : 'Ingreso', row.detalle, row.categoria || '—', row.metodoPago || '—', row.moneda,
                formatCurrency(Number(row.monto), row.moneda), row.creadoPor.nombreCompleto, state(row), String(row.adjuntos.length)];
            doc.font('Helvetica').fontSize(8);
            const height = Math.max(25, ...values.map((value, index) => doc.heightOfString(value, { width: columns[index] - 8 }) + 12));
            if (y + height > doc.page.height - 55) { doc.addPage(); startPage(); }
            doc.rect(left, y, width, height).fill(row.anuladoEn ? '#F3F4F6' : '#FAFAFF');
            let x = left;
            values.forEach((value, index) => {
                doc.fillColor(row.anuladoEn ? '#6B7280' : '#111827').font('Helvetica').fontSize(8)
                    .text(value, x + 4, y + 6, { width: columns[index] - 8, align: index === 6 ? 'right' : 'left' });
                x += columns[index];
            });
            y += height + 3;
        }
        if (!rows.length) { doc.fillColor('#4B5563').fontSize(10).text('No hay movimientos para los filtros seleccionados.', left, y + 8); y += 30; }
        if (y + 93 > doc.page.height - 55) { doc.addPage(); startPage(); }
        y += 12;
        doc.fillColor('#4338CA').font('Helvetica-Bold').fontSize(10).text('TOTALES DE MOVIMIENTOS VIGENTES', left, y);
        y += 18;
        summarizeInternalMovements(rows).forEach(total => {
            doc.fillColor('#111827').font('Helvetica').fontSize(10).text(`${total.moneda}     Ingresos: ${formatCurrency(total.ingresos, total.moneda)}     Gastos: ${formatCurrency(total.gastos, total.moneda)}     Diferencia: ${formatCurrency(total.diferencia, total.moneda)}`, left, y, { width });
            y += 18;
        });
        const pages = doc.bufferedPageRange();
        for (let index = pages.start; index < pages.start + pages.count; index++) {
            doc.switchToPage(index);
            doc.fillColor('#6B7280').font('Helvetica').fontSize(7).text(`Control interno independiente · Anulados excluidos de totales · ${formatDatePdf(argentinaDateOnly())} · Página ${index + 1} de ${pages.count}`, left, doc.page.height - 35, { width, align: 'center', lineBreak: false });
        }
        doc.end();
    });
}
