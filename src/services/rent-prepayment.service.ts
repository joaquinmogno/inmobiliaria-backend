import { applyRentPrepayment } from './rent-prepayment-application.service';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError } from '../errors/app-error';
import { acquireInstallationLock, INSTALLATION_LOCKS } from '../utils/advisory-lock';
import { assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import { auditService } from './audit.service';
import { createLiquidationVoucherSnapshot } from './liquidation-voucher.service';
import { getOwnerPaymentStateByCurrency, getTenantCollectionStateByCurrency, liquidationCurrencyRelations } from './liquidation-currency.service';

const fail = (message: string) => { throw new AppError(message, { statusCode: 409, code: 'RENT_PREPAYMENT_CONFLICT' }); };
const month = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

export async function refreshPrepaymentStates(db: Prisma.TransactionClient, liquidacionId: number) {
    const row = await db.liquidacion.findUniqueOrThrow({ where: { id: liquidacionId }, include: liquidationCurrencyRelations });
    return db.liquidacion.update({ where: { id: row.id }, data: {
        estadoCobroInquilino: getTenantCollectionStateByCurrency(row),
        estadoPagoPropietario: getOwnerPaymentStateByCurrency(row), version: { increment: 1 }
    } });
}

export async function registerRentPrepayment(db: Prisma.TransactionClient, context: { inmobiliariaId: number; usuarioId: number; contratoId: number }, input: {
    periodoDesde: string; meses: number; fechaPago: string; montoMensual: number; moneda: 'ARS' | 'USD'; observaciones: string;
}) {
    const { inmobiliariaId, usuarioId, contratoId } = context;
    await acquireInstallationLock(db, INSTALLATION_LOCKS.monthlyLiquidations, inmobiliariaId);
    await db.$queryRaw`SELECT id FROM "Contrato" WHERE id = ${contratoId} AND "inmobiliariaId" = ${inmobiliariaId} FOR UPDATE`;
    const contract = await db.contrato.findFirst({ where: { id: contratoId, inmobiliariaId }, include: { propietarios: { where: { esPrincipal: true }, include: { persona: true } }, actasRescision: true } });
    if (!contract) throw new AppError('Contrato no encontrado', { statusCode: 404 });
    if (!contract.administrado || contract.eliminadoEn || contract.actasRescision.length) fail('El contrato no admite registrar anticipos.');
    if (contract.propietarios.length !== 1) fail('Definí un único propietario principal.');
    if (contract.moneda !== input.moneda) fail('El anticipo debe estar expresado en la moneda del contrato.');
    const desde = parseDateOnly(input.periodoDesde);
    const hasta = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + input.meses - 1, 1));
    const fechaPago = parseDateOnly(input.fechaPago);
    assertOperationalDateIsNotFuture(fechaPago, 'La fecha del anticipo');
    if (month(desde) < month(contract.fechaInicio) || month(hasta) > month(contract.fechaEntregaLlaves || contract.fechaFin)) fail('Los meses cubiertos deben estar dentro de la vigencia del contrato.');
    if (await db.anticipoAlquiler.count({ where: { contratoId, anuladoEn: null, periodoDesde: { lte: hasta }, periodoHasta: { gte: desde } } })) fail('Ya existe un anticipo que cubre alguno de esos meses.');
    await db.$queryRaw`SELECT id FROM "Liquidacion" WHERE "contratoId" = ${contratoId} AND periodo >= ${desde} AND periodo <= ${hasta} ORDER BY id FOR UPDATE`;
    const existing = await db.liquidacion.findMany({ where: { contratoId, periodo: { gte: desde, lte: hasta } }, include: { pagos: { where: { anuladoEn: null } }, pagosPropietario: { where: { anuladoEn: null } }, aplicacionesCredito: true, ajustes: true } });
    for (const row of existing) {
        if (row.estado === 'ANULADA' || row.fechaLiquidacion || row.pagos.length || row.pagosPropietario.length || row.aplicacionesCredito.length || row.ajustes.length) fail('Hay períodos anulados, cerrados o con cobros, pagos o ajustes. Revisalos antes de registrar el anticipo para evitar duplicar importes.');
        if (row.moneda !== input.moneda || row.montoAlquilerBase.lessThan(input.montoMensual)) fail('El importe mensual cubierto no puede superar el alquiler de una liquidación existente.');
    }
    const advance = await db.anticipoAlquiler.create({ data: {
        inmobiliariaId, contratoId, periodoDesde: desde, periodoHasta: hasta, fechaPago,
        montoMensual: input.montoMensual, montoTotal: new Decimal(input.montoMensual).mul(input.meses), moneda: input.moneda,
        propietarioNombre: contract.propietarios[0].persona.nombreCompleto, observaciones: input.observaciones, creadoPorId: usuarioId
    } });
    for (const row of existing) {
        await applyRentPrepayment(db, row.id);
        await refreshPrepaymentStates(db, row.id);
        if (row.estado === 'CONFIRMADA') await createLiquidationVoucherSnapshot({ tx: db, inmobiliariaId, usuarioId, liquidacionId: row.id, evento: 'ALQUILER_ANTICIPADO' });
    }
    await auditService.log({ inmobiliariaId, usuarioId, accion: 'REGISTRAR_ALQUILER_ANTICIPADO', entidad: 'Contrato', entidadId: contratoId, detalle: `Anticipo #${advance.id}: ${advance.montoTotal} ${input.moneda}, ${input.meses} meses desde ${input.periodoDesde}. Recibido por el propietario, sin asiento de caja. ${input.observaciones}` }, db);
    return advance;
}

export async function cancelRentPrepayment(db: Prisma.TransactionClient, context: { inmobiliariaId: number; usuarioId: number }, id: number, motivo: string) {
    const { inmobiliariaId, usuarioId } = context;
    await acquireInstallationLock(db, INSTALLATION_LOCKS.monthlyLiquidations, inmobiliariaId);
    const advance = await db.anticipoAlquiler.findFirst({ where: { id, inmobiliariaId } });
    if (!advance) throw new AppError('Anticipo no encontrado', { statusCode: 404 });
    if (advance.anuladoEn) return advance;
    await db.$queryRaw`SELECT id FROM "Contrato" WHERE id = ${advance.contratoId} FOR UPDATE`;
    if (await db.actaRescision.count({ where: { contratoId: advance.contratoId } })) fail('El contrato tiene un cierre sin reclamos emitido.');
    await db.$queryRaw`SELECT id FROM "Liquidacion" WHERE "anticipoAlquilerId" = ${id} ORDER BY id FOR UPDATE`;
    const rows = await db.liquidacion.findMany({ where: { anticipoAlquilerId: id }, include: { pagos: { where: { anuladoEn: null } }, pagosPropietario: { where: { anuladoEn: null } }, cobrosPropietario: { where: { anuladoEn: null } }, aplicacionesCredito: true, ajustes: true } });
    if (rows.some(row => row.fechaLiquidacion || row.pagos.length || row.pagosPropietario.length || row.cobrosPropietario.length || row.aplicacionesCredito.length || row.ajustes.length)) fail('El anticipo ya tiene períodos cerrados, cobros, pagos o ajustes. Revertí las operaciones relacionadas antes de anularlo.');
    const cancelled = await db.anticipoAlquiler.update({ where: { id }, data: { anuladoEn: new Date(), motivoAnulacion: motivo } });
    for (const row of rows) {
        await applyRentPrepayment(db, row.id);
        await refreshPrepaymentStates(db, row.id);
        if (row.estado === 'CONFIRMADA') await createLiquidationVoucherSnapshot({ tx: db, inmobiliariaId, usuarioId, liquidacionId: row.id, evento: 'ANULACION_ANTICIPO' });
    }
    await auditService.log({ inmobiliariaId, usuarioId, accion: 'ANULAR_ALQUILER_ANTICIPADO', entidad: 'Contrato', entidadId: advance.contratoId, detalle: `Anticipo #${id}: ${motivo}` }, db);
    return cancelled;
}
