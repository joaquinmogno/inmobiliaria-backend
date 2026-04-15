import { Router, Response } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

// GET /api/inmobiliaria/me
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId } = req.user!;

    try {
        const inmobiliaria = await prisma.inmobiliaria.findUnique({
            where: { id: inmobiliariaId }
        });

        if (!inmobiliaria) {
            return res.status(404).json({ message: 'Inmobiliaria no encontrada' });
        }

        res.json(inmobiliaria);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener datos de la inmobiliaria' });
    }
});

// PUT /api/inmobiliaria/me
router.put('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId, role } = req.user!;
    const { nombre } = req.body;

    if (role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado. Solo administradores pueden cambiar la configuración.' });
    }

    try {
        const updatedInmobiliaria = await prisma.inmobiliaria.update({
            where: { id: inmobiliariaId },
            data: {
                nombre
            }
        });

        res.json(updatedInmobiliaria);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar datos de la inmobiliaria' });
    }
});

// GET /api/inmobiliaria/logs
router.get('/logs', authenticateToken, async (req: AuthRequest, res: Response) => {
    const { inmobiliariaId, role } = req.user!;

    const { page = '1', limit = '15', accion, fechaDesde, fechaHasta } = req.query;

    if (role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado' });
    }

    try {
        const pageNum = parseInt(page as string);
        const limitNum = parseInt(limit as string);
        const skip = (pageNum - 1) * limitNum;

        const whereClause: any = { inmobiliariaId };

        if (accion) {
            whereClause.accion = accion as string;
        }

        if (fechaDesde || fechaHasta) {
            whereClause.fechaCreacion = {};
            if (fechaDesde) {
                whereClause.fechaCreacion.gte = new Date(fechaDesde as string);
            }
            if (fechaHasta) {
                const hasta = new Date(fechaHasta as string);
                hasta.setHours(23, 59, 59, 999);
                whereClause.fechaCreacion.lte = hasta;
            }
        }

        // Fetch logs and total count
        const [total, logs] = await prisma.$transaction([
            prisma.auditLog.count({ where: whereClause }),
            prisma.auditLog.findMany({
                where: whereClause,
                include: {
                    usuario: {
                        select: { nombreCompleto: true }
                    }
                },
                orderBy: { fechaCreacion: 'desc' },
                skip,
                take: limitNum
            })
        ]);
        
        res.json({
            data: logs,
            total,
            page: pageNum,
            limit: limitNum
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ message: 'Error al obtener logs' });
    }
});

export default router;
