import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { AuthRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { withPagination } from '../middlewares/pagination.middleware';
import { userHasPermission } from '../services/permissions.service';
import { TRASH_RETENTION_DAYS } from '../services/maintenance.service';
import { syncContractLifecycle } from '../services/contract-lifecycle.service';
import { addCalendarDays, argentinaTodayAsDate } from '../utils/argentina-date';
import { auditService } from '../services/audit.service';
import { contractListStatusSchema } from '../validation/contratos.schemas';
import { getContractRenewalTimeline } from '../services/contract-renewal.service';

const router = Router();

router.get('/', requirePermission('contratos.ver'), withPagination(10), async (req, res) => {
    const { id: userId, tipo, inmobiliariaId } = (req as AuthRequest).user!;
    const { search, status, alerta } = req.query;
    const pagination = res.locals.pagination;
    const parsedStatus = contractListStatusSchema.safeParse(status ?? 'ACTIVO');
    if (!parsedStatus.success) {
        return res.status(400).json({
            message: 'Estado de contrato inválido',
            code: 'INVALID_CONTRACT_STATUS',
            validStatuses: contractListStatusSchema.options
        });
    }
    const selectedStatus = parsedStatus.data;
    if (alerta && alerta !== 'POR_VENCER') {
        return res.status(400).json({ message: 'Alerta de contrato inválida', code: 'INVALID_CONTRACT_ALERT' });
    }
    try {
        await syncContractLifecycle(inmobiliariaId);
        const where: Prisma.ContratoWhereInput = {
            inmobiliariaId,
            estado: selectedStatus,
            ...(alerta === 'POR_VENCER' ? { fechaFin: { gte: argentinaTodayAsDate(), lte: addCalendarDays(argentinaTodayAsDate(), 60) } } : {}),
            ...(search ? {
                OR: [
                    { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
                    { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                    { inquilinos: { some: { persona: { telefono: { contains: String(search), mode: 'insensitive' } } } } },
                    { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                    { propietarios: { some: { persona: { telefono: { contains: String(search), mode: 'insensitive' } } } } }
                ]
            } : {})
        };
        const [total, contracts] = await prisma.$transaction([
            prisma.contrato.count({ where }),
            prisma.contrato.findMany({
                where,
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } },
                    adjuntos: {
                        include: { creadoPor: { select: { id: true, nombreCompleto: true } } },
                        orderBy: [{ tipo: 'asc' }, { versionDocumento: 'desc' }, { id: 'desc' }]
                    }
                },
                orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
                skip: pagination.skip,
                take: pagination.limit
            })
        ]);
        const canViewFiles = await userHasPermission(userId, tipo, 'contratos.archivos.ver');
        let data = canViewFiles ? contracts : contracts.map(contract => ({ ...contract, rutaArchivoContrato: null, adjuntos: [] }));
        if (selectedStatus === 'PAPELERA') {
            data = data.map(contract => ({
                ...contract,
                daysUntilDeletion: contract.eliminadoEn
                    ? Math.max(0, Math.ceil((contract.eliminadoEn.getTime() + TRASH_RETENTION_DAYS * 86_400_000 - Date.now()) / 86_400_000))
                    : TRASH_RETENTION_DAYS
            }));
        }
        res.json({
            data,
            meta: {
                total,
                page: pagination.page,
                limit: pagination.limit,
                totalPages: Math.ceil(total / pagination.limit),
                status: selectedStatus,
                ...(selectedStatus === 'PAPELERA' ? { retentionDays: TRASH_RETENTION_DAYS } : {})
            }
        });
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ message: 'Error al obtener contratos' });
    }
});

router.get('/alertas', requirePermission('contratos.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    try {
        await syncContractLifecycle(inmobiliariaId);
        const today = argentinaTodayAsDate();
        const contracts = await prisma.contrato.findMany({
            where: {
                inmobiliariaId,
                estado: 'ACTIVO',
                OR: [
                    { requiereActualizacion: true, fechaProximaActualizacion: { gte: today, lte: addCalendarDays(today, 30) } },
                    { fechaFin: { gte: today, lte: addCalendarDays(today, 60) } }
                ]
            },
            include: {
                propiedad: true,
                inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                propietarios: { where: { esPrincipal: true }, include: { persona: true } }
            },
            orderBy: { fechaFin: 'asc' }
        });
        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contract alerts:', error);
        res.status(500).json({ message: 'Error al obtener alertas de contratos' });
    }
});

router.get('/:id', requirePermission('contratos.ver'), withPagination(10, {
    pageParam: 'auditPage', limitParam: 'auditLimit', localsKey: 'auditPagination'
}), async (req, res) => {
    const { id: userId, tipo, inmobiliariaId } = (req as AuthRequest).user!;
    const contractId = Number(req.params.id);
    try {
        await syncContractLifecycle(inmobiliariaId);
        const contract = await prisma.contrato.findFirst({
            where: { id: contractId, inmobiliariaId },
            include: {
                propiedad: true,
                inquilinos: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
                propietarios: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
                adjuntos: {
                    include: { creadoPor: { select: { id: true, nombreCompleto: true } } },
                    orderBy: [{ tipo: 'asc' }, { versionDocumento: 'desc' }, { id: 'desc' }]
                },
                creadoPor: { select: { id: true, nombreCompleto: true, email: true } },
                actualizadoPor: { select: { id: true, nombreCompleto: true, email: true } },
                actualizaciones: { orderBy: { fechaActualizacion: 'desc' }, include: { usuario: true } }
            }
        });
        if (!contract) return res.status(404).json({ message: 'Contrato no encontrado' });
        const auditLogs = await auditService.history({
            inmobiliariaId, entidad: 'Contrato', entidadId: contractId, ...res.locals.auditPagination
        });
        const historialRenovaciones = await getContractRenewalTimeline(inmobiliariaId, contractId);
        const canViewFiles = await userHasPermission(userId, tipo, 'contratos.archivos.ver');
        res.json({
            ...contract,
            rutaArchivoContrato: canViewFiles ? contract.rutaArchivoContrato : null,
            adjuntos: canViewFiles ? contract.adjuntos : [],
            historialRenovaciones,
            auditLogs: auditLogs.data,
            auditMeta: auditLogs.meta
        });
    } catch {
        res.status(500).json({ message: 'Error al obtener contrato' });
    }
});

export default router;
