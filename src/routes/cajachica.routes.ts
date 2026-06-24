import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { TipoMovimiento, MetodoPago, CuentaCaja } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { validateBody, requiredText, positiveDecimal, dateOnlyString, optionalText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';

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

        // Filtro de período para KPIs
        let kpiDateFilter: any = {};
        if (mes && anio) {
            const m = parseInt(String(mes));
            const a = parseInt(String(anio));
            const start = new Date(a, m - 1, 1);
            const end = new Date(a, m, 1);
            kpiDateFilter = { fecha: { gte: start, lt: end } };
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

        // Obtener honorarios de liquidaciones pagadas en el período para calcular KPIs por moneda.
        const liquidacionesCobradas = await prisma.liquidacion.findMany({
            where: {
                inmobiliariaId,
                movimientosCaja: {
                    some: {
                        tipo: 'INGRESO',
                        ...(mes && anio ? kpiDateFilter : {})
                    }
                }
            },
            include: { movimientos: true }
        });

        const monedas = ['ARS', 'USD'] as const;
        const sumCaja = async (moneda: typeof monedas[number], extraWhere: any) => Number((await prisma.movimientoCaja.aggregate({
            where: { inmobiliariaId, moneda, ...extraWhere },
            _sum: { monto: true }
        }))._sum?.monto || 0);

        const totalesPorMoneda = Object.fromEntries(await Promise.all(monedas.map(async moneda => {
            const [
                totalIngresos,
                totalEgresos,
                balanceCajaIngresos,
                balanceCajaEgresos,
                balanceBancoIngresos,
                balanceBancoEgresos,
                totalCobrado,
                totalPagadoPropietarios,
                gastosGenerales,
                ingresosManuales
            ] = await Promise.all([
                sumCaja(moneda, { tipo: 'INGRESO' }),
                sumCaja(moneda, { tipo: 'EGRESO' }),
                sumCaja(moneda, { tipo: 'INGRESO', cuenta: 'CAJA' }),
                sumCaja(moneda, { tipo: 'EGRESO', cuenta: 'CAJA' }),
                sumCaja(moneda, { tipo: 'INGRESO', cuenta: 'BANCO' }),
                sumCaja(moneda, { tipo: 'EGRESO', cuenta: 'BANCO' }),
                sumCaja(moneda, { tipo: 'INGRESO', liquidacionId: { not: null }, ...kpiDateFilter }),
                sumCaja(moneda, { tipo: 'EGRESO', liquidacionId: { not: null }, ...kpiDateFilter }),
                sumCaja(moneda, { tipo: 'EGRESO', liquidacionId: null, ...kpiDateFilter }),
                sumCaja(moneda, { tipo: 'INGRESO', liquidacionId: null, ...kpiDateFilter })
            ]);

            let honorariosLiquidacionesMoneda = 0;
            let totalNetoACobrarMoneda = 0;
            liquidacionesCobradas
                .filter(l => l.moneda === moneda)
                .forEach(l => {
                    const honsFijos = Number(l.montoHonorarios || 0);
                    const honsMovimientos = l.movimientos
                        .filter(m => m.esParaInmobiliaria)
                        .reduce((acc, m) => acc + Number(m.monto), 0);
                    honorariosLiquidacionesMoneda += honsFijos + honsMovimientos;
                    totalNetoACobrarMoneda += Number(l.netoACobrar);
                });

            const fondosEnCustodia = totalNetoACobrarMoneda - honorariosLiquidacionesMoneda;
            const gananciaBruta = honorariosLiquidacionesMoneda + ingresosManuales;
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
        }))) as Record<'ARS' | 'USD', any>;

        const ars = totalesPorMoneda.ARS;

        const balanceGeneral = ars.balance;
        const balanceCaja = ars.balanceCaja;
        const balanceBanco = ars.balanceBanco;

        res.json({
            data: movimientos,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
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
            }
        });
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

        res.status(201).json(movimiento);
    } catch (error) {
        console.error('Error al crear movimiento de caja:', error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

export default router;
