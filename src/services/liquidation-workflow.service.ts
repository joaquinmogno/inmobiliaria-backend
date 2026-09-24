import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../prisma';
import { acquireInstallationLock, INSTALLATION_LOCKS } from '../utils/advisory-lock';
import { assertSameCurrency } from './currency-rules.service';
import {
    assertValidLiquidationTotals,
    calculateLiquidationTotals,
    getEffectiveRentForPeriod,
    getLiquidationDueDate,
    recalculateLiquidationTotals
} from './liquidacion-financial.service';
import { getMonthlyLiquidationPreparation } from './liquidation-preparation.service';

export type MonthlyGenerationSelection = {
    contratoId: number;
    contratoVersion?: number;
    cuotasVencidasIds?: number[];
    cuotasVencidasRevisadas?: boolean;
};

const monthEnd = (period: Date) => new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0));

export async function generateMonthlyLiquidations(params: {
    inmobiliariaId: number;
    usuarioId: number;
    period: Date;
    selections?: MonthlyGenerationSelection[];
    contratoIds?: number[];
}) {
    const preparation = await getMonthlyLiquidationPreparation(params.inmobiliariaId, params.period);
    const byId = new Map(preparation.data.map(row => [row.contratoId, row]));
    const requestedSelections: MonthlyGenerationSelection[] = params.selections?.length
        ? params.selections
        : params.contratoIds?.length
            ? params.contratoIds.map(contratoId => ({ contratoId }))
            : preparation.data.filter(row => row.status === 'LISTA').map(row => ({
                contratoId: row.contratoId,
                contratoVersion: row.contratoVersion
            }));

    const skipped: Array<{
        contratoId: number;
        status: string;
        motivos: string[];
        liquidacionId: number | null;
    }> = [];
    const eligible: MonthlyGenerationSelection[] = [];

    for (const selection of requestedSelections) {
        const row = byId.get(selection.contratoId);
        if (!row) {
            skipped.push({ contratoId: selection.contratoId, status: 'NO_ELEGIBLE', motivos: ['El contrato no corresponde al período'], liquidacionId: null });
            continue;
        }
        const overdueResolved = row.puedeGenerarseAlResolverCuotas && selection.cuotasVencidasRevisadas === true;
        if (row.status !== 'LISTA' && !overdueResolved) {
            skipped.push({ contratoId: row.contratoId, status: row.status, motivos: row.motivos, liquidacionId: row.liquidacionId });
            continue;
        }
        eligible.push(selection);
    }

    if (!eligible.length) return { created: [], skipped };

    const created = await prisma.$transaction(async tx => {
        await acquireInstallationLock(tx, INSTALLATION_LOCKS.monthlyLiquidations, params.inmobiliariaId);
        const result: Array<{ contratoId: number; liquidacionId: number }> = [];
        const end = monthEnd(params.period);

        for (const selection of eligible) {
            const contract = await tx.contrato.findFirst({
                where: {
                    id: selection.contratoId,
                    inmobiliariaId: params.inmobiliariaId,
                    administrado: true,
                    estado: 'ACTIVO',
                    eliminadoEn: null,
                    fechaInicio: { lte: end },
                    fechaFin: { gte: params.period }
                },
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } },
                    actualizaciones: {
                        select: { fechaActualizacion: true, montoAnterior: true },
                        orderBy: { fechaActualizacion: 'desc' }
                    },
                    planesCuotas: {
                        where: { estado: 'VIGENTE' },
                        include: { cuotas: { where: { estado: 'PENDIENTE', liquidacionId: null, movimientoId: null, fechaVencimiento: { lte: end } } } }
                    }
                }
            });
            if (!contract) {
                throw Object.assign(new Error('Un contrato dejó de estar disponible. Actualizá la preparación mensual'), { statusCode: 409, code: 'CONTRACT_CHANGED' });
            }
            if (selection.contratoVersion !== undefined && contract.version !== selection.contratoVersion) {
                throw Object.assign(new Error(`El contrato de ${contract.propiedad.direccion} cambió mientras estabas trabajando. Revisalo nuevamente`), { statusCode: 409, code: 'CONTRACT_CHANGED' });
            }
            if (contract.inquilinos.length !== 1 || contract.propietarios.length !== 1) {
                throw Object.assign(new Error(`El contrato de ${contract.propiedad.direccion} debe tener un único inquilino y propietario principal`), { statusCode: 409, code: 'CONTRACT_PARTIES_CHANGED' });
            }

            const existing = await tx.liquidacion.findUnique({
                where: { contratoId_periodo: { contratoId: contract.id, periodo: params.period } },
                select: { id: true }
            });
            if (existing) {
                skipped.push({ contratoId: contract.id, status: 'GENERADA', motivos: ['La liquidación ya existe'], liquidacionId: existing.id });
                continue;
            }

            const effectiveRent = getEffectiveRentForPeriod(contract.montoAlquiler, contract.actualizaciones, params.period);
            const fee = contract.porcentajeHonorarios !== null
                ? effectiveRent.mul(contract.porcentajeHonorarios).div(100)
                : new Decimal(contract.montoHonorarios.toString());
            const installments = contract.planesCuotas.flatMap(plan => plan.cuotas.map(installment => ({ installment, plan })));
            const currentInstallments = installments.filter(({ installment }) => installment.fechaVencimiento >= params.period && installment.fechaVencimiento <= end);
            const overdueIds = new Set(selection.cuotasVencidasIds || []);
            const selectedOverdue = installments.filter(({ installment }) => installment.fechaVencimiento < params.period && overdueIds.has(installment.id));
            if (overdueIds.size !== selectedOverdue.length) {
                throw Object.assign(new Error('Una cuota vencida elegida ya no está disponible'), { statusCode: 409, code: 'INSTALLMENT_CHANGED' });
            }
            const selectedInstallments = [...currentInstallments, ...selectedOverdue];
            selectedInstallments.forEach(({ installment, plan }) => {
                assertSameCurrency(installment.moneda, contract.moneda, 'Hay una cuota con moneda incompatible');
                assertSameCurrency(plan.moneda, contract.moneda, 'Hay un plan de cuotas con moneda incompatible');
            });
            assertValidLiquidationTotals(calculateLiquidationTotals({
                montoHonorarios: fee,
                pagaHonorarios: contract.pagaHonorarios
            }, [
                { tipo: 'INGRESO', monto: effectiveRent, esParaInmobiliaria: false },
                ...selectedInstallments.map(({ installment, plan }) => ({
                    tipo: plan.tipoMovimiento,
                    monto: installment.monto,
                    esParaInmobiliaria: plan.esParaInmobiliaria
                }))
            ]));

            const owner = contract.propietarios[0].persona;
            const tenant = contract.inquilinos[0].persona;
            const draft = await tx.liquidacion.create({
                data: {
                    periodo: params.period,
                    fechaVencimiento: getLiquidationDueDate(params.period, contract.diaVencimiento),
                    estado: 'BORRADOR',
                    contratoId: contract.id,
                    inmobiliariaId: params.inmobiliariaId,
                    creadoPorId: params.usuarioId,
                    montoHonorarios: fee,
                    porcentajeHonorarios: contract.porcentajeHonorarios,
                    montoAlquilerBase: effectiveRent,
                    moneda: contract.moneda,
                    pagaHonorarios: contract.pagaHonorarios,
                    propiedadDireccion: contract.propiedad.direccion,
                    inquilinoNombre: tenant.nombreCompleto,
                    propietarioPagoId: owner.id,
                    propietarioNombre: owner.nombreCompleto
                }
            });
            await tx.movimiento.create({
                data: {
                    tipo: 'INGRESO',
                    concepto: 'Alquiler Mensual',
                    monto: effectiveRent,
                    moneda: contract.moneda,
                    liquidacionId: draft.id
                }
            });
            for (const { installment, plan } of selectedInstallments) {
                const claimed = await tx.cuotaPlan.updateMany({
                    where: { id: installment.id, estado: 'PENDIENTE', liquidacionId: null, movimientoId: null },
                    data: { liquidacionId: draft.id }
                });
                if (claimed.count !== 1) {
                    throw Object.assign(new Error('Una cuota fue utilizada por otra operación'), { statusCode: 409, code: 'INSTALLMENT_ALREADY_CLAIMED' });
                }
                const movement = await tx.movimiento.create({
                    data: {
                        tipo: plan.tipoMovimiento,
                        concepto: `${plan.concepto} (Cuota ${installment.numeroCuota})`,
                        monto: installment.monto,
                        moneda: contract.moneda,
                        liquidacionId: draft.id,
                        esParaInmobiliaria: plan.esParaInmobiliaria
                    }
                });
                await tx.cuotaPlan.update({ where: { id: installment.id }, data: { movimientoId: movement.id } });
            }
            const calculated = await recalculateLiquidationTotals(draft.id, tx);
            await tx.decisionLiquidacionMensual.deleteMany({ where: { contratoId: contract.id, periodo: params.period } });
            await tx.auditLog.create({
                data: {
                    usuarioId: params.usuarioId,
                    inmobiliariaId: params.inmobiliariaId,
                    accion: 'CREAR_LIQUIDACION_MENSUAL',
                    entidad: 'Liquidacion',
                    entidadId: draft.id,
                    detalle: JSON.stringify({
                        contratoId: contract.id,
                        periodo: params.period.toISOString().slice(0, 10),
                        cuotasPeriodoIds: currentInstallments.map(item => item.installment.id),
                        cuotasVencidasIncluidasIds: selectedOverdue.map(item => item.installment.id),
                        totalInquilino: calculated.netoACobrar.toString(),
                        totalPropietario: calculated.montoPropietario.toString(),
                        moneda: contract.moneda
                    })
                }
            });
            result.push({ contratoId: contract.id, liquidacionId: draft.id });
        }

        await tx.auditLog.create({
            data: {
                usuarioId: params.usuarioId,
                inmobiliariaId: params.inmobiliariaId,
                accion: 'GENERAR_LIQUIDACIONES_PERIODO',
                entidad: 'Liquidacion',
                detalle: JSON.stringify({ periodo: params.period.toISOString().slice(0, 10), creadas: result, omitidas: skipped }),
                resultado: 'EXITO'
            }
        });
        return result;
    // El advisory lock serializa la generación mensual por instalación. Con READ COMMITTED,
    // quien espera el lock ve la liquidación confirmada por la solicitud anterior y puede
    // responder de forma idempotente, en lugar de abortar por un snapshot serializable viejo.
    }, { isolationLevel: 'ReadCommitted' });

    return { created, skipped };
}
