import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { validateBody, requiredText } from '../middlewares/validation.middleware';
import bcrypt from 'bcrypt';
import { z } from 'zod';

const router = Router();

router.use(authenticateToken);

const createUserSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128),
    nombreCompleto: requiredText('El nombre completo', 120),
    rol: z.enum(['ADMIN', 'AGENTE']).optional().default('AGENTE')
});

const updateUserSchema = createUserSchema.omit({ password: true }).partial().refine(
    data => Object.keys(data).length > 0,
    { message: 'Debe indicar al menos un campo para actualizar' }
);

// Get all users of the agency
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    try {
        const users = await prisma.usuario.findMany({
            where: { inmobiliariaId },
            select: {
                id: true,
                email: true,
                nombreCompleto: true,
                rol: true,
                fechaCreacion: true,
                fechaActualizacion: true
            }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener usuarios' });
    }
});

// Create user
router.post('/', requireAdmin, validateBody(createUserSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { email, password, nombreCompleto, rol } = req.body;

    try {
        const existingUser = await prisma.usuario.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'El email ya está en uso' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.usuario.create({
            data: {
                email,
                password: hashedPassword,
                nombreCompleto,
                rol: rol || 'AGENTE',
                inmobiliariaId
            }
        });

        const { password: _, ...userWithoutPassword } = user;
        res.status(201).json(userWithoutPassword);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear usuario' });
    }
});

// Update user
router.put('/:id', requireAdmin, validateBody(updateUserSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { email, nombreCompleto, rol } = req.body;

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        const updatedUser = await prisma.usuario.update({
            where: { id: Number(id) },
            data: {
                email,
                nombreCompleto,
                rol
            }
        });

        const { password: _, ...userWithoutPassword } = updatedUser;
        res.json(userWithoutPassword);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar usuario' });
    }
});

// Delete user
router.delete('/:id', requireAdmin, async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    if (Number(id) === (req as AuthRequest).user!.id) {
        return res.status(400).json({ message: 'No puedes eliminarte a ti mismo' });
    }

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        await prisma.usuario.delete({
            where: { id: Number(id) }
        });

        res.json({ message: 'Usuario eliminado con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar usuario' });
    }
});

export default router;
