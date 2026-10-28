import { Decimal } from '@prisma/client/runtime/library';
import { PagadorHonorarios, Prisma, TipoMovimiento } from '@prisma/client';
import { prisma } from '../prisma';
import { AppError } from '../errors/app-error';

export const buildLiquidationCashConcept = (tipo: string, liquidacion: any): string => {
    const address = liquidacion.contrato?.propiedad?.direccion || 'Sin dirección';
    const period = new Date(liquidacion.periodo)
        .toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `${tipo} - ${address} - Liq. ${period}`;
};

type FinancialMovement = {
    tipo: TipoMovimiento | string;
    monto: Prisma.Decimal | Decimal | number | string;
    esParaInmobiliaria: boolean;
};

type LiquidationTerms = {
    montoHonorarios: Prisma.Decimal | Decimal | number | string;
    pagaHonorarios: PagadorHonorarios | string;
};

export const calculateLiquidationTotals = (
    liquidacion: LiquidationTerms,
    movimientos: FinancialMovement[]
) => {
    let totalIngresos = new Decimal(0);
    let totalDescuentos = new Decimal(0);
    let totalDescuentosInquilino = new Decimal(0);
    let totalConceptosInmobiliaria = new Decimal(0);

    movimientos.forEach(movimiento => {
        const monto = new Decimal(movimiento.monto.toString());
        if (movimiento.tipo === 'INGRESO') {
            totalIngresos = totalIngresos.plus(monto);
        } else {
            totalDescuentos = totalDescuentos.plus(monto);
            if (!movimiento.esParaInmobiliaria) {
                totalDescuentosInquilino = totalDescuentosInquilino.plus(monto);
            }
        }
        if (movimiento.esParaInmobiliaria) {
            totalConceptosInmobiliaria = totalConceptosInmobiliaria.plus(monto);
        }
    });

    const montoHonorarios = new Decimal(liquidacion.montoHonorarios.toString());
    const honorariosInquilino = liquidacion.pagaHonorarios === 'INQUILINO'
        ? montoHonorarios
        : new Decimal(0);
    const netoACobrar = totalIngresos.minus(totalDescuentosInquilino).plus(honorariosInquilino);
    const montoPropietario = netoACobrar.minus(montoHonorarios).minus(totalConceptosInmobiliaria);

    return {
        totalIngresos,
        totalDescuentos,
        netoACobrar,
        montoPropietario
    };
};

export const assertValidLiquidationTotals = (totals: ReturnType<typeof calculateLiquidationTotals>) => {
    if (totals.netoACobrar.lessThan(0)) {
        throw Object.assign(
            new Error('Los descuentos no pueden superar el total a cobrar al inquilino'),
            { statusCode: 409, code: 'NEGATIVE_TENANT_TOTAL' }
        );
    }
    if (totals.montoPropietario.lessThan(0)) {
        throw Object.assign(
            new Error('Los honorarios y conceptos de la inmobiliaria no pueden superar el importe disponible para el propietario'),
            { statusCode: 409, code: 'NEGATIVE_OWNER_TOTAL' }
        );
    }
    return totals;
};

export const getLiquidationDueDate = (period: Date, dueDay: number) => {
    const year = period.getUTCFullYear();
    const month = period.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const normalizedDay = Math.min(Math.max(Math.trunc(dueDay || 1), 1), lastDay);
    return new Date(Date.UTC(year, month, normalizedDay));
};

type RentUpdate = {
    fechaActualizacion: Date;
    fechaVigencia?: Date | null;
    montoAnterior: Prisma.Decimal | Decimal | number | string;
};

const monthKey = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

/**
 * Reconstruye el alquiler vigente para el mes liquidado. Las actualizaciones
 * nuevas tienen vigencia explícita; las históricas conservan su fecha de carga.
 */
export const getEffectiveRentForPeriod = (
    currentRent: Prisma.Decimal | Decimal | number | string,
    updates: RentUpdate[],
    period: Date
) => {
    let effectiveRent = new Decimal(currentRent.toString());
    const targetMonth = monthKey(period);

    [...updates]
        .sort((a, b) => (b.fechaVigencia || b.fechaActualizacion).getTime() - (a.fechaVigencia || a.fechaActualizacion).getTime())
        .forEach(update => {
            if (targetMonth < monthKey(update.fechaVigencia || update.fechaActualizacion)) {
                effectiveRent = new Decimal(update.montoAnterior.toString());
            }
        });

    return effectiveRent;
};

export const recalculateLiquidationTotals = async (
    liquidacionId: number,
    db: Prisma.TransactionClient | typeof prisma = prisma
) => {
    const [liquidacion, movimientos] = await Promise.all([
        db.liquidacion.findUniqueOrThrow({
            where: { id: liquidacionId },
            select: { montoHonorarios: true, pagaHonorarios: true, moneda: true }
        }),
        db.movimiento.findMany({ where: { liquidacionId } })
    ]);
    // Los campos de totales históricos de Liquidacion representan la moneda
    // contractual. Los conceptos de una segunda moneda se exponen y liquidan
    // por separado, nunca se convierten ni se suman a este total.
    const movementsInContractCurrency = movimientos.filter(movement => movement.moneda === liquidacion.moneda);
    const totals = assertValidLiquidationTotals(calculateLiquidationTotals(liquidacion, movementsInContractCurrency));

    return db.liquidacion.update({
        where: { id: liquidacionId },
        data: {
            totalIngresos: totals.totalIngresos,
            totalDescuentos: totals.totalDescuentos,
            netoACobrar: totals.netoACobrar,
            montoPropietario: totals.montoPropietario
        },
        include: {
            movimientos: true,
            contrato: {
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                }
            }
        }
    });
};

/** Reemplaza el alquiler completo de un borrador y recalcula sus honorarios. */
export const replaceDraftMonthlyRent = async (
    db: Prisma.TransactionClient,
    draft: { id: number; inmobiliariaId: number; version: number; moneda: string; porcentajeHonorarios: Prisma.Decimal | number | null; montoHonorarios: Prisma.Decimal },
    rent: Decimal,
    options: { alquilerExcepcional: boolean; motivo: string }
) => {
    const rentMovements = await db.movimiento.findMany({
        where: { liquidacionId: draft.id, tipo: 'INGRESO', concepto: 'Alquiler Mensual' }
    });
    if (rentMovements.length !== 1 || rentMovements[0].moneda !== draft.moneda) {
        throw new AppError('El borrador debe tener un único concepto de alquiler mensual en la moneda del contrato. Revisalo antes de actualizar', {
            statusCode: 409, code: 'RENT_MOVEMENT_INVALID'
        });
    }
    const claimed = await db.liquidacion.updateMany({
        where: { id: draft.id, inmobiliariaId: draft.inmobiliariaId, estado: 'BORRADOR', version: draft.version },
        data: {
            montoAlquilerBase: rent,
            montoHonorarios: draft.porcentajeHonorarios == null
                ? draft.montoHonorarios
                : rent.mul(draft.porcentajeHonorarios).div(100).toDecimalPlaces(2),
            pagaHonorarios: 'PROPIETARIO',
            alquilerExcepcional: options.alquilerExcepcional,
            motivoCambioAlquiler: options.motivo,
            version: { increment: 1 }
        }
    });
    if (claimed.count !== 1) throw new AppError('Un borrador cambió mientras estabas trabajando. Actualizá la pantalla', { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
    await db.movimiento.update({ where: { id: rentMovements[0].id }, data: { monto: rent } });
    return recalculateLiquidationTotals(draft.id, db);
};
