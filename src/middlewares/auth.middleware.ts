import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma';
import { env } from '../config/env';

export interface AuthRequest extends Request {
    requestId?: string;
    user?: {
        id: number;
        email: string;
        role: string;
        inmobiliariaId: number;
    };
}

export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Token no proporcionado' });
    }

    jwt.verify(token, env.jwtSecret, async (err: any, user: any) => {
        if (err) {
            return res.status(403).json({ message: 'Token inválido' });
        }

        if (user.role !== 'SUPERADMIN') {
            try {
                const inmo = await prisma.inmobiliaria.findUnique({
                    where: { id: user.inmobiliariaId }
                });
                if (!inmo || !inmo.activa) {
                    return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });
                }
            } catch (dbErr) {
                return res.status(500).json({ message: 'Error validando estado de cuenta' });
            }
        }

        (req as AuthRequest).user = user;
        next();
    });
};
