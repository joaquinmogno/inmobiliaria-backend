import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { TipoMovimiento, MetodoPago, CuentaCaja, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { validateBody, requiredText, positiveDecimal, dateOnlyString, optionalText, paymentMethodSchema } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { cached, invalidatePerformanceCache } from '../services/performance-cache.service';
import { argentinaTodayAsDate, argentinaYearMonth, assertOperationalDateIsNotFuture, parseDateOnly } from '../utils/argentina-date';
import { withPagination } from '../middlewares/pagination.middleware';
import { assertCashPeriodOpen, closeCashPeriod, monthStart, prepareCashCorrection, reopenCashPeriod } from '../services/cash-closing.service';
import { getCashLedgerReport, getMonthlyReportPeriod } from '../services/financial-reporting.service';

const router = Router();

const movimientoCajaSchema = z.object({
    tipo: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    concepto: requiredText('El concepto', 255),
    monto: positiveDecimal('El monto'),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    fecha: dateOnlyString('La fecha'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    observaciones: optionalText(1000)
});

const anulacionSchema = z.object({
    motivo: requiredText('El motivo de anulación', 1000).min(5, 'El motivo debe tener al menos 5 caracteres')
});

// Obtener movimientos de caja con filtros y paginación
router.get('/', authenticateToken, requirePermission('caja_chica.ver'), withPagination(50), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { tipo, cuenta, search, mes, anio } = req.query;

    const { page: pageNum, limit: limitNum, skip } = res.locals.pagination;

    try {
        const whereClause: any = {
            inmobiliariaId
        };

        if (tipo) whereClause.tipo = tipo as TipoMovimiento;
        if (cuenta) whereClause.cuenta = cuenta as CuentaCaja;
        
        if (search) {
            whereClause.OR = [
                { concepto: { contains: String(search), mode: 'insensitive' } },
                { observaciones: { contains: String(search), mode: 'insensitive' } }
            ];
        }

        if (mes && anio) {
            const m = parseInt(String(mes));
            const a = parseInt(String(anio));
            const start = parseDateOnly(`${a}-${String(m).padStart(2, '0')}-01`);
            const nextMonth = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
            const end = parseDateOnly(nextMonth);
            whereClause.fecha = { gte: start, lt: end };
        }

        const [total, movimientos] = await Promise.all([
            prisma.movimientoCaja.count({ where: whereClause }),
            prisma.movimientoCaja.findMany({
                where: whereClause,
                orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
                include: {
                    contrato: { include: { propiedad: true } },
                    creadoPor: { select: { id: true, nombreCompleto: true } },
                    anuladoPor: { select: { id: true, nombreCompleto: true } },
                    reversion: { select: { id: true, fechaCreacion: true } },
                    ajustePagoSueldoDe: { select: { id: true } }
                },
                skip,
                take: limitNum
            })
        ]);

        res.json({ data: movimientos, meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) } });
    } catch (error) {
        console.error('Error fetching caja chica:', error);
        res.status(500).json({ message: 'Error al obtener la caja chica' });
    }
});

router.get('/resumen', authenticateToken, requirePermission('caja_chica.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const [currentYear, currentMonth] = argentinaYearMonth().split('-').map(Number);
    const mes = Number(req.query.mes || currentMonth);
    const anio = Number(req.query.anio || currentYear);
    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio) || anio < 2000 || anio > 2200) {
        return res.status(400).json({ message: 'Período inválido' });
    }

    try {
      const summary = await cached(`inmobiliaria:${inmobiliariaId}:caja:${anio}-${mes}`, 20_000, async () => {
        const ledger = await getCashLedgerReport(prisma, inmobiliariaId, getMonthlyReportPeriod(anio, mes));
        const totalsFor = (moneda: 'ARS' | 'USD') => {
          const delPeriodo = ledger.movimientosDelPeriodo[moneda];
          const alCierre = ledger.saldoAlCierre[moneda];
          const gastosOperativos = delPeriodo.otrosEgresos + delPeriodo.pagosSueldos;
          return {
            // Los movimientos son del mes; el balance corresponde al último día
            // del mes y por eso puede utilizarse para cerrar períodos históricos.
            totalIngresos: delPeriodo.ingresos,
            totalEgresos: delPeriodo.egresos,
            balance: alCierre.saldo,
            balanceCaja: alCierre.cuentas.CAJA.saldo,
            balanceBanco: alCierre.cuentas.BANCO.saldo,
            totalCobrado: delPeriodo.cobrosInquilinos,
            totalPagadoPropietarios: delPeriodo.pagosPropietarios,
            gastosGenerales: gastosOperativos,
            gananciaBruta: delPeriodo.otrosIngresos,
            resultadoNeto: delPeriodo.otrosIngresos - gastosOperativos,
            fondosEnCustodia: Math.max(0, delPeriodo.cobrosInquilinos - delPeriodo.pagosPropietarios),
            pagosSueldos: delPeriodo.pagosSueldos,
            otrosIngresos: delPeriodo.otrosIngresos,
            otrosEgresos: delPeriodo.otrosEgresos
          };
        };
        const totalesPorMoneda = { ARS: totalsFor('ARS'), USD: totalsFor('USD') };
        const ars = totalesPorMoneda.ARS;

        return {
          ...ledger,
          balanceGeneral: ars.balance,
          totalIngresos: ars.totalIngresos,
          totalEgresos: ars.totalEgresos,
          totalIngresosARS: ars.totalIngresos,
          totalEgresosARS: ars.totalEgresos,
          balanceARS: ars.balance,
          totalIngresosUSD: totalesPorMoneda.USD.totalIngresos,
          totalEgresosUSD: totalesPorMoneda.USD.totalEgresos,
          balanceUSD: totalesPorMoneda.USD.balance,
          totalesPorMoneda,
          balanceCaja: ars.balanceCaja,
          balanceBanco: ars.balanceBanco,
          totalCobrado: ars.totalCobrado,
          totalPagadoPropietarios: ars.totalPagadoPropietarios,
          gastosGenerales: ars.gastosGenerales,
          gananciaBruta: ars.gananciaBruta,
          resultadoNeto: ars.resultadoNeto,
          fondosEnCustodia: ars.fondosEnCustodia
        };
      });
      res.json(summary);
    } catch (error) {
        console.error('Error fetching caja chica:', error);
        res.status(500).json({ message: 'Error al obtener la caja chica' });
    }
});

router.get('/cierres', authenticateToken, requirePermission('caja_chica.ver'), async (req, res) => {
  const { inmobiliariaId } = (req as AuthRequest).user!;
  res.json(await prisma.cierreCaja.findMany({
    where: { inmobiliariaId },
    include: {
      cerradoPor: { select: { nombreCompleto: true } },
      reabiertoPor: { select: { nombreCompleto: true } },
      eventos: {
        include: { usuario: { select: { nombreCompleto: true } } },
        orderBy: { version: 'asc' }
      }
    },
    orderBy: { periodo: 'desc' }
  }));
});

const cierreSchema = z.object({ periodo: dateOnlyString('El período').refine(value => value.endsWith('-01')), cuenta: z.enum(['CAJA', 'BANCO']), moneda: z.enum(['ARS', 'USD']), saldoDeclarado: z.coerce.number().finite(), motivoDiferencia: optionalText(1000) });
router.post('/cierres', authenticateToken, requirePermission('caja_chica.cerrar'), requireRecentAuthentication, validateBody(cierreSchema), async (req, res) => {
  const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
  const body = req.body;
  const periodo = parseDateOnly(body.periodo);
  const currentPeriod = monthStart(argentinaTodayAsDate());
  if (periodo > currentPeriod) {
    return res.status(409).json({ message: 'No se puede cerrar un período futuro', code: 'FUTURE_CASH_CLOSING' });
  }

  try {
    const { cierre, transition } = await prisma.$transaction(async tx => {
      // La conciliación y el cambio de estado comparten transacción serializable
      // con los movimientos de caja para que no se intercale un asiento nuevo.
      const ledger = await getCashLedgerReport(tx, inmobiliariaId, getMonthlyReportPeriod(periodo.getUTCFullYear(), periodo.getUTCMonth() + 1));
      const saldoSistema = new Decimal(ledger.saldoAlCierre[body.moneda as 'ARS' | 'USD'].cuentas[body.cuenta as CuentaCaja].saldo);
      const declarado = new Decimal(body.saldoDeclarado);
      const diferencia = declarado.minus(saldoSistema);
      if (!diferencia.isZero() && !body.motivoDiferencia) {
        throw Object.assign(new Error('Indicá el motivo de la diferencia de cierre'), { statusCode: 400, code: 'CASH_CLOSING_DIFFERENCE_REASON_REQUIRED' });
      }

      return closeCashPeriod(tx, {
        inmobiliariaId,
        periodo,
        cuenta: body.cuenta as CuentaCaja,
        moneda: body.moneda,
        saldoSistema,
        saldoDeclarado: declarado,
        diferencia,
        motivoDiferencia: body.motivoDiferencia,
        usuarioId
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await auditService.log({
      usuarioId,
      inmobiliariaId,
      accion: 'CERRAR_CAJA',
      entidad: 'CierreCaja',
      entidadId: cierre.id,
      detalle: JSON.stringify({ periodo: body.periodo, cuenta: body.cuenta, moneda: body.moneda, saldoSistema: cierre.saldoSistema, declarado: cierre.saldoDeclarado, version: cierre.version, transition, criterio: 'CAJA_AL_ULTIMO_DIA_DEL_PERIODO' })
    });
    invalidatePerformanceCache(inmobiliariaId);
    res.status(201).json(cierre);
  } catch (error: any) {
    console.error('No se pudo cerrar el período de caja:', error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({
        message: 'El período de caja fue cerrado por otra operación. Actualizá la pantalla.',
        code: 'CASH_PERIOD_ALREADY_CLOSED'
      });
    }
    res.status(error.statusCode || 409).json({ message: error.message || 'No se pudo cerrar el período', code: error.code });
  }
});

router.post('/cierres/:id/reabrir', authenticateToken, requirePermission('caja_chica.reabrir'), requireRecentAuthentication, validateBody(anulacionSchema), async (req, res) => {
  const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
  const cierreId = Number(req.params.id);
  if (!Number.isInteger(cierreId) || cierreId <= 0) {
    return res.status(400).json({ message: 'Cierre inválido', code: 'INVALID_CASH_CLOSING' });
  }

  try {
    const updated = await prisma.$transaction(
      tx => reopenCashPeriod(tx, { cierreId, inmobiliariaId, usuarioId, motivo: req.body.motivo }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    await auditService.log({
      usuarioId,
      inmobiliariaId,
      accion: 'REABRIR_CAJA',
      entidad: 'CierreCaja',
      entidadId: updated.id,
      severidad: 'WARNING',
      detalle: JSON.stringify({ motivo: req.body.motivo, version: updated.version })
    });
    invalidatePerformanceCache(inmobiliariaId);
    res.json(updated);
  } catch (error: any) {
    console.error('No se pudo reabrir el período de caja:', error);
    res.status(error.statusCode || 409).json({ message: error.message || 'No se pudo reabrir el período', code: error.code });
  }
});

// Crear nuevo movimiento manual
router.post('/', authenticateToken, requirePermission('caja_chica.crear'), validateBody(movimientoCajaSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { tipo, concepto, monto, moneda, fecha, metodoPago, observaciones } = req.body;

    if (!tipo || !concepto || !monto || !fecha) {
        return res.status(400).json({ message: 'Faltan campos obligatorios' });
    }

    // La cuenta interna no se elige manualmente: efectivo va a caja y los demás
    // métodos se registran en banco. Así se evita una combinación inconsistente.
    const cuentaFinal: CuentaCaja = metodoPago === 'EFECTIVO' ? 'CAJA' : 'BANCO';

    try {
        // La validación y la creación comparten transacción para que un cierre
        // concurrente no pueda intercalarse entre ambas operaciones.
        const movimiento = await prisma.$transaction(async tx => {
            const fechaMovimiento = parseDateOnly(fecha);
            assertOperationalDateIsNotFuture(fechaMovimiento, 'La fecha del movimiento de caja');
            await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: fechaMovimiento, cuenta: cuentaFinal, moneda: moneda || 'ARS' });
            return tx.movimientoCaja.create({
                data: {
                    inmobiliariaId,
                    tipo: tipo as TipoMovimiento,
                    concepto,
                    monto: new Decimal(monto),
                    moneda: moneda || 'ARS',
                    fecha: fechaMovimiento,
                    metodoPago: (metodoPago as MetodoPago) || 'EFECTIVO',
                    cuenta: cuentaFinal,
                    observaciones,
                    creadoPorId: usuarioId
                }
            });
        });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'CREAR_MOVIMIENTO_CAJA',
            entidad: 'MovimientoCaja',
            entidadId: movimiento.id,
            detalle: `${movimiento.tipo}: ${movimiento.concepto} por ${movimiento.moneda === 'USD' ? 'US$' : '$'}${movimiento.monto}`
        });

        invalidatePerformanceCache(inmobiliariaId);

        res.status(201).json(movimiento);
    } catch (error: any) {
        console.error('Error al crear movimiento de caja:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'Error interno del servidor', code: error.code });
    }
});

/**
 * Anula un asiento manual mediante contrapartida. Los asientos generados por
 * pagos, sueldos o liquidaciones se corrigen desde su operación de origen.
 */
router.post('/:id/anular', authenticateToken, requirePermission('caja_chica.eliminar'), requireRecentAuthentication, validateBody(anulacionSchema), async (req, res) => {
    const movimientoId = Number(req.params.id);
    const { motivo } = req.body;
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;

    if (!Number.isInteger(movimientoId) || movimientoId <= 0) {
        return res.status(400).json({ message: 'Movimiento inválido' });
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            const movimiento = await tx.movimientoCaja.findFirst({
                where: { id: movimientoId, inmobiliariaId },
                include: { reversion: true, ajustePagoSueldoDe: true }
            });

            if (!movimiento) {
                throw Object.assign(new Error('Movimiento no encontrado'), { statusCode: 404, code: 'CASH_MOVEMENT_NOT_FOUND' });
            }
            if (movimiento.anuladoEn || movimiento.reversion) {
                throw Object.assign(new Error('El movimiento ya fue anulado'), { statusCode: 409, code: 'CASH_MOVEMENT_ALREADY_VOIDED' });
            }
            if (movimiento.reversionDeId) {
                throw Object.assign(new Error('Un asiento de reversión no puede volver a anularse'), { statusCode: 409, code: 'REVERSAL_CANNOT_BE_VOIDED' });
            }
            if (movimiento.pagoId || movimiento.pagoSueldoId || movimiento.liquidacionId || movimiento.contratoId || movimiento.ajustePagoSueldoDe) {
                throw Object.assign(
                    new Error('Este movimiento fue generado por otra operación y debe corregirse desde su módulo de origen'),
                    { statusCode: 409, code: 'SYSTEM_CASH_MOVEMENT' }
                );
            }
            if (movimiento.tipo !== TipoMovimiento.INGRESO && movimiento.tipo !== TipoMovimiento.EGRESO) {
                throw Object.assign(new Error('Este tipo de movimiento histórico no admite reversión automática'), { statusCode: 409, code: 'UNSUPPORTED_CASH_MOVEMENT_TYPE' });
            }

            const anulacionEn = new Date();
            const fechaCorreccion = argentinaTodayAsDate(anulacionEn);
            const { originalPeriodClosed } = await prepareCashCorrection(tx, {
                inmobiliariaId,
                fechaCorreccion,
                movimientoOriginal: movimiento
            });

            if (!originalPeriodClosed) {
                const updated = await tx.movimientoCaja.updateMany({
                    where: { id: movimiento.id, inmobiliariaId, anuladoEn: null },
                    data: { anuladoEn: anulacionEn, anuladoPorId: usuarioId, motivoAnulacion: motivo }
                });
                if (updated.count !== 1) {
                    throw Object.assign(new Error('El movimiento ya fue anulado'), { statusCode: 409, code: 'CASH_MOVEMENT_ALREADY_VOIDED' });
                }
            }

            const reversion = await tx.movimientoCaja.create({
                data: {
                    inmobiliariaId,
                    tipo: movimiento.tipo === TipoMovimiento.INGRESO ? TipoMovimiento.EGRESO : TipoMovimiento.INGRESO,
                    concepto: `Reversión #${movimiento.id}: ${movimiento.concepto}`,
                    monto: movimiento.monto,
                    moneda: movimiento.moneda,
                    fecha: fechaCorreccion,
                    metodoPago: movimiento.metodoPago,
                    cuenta: movimiento.cuenta,
                    observaciones: motivo,
                    creadoPorId: usuarioId,
                    reversionDeId: movimiento.id
                }
            });

            await tx.auditLog.create({
                data: {
                    usuarioId,
                    inmobiliariaId,
                    accion: 'ANULAR_MOVIMIENTO_CAJA',
                    entidad: 'MovimientoCaja',
                    entidadId: movimiento.id,
                    severidad: 'WARNING',
                    detalle: `${movimiento.tipo} de ${movimiento.moneda} ${movimiento.monto} anulado. Motivo: ${motivo}. Asiento inverso #${reversion.id}.`
                }
            });

            return { movimientoId: movimiento.id, anuladoEn: anulacionEn, motivoAnulacion: motivo, reversion };
        }, { isolationLevel: 'Serializable' });

        invalidatePerformanceCache(inmobiliariaId);
        res.json(result);
    } catch (error: any) {
        console.error('Error al anular movimiento de caja:', error);
        res.status(error.statusCode || 400).json({ message: error.message || 'Error al anular el movimiento', code: error.code });
    }
});

export default router;
