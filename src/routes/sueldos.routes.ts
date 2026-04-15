import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);

// Get salaries (with privacy logic)
router.get('/', async (req, res) => {
    const { id: userId, role, inmobiliariaId } = (req as AuthRequest).user!;

    try {
        const where: any = { inmobiliariaId };

        // Privacy layer: Agents can only see their own salaries
        if (role === 'AGENTE') {
            where.usuarioId = userId;
        }

        const sueldos = await prisma.pagoSueldo.findMany({
            where,
            include: {
                usuario: {
                    select: {
                        id: true,
                        nombreCompleto: true,
                        email: true
                    }
                },
                creadoPor: {
                    select: {
                        nombreCompleto: true
                    }
                }
            },
            orderBy: { fecha: 'desc' }
        });

        res.json(sueldos);
    } catch (error) {
        console.error('Error fetching salaries:', error);
        res.status(500).json({ message: 'Error al obtener sueldos' });
    }
});

// Create salary payment (Admin only)
router.post('/', async (req, res) => {
    const { id: adminId, role, inmobiliariaId } = (req as AuthRequest).user!;
    const { usuarioId, monto, fecha, periodo, metodoPago, observaciones } = req.body;

    if (role !== 'ADMIN' && role !== 'SUPERADMIN') {
        return res.status(403).json({ message: 'No tiene permisos para registrar sueldos' });
    }

    if (!usuarioId || !monto || !fecha || !periodo) {
        return res.status(400).json({ message: 'Faltan datos obligatorios' });
    }

    try {
        // Verify recipient belongs to the same agency
        const recipient = await prisma.usuario.findFirst({
            where: { id: Number(usuarioId), inmobiliariaId }
        });

        if (!recipient) {
            return res.status(404).json({ message: 'Usuario no encontrado en esta inmobiliaria' });
        }

        const sueldo = await prisma.pagoSueldo.create({
            data: {
                monto: new Decimal(monto),
                fecha: new Date(fecha),
                periodo,
                metodoPago: metodoPago || 'EFECTIVO',
                observaciones,
                usuarioId: Number(usuarioId),
                inmobiliariaId,
                creadoPorId: adminId
            },
            include: {
                usuario: {
                    select: { nombreCompleto: true }
                }
            }
        });

        await auditService.log({
            usuarioId: adminId,
            inmobiliariaId,
            accion: 'REGISTRAR_SUELDO',
            entidad: 'PagoSueldo',
            entidadId: sueldo.id,
            detalle: `Pago de sueldo registrado para ${sueldo.usuario.nombreCompleto} - Periodo: ${periodo}`
        });

        res.status(201).json(sueldo);
    } catch (error) {
        console.error('Error creating salary payment:', error);
        res.status(500).json({ message: 'Error al registrar el pago de sueldo' });
    }
});

export default router;
