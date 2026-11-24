import { prisma } from '../prisma';
import { AppError } from '../errors/app-error';
import { auditService } from './audit.service';

export const personalCopySelect = { id: true, ambito: true, fecha: true, detalle: true, anuladoEn: true } as const;

export async function copyCashMovement(input: {
    movimientoId: number; inmobiliariaId: number; usuarioId: number; destino: 'TEODORO' | 'DANIEL';
}) {
    return prisma.$transaction(async tx => {
        // Serializa los reintentos y las copias concurrentes sobre el mismo origen.
        const rows = await tx.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM "MovimientoCaja"
            WHERE id = ${input.movimientoId} AND "inmobiliariaId" = ${input.inmobiliariaId}
            FOR UPDATE`;
        if (!rows.length) throw new AppError('Movimiento no encontrado', { statusCode: 404 });
        const existing = await tx.movimientoInterno.findUnique({
            where: { movimientoCajaOrigenId_ambito: { movimientoCajaOrigenId: input.movimientoId, ambito: input.destino } },
            select: personalCopySelect
        });
        // Incluso una copia anulada conserva su vínculo y no se vuelve a crear.
        if (existing) return { copia: existing, creada: false };
        const source = await tx.movimientoCaja.findUniqueOrThrow({
            where: { id: input.movimientoId }, include: { cuentaBancaria: true, reversion: { select: { id: true } } }
        });
        if (source.anuladoEn || source.reversionDeId || source.reversion || source.transferenciaInternaId) {
            throw new AppError('Sólo se pueden duplicar movimientos vigentes que no sean transferencias internas ni reversiones.', { statusCode: 409 });
        }
        if (!source.monto.greaterThan(0)) throw new AppError('El movimiento debe tener un importe mayor a cero.', { statusCode: 409 });
        const copy = await tx.movimientoInterno.create({
            data: {
                movimientoCajaOrigenId: source.id,
                inmobiliariaId: input.inmobiliariaId, creadoPorId: input.usuarioId, ambito: input.destino,
                fecha: source.fecha, tipo: source.tipo === 'INGRESO' ? 'INGRESO' : 'GASTO',
                detalle: source.concepto, monto: source.monto, moneda: source.moneda,
                metodoPago: source.metodoPago === 'TARJETA_CREDITO' ? 'Tarjeta de crédito' : source.metodoPago,
                // La tarjeta de caja no pertenece al catálogo de la carpeta personal.
                tarjetaDescripcion: source.tarjetaDescripcion,
                cuentaPago: source.cuentaBancaria
                    ? `${source.cuentaBancaria.banco} · ${source.cuentaBancaria.nombre} (${source.moneda})`.slice(0, 220)
                    : source.cuenta === 'BANCO' ? 'Banco histórico' : source.cuenta === 'CAJA' ? 'Caja' : null,
                observaciones: source.observaciones?.slice(0, 2000) || null
            }, select: personalCopySelect
        });
        await auditService.log({
            usuarioId: input.usuarioId, inmobiliariaId: input.inmobiliariaId,
            accion: `DUPLICAR_MOVIMIENTO_CAJA_${input.destino}`,
            entidad: input.destino === 'TEODORO' ? 'MovimientoTeodoro' : 'MovimientoDaniel', entidadId: copy.id,
            detalle: JSON.stringify({ movimientoCajaOrigenId: source.id, monto: source.monto, moneda: source.moneda })
        }, tx);
        return { copia: copy, creada: true };
    });
}
