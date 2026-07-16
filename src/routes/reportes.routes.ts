import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { getUserPermissions } from '../services/permissions.service';
import { cached } from '../services/performance-cache.service';
import { Prisma } from '@prisma/client';
import { requirePermission } from '../middlewares/permissions.middleware';
import { startOfMonth, endOfMonth } from 'date-fns';

const router = Router();

router.use(authenticateToken);

// Obtener estadísticas globales para el módulo de reportes
router.get('/dashboard', requirePermission('reportes.dashboard.ver'), async (req, res) => {
    const { id: userId, role, inmobiliariaId } = (req as AuthRequest).user!;

    try {
        const permissions = new Set(await getUserPermissions(userId, role));
        const canViewSalaries = permissions.has('sueldos.ver');
        const canViewFinancialReports = permissions.has('reportes.financieros.ver');
        const canViewContractReports = permissions.has('reportes.contratos.ver');
        const canViewDelinquencyReports = permissions.has('reportes.morosidad.ver');
        const permissionScope = [canViewSalaries, canViewFinancialReports, canViewContractReports, canViewDelinquencyReports].map(Number).join('');
        const response = await cached(`inmobiliaria:${inmobiliariaId}:dashboard:${permissionScope}`, 20_000, async () => {
        const today = new Date();
        const startOfCurrentMonth = startOfMonth(today);
        const endOfCurrentMonth = endOfMonth(today);

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

        const emptyMetrics = {
                recaudadoTotal: 0,
                gananciaBruta: 0,
                gastosAgencia: 0,
                utilidadNeta: 0,
                fondoCustodia: 0,
                morosidad: 0
            };
        const financialRows = canViewFinancialReports ? await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          WITH monedas(moneda) AS (VALUES ('ARS'::"Moneda"), ('USD'::"Moneda")),
          liquidaciones AS (
            SELECT l.moneda, SUM(l."netoACobrar") AS facturado,
              SUM(COALESCE(p.cobrado, 0)) AS cobrado,
              SUM((l."montoHonorarios" + COALESCE(m.honorarios, 0)) *
                CASE WHEN l."netoACobrar" > 0 THEN LEAST(COALESCE(p.cobrado, 0) / l."netoACobrar", 1) ELSE 0 END) AS honorarios
            FROM "Liquidacion" l
            LEFT JOIN LATERAL (SELECT SUM(monto) AS cobrado FROM "Pago" WHERE "liquidacionId" = l.id) p ON true
            LEFT JOIN LATERAL (SELECT SUM(monto) AS honorarios FROM "Movimiento" WHERE "liquidacionId" = l.id AND "esParaInmobiliaria" = true) m ON true
            WHERE l."inmobiliariaId" = ${inmobiliariaId} AND l.periodo >= ${startOfCurrentMonth} AND l.periodo <= ${endOfCurrentMonth}
            GROUP BY l.moneda
          ), caja AS (
            SELECT moneda,
              SUM(monto) FILTER (WHERE tipo = 'INGRESO' AND "liquidacionId" IS NULL) AS ingresos_manuales,
              SUM(monto) FILTER (WHERE tipo = 'EGRESO' AND "liquidacionId" IS NULL) AS egresos_manuales,
              SUM(monto) FILTER (WHERE tipo = 'EGRESO' AND "liquidacionId" IS NOT NULL) AS pagos_propietarios
            FROM "MovimientoCaja"
            WHERE "inmobiliariaId" = ${inmobiliariaId} AND fecha >= ${startOfCurrentMonth} AND fecha <= ${endOfCurrentMonth}
            GROUP BY moneda
          ), sueldos AS (
            SELECT moneda, SUM(monto) AS total FROM "PagoSueldo"
            WHERE ${canViewSalaries} AND "inmobiliariaId" = ${inmobiliariaId} AND fecha >= ${startOfCurrentMonth} AND fecha <= ${endOfCurrentMonth}
            GROUP BY moneda
          )
          SELECT mo.moneda, COALESCE(l.facturado, 0) AS facturado, COALESCE(l.cobrado, 0) AS cobrado,
            COALESCE(l.honorarios, 0) AS honorarios, COALESCE(c.ingresos_manuales, 0) AS ingresos_manuales,
            COALESCE(c.egresos_manuales, 0) AS egresos_manuales, COALESCE(c.pagos_propietarios, 0) AS pagos_propietarios,
            COALESCE(s.total, 0) AS sueldos
          FROM monedas mo LEFT JOIN liquidaciones l ON l.moneda = mo.moneda
          LEFT JOIN caja c ON c.moneda = mo.moneda LEFT JOIN sueldos s ON s.moneda = mo.moneda
        `) : [];
        const metricsByCurrency = new Map(financialRows.map(row => {
            const cobrado = Number(row.cobrado);
            const honorarios = Number(row.honorarios);
            const gananciaBruta = honorarios + Number(row.ingresos_manuales);
            const gastosAgencia = Number(row.egresos_manuales) + Number(row.sueldos);
            const facturado = Number(row.facturado);
            return [String(row.moneda), {
                recaudadoTotal: cobrado,
                gananciaBruta,
                gastosAgencia,
                utilidadNeta: gananciaBruta - gastosAgencia,
                fondoCustodia: Math.max(0, cobrado - honorarios - Number(row.pagos_propietarios)),
                morosidad: facturado > 0 ? ((facturado - cobrado) / facturado) * 100 : 0
            }];
        }));
        const finanzasPorMoneda = canViewFinancialReports
            ? { ARS: metricsByCurrency.get('ARS') || emptyMetrics, USD: metricsByCurrency.get('USD') || emptyMetrics }
            : {
                ARS: emptyMetrics,
                USD: emptyMetrics
            };
        const metricasActual = finanzasPorMoneda.ARS;
        
        // Respuesta
        return {
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
        };
        });
        res.json(response);

    } catch (error) {
        console.error('Error generando reportes:', error);
        res.status(500).json({ message: 'Error al generar los reportes' });
    }
});

export default router;
