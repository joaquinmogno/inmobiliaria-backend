import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { parseDateOnly } from '../utils/argentina-date';
import type { FiltroControlInterno } from '../validation/control-interno.schemas';

export const internalMovementInclude = {
    creadoPor: { select: { id: true, nombreCompleto: true } },
    actualizadoPor: { select: { id: true, nombreCompleto: true } },
    anuladoPor: { select: { id: true, nombreCompleto: true } },
    adjuntos: {
        select: { id: true, nombreArchivo: true, tipoContenido: true, tamano: true, fechaCreacion: true, creadoPor: { select: { id: true, nombreCompleto: true } } },
        orderBy: { id: 'asc' as const }
    }
} satisfies Prisma.MovimientoInternoInclude;

export type InternalMovementRow = Prisma.MovimientoInternoGetPayload<{ include: typeof internalMovementInclude }>;

export function internalMovementWhere(inmobiliariaId: number, filters: FiltroControlInterno): Prisma.MovimientoInternoWhereInput {
    const start = parseDateOnly(`${filters.periodo}-01`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    return {
        inmobiliariaId,
        fecha: { gte: start, lt: end },
        ...(filters.estado === 'TODOS' ? {} : { anuladoEn: filters.estado === 'ANULADOS' ? { not: null } : null }),
        ...(filters.tipo ? { tipo: filters.tipo } : {}),
        ...(filters.moneda ? { moneda: filters.moneda } : {}),
        ...(filters.categoria ? { categoria: filters.categoria } : {}),
        ...(filters.metodoPago ? { metodoPago: filters.metodoPago } : {}),
        ...(filters.creadoPorId ? { creadoPorId: filters.creadoPorId } : {}),
        ...(filters.search ? { OR: ['detalle', 'observaciones'].map(field => ({ [field]: { contains: filters.search, mode: 'insensitive' } })) } : {})
    };
}

export type InternalCurrencyTotal = { moneda: 'ARS' | 'USD'; ingresos: number; gastos: number; diferencia: number };
export function summarizeInternalMovements(rows: Array<{ tipo: string; moneda: string; monto: Decimal | number | string; anuladoEn?: Date | null }>): InternalCurrencyTotal[] {
    return (['ARS', 'USD'] as const).map(moneda => {
        const active = rows.filter(row => !row.anuladoEn && row.moneda === moneda);
        const total = (tipo: string) => active.filter(row => row.tipo === tipo).reduce((sum, row) => sum.plus(row.monto), new Decimal(0));
        const ingresos = total('INGRESO');
        const gastos = total('GASTO');
        return { moneda, ingresos: ingresos.toNumber(), gastos: gastos.toNumber(), diferencia: ingresos.minus(gastos).toNumber() };
    });
}

export const internalReportFilterLabel = (filters: FiltroControlInterno) => [
    `Mes: ${filters.periodo}`, `Estado: ${filters.estado}`, filters.tipo && `Tipo: ${filters.tipo}`,
    filters.moneda && `Moneda: ${filters.moneda}`, filters.categoria && `Categoría: ${filters.categoria}`,
    filters.metodoPago && `Medio: ${filters.metodoPago}`, filters.search && `Búsqueda: ${filters.search}`,
    filters.creadoPorId && `Usuario: #${filters.creadoPorId}`
].filter(Boolean).join(' · ');
