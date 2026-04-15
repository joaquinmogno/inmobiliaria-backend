import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { startOfMonth, subMonths, endOfMonth } from 'date-fns';

const router = Router();

router.use(authenticateToken);

// Obtener estadísticas globales para el módulo de reportes
router.get('/dashboard', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;

    try {
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
            prisma.pagoSueldo.aggregate({
                where: {
                    inmobiliariaId,
                    fecha: { gte: startOfCurrentMonth, lte: endOfCurrentMonth }
                },
                _sum: { monto: true }
            })
        ]);

        const calcFinanzasAgencia = (liquidaciones: any[], movimientos: any[]) => {
            let totalCobradoBruto = 0; // Todo lo que entró a caja (del inquilino)
            let honorariosAgencia = 0; // Parte de las liquidaciones que es para la agencia
            let facturadoTotal = 0;

            liquidaciones.forEach(liq => {
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
                .filter(m => m.tipo === 'INGRESO' && m.liquidacionId === null) // Ingresos manuales
                .reduce((acc, m) => acc + Number(m.monto), 0);
            
            const egresosInmo = movimientos
                .filter(m => m.tipo === 'EGRESO' && m.liquidacionId === null) // Gastos manuales (admin, servicios, etc)
                .reduce((acc, m) => acc + Number(m.monto), 0);

            const gananciaBruta = honorariosAgencia + ingresosInmo;
            const gastosAgencia = egresosInmo + Number(sueldosActual._sum?.monto || 0);
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

        const metricasActual = calcFinanzasAgencia(liquidacionesActual, movimientosActual);
        
        // Respuesta
        res.json({
            propiedades: {
                total: totalPropiedades,
                disponibles: propiedadesDisponibles,
                alquiladas: propiedadesAlquiladas
            },
            contratos: {
                activos: contratosActivos,
                porVencer: contratosPorVencer
            },
            finanzas: {
                ...metricasActual,
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
