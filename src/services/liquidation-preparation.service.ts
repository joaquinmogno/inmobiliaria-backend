import { Decimal } from '@prisma/client/runtime/library';
import { EstadoContrato } from '@prisma/client';
import { prisma } from '../prisma';
import { argentinaTodayAsDate } from '../utils/argentina-date';
import {
    assertValidLiquidationTotals,
    calculateLiquidationTotals,
    getEffectiveRentForPeriod,
    getLiquidationDueDate
} from './liquidacion-financial.service';

export type MonthlyPreparationStatus = 'LISTA' | 'REVISAR' | 'GENERADA' | 'NO_ELEGIBLE';

export type PreparationIssue = {
    codigo: string;
    mensaje: string;
    accion: 'REVISAR_CONTRATO' | 'REVISAR_CUOTAS' | 'VER_LIQUIDACION' | null;
    etiquetaAccion: string | null;
};

const periodEnd = (period: Date) => new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0));

const stateLabel: Record<EstadoContrato, string> = {
    PROGRAMADO: 'programado',
    ACTIVO: 'activo',
    PAPELERA: 'en papelera',
    FINALIZADO: 'finalizado',
    RESCINDIDO: 'rescindido'
};

const issue = (
    codigo: string,
    mensaje: string,
    accion: PreparationIssue['accion'] = null,
    etiquetaAccion: string | null = null
): PreparationIssue => ({ codigo, mensaje, accion, etiquetaAccion });

export const getMonthlyLiquidationPreparation = async (inmobiliariaId: number, period: Date) => {
    const end = periodEnd(period);
    const contracts = await prisma.contrato.findMany({
        where: {
            inmobiliariaId,
            eliminadoEn: null,
            fechaInicio: { lte: end },
            fechaFin: { gte: period }
        },
        include: {
            propiedad: true,
            inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
            propietarios: { where: { esPrincipal: true }, include: { persona: true } },
            actualizaciones: {
                select: { fechaActualizacion: true, montoAnterior: true },
                orderBy: { fechaActualizacion: 'desc' }
            },
            liquidaciones: {
                where: { periodo: period },
                take: 1,
                include: {
                    pagos: { where: { anuladoEn: null }, select: { monto: true } },
                    propietarioPago: { select: { id: true, nombreCompleto: true } }
                }
            },
            decisionesLiquidacion: { where: { periodo: period }, take: 1 },
            planesCuotas: {
                where: { estado: 'VIGENTE' },
                include: {
                    cuotas: {
                        where: { estado: 'PENDIENTE', liquidacionId: null, fechaVencimiento: { lte: end } },
                        select: { id: true, fechaVencimiento: true, monto: true, moneda: true, numeroCuota: true }
                    }
                }
            }
        },
        orderBy: [{ propiedad: { direccion: 'asc' } }, { id: 'asc' }]
    });

    const rows = contracts.map(contract => {
        const existing = contract.liquidaciones[0];
        const decision = contract.decisionesLiquidacion[0];
        const problemas: PreparationIssue[] = [];
        let status: MonthlyPreparationStatus = 'LISTA';
        const effectiveRent = getEffectiveRentForPeriod(contract.montoAlquiler, contract.actualizaciones, period);
        const fee = contract.porcentajeHonorarios !== null
            ? effectiveRent.mul(contract.porcentajeHonorarios).div(100)
            : new Decimal(contract.montoHonorarios.toString());
        const availableInstallments = contract.planesCuotas.flatMap(plan =>
            plan.cuotas.map(installment => ({ installment, plan }))
        );
        const currentInstallments = availableInstallments.filter(({ installment }) =>
            installment.fechaVencimiento >= period && installment.fechaVencimiento <= end
        );
        const overdueInstallments = availableInstallments.filter(({ installment }) => installment.fechaVencimiento < period);

        if (existing) {
            status = 'GENERADA';
            problemas.push(issue('ALREADY_GENERATED', 'La liquidación de este período ya fue generada', 'VER_LIQUIDACION', 'Abrir liquidación'));
        } else if (decision) {
            status = 'NO_ELEGIBLE';
            problemas.push(issue('DISMISSED_FOR_PERIOD', `Omitida conscientemente: ${decision.motivo}`));
        } else if (!contract.administrado) {
            status = 'NO_ELEGIBLE';
            problemas.push(issue('CONTRACT_NOT_MANAGED', 'El contrato no está marcado como administrado', 'REVISAR_CONTRATO', 'Revisar contrato'));
        } else if (contract.estado !== 'ACTIVO') {
            status = 'NO_ELEGIBLE';
            problemas.push(issue('CONTRACT_NOT_ACTIVE', `El contrato está ${stateLabel[contract.estado]} y no corresponde liquidarlo`, 'REVISAR_CONTRATO', 'Revisar contrato'));
        } else {
            if (contract.propietarios.length === 0) {
                problemas.push(issue('PRIMARY_OWNER_MISSING', 'Falta definir el propietario principal', 'REVISAR_CONTRATO', 'Definir propietario'));
            } else if (contract.propietarios.length > 1) {
                problemas.push(issue('MULTIPLE_PRIMARY_OWNERS', 'Hay más de un propietario marcado como principal', 'REVISAR_CONTRATO', 'Corregir propietarios'));
            }
            if (contract.inquilinos.length === 0) {
                problemas.push(issue('PRIMARY_TENANT_MISSING', 'Falta definir el inquilino principal', 'REVISAR_CONTRATO', 'Definir inquilino'));
            } else if (contract.inquilinos.length > 1) {
                problemas.push(issue('MULTIPLE_PRIMARY_TENANTS', 'Hay más de un inquilino marcado como principal', 'REVISAR_CONTRATO', 'Corregir inquilinos'));
            }
            if (effectiveRent.lessThanOrEqualTo(0)) {
                problemas.push(issue('INVALID_RENT', 'El alquiler vigente debe ser mayor que cero', 'REVISAR_CONTRATO', 'Corregir importe'));
            }
            if (fee.lessThan(0)) {
                problemas.push(issue('INVALID_FEE', 'Los honorarios no pueden ser negativos', 'REVISAR_CONTRATO', 'Corregir honorarios'));
            }
            if (contract.porcentajeHonorarios && contract.porcentajeHonorarios.greaterThan(100)) {
                problemas.push(issue('INVALID_FEE_PERCENTAGE', 'El porcentaje de honorarios no puede superar el 100 %', 'REVISAR_CONTRATO', 'Corregir honorarios'));
            }
            currentInstallments.forEach(({ installment, plan }) => {
                if (installment.moneda !== contract.moneda || plan.moneda !== contract.moneda) {
                    problemas.push(issue('INSTALLMENT_CURRENCY_MISMATCH', `La cuota ${installment.numeroCuota} de “${plan.concepto}” tiene una moneda incompatible`, 'REVISAR_CONTRATO', 'Revisar plan de cuotas'));
                }
            });
            try {
                assertValidLiquidationTotals(calculateLiquidationTotals({
                    montoHonorarios: fee,
                    pagaHonorarios: contract.pagaHonorarios
                }, [
                    { tipo: 'INGRESO', monto: effectiveRent, esParaInmobiliaria: false },
                    ...currentInstallments.map(({ installment, plan }) => ({
                        tipo: plan.tipoMovimiento,
                        monto: installment.monto,
                        esParaInmobiliaria: plan.esParaInmobiliaria
                    }))
                ]));
            } catch (error) {
                problemas.push(issue('INVALID_TOTALS', error instanceof Error ? error.message : 'Los importes requieren revisión', 'REVISAR_CONTRATO', 'Revisar importes'));
            }
            if (overdueInstallments.length > 0) {
                problemas.push(issue(
                    'OVERDUE_INSTALLMENTS',
                    `Hay ${overdueInstallments.length} cuota(s) vencida(s). Elegí expresamente si deben incluirse`,
                    'REVISAR_CUOTAS',
                    'Decidir cuotas'
                ));
            }
            if (problemas.length) status = 'REVISAR';
        }

        const paid = existing?.pagos.reduce((sum, payment) => sum.plus(payment.monto), new Decimal(0)) || new Decimal(0);
        const remaining = existing ? Decimal.max(new Decimal(existing.netoACobrar.toString()).minus(paid), 0) : new Decimal(0);
        const onlyOverdueInstallments = status === 'REVISAR'
            && problemas.every(problem => problem.codigo === 'OVERDUE_INSTALLMENTS');

        const mapInstallment = ({ installment, plan }: typeof availableInstallments[number]) => ({
            id: installment.id,
            numeroCuota: installment.numeroCuota,
            concepto: plan.concepto,
            fechaVencimiento: installment.fechaVencimiento,
            monto: installment.monto.toString(),
            moneda: installment.moneda,
            tipoMovimiento: plan.tipoMovimiento,
            esParaInmobiliaria: plan.esParaInmobiliaria
        });

        return {
            contratoId: contract.id,
            contratoVersion: contract.version,
            status,
            motivos: problemas.map(problem => problem.mensaje),
            problemas,
            descartada: Boolean(decision),
            puedeGenerarseAlResolverCuotas: onlyOverdueInstallments,
            liquidacionId: existing?.id || null,
            estadoLiquidacion: existing?.estado || null,
            estadoCobroInquilino: existing?.estadoCobroInquilino || null,
            estadoPagoPropietario: existing?.estadoPagoPropietario || null,
            proximaAccion: existing?.estado === 'BORRADOR' ? 'Revisar borrador'
                : existing?.estado === 'CONFIRMADA' && existing.estadoCobroInquilino !== 'COBRADO' ? 'Registrar cobro del inquilino'
                    : existing?.estado === 'CONFIRMADA' && existing.estadoPagoPropietario !== 'PAGADO' ? `Pagar a ${existing.propietarioNombre || contract.propietarios[0]?.persona.nombreCompleto || 'propietario'}`
                        : existing?.estado === 'CONFIRMADA' ? 'Ver comprobantes'
                            : status === 'LISTA' ? 'Generar borrador'
                                : status === 'REVISAR' ? 'Resolver excepción'
                                    : 'Sin acción pendiente',
            fechaVencimiento: existing?.fechaVencimiento || getLiquidationDueDate(period, contract.diaVencimiento),
            montoAlquiler: effectiveRent.toString(),
            montoHonorarios: fee.toString(),
            totalLiquidacion: existing?.netoACobrar.toString() || null,
            pagado: paid.toString(),
            pendiente: remaining.toString(),
            vencida: Boolean(existing?.estado === 'CONFIRMADA' && existing.estadoCobroInquilino !== 'COBRADO' && existing.fechaVencimiento && existing.fechaVencimiento < argentinaTodayAsDate()),
            cuotasPeriodo: currentInstallments.map(mapInstallment),
            cuotasVencidas: overdueInstallments.map(mapInstallment),
            moneda: contract.moneda,
            propiedad: {
                id: contract.propiedad.id,
                direccion: contract.propiedad.direccion,
                piso: contract.propiedad.piso,
                departamento: contract.propiedad.departamento
            },
            inquilino: contract.inquilinos[0]?.persona || null,
            propietario: existing?.propietarioPago || contract.propietarios[0]?.persona || null
        };
    });

    return {
        periodo: period,
        resumen: {
            total: rows.length,
            pendientesGenerar: rows.filter(row => row.status === 'LISTA').length,
            borradores: rows.filter(row => row.estadoLiquidacion === 'BORRADOR').length,
            pendientesCobro: rows.filter(row => row.estadoLiquidacion === 'CONFIRMADA' && row.estadoCobroInquilino !== 'COBRADO').length,
            pendientesPagoPropietario: rows.filter(row => row.estadoLiquidacion === 'CONFIRMADA' && row.estadoPagoPropietario !== 'PAGADO').length,
            finalizadas: rows.filter(row => row.estadoLiquidacion === 'CONFIRMADA' && row.estadoCobroInquilino === 'COBRADO' && row.estadoPagoPropietario === 'PAGADO').length,
            revisar: rows.filter(row => row.status === 'REVISAR').length,
            noElegibles: rows.filter(row => row.status === 'NO_ELEGIBLE').length,
            listas: rows.filter(row => row.status === 'LISTA').length,
            generadas: rows.filter(row => row.status === 'GENERADA').length
        },
        data: rows
    };
};
