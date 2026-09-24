import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { getUserPermissions } from '../services/permissions.service';
import { cached } from '../services/performance-cache.service';
import { requirePermission } from '../middlewares/permissions.middleware';
import { syncContractLifecycle } from '../services/contract-lifecycle.service';
import { addCalendarDays, argentinaTodayAsDate, argentinaYearMonth } from '../utils/argentina-date';
import { getAccruedFinancialReport, getCashLedgerReport, getMonthlyReportPeriod } from '../services/financial-reporting.service';
import { getDashboardPermissionScope } from '../services/dashboard-cache.service';
import { getOutstandingOwnerAdvances, summarizeOwnerAdvanceAging } from '../services/owner-advance.service';

const router = Router();

router.use(authenticateToken);

// Obtener estadísticas globales para el módulo de reportes
router.get('/dashboard', requirePermission('reportes.dashboard.ver'), async (req, res) => {
    const { id: userId, inmobiliariaId } = (req as AuthRequest).user!;

    try {
        await syncContractLifecycle(inmobiliariaId);
        const permissions = new Set(await getUserPermissions(userId));
        const canViewSalaries = permissions.has('sueldos.ver');
        const canViewFinancialReports = permissions.has('reportes.financieros.ver');
        const canViewContractReports = permissions.has('reportes.contratos.ver');
        const canViewDelinquencyReports = permissions.has('reportes.morosidad.ver');
        const canViewLiquidations = permissions.has('liquidaciones.ver');
        const permissionScope = getDashboardPermissionScope({
            canViewSalaries,
            canViewFinancialReports,
            canViewContractReports,
            canViewDelinquencyReports,
            canViewLiquidations
        });
        const response = await cached(`inmobiliaria:${inmobiliariaId}:dashboard:${permissionScope}`, 20_000, async () => {
        const today = argentinaTodayAsDate();
        const [currentYear, currentMonth] = argentinaYearMonth().split('-').map(Number);
        const ownerAdvanceSummary = canViewLiquidations
            ? summarizeOwnerAdvanceAging(await getOutstandingOwnerAdvances(prisma, inmobiliariaId))
            : summarizeOwnerAdvanceAging([]);

        // 1. Estadísticas de Propiedades
        const [totalPropiedades, propiedadesDisponibles, propiedadesAlquiladas] = await Promise.all([
            prisma.propiedad.count({ where: { inmobiliariaId } }),
            prisma.propiedad.count({ where: { inmobiliariaId, estado: 'DISPONIBLE' } }),
            prisma.propiedad.count({ where: { inmobiliariaId, estado: 'ALQUILADO' } })
        ]);

        // 2. Estadísticas de Contratos
        const [contratosActivos, contratosPorVencer, liquidacionesVencidas, cobrosPendientes, pagosPropietarioPendientes] = await Promise.all([
            prisma.contrato.count({ where: { inmobiliariaId, estado: 'ACTIVO' } }),
            prisma.contrato.count({
                where: {
                    inmobiliariaId,
                    estado: 'ACTIVO',
                    fechaFin: {
                        lte: addCalendarDays(today, 60) // Próximos 60 días
                    }
                }
            })
            , canViewLiquidations ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoCobroInquilino: { in: ['PENDIENTE', 'PARCIAL'] }, fechaVencimiento: { lt: today } } }) : Promise.resolve(0)
            , canViewLiquidations ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoCobroInquilino: { in: ['PENDIENTE', 'PARCIAL'] } } }) : Promise.resolve(0)
            , canViewLiquidations ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoPagoPropietario: { in: ['PENDIENTE', 'PARCIAL'] } } }) : Promise.resolve(0)
        ]);

        const emptyMetrics = {
            recaudadoTotal: 0,
            gananciaBruta: 0,
            gastosAgencia: 0,
            utilidadNeta: 0,
            fondoCustodia: 0,
            morosidad: 0
        };
        const reportPeriod = getMonthlyReportPeriod(currentYear, currentMonth);
        const [devengado, caja] = canViewFinancialReports
            ? await Promise.all([
                getAccruedFinancialReport(prisma, inmobiliariaId, reportPeriod),
                getCashLedgerReport(prisma, inmobiliariaId, reportPeriod)
            ])
            : [null, null];

        const finanzasPorMoneda = (['ARS', 'USD'] as const).reduce((result, moneda) => {
            if (!devengado || !caja) {
                result[moneda] = emptyMetrics;
                return result;
            }
            const accrued = devengado.porMoneda[moneda];
            const cash = caja.movimientosDelPeriodo[moneda];
            const gastosAgencia = cash.otrosEgresos + (canViewSalaries ? cash.pagosSueldos : 0);
            result[moneda] = {
                // Campos conservados para los clientes existentes; su origen ya
                // no se mezcla: cobrado es caja y honorarios es devengado.
                recaudadoTotal: cash.cobrosInquilinos,
                gananciaBruta: accrued.honorariosDevengados,
                gastosAgencia,
                utilidadNeta: accrued.honorariosDevengados - gastosAgencia,
                fondoCustodia: Math.max(0, cash.cobrosInquilinos - cash.pagosPropietarios),
                morosidad: accrued.facturado > 0 ? (accrued.saldoPendienteInquilinos / accrued.facturado) * 100 : 0
            };
            return result;
        }, {} as Record<'ARS' | 'USD', typeof emptyMetrics>);
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
            operacion: {
                alquileresVencidos: canViewLiquidations && canViewDelinquencyReports ? liquidacionesVencidas : 0,
                cobrosPendientes: canViewLiquidations ? cobrosPendientes : 0,
                pagosPropietarioPendientes: canViewLiquidations ? pagosPropietarioPendientes : 0,
                adelantosARecuperar: ownerAdvanceSummary,
                contratosPorVencer: canViewContractReports ? contratosPorVencer : 0
            },
            finanzas: {
                ...metricasActual,
                porMoneda: finanzasPorMoneda,
                devengado,
                caja,
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
