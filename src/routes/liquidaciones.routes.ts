import { Router } from 'express';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { DestinoCreditoInquilino, EstadoCreditoInquilino, EstadoLiquidacion, OrigenPagoPropietario, Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import type PDFKit from 'pdfkit';
import { auditService } from '../services/audit.service';
import { validateBody } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { userHasPermission } from '../services/permissions.service';
import { getContractDebtSummary } from '../services/debt.service';
import { formatCurrency } from '../utils/currency';
import { assertSameCurrency } from '../services/currency-rules.service';
import { argentinaTodayAsDate, assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import {
    honorariosSchema,
    liquidacionCreateSchema,
    movimientoSchema,
    pagoPropietarioSchema,
    ajusteLiquidacionSchema,
    aplicarCreditoInquilinoSchema,
    anulacionPagoPropietarioSchema,
    generarPeriodoSchema,
    confirmacionLiquidacionSchema,
    decisionLiquidacionMensualSchema,
    reabrirDecisionLiquidacionMensualSchema
} from '../validation/liquidaciones.schemas';
import {
    buildLiquidationCashConcept,
    getEffectiveRentForPeriod,
    getLiquidationDueDate,
    recalculateLiquidationTotals
} from '../services/liquidacion-financial.service';
import { getMonthlyLiquidationPreparation } from '../services/liquidation-preparation.service';
import {
    drawDebtSummaryPdf,
    drawPaymentRowsPdf,
    ensurePdfSpace,
    formatCurrencyPdf,
    formatDatePdf,
    formatPeriodPdf
} from '../services/liquidacion-pdf.service';
import liquidationQueryRouter from './liquidaciones-query.routes';
import { generateMonthlyLiquidations } from '../services/liquidation-workflow.service';
import { assertCashPeriodOpen, prepareCashCorrection } from '../services/cash-closing.service';
import { getActiveOwnerPaymentSettlement, getAgencyAdvanceExposure, getOwnerPaymentSettlement, getOwnerPaymentState, getTenantCollectionState, getTenantSettlement } from '../services/tenant-credit.service';
import { syncInstallmentsForLiquidationSettlement } from '../services/installment-plan-lifecycle.service';
import { isValidBankAlias, isValidCbu, maskedBankDestination } from '../utils/bank-account';
import { getOutstandingOwnerAdvances } from '../services/owner-advance.service';
import {
    createLiquidationVoucherSnapshot,
    readLiquidationVoucherSnapshot,
    voucherSnapshotToPdfData
} from '../services/liquidation-voucher.service';
import { calculateLiquidationAdjustment } from '../services/liquidation-adjustment.service';

const router = Router();

const firstDayOfUtcMonth = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const requestedVoucherVersion = (value: unknown) => {
    if (value === undefined) return 1;
    const version = Number(value);
    if (!Number.isInteger(version) || version < 1) {
        throw Object.assign(new Error('La versión del comprobante no es válida'), { statusCode: 400, code: 'INVALID_VOUCHER_VERSION' });
    }
    return version;
};

const drawVoucherCorrectionsPdf = (
    doc: PDFKit.PDFDocument,
    initialY: number,
    pageWidth: number,
    snapshot: ReturnType<typeof readLiquidationVoucherSnapshot>,
    moneyPdf: (amount: number) => string,
    recipient: 'INQUILINO' | 'PROPIETARIO'
) => {
    if (!snapshot?.ajustes.length) return initialY;
    const original = recipient === 'INQUILINO'
        ? snapshot.totalesOriginales.netoACobrar
        : snapshot.totalesOriginales.montoPropietario;
    const corrected = recipient === 'INQUILINO'
        ? snapshot.liquidacion.totales.netoACobrar
        : snapshot.liquidacion.totales.montoPropietario;
    const impactKey = recipient === 'INQUILINO' ? 'impactoInquilino' : 'impactoPropietario';
    let y = ensurePdfSpace(doc, initialY, 105);
    const accent = recipient === 'INQUILINO' ? '#4F46E5' : '#0F766E';

    doc.fillColor(accent).fontSize(11).font('Helvetica-Bold')
        .text(`CORRECCIONES DEL COMPROBANTE · V${snapshot.version}`, 50, y);
    doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(accent).lineWidth(1).stroke();
    y += 22;
    doc.rect(50, y, pageWidth, 22).fill('#F8FAFC');
    doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold')
        .text('IMPORTE ORIGINAL', 58, y + 7)
        .text(moneyPdf(original), 50 + pageWidth - 120, y + 7, { width: 110, align: 'right' });
    y += 28;

    snapshot.ajustes.forEach(ajuste => {
        y = ensurePdfSpace(doc, y, 54);
        const impact = ajuste[impactKey];
        const documentedAmount = recipient === 'INQUILINO'
            ? (ajuste.montoInquilino ?? Math.abs(impact))
            : (ajuste.montoPropietario ?? Math.abs(impact));
        const sign = ajuste.tipo === 'CREDITO' ? '−' : '+';
        doc.fillColor('#111827').fontSize(9).font('Helvetica-Bold')
            .text(`${ajuste.tipo === 'CREDITO' ? 'Nota de crédito' : 'Nota de débito'} #${ajuste.id}: ${ajuste.concepto}`, 58, y, { width: pageWidth - 145 });
        doc.fillColor(ajuste.tipo === 'DEBITO' ? '#065F46' : '#991B1B').text(`${sign}${moneyPdf(documentedAmount)}`, 50 + pageWidth - 100, y, { width: 90, align: 'right' });
        doc.fillColor('#4B5563').font('Helvetica')
            .text(`Motivo: ${ajuste.motivo}`, 58, y + 13, { width: pageWidth - 16 })
            .text(`Emitido por ${ajuste.creadoPor.nombreCompleto} · ${formatDatePdf(ajuste.fechaCreacion)}`, 58, y + 26, { width: pageWidth - 16 });
        y += 42;
    });

    y = ensurePdfSpace(doc, y, 30);
    doc.rect(50, y, pageWidth, 24).fill(accent);
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('TOTAL CORREGIDO', 58, y + 7)
        .text(moneyPdf(corrected), 50 + pageWidth - 120, y + 7, { width: 110, align: 'right' });
    return y + 36;
};

const applyTenantCredit = async ({
    tx,
    creditId,
    liquidacionDestinoId,
    montoSolicitado,
    inmobiliariaId,
    usuarioId
}: {
    tx: Prisma.TransactionClient;
    creditId: number;
    liquidacionDestinoId: number;
    montoSolicitado: Decimal;
    inmobiliariaId: number;
    usuarioId: number;
}) => {
    const credit = await tx.creditoInquilino.findFirst({
        where: { id: creditId, inmobiliariaId, estado: EstadoCreditoInquilino.DISPONIBLE },
        include: { liquidacionOrigen: { select: { id: true } } }
    });
    if (!credit) throw Object.assign(new Error('El saldo a favor no está disponible'), { statusCode: 409, code: 'TENANT_CREDIT_NOT_AVAILABLE' });
    if (credit.liquidacionOrigenId === liquidacionDestinoId) {
        throw Object.assign(new Error('El saldo a favor debe aplicarse a otra liquidación'), { statusCode: 409, code: 'TENANT_CREDIT_SAME_LIQUIDATION' });
    }

    const target = await tx.liquidacion.findFirst({
        where: {
            id: liquidacionDestinoId,
            inmobiliariaId,
            contratoId: credit.contratoId,
            moneda: credit.moneda,
            estado: EstadoLiquidacion.CONFIRMADA
        },
        include: { pagos: { where: { anuladoEn: null } }, aplicacionesCredito: true }
    });
    if (!target) throw Object.assign(new Error('La liquidación destino no corresponde al mismo contrato, moneda o estado'), { statusCode: 409, code: 'TENANT_CREDIT_INVALID_TARGET' });

    const { saldo: saldoDestino } = getTenantSettlement(target);
    if (saldoDestino.lessThanOrEqualTo(0)) throw Object.assign(new Error('La liquidación destino no tiene saldo pendiente'), { statusCode: 409, code: 'TENANT_CREDIT_TARGET_WITHOUT_DEBT' });
    if (montoSolicitado.greaterThan(credit.saldoPendiente) || montoSolicitado.greaterThan(saldoDestino)) {
        throw Object.assign(new Error(`El importe supera el saldo a favor o la deuda de destino (${formatCurrency(Decimal.min(credit.saldoPendiente, saldoDestino).toString(), credit.moneda)})`), { statusCode: 409, code: 'TENANT_CREDIT_AMOUNT_EXCEEDS_BALANCE' });
    }

    const application = await tx.aplicacionCreditoInquilino.create({
        data: { creditoInquilinoId: credit.id, liquidacionId: target.id, monto: montoSolicitado, creadoPorId: usuarioId }
    });
    const nuevoSaldoCredito = new Decimal(credit.saldoPendiente.toString()).minus(montoSolicitado);
    await tx.creditoInquilino.update({
        where: { id: credit.id },
        data: {
            saldoPendiente: nuevoSaldoCredito,
            estado: nuevoSaldoCredito.isZero() ? EstadoCreditoInquilino.APLICADO : EstadoCreditoInquilino.DISPONIBLE
        }
    });
    await tx.liquidacion.update({
        where: { id: target.id },
        data: {
            estadoCobroInquilino: getTenantCollectionState({
                ...target,
                aplicacionesCredito: [...target.aplicacionesCredito, application]
            }),
            version: { increment: 1 }
        }
    });
    await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId: target.id, usuarioId });

    return { application, target, nuevoSaldoCredito };
};

const releaseCreditApplicationsForCorrection = async ({
    tx,
    liquidacionId,
    montoALiberar
}: {
    tx: Prisma.TransactionClient;
    liquidacionId: number;
    montoALiberar: Decimal;
}) => {
    let restante = montoALiberar;
    const applications = await tx.aplicacionCreditoInquilino.findMany({
        where: { liquidacionId },
        include: { creditoInquilino: true },
        orderBy: [{ fechaAplicacion: 'desc' }, { id: 'desc' }]
    });

    for (const application of applications) {
        if (restante.lessThanOrEqualTo(0)) break;
        const montoAplicado = new Decimal(application.monto.toString());
        const montoALiberarDeAplicacion = Decimal.min(restante, montoAplicado);
        const saldoAplicacion = montoAplicado.minus(montoALiberarDeAplicacion);
        if (saldoAplicacion.isZero()) {
            await tx.aplicacionCreditoInquilino.delete({ where: { id: application.id } });
        } else {
            await tx.aplicacionCreditoInquilino.update({ where: { id: application.id }, data: { monto: saldoAplicacion } });
        }
        await tx.creditoInquilino.update({
            where: { id: application.creditoInquilinoId },
            data: {
                saldoPendiente: { increment: montoALiberarDeAplicacion },
                estado: EstadoCreditoInquilino.DISPONIBLE
            }
        });
        restante = restante.minus(montoALiberarDeAplicacion);
    }
    if (restante.greaterThan(0)) {
        throw Object.assign(new Error('No se pudo liberar el saldo a favor aplicado'), { statusCode: 409, code: 'TENANT_CREDIT_RELEASE_INCOMPLETE' });
    }
};

router.use(authenticateToken);
router.use(liquidationQueryRouter);

// Preparación mensual idempotente: genera únicamente contratos listos y deja
// las excepciones para revisión individual.
router.post('/generar-periodo', requirePermission('liquidaciones.crear'), validateBody(generarPeriodoSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { periodo, contratoIds, selecciones } = req.body;
    const liquidationPeriod = parseDateOnly(periodo);

    try {
        const { created, skipped } = await generateMonthlyLiquidations({
            inmobiliariaId,
            usuarioId,
            period: liquidationPeriod,
            contratoIds,
            selections: selecciones
        });
        invalidatePerformanceCache(inmobiliariaId);
        res.status(created.length ? 201 : 200).json({ periodo, created, skipped });
    } catch (error: any) {
        console.error('Error generating monthly liquidations:', error);
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'GENERAR_LIQUIDACIONES_PERIODO', entidad: 'Liquidacion',
            detalle: JSON.stringify({ periodo, error: error.message, code: error.code }), resultado: 'FALLIDO', severidad: 'WARNING'
        });
        res.status(error.statusCode || 500).json({ message: error.message || 'No se pudieron generar las liquidaciones del período', code: error.code });
    }
});

router.post('/preparacion/descartar', requirePermission('liquidaciones.crear'), validateBody(decisionLiquidacionMensualSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const contratoId = Number(req.body.contratoId);
    const period = parseDateOnly(req.body.periodo);
    const contract = await prisma.contrato.findFirst({ where: { id: contratoId, inmobiliariaId }, select: { id: true } });
    if (!contract) return res.status(404).json({ message: 'Contrato no encontrado' });
    const existing = await prisma.liquidacion.findUnique({ where: { contratoId_periodo: { contratoId, periodo: period } }, select: { id: true } });
    if (existing) return res.status(409).json({ message: 'La liquidación ya fue generada y no puede omitirse', code: 'LIQUIDATION_ALREADY_EXISTS' });

    const decision = await prisma.decisionLiquidacionMensual.upsert({
        where: { contratoId_periodo: { contratoId, periodo: period } },
        update: { motivo: req.body.motivo, usuarioId, fechaCreacion: new Date() },
        create: { contratoId, periodo: period, motivo: req.body.motivo, usuarioId, inmobiliariaId }
    });
    await auditService.log({
        usuarioId, inmobiliariaId, accion: 'OMITIR_LIQUIDACION_PERIODO', entidad: 'Contrato', entidadId: contratoId,
        detalle: `Período ${req.body.periodo}. Motivo: ${req.body.motivo}`, severidad: 'WARNING'
    });
    invalidatePerformanceCache(inmobiliariaId);
    res.json(decision);
});

router.post('/preparacion/reabrir', requirePermission('liquidaciones.crear'), validateBody(reabrirDecisionLiquidacionMensualSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const contratoId = Number(req.body.contratoId);
    const period = parseDateOnly(req.body.periodo);
    const deleted = await prisma.decisionLiquidacionMensual.deleteMany({ where: { contratoId, periodo: period, inmobiliariaId } });
    if (!deleted.count) return res.status(404).json({ message: 'No existe una omisión para reabrir' });
    await auditService.log({
        usuarioId, inmobiliariaId, accion: 'REABRIR_LIQUIDACION_PERIODO', entidad: 'Contrato', entidadId: contratoId,
        detalle: `Período ${req.body.periodo}`
    });
    invalidatePerformanceCache(inmobiliariaId);
    res.json({ message: 'El contrato volvió a la preparación mensual' });
});

// Crear una nueva liquidación (Borrador)
router.post('/', requirePermission('liquidaciones.crear'), validateBody(liquidacionCreateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, periodo, montoHonorarios, porcentajeHonorarios, cuotasIds } = req.body; // periodo: "YYYY-MM-01"

    try {
        const liquidationPeriod = parseDateOnly(periodo);
        const runTransaction = () => prisma.$transaction(async (tx) => {
            const contrato = await tx.contrato.findFirst({
                where: { id: Number(contratoId), inmobiliariaId },
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } },
                    actualizaciones: {
                        select: { fechaActualizacion: true, montoAnterior: true },
                        orderBy: { fechaActualizacion: 'desc' }
                    }
                }
            });

            if (!contrato) {
                throw Object.assign(new Error('Contrato no encontrado'), { statusCode: 404 });
            }

            if (!contrato.administrado) {
                throw Object.assign(
                    new Error('Solo se pueden generar liquidaciones para contratos administrados'),
                    { statusCode: 409, code: 'CONTRACT_NOT_MANAGED' }
                );
            }

            const contractStartPeriod = firstDayOfUtcMonth(contrato.fechaInicio);
            const contractEndPeriod = firstDayOfUtcMonth(contrato.fechaFin);
            if (liquidationPeriod < contractStartPeriod || liquidationPeriod > contractEndPeriod) {
                throw Object.assign(
                    new Error('El período de la liquidación debe estar comprendido dentro de la vigencia del contrato'),
                    { statusCode: 409, code: 'LIQUIDATION_PERIOD_OUTSIDE_CONTRACT' }
                );
            }

            if (contrato.estado !== 'ACTIVO') {
                throw Object.assign(
                    new Error('Solo se pueden generar liquidaciones para contratos activos'),
                    { statusCode: 409, code: 'CONTRACT_NOT_ACTIVE' }
                );
            }
            if (contrato.propietarios.length !== 1 || contrato.inquilinos.length !== 1) {
                throw Object.assign(
                    new Error('El contrato debe tener un único propietario y un único inquilino principal'),
                    { statusCode: 409, code: 'CONTRACT_MAIN_PARTIES_REQUIRED' }
                );
            }

            const effectiveRent = getEffectiveRentForPeriod(
                contrato.montoAlquiler,
                contrato.actualizaciones,
                liquidationPeriod
            );
            const resolvedPercentage = porcentajeHonorarios !== undefined
                ? new Decimal(porcentajeHonorarios.toString())
                : contrato.porcentajeHonorarios;
            const resolvedFee = montoHonorarios !== undefined
                ? new Decimal(montoHonorarios.toString())
                : resolvedPercentage
                    ? effectiveRent.mul(resolvedPercentage).div(100)
                    : contrato.montoHonorarios;

            const liquidacion = await tx.liquidacion.create({
                data: {
                    periodo: parseDateOnly(periodo),
                    estado: 'BORRADOR',
                    contratoId: Number(contratoId),
                    inmobiliariaId,
                    creadoPorId: (req as AuthRequest).user!.id,
                    montoHonorarios: resolvedFee,
                    porcentajeHonorarios: resolvedPercentage,
                    montoAlquilerBase: effectiveRent,
                    montoPropietario: 0,
                    fechaVencimiento: getLiquidationDueDate(liquidationPeriod, contrato.diaVencimiento),
                    moneda: contrato.moneda,
                    pagaHonorarios: contrato.pagaHonorarios,
                    propiedadDireccion: contrato.propiedad.direccion,
                    inquilinoNombre: contrato.inquilinos[0].persona.nombreCompleto,
                    propietarioPagoId: contrato.propietarios[0].persona.id,
                    propietarioNombre: contrato.propietarios[0].persona.nombreCompleto
                }
            });

            await tx.movimiento.create({
                data: {
                    tipo: 'INGRESO',
                    concepto: 'Alquiler Mensual',
                    monto: effectiveRent,
                    moneda: contrato.moneda,
                    liquidacionId: liquidacion.id
                }
            });

            for (const cuotaId of cuotasIds || []) {
                const cuota = await tx.cuotaPlan.findFirst({
                    where: {
                        id: Number(cuotaId),
                        estado: 'PENDIENTE',
                        liquidacionId: null,
                        movimientoId: null,
                        plan: { contratoId: contrato.id, inmobiliariaId }
                    },
                    include: { plan: true }
                });

                if (!cuota) {
                    throw Object.assign(new Error('Una o más cuotas ya fueron utilizadas o no pertenecen al contrato'), { statusCode: 409 });
                }

                assertSameCurrency(cuota.moneda, contrato.moneda, 'No se pueden liquidar cuotas con una moneda distinta a la del contrato');
                assertSameCurrency(cuota.plan.moneda, contrato.moneda, 'No se pueden liquidar planes con una moneda distinta a la del contrato');

                const liquidationPeriodEnd = new Date(Date.UTC(
                    liquidationPeriod.getUTCFullYear(), liquidationPeriod.getUTCMonth() + 1, 0
                ));
                if (cuota.fechaVencimiento > liquidationPeriodEnd) {
                    throw Object.assign(new Error('La cuota seleccionada todavía no corresponde al período de esta liquidación'), {
                        statusCode: 409,
                        code: 'INSTALLMENT_NOT_DUE'
                    });
                }

                const claimed = await tx.cuotaPlan.updateMany({
                    where: {
                        id: cuota.id,
                        estado: 'PENDIENTE',
                        liquidacionId: null,
                        movimientoId: null
                    },
                    data: { liquidacionId: liquidacion.id }
                });

                if (claimed.count !== 1) {
                    throw Object.assign(new Error('La cuota fue utilizada por otra operación'), { statusCode: 409 });
                }

                const movimiento = await tx.movimiento.create({
                    data: {
                        tipo: cuota.plan.tipoMovimiento,
                        concepto: `${cuota.plan.concepto} (Cuota ${cuota.numeroCuota})`,
                        monto: cuota.monto,
                        moneda: contrato.moneda,
                        liquidacionId: liquidacion.id,
                        esParaInmobiliaria: cuota.plan.esParaInmobiliaria
                    }
                });

                await tx.cuotaPlan.update({
                    where: { id: cuota.id },
                    data: { movimientoId: movimiento.id }
                });
            }

            return recalculateLiquidationTotals(liquidacion.id, tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        let actualizada;
        try {
            actualizada = await runTransaction();
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
                actualizada = await runTransaction();
            } else {
                throw error;
            }
        }
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: actualizada.id,
            detalle: `Liquidación creada para contrato ${contratoId}, periodo ${periodo}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(actualizada);
    } catch (error: any) {
        console.error(error);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return res.status(409).json({ message: 'Ya existe una liquidación para este contrato y período' });
        }
        res.status(error.statusCode || 500).json({
            message: error.message || 'Error al crear liquidación',
            ...(error.code ? { code: error.code } : {})
        });
    }
});

// Agregar un movimiento
router.post('/:id/movimientos', requirePermission('liquidaciones.editar'), validateBody(movimientoSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { tipo, concepto, monto, observaciones, expectedVersion } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== EstadoLiquidacion.BORRADOR) {
            return res.status(409).json({
                message: 'La liquidación está confirmada y sus conceptos ya no pueden modificarse',
                code: 'LIQUIDATION_NOT_EDITABLE'
            });
        }

        const actualizada = await prisma.$transaction(async tx => {
            const claimed = await tx.liquidacion.updateMany({
                where: {
                    id: Number(id),
                    inmobiliariaId,
                    estado: EstadoLiquidacion.BORRADOR,
                    ...(expectedVersion ? { version: expectedVersion } : {})
                },
                data: { version: { increment: 1 } }
            });
            if (claimed.count !== 1) {
                throw Object.assign(new Error('La liquidación cambió mientras estabas trabajando. Actualizá la pantalla'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
            }
            await tx.movimiento.create({
                data: {
                    tipo,
                    concepto,
                    monto: monto ? monto.toString() : 0,
                    moneda: liquidacion.moneda,
                    observaciones,
                    liquidacionId: Number(id)
                }
            });
            return recalculateLiquidationTotals(Number(id), tx);
        });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'AGREGAR_MOVIMIENTO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `${tipo}: ${concepto} por monto ${monto}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(actualizada);
    } catch (error: any) {
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al agregar movimiento', code: error.code });
    }
});

// Eliminar un movimiento
router.delete('/movimientos/:movimientoId', requirePermission('liquidaciones.editar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { movimientoId } = req.params;

    try {
        const movimiento = await prisma.movimiento.findUnique({
            where: { id: Number(movimientoId) },
            include: { liquidacion: true }
        });

        if (!movimiento || movimiento.liquidacion.inmobiliariaId !== inmobiliariaId) {
            return res.status(404).json({ message: 'Movimiento no encontrado' });
        }

        if (movimiento.liquidacion.estado !== EstadoLiquidacion.BORRADOR) {
            return res.status(409).json({
                message: 'La liquidación está confirmada y sus conceptos ya no pueden modificarse',
                code: 'LIQUIDATION_NOT_EDITABLE'
            });
        }

        const actualizada = await prisma.$transaction(async tx => {
            // Si el concepto nació de una cuota, liberarla junto con el movimiento.
            // Borrar solo Movimiento dejaría la cuota asociada a una liquidación y
            // bloquearía tanto su reutilización como la eliminación del plan.
            await tx.cuotaPlan.updateMany({
                where: { movimientoId: Number(movimientoId), liquidacionId: movimiento.liquidacionId },
                data: { movimientoId: null, liquidacionId: null, estado: 'PENDIENTE' }
            });
            const claimed = await tx.liquidacion.updateMany({
                where: { id: movimiento.liquidacionId, inmobiliariaId, estado: EstadoLiquidacion.BORRADOR },
                data: { version: { increment: 1 } }
            });
            if (claimed.count !== 1) {
                throw Object.assign(new Error('La liquidación cambió mientras estabas trabajando. Actualizá la pantalla'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
            }
            await tx.movimiento.delete({ where: { id: Number(movimientoId) } });
            return recalculateLiquidationTotals(movimiento.liquidacionId, tx);
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_MOVIMIENTO',
            entidad: 'Liquidacion',
            entidadId: movimiento.liquidacionId,
            detalle: `${movimiento.tipo}: ${movimiento.concepto} por monto ${movimiento.monto}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(actualizada);
    } catch (error: any) {
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al eliminar movimiento', code: error.code });
    }
});

// Confirmar liquidación (Borrador -> Pendiente de Pago)
router.patch('/:id/confirmar', requirePermission('liquidaciones.confirmar'), validateBody(confirmacionLiquidacionSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const actualizada = await prisma.$transaction(async tx => {
            const liquidacion = await tx.liquidacion.findFirst({
                where: { id: Number(id), inmobiliariaId },
                include: {
                    movimientos: true,
                    contrato: {
                        include: {
                            propiedad: true,
                            propietarios: { where: { esPrincipal: true }, include: { persona: true } },
                            inquilinos: { where: { esPrincipal: true }, include: { persona: true } }
                        }
                    }
                }
            });

            if (!liquidacion) throw Object.assign(new Error('Liquidación no encontrada'), { statusCode: 404 });

            if (liquidacion.estado !== 'BORRADOR') {
                throw Object.assign(new Error('Solo se pueden confirmar liquidaciones en estado borrador'), { statusCode: 409, code: 'LIQUIDATION_NOT_EDITABLE' });
            }

            if (liquidacion.contrato.propietarios.length !== 1 || liquidacion.contrato.inquilinos.length !== 1) {
                throw Object.assign(new Error('Definí un único propietario y un único inquilino principal antes de confirmar'), { statusCode: 409, code: 'MAIN_PARTIES_REQUIRED' });
            }

            const recalculated = await recalculateLiquidationTotals(liquidacion.id, tx);
            if (new Decimal(recalculated.netoACobrar.toString()).lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('El total a cobrar al inquilino debe ser mayor que cero'), { statusCode: 409, code: 'TENANT_TOTAL_NOT_POSITIVE' });
            }
            if (new Decimal(recalculated.montoPropietario.toString()).lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('El importe a entregar al propietario debe ser mayor que cero'), { statusCode: 409, code: 'OWNER_TOTAL_NOT_POSITIVE' });
            }

            const owner = liquidacion.contrato.propietarios[0].persona;
            const tenant = liquidacion.contrato.inquilinos[0].persona;
            const claimed = await tx.liquidacion.updateMany({
                where: {
                    id: liquidacion.id,
                    inmobiliariaId,
                    estado: EstadoLiquidacion.BORRADOR,
                    ...(req.body.expectedVersion ? { version: req.body.expectedVersion } : {})
                },
                data: {
                    estado: EstadoLiquidacion.CONFIRMADA,
                    estadoCobroInquilino: 'PENDIENTE',
                    estadoPagoPropietario: 'PENDIENTE',
                    version: { increment: 1 },
                    fechaConfirmacion: new Date(),
                    confirmadoPorId: (req as AuthRequest).user!.id,
                    propiedadDireccion: liquidacion.contrato.propiedad.direccion,
                    inquilinoNombre: tenant.nombreCompleto,
                    propietarioPagoId: owner.id,
                    propietarioNombre: owner.nombreCompleto
                }
            });
            if (claimed.count !== 1) {
                throw Object.assign(new Error('La liquidación cambió mientras estabas trabajando. Revisala antes de confirmar'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
            }
            await createLiquidationVoucherSnapshot({
                tx,
                liquidacionId: liquidacion.id,
                inmobiliariaId,
                usuarioId: (req as AuthRequest).user!.id
            });
            // La respuesta de confirmación se usa inmediatamente para actualizar
            // el detalle. Incluimos los componentes del saldo para que nunca se
            // informe $0 mientras la liquidación ya está confirmada.
            return tx.liquidacion.findUniqueOrThrow({
                where: { id: liquidacion.id },
                include: {
                    movimientos: true,
                    pagos: { where: { anuladoEn: null } },
                    aplicacionesCredito: true,
                    pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } }
                }
            });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        const tenantSettlement = getTenantSettlement(actualizada);
        const ownerSettlement = getOwnerPaymentSettlement(actualizada);

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CONFIRMAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: 'Liquidación confirmada y pasada a pendiente de pago'
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json({
            ...actualizada,
            montoPagadoPropietario: ownerSettlement.pagado.toNumber(),
            resumenOperativo: {
                cobradoInquilino: tenantSettlement.pagos.toNumber(),
                creditoAplicadoInquilino: tenantSettlement.creditosAplicados.toNumber(),
                saldoInquilino: tenantSettlement.saldo.toNumber(),
                pagadoPropietario: ownerSettlement.pagado.toNumber(),
                saldoPropietario: ownerSettlement.saldo.toNumber(),
                capitalPropioExpuesto: getAgencyAdvanceExposure(actualizada).toNumber()
            }
        });
    } catch (error: any) {
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id, inmobiliariaId,
            accion: 'CONFIRMAR_LIQUIDACION', entidad: 'Liquidacion', entidadId: Number(id),
            resultado: 'FALLIDO', severidad: 'WARNING', detalle: error.message
        });
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al confirmar liquidación', code: error.code });
    }
});

// Actualizar honorarios de una liquidación
router.patch('/:id/honorarios', requirePermission('liquidaciones.editar'), validateBody(honorariosSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { montoHonorarios, porcentajeHonorarios, expectedVersion } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== EstadoLiquidacion.BORRADOR) {
            return res.status(409).json({
                message: 'La liquidación está confirmada y sus honorarios ya no pueden modificarse',
                code: 'LIQUIDATION_NOT_EDITABLE'
            });
        }

        const actualizada = await prisma.$transaction(async tx => {
            const claimed = await tx.liquidacion.updateMany({
                where: {
                    id: Number(id), inmobiliariaId, estado: EstadoLiquidacion.BORRADOR,
                    ...(expectedVersion ? { version: expectedVersion } : {})
                },
                data: {
                    montoHonorarios: montoHonorarios !== undefined ? Number(montoHonorarios) : undefined,
                    porcentajeHonorarios: porcentajeHonorarios !== undefined ? Number(porcentajeHonorarios) : undefined,
                    version: { increment: 1 }
                },
            });
            if (claimed.count !== 1) {
                throw Object.assign(new Error('La liquidación cambió mientras estabas trabajando. Actualizá la pantalla'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
            }
            return recalculateLiquidationTotals(Number(id), tx);
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_HONORARIOS_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: JSON.stringify({
                montoHonorarios: { anterior: liquidacion.montoHonorarios.toString(), nuevo: montoHonorarios },
                porcentajeHonorarios: { anterior: liquidacion.porcentajeHonorarios?.toString() || null, nuevo: porcentajeHonorarios }
            })
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(actualizada);
    } catch (error: any) {
        console.error('Error updates honorarios:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al actualizar honorarios', code: error.code });
    }
});

// Eliminar liquidación (Solo si es borrador)
router.delete('/:id', requirePermission('liquidaciones.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== 'BORRADOR') {
            return res.status(400).json({ message: 'Solo se pueden eliminar liquidaciones en borrador' });
        }

        const deleted = await prisma.liquidacion.deleteMany({
            where: { id: Number(id), inmobiliariaId, estado: EstadoLiquidacion.BORRADOR }
        });
        if (deleted.count !== 1) {
            throw Object.assign(new Error('La liquidación cambió mientras estabas trabajando y ya no puede eliminarse'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id)
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json({ message: 'Liquidación eliminada' });
    } catch (error: any) {
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id, inmobiliariaId, accion: 'ELIMINAR_LIQUIDACION',
            entidad: 'Liquidacion', entidadId: Number(id), detalle: error.message, resultado: 'FALLIDO', severidad: 'WARNING'
        });
        res.status(error.statusCode || 500).json({ message: error.message || 'Error al eliminar liquidación', code: error.code });
    }
});

// Nota de crédito/débito: conserva el documento de ajuste y, si el inquilino
// ya había pagado de más, liquida ese excedente como devolución, saldo a favor
// o compensación contra otra liquidación. Nunca se duplica la deuda.
router.post('/:id/ajustes', requirePermission('liquidaciones.ajustar'), requireRecentAuthentication, validateBody(ajusteLiquidacionSchema), async (req, res) => {
    const liquidacionId = Number(req.params.id);
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const {
        tipo, concepto, motivo, montoInquilino, montoPropietario,
        destinoCredito, liquidacionDestinoId, fechaDevolucion, metodoDevolucion, observacionesDevolucion
    } = req.body;
    try {
        const result = await prisma.$transaction(async tx => {
            const liquidation = await tx.liquidacion.findFirst({
                where: { id: liquidacionId, inmobiliariaId },
                include: {
                    pagos: { where: { anuladoEn: null }, select: { monto: true } },
                    aplicacionesCredito: true,
                    pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } }
                }
            });
            if (!liquidation) throw Object.assign(new Error('Liquidación no encontrada'), { statusCode: 404, code: 'LIQUIDATION_NOT_FOUND' });
            if (liquidation.estado !== EstadoLiquidacion.CONFIRMADA) throw Object.assign(new Error('Sólo una liquidación confirmada admite ajustes'), { statusCode: 409, code: 'LIQUIDATION_NOT_CONFIRMED' });

            const adjustmentAmounts = calculateLiquidationAdjustment({
                tipo,
                montoInquilino,
                montoPropietario
            });
            const {
                montoInquilino: tenantAdjustment,
                montoPropietario: ownerAdjustment,
                impactoInquilino,
                impactoPropietario,
                montoHistorico
            } = adjustmentAmounts;
            const correctedTenant = new Decimal(liquidation.netoACobrar.toString()).plus(impactoInquilino);
            const correctedOwner = new Decimal(liquidation.montoPropietario.toString()).plus(impactoPropietario);
            if (correctedTenant.lessThan(0) || correctedOwner.lessThan(0)) throw Object.assign(new Error('El ajuste dejaría un importe negativo'), { statusCode: 409, code: 'NEGATIVE_ADJUSTED_TOTAL' });
            const { pagado: ownerAlreadyPaid } = getOwnerPaymentSettlement(liquidation);
            if (ownerAlreadyPaid.greaterThan(correctedOwner)) {
                throw Object.assign(new Error('El ajuste reduciría el importe del propietario por debajo de lo ya entregado. Registrá primero la devolución o la corrección de esa entrega.'), {
                    statusCode: 409, code: 'OWNER_PAYMENT_EXCEEDS_CORRECTED_TOTAL'
                });
            }

            const settlementBeforeCorrection = getTenantSettlement(liquidation);
            const excessSettlement = Decimal.max(new Decimal(0), settlementBeforeCorrection.totalAplicado.minus(correctedTenant));
            const cashExcess = Decimal.max(new Decimal(0), settlementBeforeCorrection.pagos.minus(correctedTenant));
            const creditApplicationExcess = excessSettlement.minus(cashExcess);

            // Si una parte del excedente provenía de otro saldo a favor, se lo
            // devuelve a su crédito de origen antes de generar un nuevo crédito.
            if (creditApplicationExcess.greaterThan(0)) {
                await releaseCreditApplicationsForCorrection({ tx, liquidacionId, montoALiberar: creditApplicationExcess });
            }

            if (cashExcess.greaterThan(0) && tipo !== 'CREDITO') {
                throw Object.assign(new Error('Sólo una nota de crédito al inquilino puede generar un saldo a favor'), { statusCode: 409, code: 'INVALID_TENANT_CREDIT_SETTLEMENT' });
            }
            if (cashExcess.greaterThan(0) && !destinoCredito) {
                throw Object.assign(new Error('Elegí si el excedente se devuelve, queda a favor o se compensa'), { statusCode: 409, code: 'TENANT_CREDIT_DESTINATION_REQUIRED' });
            }

            const adjustment = await tx.ajusteLiquidacion.create({
                // `monto` conserva compatibilidad histórica. Los importes
                // documentales reales son los específicos de cada parte.
                data: {
                    liquidacionId,
                    tipo,
                    concepto,
                    motivo,
                    monto: montoHistorico,
                    montoInquilino: tenantAdjustment,
                    montoPropietario: ownerAdjustment,
                    moneda: liquidation.moneda,
                    impactoInquilino,
                    impactoPropietario,
                    creadoPorId: usuarioId
                }
            });

            let creditoInquilino: { id: number; montoOriginal: Decimal; saldoPendiente: Decimal; destino: DestinoCreditoInquilino; estado: EstadoCreditoInquilino } | null = null;
            let compensacion: unknown = null;
            if (cashExcess.greaterThan(0)) {
                const credit = await tx.creditoInquilino.create({
                    data: {
                        liquidacionOrigenId: liquidation.id,
                        ajusteLiquidacionId: adjustment.id,
                        contratoId: liquidation.contratoId,
                        inmobiliariaId,
                        montoOriginal: cashExcess,
                        saldoPendiente: cashExcess,
                        moneda: liquidation.moneda,
                        destino: destinoCredito!,
                        creadoPorId: usuarioId
                    }
                });

                if (destinoCredito === 'DEVOLUCION') {
                    const refundDate = fechaDevolucion ? parseDateOnly(fechaDevolucion) : argentinaTodayAsDate();
                    assertOperationalDateIsNotFuture(refundDate, 'La fecha de devolución');
                    const refundAccount = metodoDevolucion === 'EFECTIVO' ? 'CAJA' : 'BANCO';
                    await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: refundDate, cuenta: refundAccount, moneda: liquidation.moneda });
                    const refundMovement = await tx.movimientoCaja.create({
                        data: {
                            inmobiliariaId,
                            tipo: 'EGRESO',
                            concepto: `Devolución saldo a favor - Liquidación #${liquidation.id}`,
                            monto: cashExcess,
                            moneda: liquidation.moneda,
                            fecha: refundDate,
                            metodoPago: metodoDevolucion,
                            cuenta: refundAccount,
                            observaciones: observacionesDevolucion || `Nota de crédito #${adjustment.id}: ${concepto}`,
                            creadoPorId: usuarioId,
                            contratoId: liquidation.contratoId,
                            liquidacionId: liquidation.id
                        }
                    });
                    creditoInquilino = await tx.creditoInquilino.update({
                        where: { id: credit.id },
                        data: { saldoPendiente: new Decimal(0), estado: EstadoCreditoInquilino.DEVUELTO, movimientoDevolucionId: refundMovement.id }
                    });
                } else if (destinoCredito === 'COMPENSACION') {
                    const applied = await applyTenantCredit({
                        tx,
                        creditId: credit.id,
                        liquidacionDestinoId: liquidacionDestinoId!,
                        montoSolicitado: cashExcess,
                        inmobiliariaId,
                        usuarioId
                    });
                    creditoInquilino = await tx.creditoInquilino.findUniqueOrThrow({ where: { id: credit.id } });
                    compensacion = { liquidacionDestinoId: applied.target.id, monto: applied.application.monto.toString() };
                } else {
                    creditoInquilino = credit;
                }
            }

            const currentSource = await tx.liquidacion.findUniqueOrThrow({
                where: { id: liquidacionId },
                include: { pagos: { where: { anuladoEn: null } }, aplicacionesCredito: true, pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } } }
            });
            const updated = await tx.liquidacion.update({
                where: { id: liquidacionId },
                data: {
                    netoACobrar: correctedTenant,
                    montoPropietario: correctedOwner,
                    estadoCobroInquilino: getTenantCollectionState({ ...currentSource, netoACobrar: correctedTenant }),
                    estadoPagoPropietario: getOwnerPaymentState({ ...currentSource, montoPropietario: correctedOwner }),
                    version: { increment: 1 }
                }
            });
            await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId, usuarioId });
            const comprobante = await createLiquidationVoucherSnapshot({ tx, liquidacionId, inmobiliariaId, usuarioId });
            return { adjustment, creditoInquilino, compensacion, liquidacion: updated, comprobante };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'AJUSTAR_LIQUIDACION', entidad: 'Liquidacion', entidadId: liquidacionId, severidad: 'WARNING',
            detalle: JSON.stringify({ tipo, concepto, motivo, montoInquilino, montoPropietario, destinoCredito, liquidacionDestinoId })
        });
        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(result);
    } catch (error: any) { res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo emitir el ajuste', code: error.code }); }
});

// Aplica un saldo a favor ya emitido a una liquidación pendiente del mismo
// contrato y moneda. No genera caja: compensa una deuda con dinero recibido antes.
router.post('/creditos-inquilino/:id/aplicar', requirePermission('liquidaciones.ajustar'), requireRecentAuthentication, validateBody(aplicarCreditoInquilinoSchema), async (req, res) => {
    const creditId = Number(req.params.id);
    const { liquidacionDestinoId, monto } = req.body;
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ message: 'Saldo a favor inválido' });
    try {
        const result = await prisma.$transaction(
            tx => applyTenantCredit({
                tx,
                creditId,
                liquidacionDestinoId,
                montoSolicitado: new Decimal(monto),
                inmobiliariaId,
                usuarioId
            }),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'APLICAR_SALDO_A_FAVOR', entidad: 'CreditoInquilino', entidadId: creditId,
            detalle: `Crédito aplicado a liquidación #${liquidacionDestinoId} por ${formatCurrency(monto, result.target.moneda)}`
        });
        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(result);
    } catch (error: any) {
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo aplicar el saldo a favor', code: error.code });
    }
});

// Registra entregas parciales al propietario. Sólo se permite adelantar fondos
// antes de cobrar al inquilino a quien tenga la capacidad explícita.
router.patch('/:id/pagar-propietario', requirePermission('liquidaciones.pagar_propietario'), requireRecentAuthentication, validateBody(pagoPropietarioSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { fechaPago, metodoPago, comprobante, observaciones, motivoAdelanto, propietarioId, monto, expectedVersion } = req.body;

    try {
        const paymentDate = fechaPago ? parseDateOnly(fechaPago) : argentinaTodayAsDate();
        assertOperationalDateIsNotFuture(paymentDate, 'La fecha de pago al propietario');
        const result = await prisma.$transaction(async (tx) => {
            const liquidacion = await tx.liquidacion.findFirst({
                where: { id: Number(id), inmobiliariaId },
                include: {
                    propietarioPago: true,
                    pagos: { where: { anuladoEn: null }, select: { monto: true } },
                    pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } },
                    contrato: {
                        include: {
                            propiedad: true,
                            propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                        }
                    }
                }
            });

            if (!liquidacion) {
                throw new Error('Liquidación no encontrada');
            }

            if (liquidacion.estado !== EstadoLiquidacion.CONFIRMADA) {
                throw Object.assign(new Error('La liquidación no admite nuevos pagos al propietario'), { statusCode: 409, code: 'INVALID_LIQUIDATION_STATE' });
            }

            const montoPropietario = new Decimal(liquidacion.montoPropietario.toString());
            const { pagado: montoYaPagado, saldo: saldoPropietario } = getOwnerPaymentSettlement(liquidacion);
            const montoAPagar = new Decimal(monto.toString());
            if (montoPropietario.lessThanOrEqualTo(0)) {
                throw Object.assign(new Error('El importe a entregar al propietario debe ser mayor que cero'), { statusCode: 409, code: 'OWNER_TOTAL_NOT_POSITIVE' });
            }
            if (montoAPagar.greaterThan(saldoPropietario)) {
                throw Object.assign(new Error(`El pago supera el saldo pendiente del propietario (${formatCurrency(saldoPropietario.toString(), liquidacion.moneda)})`), { statusCode: 409, code: 'OWNER_PAYMENT_EXCEEDS_BALANCE' });
            }
            const totalCobrado = liquidacion.pagos.reduce((sum, pago) => sum.plus(pago.monto), new Decimal(0));
            // Sólo el efectivo ya cobrado puede financiar esta entrega. El
            // excedente es capital propio expuesto, aunque el inquilino tenga
            // créditos aplicados que reduzcan su deuda documental.
            const coberturaDisponible = Decimal.max(new Decimal(0), totalCobrado.minus(montoYaPagado));
            const montoFondosCobrados = Decimal.min(montoAPagar, coberturaDisponible);
            const montoAdelantoPropio = montoAPagar.minus(montoFondosCobrados);
            const esAdelanto = montoAdelantoPropio.greaterThan(0);
            if (esAdelanto && !(await userHasPermission((req as AuthRequest).user!.id, (req as AuthRequest).user!.tipo, 'liquidaciones.adelantar_propietario'))) {
                throw Object.assign(new Error('No tenés permiso para adelantar fondos al propietario antes de cobrar al inquilino'), { statusCode: 403, code: 'OWNER_ADVANCE_PERMISSION_REQUIRED' });
            }
            if (esAdelanto && (!motivoAdelanto || motivoAdelanto.trim().length < 5)) {
                throw Object.assign(new Error('Indicá el motivo del adelanto de fondos propios'), { statusCode: 422, code: 'OWNER_ADVANCE_REASON_REQUIRED' });
            }
            if (esAdelanto) {
                const vencidos = (await getOutstandingOwnerAdvances(tx, inmobiliariaId))
                    .filter(adelanto => adelanto.contratoId === liquidacion.contratoId && adelanto.antiguedadDias > 30);
                if (vencidos.length) {
                    throw Object.assign(new Error('El contrato ya tiene adelantos con más de 30 días sin recuperar. Regularizalos o autorizá una excepción antes de generar otro adelanto.'), {
                        statusCode: 409, code: 'OWNER_ADVANCE_OVERDUE_BLOCKED'
                    });
                }
            }
            const principalOwner = liquidacion.propietarioPago
                || (liquidacion.contrato.propietarios.length === 1 ? liquidacion.contrato.propietarios[0].persona : null);
            if (!principalOwner) {
                throw Object.assign(new Error('La liquidación no tiene un destinatario histórico válido'), { statusCode: 409, code: 'OWNER_RECIPIENT_REQUIRED' });
            }
            if (principalOwner.id !== Number(propietarioId)) {
                throw Object.assign(new Error(`El pago debe registrarse a nombre de ${principalOwner.nombreCompleto}`), { statusCode: 409, code: 'OWNER_RECIPIENT_MISMATCH' });
            }
            const validCbu = Boolean(principalOwner.cbu && isValidCbu(principalOwner.cbu));
            const validAlias = Boolean(principalOwner.aliasBancario && isValidBankAlias(principalOwner.aliasBancario));
            if (metodoPago === 'TRANSFERENCIA' && !validCbu && !validAlias) {
                throw Object.assign(new Error(`No se puede registrar una transferencia: ${principalOwner.nombreCompleto} no tiene un CBU o alias válido informado`), {
                    statusCode: 409, code: 'OWNER_BANK_DESTINATION_REQUIRED'
                });
            }
            if (metodoPago === 'TRANSFERENCIA' && !principalOwner.titularidadBancariaVerificada) {
                throw Object.assign(new Error(`No se puede registrar una transferencia: falta confirmar la titularidad de la cuenta de ${principalOwner.nombreCompleto}`), {
                    statusCode: 409, code: 'OWNER_BANK_HOLDER_UNVERIFIED'
                });
            }
            const destinoBancario = metodoPago === 'TRANSFERENCIA'
                ? maskedBankDestination(validCbu ? principalOwner.cbu : null, validAlias ? principalOwner.aliasBancario : null)
                : null;
            const cuentaPago = (metodoPago === 'EFECTIVO') ? 'CAJA' : 'BANCO';
            await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: paymentDate, cuenta: cuentaPago, moneda: liquidacion.moneda });

            const cashMovement = await tx.movimientoCaja.create({
                data: {
                    inmobiliariaId,
                    tipo: 'EGRESO',
                    concepto: buildLiquidationCashConcept(`Pago a ${principalOwner.nombreCompleto}`, liquidacion),
                    monto: montoAPagar,
                    moneda: liquidacion.moneda,
                    fecha: paymentDate,
                    metodoPago: metodoPago || 'EFECTIVO',
                    cuenta: cuentaPago,
                    comprobante: comprobante || undefined,
                    observaciones: observaciones || undefined,
                    creadoPorId: (req as AuthRequest).user!.id,
                    contratoId: liquidacion.contratoId,
                    liquidacionId: liquidacion.id
                    , esPagoPropietario: true
                }
            });

            const nuevoMontoPagado = montoYaPagado.plus(montoAPagar);
            const pagoPropietario = await tx.pagoPropietario.create({
                data: {
                    liquidacionId: liquidacion.id,
                    propietarioId: principalOwner.id,
                    inmobiliariaId,
                    monto: montoAPagar,
                    moneda: liquidacion.moneda,
                    fechaPago: paymentDate,
                    metodoPago: metodoPago || 'EFECTIVO',
                    cuenta: cuentaPago,
                    comprobante: comprobante || undefined,
                    observaciones: observaciones || undefined,
                    motivoAdelanto: esAdelanto ? motivoAdelanto.trim() : undefined,
                    origen: montoAdelantoPropio.isZero()
                        ? OrigenPagoPropietario.FONDOS_COBRADOS
                        : montoFondosCobrados.isZero() ? OrigenPagoPropietario.ADELANTO_PROPIO : OrigenPagoPropietario.MIXTO,
                    montoFondosCobrados,
                    montoAdelantoPropio,
                    creadoPorId: (req as AuthRequest).user!.id,
                    movimientoCajaId: cashMovement.id
                }
            });
            const estadoPagoPropietario = getOwnerPaymentState({
                montoPropietario,
                pagosPropietario: [...liquidacion.pagosPropietario, pagoPropietario]
            });

            const claimed = await tx.liquidacion.updateMany({
                where: { id: Number(id), inmobiliariaId, estado: EstadoLiquidacion.CONFIRMADA, ...(expectedVersion ? { version: expectedVersion } : {}) },
                data: {
                    estadoPagoPropietario,
                    montoPagadoPropietario: nuevoMontoPagado,
                    fechaPagoPropietario: paymentDate,
                    metodoPagoPropietario: metodoPago || 'EFECTIVO',
                    propietarioPagoId: principalOwner.id,
                    propietarioNombre: liquidacion.propietarioNombre || principalOwner.nombreCompleto,
                    pagoPropietarioMovimientoId: cashMovement.id,
                    version: { increment: 1 }
                }
            });
            if (claimed.count !== 1) {
                throw Object.assign(new Error('La liquidación cambió mientras registrabas la entrega. Actualizá la pantalla e intentá nuevamente'), { statusCode: 409, code: 'LIQUIDATION_CHANGED' });
            }
            const actualizada = await tx.liquidacion.findUniqueOrThrow({ where: { id: liquidacion.id } });

            return {
                ...actualizada,
                montoPropietario: montoPropietario.toString(), montoPagadoPropietario: nuevoMontoPagado.toString(),
                saldoPropietario: montoPropietario.minus(nuevoMontoPagado).toString(), esAdelanto,
                moneda: liquidacion.moneda,
                propiedadDireccion: liquidacion.contrato?.propiedad?.direccion || 'Sin dirección',
                propietarioNombre: principalOwner.nombreCompleto,
                propietarioPagoId: principalOwner.id,
                pagoPropietarioMovimientoId: cashMovement.id,
                pagoPropietarioId: pagoPropietario.id,
                montoFondosCobrados: montoFondosCobrados.toString(),
                montoAdelantoPropio: montoAdelantoPropio.toString(),
                capitalPropioExpuesto: Decimal.max(new Decimal(0), nuevoMontoPagado.minus(totalCobrado)).toString(),
                periodoTexto: new Date(liquidacion.periodo).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
                destinoBancario
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'PAGO_PROPIETARIO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `${result.esAdelanto ? 'Adelanto' : 'Pago'} a ${result.propietarioNombre} por ${formatCurrency(monto, result.moneda)}; pendiente para propietario: ${formatCurrency(result.saldoPropietario, result.moneda)} - ${result.propiedadDireccion} - ${result.periodoTexto}${result.destinoBancario ? ` - ${result.destinoBancario}` : ''}`
        });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(result);
    } catch (error: any) {
        console.error(error);
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id, inmobiliariaId,
            accion: 'PAGO_PROPIETARIO', entidad: 'Liquidacion', entidadId: Number(id),
            detalle: error.message, resultado: 'FALLIDO', severidad: 'WARNING'
        });
        res.status(error.statusCode || 400).json({ message: error.message || 'Error al registrar pago al propietario', code: error.code });
    }
});

// La ruta histórica se deja comentada porque representaba todos los pagos con
// un único puntero en Liquidacion. Cada entrega se revierte por su propio id.
/*
router.post(
    '/:id/anular-pago-propietario',
    requirePermission('liquidaciones.anular_pago_propietario'),
    requireRecentAuthentication,
    validateBody(anulacionPagoPropietarioSchema),
    async (req, res) => {
        const liquidacionId = Number(req.params.id);
        const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
        const { motivo } = req.body;
        if (!Number.isInteger(liquidacionId) || liquidacionId <= 0) {
            return res.status(400).json({ message: 'Liquidación inválida' });
        }

        try {
            const result = await prisma.$transaction(async tx => {
                const liquidacion = await tx.liquidacion.findFirst({
                    where: { id: liquidacionId, inmobiliariaId },
                    include: {
                        pagoPropietarioMovimiento: { include: { reversion: true } },
                        propietarioPago: true
                    }
                });
                if (!liquidacion) throw Object.assign(new Error('Liquidación no encontrada'), { statusCode: 404, code: 'LIQUIDATION_NOT_FOUND' });
                if (!([EstadoLiquidacion.LIQUIDADA, EstadoLiquidacion.PAGADA_POR_INQUILINO, EstadoLiquidacion.PENDIENTE_PAGO] as EstadoLiquidacion[]).includes(liquidacion.estado)) {
                    throw Object.assign(new Error('La liquidación no tiene un pago al propietario vigente'), { statusCode: 409, code: 'OWNER_PAYMENT_NOT_ACTIVE' });
                }
                let original = liquidacion.pagoPropietarioMovimiento;
                // Con pagos parciales el puntero puede referir a un pago ya anulado;
                // se revierte siempre el último egreso vigente de propietario.
                if (!original || original.anuladoEn || original.reversion) {
                    original = await tx.movimientoCaja.findFirst({
                        where: { inmobiliariaId, liquidacionId, esPagoPropietario: true, anuladoEn: null, reversionDeId: null },
                        include: { reversion: true }, orderBy: { id: 'desc' }
                    });
                }
                if (!original || original.anuladoEn || original.reversion) {
                    throw Object.assign(new Error('No se encontró un egreso reversible asociado al pago'), { statusCode: 409, code: 'OWNER_CASH_ENTRY_NOT_REVERSIBLE' });
                }

                const voidedAt = new Date();
                const fechaCorreccion = argentinaTodayAsDate(voidedAt);
                const { originalPeriodClosed } = await prepareCashCorrection(tx, {
                    inmobiliariaId,
                    fechaCorreccion,
                    movimientoOriginal: original
                });
                if (!originalPeriodClosed) {
                    const claimed = await tx.movimientoCaja.updateMany({
                        where: { id: original.id, inmobiliariaId, anuladoEn: null },
                        data: { anuladoEn: voidedAt, anuladoPorId: usuarioId, motivoAnulacion: motivo }
                    });
                    if (claimed.count !== 1) {
                        throw Object.assign(new Error('El pago ya fue anulado'), { statusCode: 409, code: 'OWNER_PAYMENT_ALREADY_VOIDED' });
                    }
                }

                const reversal = await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Reversión pago a propietario #${liquidacion.id}: ${original.concepto}`,
                        monto: original.monto,
                        moneda: original.moneda,
                        fecha: fechaCorreccion,
                        metodoPago: original.metodoPago,
                        cuenta: original.cuenta,
                        observaciones: motivo,
                        creadoPorId: usuarioId,
                        contratoId: liquidacion.contratoId,
                        liquidacionId: liquidacion.id,
                        esPagoPropietario: true,
                        reversionDeId: original.id
                    }
                });

                const restantePropietario = Decimal.max(new Decimal(0), new Decimal(liquidacion.montoPagadoPropietario.toString()).minus(original.monto));
                const pagosInquilino = await tx.pago.aggregate({ where: { liquidacionId, inmobiliariaId, anuladoEn: null }, _sum: { monto: true } });
                const inquilinoAlDia = new Decimal(pagosInquilino._sum.monto?.toString() || '0').greaterThanOrEqualTo(liquidacion.netoACobrar);
                const updated = await tx.liquidacion.update({
                    where: { id: liquidacion.id },
                    data: {
                        estado: inquilinoAlDia ? EstadoLiquidacion.PAGADA_POR_INQUILINO : EstadoLiquidacion.PENDIENTE_PAGO,
                        montoPagadoPropietario: restantePropietario,
                        fechaPagoPropietario: restantePropietario.greaterThan(0) ? liquidacion.fechaPagoPropietario : null,
                        metodoPagoPropietario: null,
                        pagoPropietarioMovimientoId: null,
                        cerradoPorId: null,
                        fechaLiquidacion: null,
                        version: { increment: 1 }
                    }
                });
                await tx.auditLog.create({
                    data: {
                        usuarioId, inmobiliariaId, accion: 'ANULAR_PAGO_PROPIETARIO', entidad: 'Liquidacion',
                        entidadId: liquidacion.id, severidad: 'WARNING',
                        detalle: `Pago a ${liquidacion.propietarioPago?.nombreCompleto || 'propietario'} por ${formatCurrency(original.monto.toString(), original.moneda)} anulado. Motivo: ${motivo}. Asiento inverso #${reversal.id}.`
                    }
                });
                return { liquidacion: updated, movimientoReversion: reversal };
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

            invalidatePerformanceCache(inmobiliariaId);
            res.json(result);
        } catch (error: any) {
            console.error('Error reversing owner payment:', error);
            await auditService.log({
                usuarioId, inmobiliariaId, accion: 'ANULAR_PAGO_PROPIETARIO', entidad: 'Liquidacion', entidadId: liquidacionId,
                detalle: error.message, resultado: 'FALLIDO', severidad: 'WARNING'
            });
            res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo anular el pago al propietario', code: error.code });
        }
    }
);
*/

router.post(
    '/:id/pagos-propietario/:pagoId/anular',
    requirePermission('liquidaciones.anular_pago_propietario'),
    requireRecentAuthentication,
    validateBody(anulacionPagoPropietarioSchema),
    async (req, res) => {
        const liquidacionId = Number(req.params.id);
        const pagoPropietarioId = Number(req.params.pagoId);
        const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
        const { motivo } = req.body;
        if (!Number.isInteger(liquidacionId) || !Number.isInteger(pagoPropietarioId)) {
            return res.status(400).json({ message: 'Pago al propietario inválido' });
        }

        try {
            const result = await prisma.$transaction(async tx => {
                const pago = await tx.pagoPropietario.findFirst({
                    where: { id: pagoPropietarioId, liquidacionId, inmobiliariaId },
                    include: {
                        movimientoCaja: { include: { reversion: true } },
                        propietario: { select: { nombreCompleto: true } },
                        liquidacion: { select: { contratoId: true, montoPropietario: true } }
                    }
                });
                if (!pago) throw Object.assign(new Error('Entrega al propietario no encontrada'), { statusCode: 404, code: 'OWNER_PAYMENT_NOT_FOUND' });
                if (pago.anuladoEn) throw Object.assign(new Error('La entrega ya fue anulada'), { statusCode: 409, code: 'OWNER_PAYMENT_ALREADY_VOIDED' });
                if (!pago.movimientoCaja || pago.movimientoCaja.reversion) {
                    throw Object.assign(new Error('No se encontró el asiento reversible de esta entrega'), { statusCode: 409, code: 'OWNER_CASH_ENTRY_NOT_REVERSIBLE' });
                }

                const anulacionEn = new Date();
                const fechaCorreccion = argentinaTodayAsDate(anulacionEn);
                const { originalPeriodClosed } = await prepareCashCorrection(tx, {
                    inmobiliariaId, fechaCorreccion, movimientoOriginal: pago.movimientoCaja
                });
                const claimed = await tx.pagoPropietario.updateMany({
                    where: { id: pago.id, anuladoEn: null },
                    data: { anuladoEn: anulacionEn, anuladoPorId: usuarioId, motivoAnulacion: motivo, version: { increment: 1 } }
                });
                if (claimed.count !== 1) throw Object.assign(new Error('La entrega ya fue anulada'), { statusCode: 409, code: 'OWNER_PAYMENT_ALREADY_VOIDED' });
                // Un cierre no se reescribe: se mantiene el asiento original
                // y la contrapartida se registra en el período abierto actual.
                // Si el período sigue abierto, ambos asientos quedan fuera del
                // saldo económico al estar el original anulado.
                if (!originalPeriodClosed) {
                    await tx.movimientoCaja.update({
                        where: { id: pago.movimientoCaja.id },
                        data: { anuladoEn: anulacionEn, anuladoPorId: usuarioId, motivoAnulacion: motivo }
                    });
                }
                const reversal = await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Reversión entrega a ${pago.propietario.nombreCompleto} - Liquidación #${liquidacionId}`,
                        monto: pago.monto,
                        moneda: pago.moneda,
                        fecha: fechaCorreccion,
                        metodoPago: pago.metodoPago,
                        cuenta: pago.cuenta,
                        observaciones: motivo,
                        creadoPorId: usuarioId,
                        contratoId: pago.liquidacion.contratoId,
                        liquidacionId,
                        esPagoPropietario: true,
                        reversionDeId: pago.movimientoCaja.id
                    }
                });
                const settlement = await getActiveOwnerPaymentSettlement(tx, {
                    inmobiliariaId,
                    liquidacionId,
                    montoPropietario: pago.liquidacion.montoPropietario
                });
                const updated = await tx.liquidacion.update({
                    where: { id: liquidacionId },
                    data: {
                        estadoPagoPropietario: settlement.estado,
                        montoPagadoPropietario: settlement.pagado,
                        version: { increment: 1 }
                    }
                });
                return {
                    liquidacion: updated,
                    pagoPropietarioId: pago.id,
                    movimientoReversion: reversal,
                    asientoHistoricoConservado: originalPeriodClosed
                };
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

            await auditService.log({
                usuarioId, inmobiliariaId, accion: 'ANULAR_PAGO_PROPIETARIO', entidad: 'PagoPropietario', entidadId: pagoPropietarioId,
                severidad: 'WARNING', detalle: `Entrega de propietario #${pagoPropietarioId} anulada. Motivo: ${motivo}.`
            });
            invalidatePerformanceCache(inmobiliariaId);
            res.json(result);
        } catch (error: any) {
            res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo anular la entrega al propietario', code: error.code });
        }
    }
);

// ─── PDF Inquilino (Comprobante de pago) ─────────────────────────────────────
router.get('/:id/pdf', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacionViva = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { include: { persona: true } }, 
                        propietarios: { include: { persona: true } } 
                    } 
                },
                propietarioPago: true,
                pagos: { where: { anuladoEn: null } },
                aplicacionesCredito: {
                    include: { creditoInquilino: { include: { ajusteLiquidacion: { select: { id: true, concepto: true } } } } }
                },
                ajustes: { include: { creditoInquilino: true }, orderBy: { fechaCreacion: 'asc' } }
            }
        });

        if (!liquidacionViva) return res.status(404).json({ message: 'Liquidación no encontrada' });
        const versionComprobante = requestedVoucherVersion(req.query.version);
        const comprobante = await prisma.comprobanteLiquidacion.findFirst({
            where: { liquidacionId: liquidacionViva.id, version: versionComprobante },
            select: { version: true, fotografia: true, fechaEmision: true }
        });
        if (req.query.version !== undefined && !comprobante) {
            return res.status(404).json({ message: 'No existe esa versión del comprobante', code: 'VOUCHER_VERSION_NOT_FOUND' });
        }
        const snapshot = readLiquidationVoucherSnapshot(comprobante?.fotografia);
        const liquidacion: any = snapshot ? voucherSnapshotToPdfData(snapshot) : liquidacionViva;
        const moneyPdf = (amount: number) => formatCurrencyPdf(amount, liquidacion.moneda);
        const deudaAnterior = snapshot?.deudaAnterior || await getContractDebtSummary(liquidacion.contratoId, inmobiliariaId, Number(id));

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprobante-inquilino-${id}.pdf"`);
        doc.pipe(res);

        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header
        doc.rect(50, 50, pageWidth, 80).fill(INDIGO);
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
            .text('COMPROBANTE DE ALQUILER', 70, 68, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  ${snapshot ? `Comprobante V${snapshot.version}` : 'Sin versión histórica'}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(INDIGO).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAny = liquidacion as any;
        field('Inmueble', liqAny.propiedadDireccion || liqAny.contrato?.propiedad.direccion || '-', col1, y);
        const pPrincipal = liqAny.propietarioNombre
            || liqAny.propietarioPago?.nombreCompleto
            || liqAny.contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto
            || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = liqAny.inquilinoNombre
            || liqAny.contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto
            || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(snapshot?.emitidoEn || liquidacion.fechaCreacion), col2, y);
        y += 40;
        field(
            'Próxima Actualización',
            liqAny.contrato?.requiereActualizacion ? formatDatePdf(liqAny.contrato?.fechaProximaActualizacion) : 'No programada',
            col1,
            y
        );
        y += 50;

        // Ingresos
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        liqAny.movimientos.filter((m: any) => m.tipo === 'INGRESO').forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(moneyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(moneyPdf(Number(liquidacion.totalIngresos)), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentos = liquidacion.movimientos.filter((m: any) => m.tipo === 'DESCUENTO');
        if (descuentos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentos.forEach((m: any) => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${moneyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${moneyPdf(Number(liquidacion.totalDescuentos))})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        // Neto
        doc.rect(50, y, pageWidth, 36).fill(INDIGO);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A PAGAR', 58, y + 12)
            .text(moneyPdf(Number(liquidacion.netoACobrar)), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        y = drawVoucherCorrectionsPdf(doc, y, pageWidth, snapshot, moneyPdf, 'INQUILINO');

        // Pagos
        if (liqAny.pagos && liqAny.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS REGISTRADOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            y = drawPaymentRowsPdf(doc, y, pageWidth, liqAny.pagos, moneyPdf);
        }

        const creditApplications = liqAny.aplicacionesCredito || [];
        if (creditApplications.length > 0) {
            y = ensurePdfSpace(doc, y, 52);
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('SALDOS A FAVOR APLICADOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;
            creditApplications.forEach((application: any) => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica')
                    .text(`Crédito #${application.creditoInquilinoId} · ${application.creditoInquilino.ajusteLiquidacion.concepto}`, 58, y + 5)
                    .text(moneyPdf(Number(application.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                y += 20;
            });
        }

        const creditNotes = (liqAny.ajustes || []).filter((adjustment: any) => adjustment.creditoInquilino);
        if (creditNotes.length > 0) {
            y = ensurePdfSpace(doc, y, 44);
            const lastCredit = creditNotes[creditNotes.length - 1];
            const credit = lastCredit.creditoInquilino;
            const destination = credit.estado === 'DEVUELTO' ? 'devuelto al inquilino' : credit.estado === 'APLICADO' ? 'compensado por completo' : `saldo a favor disponible: ${moneyPdf(Number(credit.saldoPendiente))}`;
            doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
                .text(`NOTA DE CRÉDITO #${lastCredit.id}: ${lastCredit.concepto}`, 58, y)
                .font('Helvetica').text(destination, 58, y + 13);
            y += 30;
        }

        // Saldo pendiente
        const totalPagado = (liqAny.pagos || []).reduce((acc: number, p: any) => acc + Number(p.monto), 0)
            + creditApplications.reduce((acc: number, application: any) => acc + Number(application.monto), 0);
        const saldoPendiente = Number(liquidacion.netoACobrar) - totalPagado;
        if (saldoPendiente > 0) {
            y += 10;
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SALDO PENDIENTE', 58, y)
                .text(moneyPdf(saldoPendiente), 50 + pageWidth - 80, y, { width: 70, align: 'right' });
            y += 18;
        }

        if (deudaAnterior.totalDeuda > 0) {
            y += 12;
            y = drawDebtSummaryPdf(doc, y, pageWidth, deudaAnterior, moneyPdf);

            const totalARegularizar = Math.max(saldoPendiente, 0) + deudaAnterior.totalDeuda;
            y = ensurePdfSpace(doc, y, 50);
            doc.rect(50, y, pageWidth, 34).fill('#7F1D1D');
            doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
                .text('TOTAL A REGULARIZAR', 58, y + 11)
                .text(moneyPdf(totalARegularizar), 50 + pageWidth - 120, y + 11, { width: 110, align: 'right' });
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(snapshot
                ? `Comprobante V${snapshot.version} emitido el ${formatDatePdf(snapshot.emitidoEn)} · Información congelada a esa fecha`
                : `Documento generado el ${formatDatePdf(argentinaTodayAsDate())} · Sin fotografía histórica`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF inquilino:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF' });
    }
});

// ─── PDF Propietario (Liquidación con honorarios y datos del contrato) ────────
router.get('/:id/pdf-propietario', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacionViva = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { include: { persona: true } },
                        propietarios: { include: { persona: true } }
                    }
                },
                propietarioPago: true,
                pagos: { where: { anuladoEn: null } }
            }
        });

        if (!liquidacionViva) return res.status(404).json({ message: 'Liquidación no encontrada' });
        const versionComprobante = requestedVoucherVersion(req.query.version);
        const comprobante = await prisma.comprobanteLiquidacion.findFirst({
            where: { liquidacionId: liquidacionViva.id, version: versionComprobante },
            select: { version: true, fotografia: true, fechaEmision: true }
        });
        if (req.query.version !== undefined && !comprobante) {
            return res.status(404).json({ message: 'No existe esa versión del comprobante', code: 'VOUCHER_VERSION_NOT_FOUND' });
        }
        const snapshot = readLiquidationVoucherSnapshot(comprobante?.fotografia);
        const liquidacion: any = snapshot ? voucherSnapshotToPdfData(snapshot) : liquidacionViva;
        const moneyPdf = (amount: number) => formatCurrencyPdf(amount, liquidacion.moneda);
        const deudaAnterior = snapshot?.deudaAnterior || await getContractDebtSummary(liquidacion.contratoId, inmobiliariaId, Number(id));

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="liquidacion-propietario-${id}.pdf"`);
        doc.pipe(res);

        const contrato = liquidacion.contrato as any;
        const TEAL = '#0F766E';
        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header (color verde-teal para diferenciar del PDF del inquilino)
        doc.rect(50, 50, pageWidth, 80).fill(TEAL);
        doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
            .text('LIQUIDACIÓN — COMPROBANTE PROPIETARIO', 70, 64, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  ${snapshot ? `Comprobante V${snapshot.version}` : 'Sin versión histórica'}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato (ampliados)
        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(TEAL).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAnyProp = liquidacion as any;
        field('Inmueble', liqAnyProp.propiedadDireccion || contrato?.propiedad?.direccion || '-', col1, y);
        const pPrincipal = liqAnyProp.propietarioNombre
            || (liquidacion as any).propietarioPago?.nombreCompleto
            || contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto
            || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = liqAnyProp.inquilinoNombre
            || contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto
            || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(snapshot?.emitidoEn || liquidacion.fechaCreacion), col2, y);
        y += 40;
        field('Vencimiento del Contrato', formatDatePdf(contrato?.fechaFin), col1, y);
        field(
            'Próxima Actualización',
            contrato?.requiereActualizacion ? formatDatePdf(contrato?.fechaProximaActualizacion) : 'No programada',
            col2,
            y
        );
        y += 40;

        // Tipo de ajuste y porcentaje
        const partsAjuste = [
            contrato?.tipoAjuste || null,
            contrato?.porcentajeActualizacion ? `${Number(contrato.porcentajeActualizacion)}%` : null
        ].filter(Boolean);
        field('Tipo / % de Ajuste', partsAjuste.length > 0 ? partsAjuste.join(' · ') : '-', col1, y);
        y += 50;

        // Ingresos
        const ingresosPropietario = liqAnyProp.movimientos.filter((m: any) => m.tipo === 'INGRESO' && !m.esParaInmobiliaria);
        const totalIngresosProp = ingresosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        ingresosPropietario.forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(moneyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(moneyPdf(totalIngresosProp), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentosPropietario = liquidacion.movimientos.filter((m: any) => m.tipo === 'DESCUENTO' && !m.esParaInmobiliaria);
        const totalDescuentosProp = descuentosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        if (descuentosPropietario.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentosPropietario.forEach((m: any) => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${moneyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${moneyPdf(totalDescuentosProp)})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        // Honorarios inmobiliaria
        const montoHonorarios = Number(liquidacion.montoHonorarios || 0);
        const porcentajeHonorarios = liquidacion.porcentajeHonorarios ? Number(liquidacion.porcentajeHonorarios) : null;
        const pagaHonorarios: string = liquidacion.pagaHonorarios || contrato?.pagaHonorarios || 'INQUILINO';

        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('HONORARIOS INMOBILIARIA', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(TEAL).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 22).fill('#F0FDFA');
        const honorariosDescText = porcentajeHonorarios ? `${porcentajeHonorarios}% sobre alquiler` : 'Monto fijo';
        doc.fillColor('#134E4A').fontSize(9).font('Helvetica')
            .text(`${honorariosDescText} — Abona: ${pagaHonorarios}`, 58, y + 7);
        doc.font('Helvetica-Bold')
            .text(moneyPdf(montoHonorarios), 50 + pageWidth - 80, y + 7, { width: 70, align: 'right' });
        y += 32;

        // El importe canónico se calcula al modificar el borrador y queda
        // disponible de la misma forma para API, UI, pago y comprobante.
        const netoParaPropietario = Number(liquidacion.montoPropietario);

        doc.rect(50, y, pageWidth, 36).fill(TEAL);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A TRANSFERIR AL PROPIETARIO', 58, y + 12)
            .text(moneyPdf(netoParaPropietario), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        y = drawVoucherCorrectionsPdf(doc, y, pageWidth, snapshot, moneyPdf, 'PROPIETARIO');

        // Pagos recibidos
        if (liquidacion.pagos && liquidacion.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS RECIBIDOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            y = drawPaymentRowsPdf(doc, y, pageWidth, liquidacion.pagos, moneyPdf);
        }

        if (deudaAnterior.totalDeuda > 0) {
            y += 18;
            y = drawDebtSummaryPdf(
                doc,
                y,
                pageWidth,
                deudaAnterior,
                moneyPdf,
                'DEUDA ANTERIOR PENDIENTE DEL INQUILINO'
            );
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(snapshot
                ? `Comprobante V${snapshot.version} emitido el ${formatDatePdf(snapshot.emitidoEn)} · Información congelada a esa fecha — USO INTERNO`
                : `Documento generado el ${formatDatePdf(argentinaTodayAsDate())} · Sin fotografía histórica — USO INTERNO`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF propietario:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF del propietario' });
    }
});

export default router;
