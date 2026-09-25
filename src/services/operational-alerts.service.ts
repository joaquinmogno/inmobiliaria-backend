import { prisma } from '../prisma';
import { getUserPermissions } from './permissions.service';
import { addCalendarDays, argentinaTodayAsDate } from '../utils/argentina-date';
import { syncContractLifecycle } from './contract-lifecycle.service';
import { getOutstandingOwnerAdvances, summarizeOwnerAdvanceAging } from './owner-advance.service';

export type OperationalAlertKey =
    | 'LIQUIDACIONES_VENCIDAS'
    | 'COBROS_PENDIENTES'
    | 'PAGOS_PROPIETARIO_PENDIENTES'
    | 'ADELANTOS_A_RECUPERAR'
    | 'CONTRATOS_POR_VENCER';

type AlertDefinition = {
    clave: OperationalAlertKey;
    titulo: string;
    descripcion: string;
    prioridad: 'ALTA' | 'MEDIA';
    enlace: string;
    cantidad: number;
};

const managementInclude = {
    responsable: { select: { id: true, nombreCompleto: true, email: true } },
    registros: {
        include: { usuario: { select: { id: true, nombreCompleto: true } } },
        orderBy: [{ fechaCreacion: 'desc' as const }, { id: 'desc' as const }],
        take: 10
    }
};

export async function getOperationalAlertsForUser(userId: number, inmobiliariaId: number) {
    await syncContractLifecycle(inmobiliariaId);
    const permissions = new Set(await getUserPermissions(userId));
    const canViewLiquidations = permissions.has('liquidaciones.ver');
    const canViewDelinquency = permissions.has('reportes.morosidad.ver');
    const canViewContracts = permissions.has('reportes.contratos.ver');
    const today = argentinaTodayAsDate();

    const [overdueCount, collectionCount, ownerPaymentCount, expiringContractsCount, ownerAdvances] = await Promise.all([
        canViewLiquidations && canViewDelinquency
            ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoCobroInquilino: { in: ['PENDIENTE', 'PARCIAL'] }, fechaVencimiento: { lt: today } } })
            : Promise.resolve(0),
        canViewLiquidations
            ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoCobroInquilino: { in: ['PENDIENTE', 'PARCIAL'] } } })
            : Promise.resolve(0),
        canViewLiquidations
            ? prisma.liquidacion.count({ where: { inmobiliariaId, estado: 'CONFIRMADA', estadoPagoPropietario: { in: ['PENDIENTE', 'PARCIAL'] } } })
            : Promise.resolve(0),
        canViewContracts
            ? prisma.contrato.count({ where: { inmobiliariaId, estado: 'ACTIVO', fechaFin: { lte: addCalendarDays(today, 60) } } })
            : Promise.resolve(0),
        canViewLiquidations ? getOutstandingOwnerAdvances(prisma, inmobiliariaId) : Promise.resolve([])
    ]);
    const advanceSummary = summarizeOwnerAdvanceAging(ownerAdvances);

    const definitions: AlertDefinition[] = [
        {
            clave: 'LIQUIDACIONES_VENCIDAS',
            titulo: 'Alquileres vencidos',
            descripcion: 'Liquidaciones vencidas que siguen pendientes de cobro.',
            prioridad: 'ALTA',
            enlace: '/liquidaciones?view=HISTORIAL&vencidas=true',
            cantidad: overdueCount
        },
        {
            clave: 'COBROS_PENDIENTES',
            titulo: 'Cobros pendientes',
            descripcion: 'Liquidaciones confirmadas que aún tienen saldo del inquilino.',
            prioridad: 'MEDIA',
            enlace: '/liquidaciones?view=HISTORIAL&soloDeuda=true',
            cantidad: collectionCount
        },
        {
            clave: 'PAGOS_PROPIETARIO_PENDIENTES',
            titulo: 'Pagos pendientes al propietario',
            descripcion: 'Liquidaciones cobradas al inquilino que esperan una entrega al propietario.',
            prioridad: 'MEDIA',
            enlace: '/liquidaciones?view=HISTORIAL&pendientePropietario=true',
            cantidad: ownerPaymentCount
        },
        {
            clave: 'ADELANTOS_A_RECUPERAR',
            titulo: 'Adelantos a recuperar',
            descripcion: `${advanceSummary.cantidad} liquidación(es) con capital propio expuesto. 0–15 días: ${advanceSummary.porAntiguedad['0_15']}; 16–30: ${advanceSummary.porAntiguedad['16_30']}; 31+: ${advanceSummary.porAntiguedad['31_mas']}.`,
            prioridad: advanceSummary.porAntiguedad['31_mas'] > 0 ? 'ALTA' : 'MEDIA',
            enlace: '/liquidaciones?view=HISTORIAL&adelantos=true',
            cantidad: advanceSummary.cantidad
        },
        {
            clave: 'CONTRATOS_POR_VENCER',
            titulo: 'Contratos próximos a vencer',
            descripcion: 'Contratos activos con vencimiento dentro de los próximos 60 días.',
            prioridad: 'MEDIA',
            enlace: '/contratos?alerta=POR_VENCER',
            cantidad: expiringContractsCount
        }
    ];
    const candidates = definitions.filter(alert => alert.cantidad > 0);

    const managed = candidates.length
        ? await prisma.gestionAlertaOperativa.findMany({
            where: { inmobiliariaId, clave: { in: candidates.map(alert => alert.clave) } },
            include: managementInclude
        })
        : [];
    const managedByKey = new Map(managed.map(item => [item.clave, item]));

    return candidates.map(alert => ({
        ...alert,
        gestion: managedByKey.get(alert.clave) || null
    }));
}

export async function getOperationalAlertByKey(userId: number, inmobiliariaId: number, key: OperationalAlertKey) {
    const alerts = await getOperationalAlertsForUser(userId, inmobiliariaId);
    return alerts.find(alert => alert.clave === key) || null;
}
