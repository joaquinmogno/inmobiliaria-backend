import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { validateBody, optionalText } from '../middlewares/validation.middleware';
import { parseDateOnly } from '../utils/argentina-date';
import { auditService } from '../services/audit.service';
import { getOperationalAlertByKey, getOperationalAlertsForUser, type OperationalAlertKey } from '../services/operational-alerts.service';

const router = Router();
router.use(authenticateToken);

const alertKeySchema = z.enum([
    'LIQUIDACIONES_VENCIDAS',
    'COBROS_PENDIENTES',
    'PAGOS_PROPIETARIO_PENDIENTES',
    'ADELANTOS_A_RECUPERAR',
    'CONTRATOS_POR_VENCER'
]);

const managementSchema = z.object({
    clave: alertKeySchema,
    responsableId: z.number().int().positive().nullable().optional(),
    estado: z.enum(['PENDIENTE', 'EN_SEGUIMIENTO', 'RESUELTA']),
    observacion: optionalText(2000),
    canal: z.enum(['INTERNO', 'EMAIL', 'WHATSAPP']).default('INTERNO'),
    destinatario: optionalText(180),
    proximaRevision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La próxima revisión debe tener formato AAAA-MM-DD').optional().nullable()
}).strict().superRefine((data, ctx) => {
    if (data.canal !== 'INTERNO' && !data.destinatario) {
        ctx.addIssue({ code: 'custom', path: ['destinatario'], message: 'Indicá el destinatario del recordatorio externo' });
    }
    if (data.canal === 'EMAIL' && data.destinatario && !z.string().email().safeParse(data.destinatario).success) {
        ctx.addIssue({ code: 'custom', path: ['destinatario'], message: 'El email del destinatario no es válido' });
    }
    if (data.canal === 'WHATSAPP' && data.destinatario && !/^[+\d][\d\s()-]{5,39}$/.test(data.destinatario)) {
        ctx.addIssue({ code: 'custom', path: ['destinatario'], message: 'El teléfono de WhatsApp no es válido' });
    }
});

router.get('/', requirePermission('reportes.dashboard.ver'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    try {
        res.json(await getOperationalAlertsForUser(user.id, user.inmobiliariaId));
    } catch (error) {
        console.error('Error fetching operational alerts:', error);
        res.status(500).json({ message: 'No se pudieron obtener las alertas operativas' });
    }
});

router.get('/responsables', requirePermission('reportes.dashboard.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const users = await prisma.usuario.findMany({
        where: { inmobiliariaId, activo: true },
        select: { id: true, nombreCompleto: true, email: true },
        orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }]
    });
    res.json(users);
});

router.post('/gestiones', requirePermission('reportes.dashboard.ver'), requireRecentAuthentication, validateBody(managementSchema), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const { clave, responsableId, estado, observacion, canal, destinatario, proximaRevision } = req.body;

    try {
        const alert = await getOperationalAlertByKey(user.id, user.inmobiliariaId, clave as OperationalAlertKey);
        if (!alert) return res.status(409).json({ message: 'La alerta ya no está activa o no tenés acceso a ella' });

        if (responsableId) {
            const responsible = await prisma.usuario.findFirst({ where: { id: responsableId, inmobiliariaId: user.inmobiliariaId, activo: true }, select: { id: true } });
            if (!responsible) return res.status(400).json({ message: 'El responsable seleccionado no está activo en esta inmobiliaria' });
        }

        const management = await prisma.$transaction(async tx => {
            const saved = await tx.gestionAlertaOperativa.upsert({
                where: { inmobiliariaId_clave: { inmobiliariaId: user.inmobiliariaId, clave: alert.clave } },
                create: {
                    clave: alert.clave,
                    titulo: alert.titulo,
                    enlace: alert.enlace,
                    estado,
                    responsableId: responsableId ?? null,
                    canal,
                    destinatario,
                    proximaRevision: proximaRevision ? parseDateOnly(proximaRevision) : null,
                    resueltaEn: estado === 'RESUELTA' ? new Date() : null,
                    inmobiliariaId: user.inmobiliariaId,
                    creadoPorId: user.id
                },
                update: {
                    titulo: alert.titulo,
                    enlace: alert.enlace,
                    estado,
                    responsableId: responsableId ?? null,
                    canal,
                    destinatario,
                    proximaRevision: proximaRevision ? parseDateOnly(proximaRevision) : null,
                    resueltaEn: estado === 'RESUELTA' ? new Date() : null
                }
            });
            await tx.registroGestionAlertaOperativa.create({
                data: { gestionId: saved.id, usuarioId: user.id, estado, observacion, canal, destinatario }
            });
            return tx.gestionAlertaOperativa.findUniqueOrThrow({
                where: { id: saved.id },
                include: {
                    responsable: { select: { id: true, nombreCompleto: true, email: true } },
                    registros: {
                        include: { usuario: { select: { id: true, nombreCompleto: true } } },
                        orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
                        take: 10
                    }
                }
            });
        });

        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'GESTIONAR_ALERTA_OPERATIVA',
            entidad: 'GestionAlertaOperativa',
            entidadId: management.id,
            detalle: JSON.stringify({ clave: alert.clave, estado, responsableId: responsableId ?? null, canal, destinatario: destinatario ?? null })
        });
        res.json({ ...alert, gestion: management });
    } catch (error) {
        console.error('Error managing operational alert:', error);
        res.status(500).json({ message: 'No se pudo registrar la gestión de la alerta' });
    }
});

export default router;
