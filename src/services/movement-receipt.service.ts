import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { Prisma, type AmbitoMovimientoInterno } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { getLiquidationCurrencyDecimalSummaries, liquidationCurrencyRelations, type MultiCurrencyLiquidation } from './liquidation-currency.service';

export type ReceiptScope = 'CAJA' | AmbitoMovimientoInterno;
export type ReceiptStatus = 'VIGENTE' | 'ANULADO' | 'REEMPLAZADO' | 'DESACTUALIZADO';
const publicText = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value), 'El texto contiene caracteres inválidos');
export const receiptInputSchema = z.object({
    pagador: publicText(180).min(1, 'Completá quién entrega el dinero'),
    receptor: publicText(180).min(1, 'Completá quién recibe el dinero'),
    documentoReceptor: publicText(40).default(''),
    inmueble: publicText(255).default(''),
    descripcion: publicText(1500).min(1, 'Completá el concepto del recibo'),
    motivo: publicText(500).default(''),
    huellaMovimiento: z.string().regex(/^[a-f0-9]{64}$/),
    ultimaVersion: z.number().int().min(0)
}).strict();
export type ReceiptInput = z.infer<typeof receiptInputSchema>;
export type ReceiptFields = Pick<ReceiptInput, 'pagador' | 'receptor' | 'documentoReceptor' | 'inmueble' | 'descripcion'>;
export type ReceiptMovement = {
    id: number; ambito: ReceiptScope; tipo: 'INGRESO' | 'EGRESO'; fecha: string;
    concepto: string; monto: string; moneda: 'ARS' | 'USD'; metodoPago: string | null;
};
export type ReceiptSnapshot = {
    formato: 1; movimiento: ReceiptMovement; datos: ReceiptFields;
    emisor: { nombre: string; cuit: string | null; direccion: string | null; contacto: string; logo: string | null };
    // Optional for historic snapshots. Reprints use this frozen context, never today's balances.
    contexto?: ReceiptFinancialContext;
};
export type ReceiptFinancialContext = {
    contratoId: number; liquidacionId: number; periodo: string; fechaConsulta: string;
    operacion: 'COBRO_INQUILINO' | 'PAGO_PROPIETARIO';
    monedas: Array<{ moneda: 'ARS' | 'USD'; total: string; registrado: string; creditoAplicado: string; pendiente: string }>;
};
export function receiptFinancialContext(liquidacion: MultiCurrencyLiquidation & { id: number; contratoId: number; periodo: Date }, operacion: ReceiptFinancialContext['operacion'], fechaConsulta = new Date()): ReceiptFinancialContext {
    const tenant = operacion === 'COBRO_INQUILINO';
    return {
        contratoId: liquidacion.contratoId, liquidacionId: liquidacion.id,
        periodo: liquidacion.periodo.toISOString().slice(0, 10), fechaConsulta: fechaConsulta.toISOString(), operacion,
        monedas: getLiquidationCurrencyDecimalSummaries(liquidacion).map(row => ({
            moneda: row.moneda, total: (tenant ? row.netoACobrar : row.montoPropietario).toFixed(2),
            registrado: (tenant ? row.cobradoInquilino : row.pagadoPropietario).toFixed(2),
            creditoAplicado: tenant ? row.creditoAplicadoInquilino.toFixed(2) : '0.00',
            pendiente: (tenant ? row.saldoInquilino : row.saldoPropietario).toFixed(2)
        }))
    };
}
export const receiptNumber = (id: number) => `REC-${String(id).padStart(6, '0')}`;
export const movementFingerprint = (movement: ReceiptMovement) => createHash('sha256').update(JSON.stringify(movement)).digest('hex');
export const receiptStatus = (cancelled: boolean, version: number, latest: number, fingerprint: string, currentFingerprint: string): ReceiptStatus =>
    cancelled ? 'ANULADO' : version !== latest ? 'REEMPLAZADO' : fingerprint !== currentFingerprint ? 'DESACTUALIZADO' : 'VIGENTE';
export const receiptConflict = () => new AppError('El movimiento o su recibo cambió. Actualizá los datos y revisá la vista previa antes de emitir.', { statusCode: 409, code: 'MOVEMENT_RECEIPT_CHANGED' });

// Sólo se seleccionan datos públicos del movimiento; las notas y cuentas privadas no se copian al recibo.
export async function loadReceiptSource(tx: Prisma.TransactionClient, scope: ReceiptScope, id: number, inmobiliariaId: number) {
    let movimiento: ReceiptMovement;
    let anulado: boolean;
    let permitido = true;
    let inmueble = '';
    let referencia: { liquidacionId: number; operacion: ReceiptFinancialContext['operacion'] } | undefined;
    if (scope === 'CAJA') {
        const row = await tx.movimientoCaja.findFirst({
            where: { id, inmobiliariaId },
            select: { id: true, tipo: true, fecha: true, concepto: true, monto: true, moneda: true, metodoPago: true, anuladoEn: true,
                reversionDeId: true, transferenciaInternaId: true, reversion: { select: { id: true } },
                pago: { select: { liquidacionId: true } }, pagoPropietario: { select: { liquidacionId: true } },
                contrato: { select: { propiedad: { select: { direccion: true } } } } }
        });
        if (!row) throw new AppError('Movimiento no encontrado', { statusCode: 404 });
        movimiento = { id, ambito: scope, tipo: row.tipo === 'INGRESO' ? 'INGRESO' : 'EGRESO', fecha: row.fecha.toISOString().slice(0, 10), concepto: row.concepto, monto: row.monto.abs().toFixed(2), moneda: row.moneda, metodoPago: row.metodoPago };
        anulado = Boolean(row.anuladoEn || row.reversion);
        permitido = !row.reversionDeId && !row.transferenciaInternaId && row.tipo !== 'DESCUENTO';
        inmueble = row.contrato?.propiedad.direccion || '';
        // Only a verified payment link gives meaning to a balance. A manual cash entry does not.
        if (row.pago && row.tipo === 'INGRESO') referencia = { liquidacionId: row.pago.liquidacionId, operacion: 'COBRO_INQUILINO' };
        else if (row.pagoPropietario && row.tipo === 'EGRESO') referencia = { liquidacionId: row.pagoPropietario.liquidacionId, operacion: 'PAGO_PROPIETARIO' };
    } else {
        const row = await tx.movimientoInterno.findFirst({
            where: { id, inmobiliariaId, ambito: scope },
            select: { id: true, tipo: true, fecha: true, detalle: true, monto: true, moneda: true, metodoPago: true, anuladoEn: true }
        });
        if (!row) throw new AppError('Movimiento no encontrado', { statusCode: 404 });
        movimiento = { id, ambito: scope, tipo: row.tipo === 'INGRESO' ? 'INGRESO' : 'EGRESO', fecha: row.fecha.toISOString().slice(0, 10), concepto: row.detalle, monto: row.monto.toFixed(2), moneda: row.moneda, metodoPago: row.metodoPago };
        anulado = Boolean(row.anuladoEn);
    }
    const recibo = await tx.reciboMovimiento.findFirst({
        where: { inmobiliariaId, ...(scope === 'CAJA' ? { movimientoCajaId: id } : { movimientoInternoId: id }) },
        include: { versiones: { orderBy: { version: 'desc' }, include: { creadoPor: { select: { nombreCompleto: true } } } } }
    });
    return { movimiento, anulado, permitido, inmueble, recibo, referencia, huellaMovimiento: movementFingerprint(movimiento) };
}
type ReceiptSource = Awaited<ReturnType<typeof loadReceiptSource>>;

export function formatReceiptContext(source: ReceiptSource, agencyName: string) {
    const { movimiento, recibo, huellaMovimiento } = source;
    const latest = recibo?.versiones[0];
    const holder = movimiento.ambito === 'TEODORO' ? 'Teodoro' : movimiento.ambito === 'DANIEL' ? 'Daniel' : agencyName;
    const defaults: ReceiptFields = {
        pagador: movimiento.tipo === 'EGRESO' ? holder : '', receptor: movimiento.tipo === 'INGRESO' ? holder : '',
        documentoReceptor: '', inmueble: source.inmueble, descripcion: movimiento.concepto
    };
    return {
        movimiento, huellaMovimiento, ultimaVersion: latest?.version || 0,
        puedeEmitir: !source.anulado && source.permitido,
        bloqueo: source.anulado ? 'El movimiento fue anulado. Sus recibos se conservan para consulta.' : !source.permitido ? 'Las transferencias internas, los descuentos y las reversiones no emiten recibos de pago.' : null,
        numero: recibo ? receiptNumber(recibo.id) : null,
        datos: latest ? (latest.fotografia as unknown as ReceiptSnapshot).datos : defaults,
        versiones: (recibo?.versiones || []).map(row => ({
            version: row.version, fechaEmision: row.fechaEmision, creadoPor: row.creadoPor.nombreCompleto, motivo: row.motivo,
            estado: receiptStatus(source.anulado, row.version, latest!.version, row.huellaMovimiento, huellaMovimiento)
        }))
    };
}

export function assertReceiptIssuable(source: ReceiptSource, input: ReceiptInput) {
    if (source.anulado || !source.permitido) throw new AppError('Este movimiento no permite emitir un recibo de pago.', { statusCode: 409, code: 'MOVEMENT_RECEIPT_UNAVAILABLE' });
    if (source.huellaMovimiento !== input.huellaMovimiento) throw receiptConflict();
}

export async function makeReceiptSnapshot(tx: Prisma.TransactionClient, inmobiliariaId: number, source: ReceiptSource, input: ReceiptInput): Promise<ReceiptSnapshot> {
    const agency = await tx.inmobiliaria.findUniqueOrThrow({ where: { id: inmobiliariaId } });
    const liquidation = source.referencia ? await tx.liquidacion.findFirst({
        where: { id: source.referencia.liquidacionId, inmobiliariaId }, include: liquidationCurrencyRelations
    }) : null;
    const contexto = liquidation && source.referencia ? receiptFinancialContext(liquidation, source.referencia.operacion) : undefined;
    let logo: string | null = null;
    if (agency.logoArchivo) {
        const root = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
        const absolute = path.resolve(root, agency.logoArchivo);
        // Freeze a compact PNG, including uploaded WEBP logos. Never fetch remote URLs or read another agency's uploads.
        if (absolute.startsWith(path.resolve(root, `inmobiliaria-${inmobiliariaId}`) + path.sep) && /\.(png|jpe?g|webp)$/i.test(absolute)) {
            try {
                if ((await fs.stat(absolute)).size <= 7 * 1024 * 1024) logo = (await sharp(await fs.readFile(absolute), { limitInputPixels: 40_000_000 }).rotate().resize(360, 240, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()).toString('base64');
            } catch { /* A missing logo must not prevent documenting a payment. */ }
        }
    }
    return {
        formato: 1, movimiento: source.movimiento,
        ...(contexto ? { contexto } : {}),
        datos: { pagador: input.pagador, receptor: input.receptor, documentoReceptor: input.documentoReceptor, inmueble: input.inmueble, descripcion: input.descripcion },
        emisor: { nombre: agency.razonSocial || agency.nombre, cuit: agency.cuit, direccion: agency.domicilioFiscal || agency.direccion, contacto: [agency.telefono, agency.email].filter(Boolean).join(' · '), logo }
    };
}

export async function issueMovementReceipt(tx: Prisma.TransactionClient, scope: ReceiptScope, id: number, user: { id: number; inmobiliariaId: number }, input: ReceiptInput, metadata: { ipAddress: string | null; userAgent: string | null; requestId: string | null }) {
    // Serialize issuing and concurrent edits/cancellations on the source row, without changing its balance or version.
    if (scope === 'CAJA') await tx.$queryRaw`SELECT id FROM "MovimientoCaja" WHERE id = ${id} AND "inmobiliariaId" = ${user.inmobiliariaId} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "MovimientoInterno" WHERE id = ${id} AND "inmobiliariaId" = ${user.inmobiliariaId} AND ambito::text = ${scope} FOR UPDATE`;
    const source = await loadReceiptSource(tx, scope, id, user.inmobiliariaId);
    assertReceiptIssuable(source, input);
    const latest = source.recibo?.versiones[0];
    const fields: ReceiptFields = { pagador: input.pagador, receptor: input.receptor, documentoReceptor: input.documentoReceptor, inmueble: input.inmueble, descripcion: input.descripcion };
    // Retrying the same issuance (including a double click/network retry) returns the same number and version.
    if (latest && latest.huellaMovimiento === source.huellaMovimiento && (latest.motivo || '') === input.motivo && (Object.keys(fields) as (keyof ReceiptFields)[]).every(key => (latest.fotografia as unknown as ReceiptSnapshot).datos[key] === fields[key])) {
        return { numero: receiptNumber(source.recibo!.id), version: latest.version, creada: false };
    }
    if (input.ultimaVersion !== (latest?.version || 0)) throw receiptConflict();
    if (latest && input.motivo.length < 5) throw new AppError('Indicá el motivo de la nueva versión (al menos 5 caracteres).', { statusCode: 400 });
    const fotografia = await makeReceiptSnapshot(tx, user.inmobiliariaId, source, input);
    const recibo = source.recibo || await tx.reciboMovimiento.create({ data: {
        inmobiliariaId: user.inmobiliariaId, ...(scope === 'CAJA' ? { movimientoCajaId: id } : { movimientoInternoId: id })
    } });
    const version = (latest?.version || 0) + 1;
    await tx.versionReciboMovimiento.create({ data: {
        reciboId: recibo.id, version, creadoPorId: user.id, huellaMovimiento: source.huellaMovimiento,
        fotografia: fotografia as unknown as Prisma.InputJsonValue, motivo: latest ? input.motivo : null
    } });
    await tx.auditLog.create({ data: {
        usuarioId: user.id, inmobiliariaId: user.inmobiliariaId,
        entidad: scope === 'CAJA' ? 'MovimientoCaja' : scope === 'INTERNO' ? 'MovimientoInterno' : scope === 'TEODORO' ? 'MovimientoTeodoro' : 'MovimientoDaniel',
        entidadId: id, accion: latest ? 'REEMITIR_RECIBO_MOVIMIENTO' : 'EMITIR_RECIBO_MOVIMIENTO',
        detalle: JSON.stringify({ numero: receiptNumber(recibo.id), version, motivo: latest ? input.motivo : null }), ...metadata
    } });
    return { numero: receiptNumber(recibo.id), version, creada: true };
}
