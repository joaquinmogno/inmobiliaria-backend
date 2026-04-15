import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { TipoMovimiento, MetodoPago, CuentaCaja } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();

// Obtener movimientos de caja con filtros y paginación
router.get('/', authenticateToken, async (req, res) => {
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

        // Totales globales y por cuenta (Acumulados)
        const [
            ingresosGlobal, 
            egresosGlobal, 
            ingresosCaja, 
            egresosCaja, 
            ingresosBanco, 
            egresosBanco,
            fondosEnCustodiaAggr // Plata ajena acumulada
        ] = await Promise.all([
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'INGRESO' }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'EGRESO' }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'INGRESO', cuenta: 'CAJA' }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'EGRESO', cuenta: 'CAJA' }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'INGRESO', cuenta: 'BANCO' }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'EGRESO', cuenta: 'BANCO' }, _sum: { monto: true } }),
            prisma.liquidacion.aggregate({ where: { inmobiliariaId, estado: 'PAGADA_POR_INQUILINO' }, _sum: { netoACobrar: true } })
        ]);

        // KPIs por período (Filtrables)
        const [
            cobradoInquilinosAggr, 
            pagadoPropietariosAggr, 
            gastosGeneralesAggr,    
            ingresosManualesAggr
        ] = await Promise.all([
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'INGRESO', liquidacionId: { not: null }, ...kpiDateFilter }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'EGRESO', liquidacionId: { not: null }, ...kpiDateFilter }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'EGRESO', liquidacionId: null, ...kpiDateFilter }, _sum: { monto: true } }),
            prisma.movimientoCaja.aggregate({ where: { inmobiliariaId, tipo: 'INGRESO', liquidacionId: null, ...kpiDateFilter }, _sum: { monto: true } })
        ]);

        // Obtener honorarios de liquidaciones pagadas en el período
        let honorariosLiquidaciones = 0;
        let totalNetoACobrar = 0;
        
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

        liquidacionesCobradas.forEach(l => {
            const honsFijos = Number(l.montoHonorarios || 0);
            const honsMovimientos = l.movimientos
                .filter(m => m.esParaInmobiliaria)
                .reduce((acc, m) => acc + Number(m.monto), 0);
            
            honorariosLiquidaciones += (honsFijos + honsMovimientos);
            totalNetoACobrar += Number(l.netoACobrar);
        });

        const totalIngresosNum = Number(ingresosGlobal._sum?.monto || 0);
        const totalEgresosNum = Number(egresosGlobal._sum?.monto || 0);
        const totalCobrado = Number(cobradoInquilinosAggr._sum?.monto || 0);
        const totalPagadoProp = Number(pagadoPropietariosAggr._sum?.monto || 0);
        const totalGastosGral = Number(gastosGeneralesAggr._sum?.monto || 0);
        const ingresosManuales = Number(ingresosManualesAggr._sum?.monto || 0);
        
        // Fondos en Custodia real: Lo que se cobró de liquidaciones menos lo que es honorarios de esas liquidaciones
        const fondosEnCustodia = totalNetoACobrar - honorariosLiquidaciones;
        
        const gananciaBruta = honorariosLiquidaciones + ingresosManuales;
        const resultadoNeto = gananciaBruta - totalGastosGral;

        const balanceGeneral = totalIngresosNum - totalEgresosNum;
        const balanceCaja = Number(ingresosCaja._sum?.monto || 0) - Number(egresosCaja._sum?.monto || 0);
        const balanceBanco = Number(ingresosBanco._sum?.monto || 0) - Number(egresosBanco._sum?.monto || 0);

        res.json({
            data: movimientos,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
                balanceGeneral,
                totalIngresos: totalIngresosNum,
                totalEgresos: totalEgresosNum,
                balanceCaja,
                balanceBanco,
                // KPIs
                totalCobrado,
                totalPagadoPropietarios: totalPagadoProp,
                gastosGenerales: totalGastosGral,
                gananciaBruta,
                resultadoNeto,
                fondosEnCustodia
            }
        });
    } catch (error) {
        console.error('Error fetching caja chica:', error);
        res.status(500).json({ message: 'Error al obtener la caja chica' });
    }
});

// Crear nuevo movimiento manual
router.post('/', authenticateToken, async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { tipo, concepto, monto, fecha, metodoPago, cuenta, observaciones } = req.body;

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
                fecha: new Date(fecha),
                metodoPago: (metodoPago as MetodoPago) || 'EFECTIVO',
                cuenta: cuentaFinal,
                observaciones,
                creadoPorId: usuarioId
            }
        });

        res.status(201).json(movimiento);
    } catch (error) {
        console.error('Error al crear movimiento de caja:', error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

export default router;
