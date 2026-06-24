import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { userHasPermission } from '../services/permissions.service';
import { requirePermission } from '../middlewares/permissions.middleware';
import { startOfMonth, subMonths, endOfMonth } from 'date-fns';

const router = Router();

router.use(authenticateToken);

// Obtener estadísticas globales para el módulo de reportes
router.get('/dashboard', requirePermission('reportes.dashboard.ver'), async (req, res) => {
    const { id: userId, role, inmobiliariaId } = (req as AuthRequest).user!;

    try {
        const canViewSalaries = await userHasPermission(userId, role, 'sueldos.ver');
        const canViewFinancialReports = await userHasPermission(userId, role, 'reportes.financieros.ver');
        const canViewContractReports = await userHasPermission(userId, role, 'reportes.contratos.ver');
        const canViewDelinquencyReports = await userHasPermission(userId, role, 'reportes.morosidad.ver');
        const today = new Date();
        const startOfCurrentMonth = startOfMonth(today);
        const endOfCurrentMonth = endOfMonth(today);
        const startOfPreviousMonth = startOfMonth(subMonths(today, 1));
        const endOfPreviousMonth = endOfMonth(subMonths(today, 1));

        // 1. Estadísticas de Propiedades
        const [totalPropiedades, propiedadesDisponibles, propiedadesAlquiladas] = await Promise.all([
            prisma.propiedad.count({ where: { inmobiliariaId } }),
            prisma.propiedad.count({ where: { inmobiliariaId, estado: 'DISPONIBLE' } }),
            prisma.propiedad.count({ where: { inmobiliariaId, estado: 'ALQUILADO' } })
        ]);

        // 2. Estadísticas de Contratos
        const [contratosActivos, contratosPorVencer] = await Promise.all([
            prisma.contrato.count({ where: { inmobiliariaId, estado: 'ACTIVO' } }),
            prisma.contrato.count({
                where: {
                    inmobiliariaId,
                    estado: 'ACTIVO',
                    fechaFin: {
                        lte: new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000) // Próximos 60 días
                    }
                }
            })
        ]);

        // 3. Recaudación y Morosidad (Mes Actual vs Mes Anterior)
        const [liquidacionesActual, liquidacionesAnterior, movimientosActual, sueldosActual] = await Promise.all([
            prisma.liquidacion.findMany({
                where: {
                    inmobiliariaId,
                    periodo: { gte: startOfCurrentMonth, lte: endOfCurrentMonth }
                },
                include: { pagos: true, movimientos: true }
            }),
            prisma.liquidacion.findMany({
                where: {
                    inmobiliariaId,
                    periodo: { gte: startOfPreviousMonth, lte: endOfPreviousMonth }
                },
                include: { pagos: true, movimientos: true }
            }),
            prisma.movimientoCaja.findMany({
                where: {
                    inmobiliariaId,
                    fecha: { gte: startOfCurrentMonth, lte: endOfCurrentMonth }
                }
            }),
            canViewSalaries ? prisma.pagoSueldo.findMany({
                where: {
                    inmobiliariaId,
                    fecha: { gte: startOfCurrentMonth, lte: endOfCurrentMonth }
                }
            }) : Promise.resolve([])
        ]);

        const calcFinanzasAgencia = (liquidaciones: any[], movimientos: any[], sueldos: any[], moneda: 'ARS' | 'USD') => {
            let totalCobradoBruto = 0; // Todo lo que entró a caja (del inquilino)
            let honorariosAgencia = 0; // Parte de las liquidaciones que es para la agencia
            let facturadoTotal = 0;

            liquidaciones.filter(liq => liq.moneda === moneda).forEach(liq => {
                const neto = Number(liq.netoACobrar);
                facturadoTotal += neto;
                
                // Honorarios fijos + Movimientos internos para la inmobiliaria
                const honsFijos = Number(liq.montoHonorarios || 0);
                const honsMovimientos = liq.movimientos
                    .filter((m: any) => m.esParaInmobiliaria)
                    .reduce((acc: number, m: any) => acc + Number(m.monto), 0);
                
                const honsTotales = honsFijos + honsMovimientos;

                const cobradoLiq = liq.pagos.reduce((acc: number, p: any) => acc + Number(p.monto), 0);
                totalCobradoBruto += cobradoLiq;

                // Proporción de honorarios cobrados (si el inquilino pagó parcial, cobramos honorarios proporcionales)
                if (neto > 0 && cobradoLiq > 0) {
                    const ratio = Math.min(cobradoLiq / neto, 1);
                    honorariosAgencia += honsTotales * ratio;
                }
            });

            // Movimientos Directos de Caja (Manuales)
            const ingresosInmo = movimientos
                .filter(m => m.moneda === moneda && m.tipo === 'INGRESO' && m.liquidacionId === null) // Ingresos manuales
                .reduce((acc, m) => acc + Number(m.monto), 0);
            
            const egresosInmo = movimientos
                .filter(m => m.moneda === moneda && m.tipo === 'EGRESO' && m.liquidacionId === null) // Gastos manuales (admin, servicios, etc)
                .reduce((acc, m) => acc + Number(m.monto), 0);

            const gananciaBruta = honorariosAgencia + ingresosInmo;
            const totalSueldos = sueldos
                .filter(sueldo => sueldo.moneda === moneda)
                .reduce((acc, sueldo) => acc + Number(sueldo.monto), 0);
            const gastosAgencia = egresosInmo + totalSueldos;
            const utilidadNeta = gananciaBruta - gastosAgencia;

            // Fondo en Custodia: Lo que se cobró de liquidaciones pero no es de la agencia
            const fondoCustodia = totalCobradoBruto - honorariosAgencia;

            return {
                recaudadoTotal: totalCobradoBruto,
                gananciaBruta,
                gastosAgencia,
                utilidadNeta,
                fondoCustodia,
                morosidad: facturadoTotal > 0 ? ((facturadoTotal - totalCobradoBruto) / facturadoTotal) * 100 : 0
            };
        };

        const emptyMetrics = {
                recaudadoTotal: 0,
                gananciaBruta: 0,
                gastosAgencia: 0,
                utilidadNeta: 0,
                fondoCustodia: 0,
                morosidad: 0
            };
        const finanzasPorMoneda = canViewFinancialReports
            ? {
                ARS: calcFinanzasAgencia(liquidacionesActual, movimientosActual, sueldosActual, 'ARS'),
                USD: calcFinanzasAgencia(liquidacionesActual, movimientosActual, sueldosActual, 'USD')
            }
            : {
                ARS: emptyMetrics,
                USD: emptyMetrics
            };
        const metricasActual = finanzasPorMoneda.ARS;
        
        // Respuesta
        res.json({
            propiedades: {
                total: totalPropiedades,
                disponibles: propiedadesDisponibles,
                alquiladas: propiedadesAlquiladas
            },
            contratos: canViewContractReports
                ? {
                    activos: contratosActivos,
                    porVencer: contratosPorVencer
                }
                : {
                    activos: 0,
                    porVencer: 0
                },
            finanzas: {
                ...metricasActual,
                porMoneda: finanzasPorMoneda,
                morosidad: canViewDelinquencyReports ? metricasActual.morosidad : 0,
                honorarios: {
                    cobrados: metricasActual.gananciaBruta, // Para compatibilidad con frontend anterior si hiciera falta
                    totalInmo: metricasActual.gananciaBruta
                }
            }
        });

    } catch (error) {
        console.error('Error generando reportes:', error);
        res.status(500).json({ message: 'Error al generar los reportes' });
    }
});

export default router;
