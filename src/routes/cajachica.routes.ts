import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { TipoMovimiento, MetodoPago, CuentaCaja } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { validateBody, requiredText, positiveDecimal, dateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { cached, invalidatePerformanceCache } from '../services/performance-cache.service';

const router = Router();

const movimientoCajaSchema = z.object({
    tipo: z.enum(['INGRESO', 'DESCUENTO', 'EGRESO']),
    concepto: requiredText('El concepto', 255),
    monto: positiveDecimal('El monto'),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    fecha: dateOnlyString('La fecha'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional().default('EFECTIVO'),
    cuenta: z.enum(['CAJA', 'BANCO']).optional(),
    observaciones: optionalText(1000)
});

// Obtener movimientos de caja con filtros y paginación
router.get('/', authenticateToken, requirePermission('caja_chica.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { tipo, cuenta, search, page, limit, mes, anio } = req.query;

    const pageNum = page ? parseInt(String(page)) : 1;
    const limitNum = limit ? parseInt(String(limit)) : 50;
    const skip = (pageNum - 1) * limitNum;

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
            const start = new Date(a, m - 1, 1);
            const end = new Date(a, m, 1);
            whereClause.fecha = { gte: start, lt: end };
        }

        const [total, movimientos] = await Promise.all([
            prisma.movimientoCaja.count({ where: whereClause }),
            prisma.movimientoCaja.findMany({
                where: whereClause,
                orderBy: { fecha: 'desc' },
                include: {
                    contrato: { include: { propiedad: true } },
                    creadoPor: { select: { nombreCompleto: true } }
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
    const mes = Number(req.query.mes || new Date().getMonth() + 1);
    const anio = Number(req.query.anio || new Date().getFullYear());
    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio) || anio < 2000 || anio > 2200) {
        return res.status(400).json({ message: 'Período inválido' });
    }

    try {
      const summary = await cached(`inmobiliaria:${inmobiliariaId}:caja:${anio}-${mes}`, 20_000, async () => {
        const start = new Date(anio, mes - 1, 1);
        const end = new Date(anio, mes, 1);
        const [allTimeGroups, periodGroups, liquidacionesCobradas] = await Promise.all([
          prisma.movimientoCaja.groupBy({ by: ['moneda', 'tipo', 'cuenta'], where: { inmobiliariaId }, _sum: { monto: true } }),
          prisma.movimientoCaja.groupBy({ by: ['moneda', 'tipo', 'cuenta', 'liquidacionId'], where: { inmobiliariaId, fecha: { gte: start, lt: end } }, _sum: { monto: true } }),
          prisma.liquidacion.findMany({
            where: {
                inmobiliariaId,
                movimientosCaja: { some: { tipo: 'INGRESO', fecha: { gte: start, lt: end } } }
            },
            select: {
                moneda: true, montoHonorarios: true, netoACobrar: true,
                movimientos: { where: { esParaInmobiliaria: true }, select: { monto: true } },
                movimientosCaja: {
                    where: { tipo: 'INGRESO', fecha: { gte: start, lt: end } }, select: { monto: true }
                }
            }
          })
        ]);

        const monedas = ['ARS', 'USD'] as const;
        const groupedAmount = (moneda: typeof monedas[number], tipo: TipoMovimiento, cuenta?: CuentaCaja) => allTimeGroups
            .filter(group => group.moneda === moneda && group.tipo === tipo && (!cuenta || group.cuenta === cuenta))
            .reduce((sum, group) => sum + Number(group._sum.monto || 0), 0);
        const periodAmount = (moneda: typeof monedas[number], tipo: TipoMovimiento, linked: boolean) => periodGroups
            .filter(group => group.moneda === moneda && group.tipo === tipo && (linked ? group.liquidacionId !== null : group.liquidacionId === null))
            .reduce((sum, group) => sum + Number(group._sum.monto || 0), 0);

        const totalesPorMoneda = Object.fromEntries(monedas.map(moneda => {
            const totalIngresos = groupedAmount(moneda, 'INGRESO');
            const totalEgresos = groupedAmount(moneda, 'EGRESO');
            const balanceCajaIngresos = groupedAmount(moneda, 'INGRESO', 'CAJA');
            const balanceCajaEgresos = groupedAmount(moneda, 'EGRESO', 'CAJA');
            const balanceBancoIngresos = groupedAmount(moneda, 'INGRESO', 'BANCO');
            const balanceBancoEgresos = groupedAmount(moneda, 'EGRESO', 'BANCO');
            const totalCobrado = periodAmount(moneda, 'INGRESO', true);
            const totalPagadoPropietarios = periodAmount(moneda, 'EGRESO', true);
            const gastosGenerales = periodAmount(moneda, 'EGRESO', false);
            const ingresosManuales = periodAmount(moneda, 'INGRESO', false);

            let honorariosCobradosMoneda = 0;
            liquidacionesCobradas
                .filter(l => l.moneda === moneda)
                .forEach(l => {
                    const honsFijos = Number(l.montoHonorarios || 0);
                    const honsMovimientos = l.movimientos
                        .reduce((acc, m) => acc + Number(m.monto), 0);
                    const cobrado = Number(l.movimientosCaja
                        .reduce((sum, movimiento) => sum + Number(movimiento.monto), 0));
                    const ratioCobrado = Number(l.netoACobrar) > 0 ? cobrado / Number(l.netoACobrar) : 0;
                    honorariosCobradosMoneda += (honsFijos + honsMovimientos) * Math.min(ratioCobrado, 1);
                });

            const fondosEnCustodia = Math.max(0, totalCobrado - honorariosCobradosMoneda - totalPagadoPropietarios);
            const gananciaBruta = honorariosCobradosMoneda + ingresosManuales;
            const resultadoNeto = gananciaBruta - gastosGenerales;

            return [moneda, {
                totalIngresos,
                totalEgresos,
                balance: totalIngresos - totalEgresos,
                balanceCaja: balanceCajaIngresos - balanceCajaEgresos,
                balanceBanco: balanceBancoIngresos - balanceBancoEgresos,
                totalCobrado,
                totalPagadoPropietarios,
                gastosGenerales,
                gananciaBruta,
                resultadoNeto,
                fondosEnCustodia
            }];
        })) as Record<'ARS' | 'USD', any>;

        const ars = totalesPorMoneda.ARS;

        const balanceGeneral = ars.balance;
        const balanceCaja = ars.balanceCaja;
        const balanceBanco = ars.balanceBanco;

        return {
                balanceGeneral,
                totalIngresos: ars.totalIngresos,
                totalEgresos: ars.totalEgresos,
                totalIngresosARS: totalesPorMoneda.ARS.totalIngresos,
                totalEgresosARS: totalesPorMoneda.ARS.totalEgresos,
                balanceARS: totalesPorMoneda.ARS.balance,
                totalIngresosUSD: totalesPorMoneda.USD.totalIngresos,
                totalEgresosUSD: totalesPorMoneda.USD.totalEgresos,
                balanceUSD: totalesPorMoneda.USD.balance,
                totalesPorMoneda,
                balanceCaja,
                balanceBanco,
                // KPIs
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

// Crear nuevo movimiento manual
router.post('/', authenticateToken, requirePermission('caja_chica.crear'), validateBody(movimientoCajaSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { tipo, concepto, monto, moneda, fecha, metodoPago, cuenta, observaciones } = req.body;

    if (!tipo || !concepto || !monto || !fecha) {
        return res.status(400).json({ message: 'Faltan campos obligatorios' });
    }

    // Auto-asignar cuenta si no se pasa: efectivo => CAJA, resto => BANCO
    const cuentaFinal: CuentaCaja = cuenta
        ? (cuenta as CuentaCaja)
        : (metodoPago === 'EFECTIVO' ? 'CAJA' : 'BANCO');

    try {
        const movimiento = await prisma.movimientoCaja.create({
            data: {
                inmobiliariaId,
                tipo: tipo as TipoMovimiento,
                concepto,
                monto: new Decimal(monto),
                moneda: moneda || 'ARS',
                fecha: new Date(fecha),
                metodoPago: (metodoPago as MetodoPago) || 'EFECTIVO',
                cuenta: cuentaFinal,
                observaciones,
                creadoPorId: usuarioId
            }
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
    } catch (error) {
        console.error('Error al crear movimiento de caja:', error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

export default router;
