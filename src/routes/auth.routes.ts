import { Router } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_change_me';

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await prisma.usuario.findUnique({
            where: { email },
            include: { inmobiliaria: true }
        });

        if (!user) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                role: user.rol,
                inmobiliariaId: user.inmobiliariaId
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.nombreCompleto,
                role: user.rol,
                inmobiliaria: user.inmobiliaria
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor' });
    }
});

// Change password (logged in user)
router.post('/change-password', authenticateToken, async (req, res) => {
    const { id } = (req as AuthRequest).user!;
    const { currentPassword, newPassword } = req.body;

    try {
        const user = await prisma.usuario.findUnique({ where: { id } });
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Contraseña actual incorrecta' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.usuario.update({
            where: { id },
            data: { password: hashedPassword }
        });

        res.json({ message: 'Contraseña actualizada con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al cambiar contraseña' });
    }
});

// Reset password (admin only)
router.post('/reset-password/:userId', authenticateToken, async (req, res) => {
    const { role, inmobiliariaId } = (req as AuthRequest).user!;
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado' });
    }

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(userId), inmobiliariaId }
        });

        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.usuario.update({
            where: { id: Number(userId) },
            data: { password: hashedPassword }
        });

        res.json({ message: 'Contraseña reseteada con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al resetear contraseña' });
    }
});

export default router;
