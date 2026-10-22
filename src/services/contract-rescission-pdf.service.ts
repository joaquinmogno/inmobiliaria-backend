import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type { KeyDeliverySnapshot, RescissionSnapshot } from './contract-rescission.service';

const dateEs = (value: string) => new Date(`${value}T00:00:00.000Z`).toLocaleDateString('es-AR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});

const personList = (people: RescissionSnapshot['contrato']['propietarios']) =>
    people.map(person => `${person.nombre}${person.dni ? `, DNI N.º ${person.dni}` : ''}`).join('; ') || 'No informado';

const propertyAddress = (contract: RescissionSnapshot['contrato']) => [
    contract.direccion,
    contract.piso && `piso ${contract.piso}`,
    contract.departamento && `departamento ${contract.departamento}`
].filter(Boolean).join(', ');

/** Texto estructural inspirado en el acta de ejemplo; nunca presume una renuncia general a reclamos. */
export function rescissionActWording(snapshot: RescissionSnapshot) {
    const { contrato, declaracion } = snapshot;
    return {
        title: declaracion.tipoCierre === 'ANTICIPADA_INQUILINO'
            ? 'ACTA DE RESCISIÓN ANTICIPADA VOLUNTARIA Y CIERRE DEFINITIVO'
            : 'ACTA DE FINALIZACIÓN DE CONTRATO POR ACUERDO DE LAS PARTES Y CIERRE DEFINITIVO',
        introduction: `Se extiende la presente acta respecto del inmueble sito en ${propertyAddress(contrato)}. Intervienen como parte propietaria ${personList(contrato.propietarios)} y como parte inquilina ${personList(contrato.inquilinos)}. El contrato de locación N.º ${contrato.id} tenía vigencia original del ${dateEs(contrato.fechaInicio)} al ${dateEs(contrato.fechaFin)}. La entrega de llaves se documentó con fecha ${dateEs(declaracion.fechaEntregaLlaves!)}.`,
        reason: `Motivo informado del cierre: ${declaracion.motivo}.`,
        delivery: `La entrega del inmueble y de ${declaracion.cantidadLlaves} llave${declaracion.cantidadLlaves === 1 ? '' : 's'} consta en el acta de llaves del ${dateEs(declaracion.fechaEntregaLlaves!)}. Estado informado al entregar: ${declaracion.estadoInmueble}.`,
        financial: 'Las partes declaran haber revisado y resuelto la liquidación final, los servicios, las expensas, las multas que correspondan y el destino del depósito. Los importes que se consignan a continuación describen lo acordado; este documento no registra por sí mismo movimientos de dinero.',
        closing: 'Las partes, luego de revisar lo anterior, declaran que nada tienen que reclamarse a futuro entre sí en relación con este contrato. Leída la presente, firman en conformidad.'
    };
}

export function sendKeyDeliveryPdf(res: Response, snapshot: KeyDeliverySnapshot, version: number, issuedAt: Date) {
    const { contrato, entrega } = snapshot;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="acta-llaves-contrato-${contrato.id}-v${version}.pdf"`);
    doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(16).text('ACTA DE ENTREGA DE INMUEBLE Y LLAVES', { align: 'center' });
    doc.moveDown().font('Helvetica').fontSize(10)
        .text(`Acta v${version} · Contrato N.º ${contrato.id} · Emitida el ${issuedAt.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    doc.moveDown().text(`Inmueble: ${propertyAddress(contrato)}`);
    doc.text(`Contrato: ${dateEs(contrato.fechaInicio)} al ${dateEs(contrato.fechaFin)}`);
    doc.text(`Propietario/s: ${personList(contrato.propietarios)}`);
    doc.text(`Inquilino/s: ${personList(contrato.inquilinos)}`);
    doc.moveDown().text(`El ${dateEs(entrega.fechaEntregaLlaves)}${entrega.horaEntrega ? ` a las ${entrega.horaEntrega} hs` : ''}, la parte inquilina entrega el inmueble desocupado y ${entrega.cantidadLlaves} llave${entrega.cantidadLlaves === 1 ? '' : 's'} a ${entrega.receptorNombre}.`, { lineGap: 3 });
    doc.moveDown().text(`Estado del inmueble informado: ${entrega.estadoInmueble}.`, { lineGap: 3 });
    if (entrega.observaciones) doc.moveDown().text(`Observaciones: ${entrega.observaciones}`, { lineGap: 3 });
    doc.moveDown().text('Desde esta entrega no se devengan nuevos días de alquiler. El importe por los días anteriores se determina manualmente en la liquidación final, sin prorrateo automático.', { lineGap: 3 });
    doc.moveDown().text('Esta acta acredita la entrega del inmueble y las llaves. No declara cancelados servicios, expensas, multas, depósitos ni otros saldos; su resolución y el cierre sin reclamos se documentarán por separado.', { lineGap: 3 });
    const signers = [
        ...contrato.inquilinos.map(item => `Inquilino/a: ${item.nombre}`),
        `Recibe las llaves: ${entrega.receptorNombre}`
    ];
    for (const signer of signers) {
        if (doc.y + 48 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        doc.moveDown(1.5).text('____________________________');
        doc.text(signer);
    }
    doc.end();
}

export function sendRescissionPdf(res: Response, snapshot: RescissionSnapshot, version: number, issuedAt: Date) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const { contrato, declaracion, saldosRegistrados } = snapshot;
    const wording = rescissionActWording(snapshot);
    const money = (value: string | number, currency: string = contrato.moneda) => `${currency} ${Number(value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const section = (title: string) => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).text(title); doc.moveDown(0.25).font('Helvetica').fontSize(10); };
    const line = (label: string, value: string) => doc.text(`${label}: ${value}`, { lineGap: 3 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="acta-rescision-contrato-${contrato.id}-v${version}.pdf"`);
    doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(15).text(wording.title, { align: 'center' });
    doc.moveDown(0.5).font('Helvetica').fontSize(9).text(`Acta v${version} · Contrato N.º ${contrato.id} · Emitida el ${issuedAt.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'center' });
    doc.moveDown(1.2).fontSize(10);
    line('Fecha', issuedAt.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));
    line('Dirección del inmueble', propertyAddress(contrato));
    doc.moveDown().text(wording.introduction, { lineGap: 3, align: 'justify' });
    section('LAS PARTES DEJAN CONSTANCIA DE QUE');
    doc.text(`• ${wording.reason}`, { lineGap: 3 });
    doc.moveDown(0.3).text(`• ${wording.delivery}`, { lineGap: 3 });
    if (declaracion.motivoRevision) doc.moveDown(0.3).text(`• Motivo de emisión de esta nueva versión: ${declaracion.motivoRevision}.`, { lineGap: 3 });
    if (declaracion.observaciones) doc.moveDown(0.3).text(`• Observaciones: ${declaracion.observaciones}`, { lineGap: 3 });
    doc.moveDown(0.3).text(`• ${wording.financial}`, { lineGap: 3 });

    section('IMPORTES ACORDADOS O INFORMADOS MANUALMENTE');
    line('Multa acordada y saldada según declaración', `${money(declaracion.multaImporte)}${declaracion.multaResponsable ? ` · a cargo de ${declaracion.multaResponsable.toLowerCase()}` : ''}`);
    line('Depósito devuelto según declaración de las partes', money(declaracion.depositoADevolver));
    line('Depósito retenido según acuerdo', money(declaracion.depositoRetenido));
    if (declaracion.motivoRetencion) line('Motivo de retención', declaracion.motivoRetencion);
    for (const item of declaracion.pendientesManuales) line(`${item.tipo} · ${item.concepto} · a cargo de ${item.responsable.toLowerCase()}`, money(item.importe));
    if (!declaracion.pendientesManuales.length) doc.text('No se informaron otros conceptos pendientes.', { lineGap: 3 });

    section('SALDOS REGISTRADOS POR LA APLICACIÓN AL EMITIR');
    for (const item of saldosRegistrados.cobrosPendientesInquilino) line(`Cobro pendiente · liquidación #${item.liquidacionId} (${new Date(item.periodo).toISOString().slice(0, 7)})`, money(item.saldo, item.moneda));
    for (const item of saldosRegistrados.pagosPendientesPropietario) line(`Pago pendiente al propietario · liquidación #${item.liquidacionId} (${new Date(item.periodo).toISOString().slice(0, 7)})`, money(item.saldo, item.moneda));
    line('Cuotas pendientes', String(saldosRegistrados.cuotasPendientes));
    for (const item of saldosRegistrados.saldosAFavorInquilino) line(`Crédito a favor del inquilino #${item.creditoId}`, money(item.saldo, item.moneda));
    if (!saldosRegistrados.cobrosPendientesInquilino.length && !saldosRegistrados.pagosPendientesPropietario.length && !saldosRegistrados.saldosAFavorInquilino.length && !saldosRegistrados.cuotasPendientes) {
        doc.text('No se registran saldos pendientes en la aplicación al momento de emitir esta acta.', { lineGap: 3 });
    }

    const firmantes = [
        ...contrato.propietarios.map(persona => ({ rol: 'Propietario/a', nombre: persona.nombre })),
        ...contrato.inquilinos.map(persona => ({ rol: 'Inquilino/a', nombre: persona.nombre })),
        { rol: 'Representante de la inmobiliaria', nombre: '' }
    ];
    const espacioFirmas = 55 + firmantes.length * 43;
    if (doc.y + espacioFirmas > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.moveDown(1.2).font('Helvetica').fontSize(10).text(wording.closing);
    for (const firmante of firmantes) {
        if (doc.y + 38 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        doc.moveDown(1.3).text('____________________________');
        doc.text(`${firmante.rol}${firmante.nombre ? `: ${firmante.nombre}` : ''}`);
    }
    doc.end();
}
