import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import bcrypt from 'bcrypt';

const router = Router();

router.use(authenticateToken);

// Middleware to check if user is ADMIN
const isAdmin = (req: AuthRequest, res: any, next: any) => {
    if (req.user?.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
};

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
router.post('/', isAdmin, async (req, res) => {
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
router.put('/:id', isAdmin, async (req, res) => {
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
router.delete('/:id', isAdmin, async (req, res) => {
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
