import { Router } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { loginLimiter } from '../middlewares/rateLimiter.middleware';
import { z } from 'zod';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_change_me';

const loginSchema = z.object({
    email: z.string()
        .trim()
        .toLowerCase()
        .email('Email inválido')
        .max(254, 'Email demasiado largo'),
    password: z.string()
        .min(6, 'La contraseña debe tener al menos 6 caracteres')
        .max(128, 'Contraseña demasiado larga')
});

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
    newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres')
});

const resetPasswordSchema = z.object({
    newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres')
});

const setupSuperAdminSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254, 'Email demasiado largo'),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128, 'Contraseña demasiado larga'),
    nombreCompleto: z.string().trim().min(2, 'El nombre es obligatorio').max(120, 'Nombre demasiado largo')
});

router.post('/login', loginLimiter, async (req, res) => {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { email, password } = validation.data;

    try {
        const user = await prisma.usuario.findUnique({
            where: { email },
            include: { inmobiliaria: true }
        });

        if (!user) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        if (user.rol !== 'SUPERADMIN' && (!user.inmobiliaria || !user.inmobiliaria.activa)) {
            return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });
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
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { id } = (req as AuthRequest).user!;
    const { currentPassword, newPassword } = validation.data;

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
    const validation = resetPasswordSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { role, inmobiliariaId } = (req as AuthRequest).user!;
    const { userId } = req.params;
    const { newPassword } = validation.data;

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

// Setup Initial SuperAdmin (Solo se puede usar si no existe ninguno)
router.post('/setup-superadmin', async (req, res) => {
    try {
        const validation = setupSuperAdminSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({
                message: 'Datos de entrada inválidos',
                errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
            });
        }

        const existingSuperAdmin = await prisma.usuario.findFirst({
            where: { rol: 'SUPERADMIN' }
        });
        
        if (existingSuperAdmin) {
            return res.status(403).json({ message: 'Ya existe un administrador global configurado' });
        }

        const { email, password, nombreCompleto } = validation.data;

        // Enlazar al super admin a la primera inmobiliaria existente (Foreign Key)
        // El rol de SUPERADMIN ignora la restricción de inmobiliariaId posteriormente.
        let rootInmo = await prisma.inmobiliaria.findFirst();

        if (!rootInmo) {
            rootInmo = await prisma.inmobiliaria.create({
                data: {
                    nombre: 'SaaS Platform Home',
                    activa: true
                }
            });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const superAdmin = await prisma.usuario.create({
            data: {
                email,
                password: hashedPassword,
                nombreCompleto,
                rol: 'SUPERADMIN',
                inmobiliariaId: rootInmo.id
            }
        });
        
        res.status(201).json({ 
            message: 'Super Administrador inicializado con éxito', 
            email: superAdmin.email 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error crítico de inicialización' });
    }
});

export default router;
