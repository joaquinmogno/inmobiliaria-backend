import type PDFKit from 'pdfkit';
import { formatCurrency } from '../utils/currency';

type DebtSummaryPdf = {
    totalDeuda: number;
    moneda: string;
    detalle: Array<{
        id: number;
        periodo: Date | string;
        neto: number;
        pagado: number;
        creditosAplicados: number;
        deuda: number;
        moneda: string;
        estado: string;
    }>;
};

export const formatCurrencyPdf = (amount: number, moneda = 'ARS') => formatCurrency(amount, moneda);

export const formatDatePdf = (date: Date | string | null | undefined) => {
    if (!date) return '-';
    const dateOnly = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
    const [year, month, day] = dateOnly.split('-');
    return `${day}/${month}/${year}`;
};

export const formatPeriodPdf = (date: Date | string) =>
    new Date(date).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const ensurePdfSpace = (doc: PDFKit.PDFDocument, y: number, requiredHeight = 100) => {
    if (y + requiredHeight < doc.page.height - 70) return y;
    doc.addPage();
    return 50;
};

export const drawDebtSummaryPdf = (
    doc: PDFKit.PDFDocument,
    initialY: number,
    pageWidth: number,
    debtSummary: DebtSummaryPdf,
    moneyPdf: (amount: number) => string,
    title = 'DEUDA ANTERIOR DEL CONTRATO'
) => {
    let y = initialY;
    if (debtSummary.totalDeuda <= 0) return y;
    y = ensurePdfSpace(doc, y, 120);
    doc.fillColor('#B45309').fontSize(11).font('Helvetica-Bold').text(title, 50, y);
    doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor('#F59E0B').lineWidth(1).stroke();
    y += 22;
    doc.rect(50, y, pageWidth, 20).fill('#FFFBEB');
    doc.fillColor('#92400E').fontSize(8).font('Helvetica-Bold')
        .text('PERÍODO', 58, y + 6)
        .text('NETO', 190, y + 6, { width: 70, align: 'right' })
        .text('PAGADO', 300, y + 6, { width: 70, align: 'right' })
        .text('DEUDA', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
    y += 20;
    debtSummary.detalle.forEach(item => {
        y = ensurePdfSpace(doc, y, 45);
        doc.fillColor('#111827').fontSize(9).font('Helvetica')
            .text(formatPeriodPdf(item.periodo), 58, y + 5)
            .text(moneyPdf(item.neto), 190, y + 5, { width: 70, align: 'right' })
            .text(moneyPdf(item.pagado), 300, y + 5, { width: 70, align: 'right' });
        doc.fillColor('#B91C1C').font('Helvetica-Bold').text(moneyPdf(item.deuda), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
        doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#FDE68A').lineWidth(0.5).stroke();
        y += 20;
    });
    doc.rect(50, y, pageWidth, 22).fill('#FEF3C7');
    doc.fillColor('#92400E').fontSize(9).font('Helvetica-Bold')
        .text('TOTAL DEUDA ANTERIOR', 58, y + 7)
        .text(moneyPdf(debtSummary.totalDeuda), 50 + pageWidth - 120, y + 7, { width: 110, align: 'right' });
    return y + 34;
};

export const drawPaymentRowsPdf = (
    doc: PDFKit.PDFDocument,
    initialY: number,
    pageWidth: number,
    payments: any[],
    moneyPdf: (amount: number) => string
) => {
    let y = initialY;
    const dateX = 58;
    const methodX = 145;
    const detailX = 238;
    const amountWidth = 105;
    const amountX = 50 + pageWidth - amountWidth - 10;
    const detailWidth = amountX - detailX - 12;
    payments.forEach(payment => {
        const detailText = payment.observaciones || '-';
        const methodText = payment.metodoPago || '-';
        doc.fontSize(9).font('Helvetica');
        const contentHeight = Math.max(
            doc.heightOfString(formatDatePdf(payment.fechaPago), { width: 70 }),
            doc.heightOfString(methodText, { width: 80 }),
            doc.heightOfString(detailText, { width: detailWidth })
        );
        const rowHeight = Math.max(20, contentHeight + 10);
        y = ensurePdfSpace(doc, y, rowHeight + 10);
        doc.fillColor('#111827').fontSize(9).font('Helvetica')
            .text(formatDatePdf(payment.fechaPago), dateX, y + 5, { width: 70 })
            .text(methodText, methodX, y + 5, { width: 80 })
            .text(detailText, detailX, y + 5, { width: detailWidth });
        doc.fillColor('#059669').font('Helvetica-Bold').text(moneyPdf(Number(payment.monto)), amountX, y + 5, { width: amountWidth, align: 'right' });
        doc.moveTo(50, y + rowHeight - 2).lineTo(50 + pageWidth, y + rowHeight - 2).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
        y += rowHeight;
    });
    return y;
};
