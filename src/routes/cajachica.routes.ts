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
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFilesContent } from '../middlewares/upload.middleware';

const router = Router();

const movimientoCajaSchema = z.object({
    tipo: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    concepto: requiredText('El concepto', 255),
    monto: positiveDecimal('El monto'),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    fecha: dateOnlyString('La fecha'),
    metodoPago: paymentMethodSchema.optional().default('EFECTIVO'),
    cuentaBancariaId: z.coerce.number().int().positive().optional(),
    observaciones: optionalText(1000)
});

const transferenciaInternaSchema = z.object({
    fecha: dateOnlyString('La fecha'),
    moneda: z.enum(['ARS', 'USD']),
    monto: positiveDecimal('El monto'),
    cuentaOrigenId: z.coerce.number().int().positive('La cuenta de origen es inválida'),
    cuentaDestinoId: z.coerce.number().int().positive('La cuenta de destino es inválida'),
    concepto: requiredText('El concepto', 255),
    observaciones: optionalText(1000)
}).refine(data => data.cuentaOrigenId !== data.cuentaDestinoId, {
    path: ['cuentaDestinoId'],
    message: 'La cuenta de destino debe ser distinta de la cuenta de origen'
});

const anulacionSchema = z.object({
    motivo: requiredText('El motivo de anulación', 1000).min(5, 'El motivo debe tener al menos 5 caracteres')
});

// Obtener movimientos de caja con filtros y paginación
router.get('/', authenticateToken, requirePermission('caja_chica.ver'), withPagination(50), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { tipo, cuenta, cuentaBancariaId, search, mes, anio, estado } = req.query;

    const { page: pageNum, limit: limitNum, skip } = res.locals.pagination;

    try {
        if (estado !== undefined && estado !== 'REVERSIONES') {
            return res.status(400).json({ message: 'Estado de movimiento inválido.', code: 'INVALID_CASH_MOVEMENT_STATUS_FILTER' });
        }

        const isReversalsFilter = estado === 'REVERSIONES';
        const whereClause: Prisma.MovimientoCajaWhereInput = { inmobiliariaId };
        const conditions: Prisma.MovimientoCajaWhereInput[] = [];

        if (tipo) whereClause.tipo = tipo as TipoMovimiento;
        if (cuenta === 'CAJA' || cuenta === 'BANCO') whereClause.cuenta = cuenta as CuentaCaja;
        if (cuentaBancariaId !== undefined) {
            const accountId = Number(cuentaBancariaId);
            if (!Number.isInteger(accountId) || accountId <= 0) {
                return res.status(400).json({ message: 'Cuenta bancaria inválida.', code: 'INVALID_BANK_ACCOUNT_FILTER' });
            }
            whereClause.cuenta = CuentaCaja.BANCO;
            whereClause.cuentaBancariaId = accountId;
        }
        
        if (search) {
            conditions.push({ OR: [
                { concepto: { contains: String(search), mode: 'insensitive' } },
                { observaciones: { contains: String(search), mode: 'insensitive' } }
            ] });
        }

        if (isReversalsFilter) {
            // Incluye tanto el asiento inverso como el movimiento original. Algunos
            // movimientos de períodos cerrados no tienen anuladoEn, pero siempre
            // conservan el vínculo con su reversión.
            conditions.push({ OR: [
                { reversionDeId: { not: null } },
                { reversion: { isNot: null } },
                { anuladoEn: { not: null } }
            ] });
        }

        if (mes && anio) {
            const m = parseInt(String(mes));
            const a = parseInt(String(anio));
            const start = parseDateOnly(`${a}-${String(m).padStart(2, '0')}-01`);
            const nextMonth = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
            const end = parseDateOnly(nextMonth);
            const periodCondition = { fecha: { gte: start, lt: end } };
            if (isReversalsFilter) {
                // Si uno de los dos asientos está en el período elegido, se trae el
                // par completo para que la corrección se pueda revisar en contexto.
                conditions.push({ OR: [
                    periodCondition,
                    { reversion: { is: periodCondition } },
                    { reversionDe: { is: periodCondition } }
                ] });
            } else {
                whereClause.fecha = periodCondition.fecha;
            }
        }

        if (conditions.length) {
            whereClause.AND = conditions;
        }

        const includeRelations = {
            cuentaBancaria: { select: { id: true, banco: true, nombre: true, moneda: true } },
            transferenciaInterna: { select: { id: true, concepto: true } },
            adjuntos: { select: { id: true, rutaArchivo: true, nombreArchivo: true, fechaCreacion: true } },
            contrato: { include: { propiedad: true } },
            creadoPor: { select: { id: true, nombreCompleto: true } },
            anuladoPor: { select: { id: true, nombreCompleto: true } },
            reversion: { select: { id: true, fechaCreacion: true } }
        } satisfies Prisma.MovimientoCajaInclude;

        if (isReversalsFilter) {
            // Se pagina por corrección, en lugar de por asiento: un resultado puede
            // contener el original anulado y su reversión, siempre consecutivos.
            const matchingMovements = await prisma.movimientoCaja.findMany({
                where: whereClause,
                orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
                include: includeRelations
            });

            const relatedIds = new Set<number>();
            matchingMovements.forEach(movimiento => {
                relatedIds.add(movimiento.id);
                if (movimiento.reversionDeId) relatedIds.add(movimiento.reversionDeId);
                if (movimiento.reversion) relatedIds.add(movimiento.reversion.id);
            });

            const pairMovements = relatedIds.size
                ? await prisma.movimientoCaja.findMany({
                    where: { inmobiliariaId, id: { in: [...relatedIds] } },
                    include: includeRelations
                })
                : [];
            const groups = new Map<number, typeof pairMovements>();
            pairMovements.forEach(movimiento => {
                const groupId = movimiento.reversionDeId || movimiento.id;
                const group = groups.get(groupId) || [];
                group.push(movimiento);
                groups.set(groupId, group);
            });

            const orderedGroups = [...groups.values()].sort((left, right) => {
                const latestLeft = Math.max(...left.map(movimiento => movimiento.fecha.getTime()));
                const latestRight = Math.max(...right.map(movimiento => movimiento.fecha.getTime()));
                return latestRight - latestLeft || Math.max(...right.map(movimiento => movimiento.id)) - Math.max(...left.map(movimiento => movimiento.id));
            });
            const movimientos = orderedGroups
                .slice(skip, skip + limitNum)
                .flatMap(group => group.sort((left, right) => {
                    if (Boolean(left.reversionDeId) !== Boolean(right.reversionDeId)) {
                        return left.reversionDeId ? -1 : 1;
                    }
                    return right.id - left.id;
                }));
            const total = orderedGroups.length;

            return res.json({ data: movimientos, meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) } });
        }

        const [total, movimientos] = await Promise.all([
            prisma.movimientoCaja.count({ where: whereClause }),
            prisma.movimientoCaja.findMany({
                where: whereClause,
                orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
                include: includeRelations,
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
      const cuentasBancarias = await prisma.cuentaBancaria.findMany({ where: { inmobiliariaId }, select: { id: true, banco: true, nombre: true, moneda: true, activa: true } });
        const totalsFor = (moneda: 'ARS' | 'USD') => {
          const delPeriodo = ledger.movimientosDelPeriodo[moneda];
          const alCierre = ledger.saldoAlCierre[moneda];
          const gastosOperativos = delPeriodo.otrosEgresos;
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
          saldosBancarios: Object.fromEntries(cuentasBancarias.map(cuenta => [cuenta.id, {
            ...cuenta,
            ingresos: ledger.movimientosDelPeriodo[cuenta.moneda as 'ARS' | 'USD'].cuentasBancarias[String(cuenta.id)]?.ingresos || 0,
            egresos: ledger.movimientosDelPeriodo[cuenta.moneda as 'ARS' | 'USD'].cuentasBancarias[String(cuenta.id)]?.egresos || 0,
            saldo: ledger.saldoAlCierre[cuenta.moneda as 'ARS' | 'USD'].cuentasBancarias[String(cuenta.id)]?.saldo || 0
          }])),
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
      cuentaBancaria: { select: { id: true, banco: true, nombre: true, moneda: true, activa: true, esHistorica: true } },
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

const cierreSchema = z.object({
  periodo: dateOnlyString('El período').refine(value => value.endsWith('-01')),
  cuenta: z.enum(['CAJA', 'BANCO']),
  cuentaBancariaId: z.coerce.number().int().positive().optional(),
  moneda: z.enum(['ARS', 'USD']),
  saldoDeclarado: z.coerce.number().finite(),
  motivoDiferencia: optionalText(1000)
}).superRefine((data, ctx) => {
  if (data.cuenta === 'BANCO' && !data.cuentaBancariaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cuentaBancariaId'], message: 'Seleccioná la cuenta bancaria a conciliar.' });
  }
  if (data.cuenta === 'CAJA' && data.cuentaBancariaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cuentaBancariaId'], message: 'Caja no lleva cuenta bancaria.' });
  }
});
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
      const cuentaBancariaId = body.cuenta === CuentaCaja.BANCO ? Number(body.cuentaBancariaId) : null;
      if (cuentaBancariaId) {
        const cuentaBancaria = await tx.cuentaBancaria.findFirst({
          where: { id: cuentaBancariaId, inmobiliariaId, moneda: body.moneda },
          select: { id: true }
        });
        if (!cuentaBancaria) {
          throw Object.assign(new Error('La cuenta bancaria no pertenece a la inmobiliaria o no coincide con la moneda.'), { statusCode: 400, code: 'INVALID_BANK_ACCOUNT' });
        }
      }
      // La conciliación y el cambio de estado comparten transacción serializable
      // con los movimientos de caja para que no se intercale un asiento nuevo.
      const ledger = await getCashLedgerReport(tx, inmobiliariaId, getMonthlyReportPeriod(periodo.getUTCFullYear(), periodo.getUTCMonth() + 1));
      const saldoSistema = new Decimal(body.cuenta === CuentaCaja.BANCO
        ? ledger.saldoAlCierre[body.moneda as 'ARS' | 'USD'].cuentasBancarias[String(cuentaBancariaId)]?.saldo || 0
        : ledger.saldoAlCierre[body.moneda as 'ARS' | 'USD'].cuentas.CAJA.saldo);
      const declarado = new Decimal(body.saldoDeclarado);
      const diferencia = declarado.minus(saldoSistema);
      if (!diferencia.isZero() && !body.motivoDiferencia) {
        throw Object.assign(new Error('Indicá el motivo de la diferencia de cierre'), { statusCode: 400, code: 'CASH_CLOSING_DIFFERENCE_REASON_REQUIRED' });
      }

      return closeCashPeriod(tx, {
        inmobiliariaId,
        periodo,
        cuenta: body.cuenta as CuentaCaja,
        cuentaBancariaId,
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
      detalle: JSON.stringify({ periodo: body.periodo, cuenta: body.cuenta, cuentaBancariaId: cierre.cuentaBancariaId, moneda: body.moneda, saldoSistema: cierre.saldoSistema, declarado: cierre.saldoDeclarado, version: cierre.version, transition, criterio: 'CUENTA_AL_ULTIMO_DIA_DEL_PERIODO' })
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

// Crear nuevo movimiento manual. Los comprobantes son documentación de respaldo
// y no alteran el importe ni el impacto contable del asiento.
router.post('/', authenticateToken, requirePermission('caja_chica.crear'), upload.array('comprobantes', 10), validateUploadedFilesContent, cleanupFailedUpload, validateBody(movimientoCajaSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { tipo, concepto, monto, moneda, fecha, metodoPago, cuentaBancariaId, observaciones } = req.body;
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];

    if (!tipo || !concepto || !monto || !fecha) {
        return res.status(400).json({ message: 'Faltan campos obligatorios' });
    }

    // La cuenta interna no se elige manualmente: efectivo va a caja y los demás
    // métodos se registran en banco. Así se evita una combinación inconsistente.
    const cuentaFinal: CuentaCaja = metodoPago === 'EFECTIVO' ? 'CAJA' : 'BANCO';

    const persistedAttachments: Array<{ rutaArchivo: string; nombreArchivo: string }> = [];
    let movimiento;
    try {
        for (const file of uploadedFiles) {
            const rutaArchivo = await commitUploadedFile(file, inmobiliariaId);
            if (rutaArchivo) persistedAttachments.push({ rutaArchivo, nombreArchivo: file.originalname.slice(0, 255) });
        }
        // La validación y la creación comparten transacción para que un cierre
        // concurrente no pueda intercalarse entre ambas operaciones.
        movimiento = await prisma.$transaction(async tx => {
            const fechaMovimiento = parseDateOnly(fecha);
            assertOperationalDateIsNotFuture(fechaMovimiento, 'La fecha del movimiento de caja');
            let cuentaBancariaFinal: number | null = null;
            if (cuentaFinal === 'BANCO') {
                if (!cuentaBancariaId) {
                    throw Object.assign(new Error('Seleccioná la cuenta bancaria donde se registró la operación.'), { statusCode: 400, code: 'BANK_ACCOUNT_REQUIRED' });
                }
                const cuentaBancaria = await tx.cuentaBancaria.findFirst({
                    where: { id: cuentaBancariaId, inmobiliariaId, activa: true, moneda: moneda || 'ARS' },
                    select: { id: true }
                });
                if (!cuentaBancaria) {
                    throw Object.assign(new Error('La cuenta bancaria elegida no está activa o no corresponde a la moneda del movimiento.'), { statusCode: 400, code: 'INVALID_BANK_ACCOUNT' });
                }
                cuentaBancariaFinal = cuentaBancaria.id;
            }
            await assertCashPeriodOpen(tx, {
                inmobiliariaId,
                fecha: fechaMovimiento,
                cuenta: cuentaFinal,
                moneda: moneda || 'ARS',
                cuentaBancariaId: cuentaBancariaFinal
            });
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
                    cuentaBancariaId: cuentaBancariaFinal,
                    observaciones,
                    creadoPorId: usuarioId,
                    adjuntos: persistedAttachments.length > 0 ? {
                        create: persistedAttachments.map(attachment => ({ ...attachment, creadoPorId: usuarioId }))
                    } : undefined
                },
                include: {
                    adjuntos: { select: { id: true, rutaArchivo: true, nombreArchivo: true, fechaCreacion: true } }
                }
            });
        });
    } catch (error: any) {
        await Promise.all(persistedAttachments.map(attachment => removeUploadedFile(attachment.rutaArchivo)));
        console.error('Error al crear movimiento de caja:', error);
        return res.status(error.statusCode || 500).json({ message: error.message || 'Error interno del servidor', code: error.code });
    }

    await auditService.log({
        usuarioId,
        inmobiliariaId,
        accion: 'CREAR_MOVIMIENTO_CAJA',
        entidad: 'MovimientoCaja',
        entidadId: movimiento!.id,
        detalle: `${movimiento!.tipo}: ${movimiento!.concepto} por ${movimiento!.moneda === 'USD' ? 'US$' : '$'}${movimiento!.monto}${persistedAttachments.length ? ` · ${persistedAttachments.length} comprobante(s)` : ''}`
    });

    invalidatePerformanceCache(inmobiliariaId);

    res.status(201).json(movimiento);
});

// Permite completar el respaldo documental luego de registrar el movimiento,
// por ejemplo cuando el comprobante de transferencia llega más tarde.
router.post('/:id/comprobantes', authenticateToken, requirePermission('caja_chica.crear'), upload.array('comprobantes', 10), validateUploadedFilesContent, cleanupFailedUpload, async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const movimientoId = Number(req.params.id);
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];

    if (!Number.isInteger(movimientoId) || movimientoId <= 0) {
        return res.status(400).json({ message: 'Movimiento inválido.', code: 'INVALID_CASH_MOVEMENT' });
    }
    if (uploadedFiles.length === 0) {
        return res.status(400).json({ message: 'Seleccioná al menos un comprobante.', code: 'ATTACHMENT_REQUIRED' });
    }

    const movimiento = await prisma.movimientoCaja.findFirst({
        where: { id: movimientoId, inmobiliariaId, anuladoEn: null },
        select: { id: true, concepto: true }
    });
    if (!movimiento) {
        return res.status(404).json({ message: 'Movimiento no encontrado o anulado.', code: 'CASH_MOVEMENT_NOT_FOUND' });
    }

    const persistedAttachments: Array<{ rutaArchivo: string; nombreArchivo: string }> = [];
    try {
        for (const file of uploadedFiles) {
            const rutaArchivo = await commitUploadedFile(file, inmobiliariaId);
            if (rutaArchivo) persistedAttachments.push({ rutaArchivo, nombreArchivo: file.originalname.slice(0, 255) });
        }
        const adjuntos = await prisma.$transaction(tx => Promise.all(
            persistedAttachments.map(attachment => tx.adjuntoMovimientoCaja.create({
                data: { ...attachment, movimientoCajaId: movimiento.id, creadoPorId: usuarioId }
            }))
        ));

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ADJUNTAR_COMPROBANTES_MOVIMIENTO_CAJA',
            entidad: 'MovimientoCaja',
            entidadId: movimiento.id,
            detalle: `${adjuntos.length} comprobante(s) adjuntado(s) a: ${movimiento.concepto}`
        });
        res.status(201).json({ data: adjuntos });
    } catch (error: any) {
        await Promise.all(persistedAttachments.map(attachment => removeUploadedFile(attachment.rutaArchivo)));
        console.error('Error al adjuntar comprobantes del movimiento de caja:', error);
        res.status(error.statusCode || 500).json({ message: error.message || 'No se pudieron adjuntar los comprobantes.', code: error.code });
    }
});

/**
 * Traslada fondos entre dos cuentas propias. Los dos asientos usan el mismo
 * identificador de transferencia, de modo que el historial conserva origen y
 * destino sin alterar el saldo consolidado de bancos ni el total general.
 */
router.post('/transferencias', authenticateToken, requirePermission('caja_chica.crear'), requireRecentAuthentication, validateBody(transferenciaInternaSchema), async (req: AuthRequest, res) => {
    const { inmobiliariaId, id: usuarioId } = req.user!;
    const { fecha, moneda, monto, cuentaOrigenId, cuentaDestinoId, concepto, observaciones } = req.body as z.infer<typeof transferenciaInternaSchema>;

    try {
        const result = await prisma.$transaction(async tx => {
            const fechaTransferencia = parseDateOnly(fecha);
            assertOperationalDateIsNotFuture(fechaTransferencia, 'La fecha de la transferencia interna');
            const cuentas = await tx.cuentaBancaria.findMany({
                where: {
                    id: { in: [cuentaOrigenId, cuentaDestinoId] },
                    inmobiliariaId,
                    activa: true,
                    moneda
                },
                select: { id: true, banco: true, nombre: true, moneda: true }
            });
            const origen = cuentas.find(cuenta => cuenta.id === cuentaOrigenId);
            const destino = cuentas.find(cuenta => cuenta.id === cuentaDestinoId);
            if (!origen || !destino) {
                throw Object.assign(new Error('Origen y destino deben ser cuentas activas de la inmobiliaria y de la misma moneda.'), { statusCode: 400, code: 'INVALID_INTERNAL_TRANSFER_ACCOUNT' });
            }

            // Ambos bloqueos se verifican antes de crear nada: una transferencia
            // nunca puede quedar a medias porque una de las dos cuentas cerró.
            await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: fechaTransferencia, cuenta: CuentaCaja.BANCO, moneda, cuentaBancariaId: origen.id });
            await assertCashPeriodOpen(tx, { inmobiliariaId, fecha: fechaTransferencia, cuenta: CuentaCaja.BANCO, moneda, cuentaBancariaId: destino.id });

            const transferencia = await tx.transferenciaInterna.create({
                data: { inmobiliariaId, creadoPorId: usuarioId, fecha: fechaTransferencia, moneda, monto: new Decimal(monto), concepto, observaciones }
            });
            const prefijo = `Transferencia interna #${transferencia.id}`;
            const [egreso, ingreso] = await Promise.all([
                tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        creadoPorId: usuarioId,
                        transferenciaInternaId: transferencia.id,
                        tipo: TipoMovimiento.EGRESO,
                        concepto: `${prefijo}: ${origen.banco} — ${origen.nombre} → ${destino.banco} — ${destino.nombre}`.slice(0, 255),
                        monto: new Decimal(monto),
                        moneda,
                        fecha: fechaTransferencia,
                        metodoPago: MetodoPago.TRANSFERENCIA,
                        cuenta: CuentaCaja.BANCO,
                        cuentaBancariaId: origen.id,
                        observaciones
                    }
                }),
                tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        creadoPorId: usuarioId,
                        transferenciaInternaId: transferencia.id,
                        tipo: TipoMovimiento.INGRESO,
                        concepto: `${prefijo}: ${origen.banco} — ${origen.nombre} → ${destino.banco} — ${destino.nombre}`.slice(0, 255),
                        monto: new Decimal(monto),
                        moneda,
                        fecha: fechaTransferencia,
                        metodoPago: MetodoPago.TRANSFERENCIA,
                        cuenta: CuentaCaja.BANCO,
                        cuentaBancariaId: destino.id,
                        observaciones
                    }
                })
            ]);
            return { transferencia, egreso, ingreso, origen, destino };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'TRANSFERIR_ENTRE_CUENTAS',
            entidad: 'TransferenciaInterna',
            entidadId: result.transferencia.id,
            detalle: `${result.transferencia.moneda} ${result.transferencia.monto} desde ${result.origen.banco} — ${result.origen.nombre} hacia ${result.destino.banco} — ${result.destino.nombre}`
        });
        invalidatePerformanceCache(inmobiliariaId);
        res.status(201).json(result);
    } catch (error: any) {
        console.error('Error al transferir entre cuentas:', error);
        res.status(error.statusCode || 400).json({ message: error.message || 'No se pudo registrar la transferencia interna', code: error.code });
    }
});

/**
 * Anula un asiento manual mediante contrapartida. Los asientos generados por
 * pagos o liquidaciones se corrigen desde su operación de origen.
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
                include: { reversion: true }
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
            if (movimiento.pagoId || movimiento.liquidacionId || movimiento.contratoId || movimiento.transferenciaInternaId) {
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
                    cuentaBancariaId: movimiento.cuentaBancariaId,
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
