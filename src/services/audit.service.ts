import { prisma } from '../prisma';

export const auditService = {
  log: async (params: {
    usuarioId?: number | null;
    inmobiliariaId: number;
    accion: string;
    entidad: string;
    entidadId?: number;
    detalle?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    severidad?: 'INFO' | 'WARNING' | 'CRITICAL';
  }) => {
    try {
      await prisma.auditLog.create({
        data: {
          usuarioId: params.usuarioId || null,
          inmobiliariaId: params.inmobiliariaId,
          accion: params.accion,
          entidad: params.entidad,
          entidadId: params.entidadId,
          detalle: params.detalle,
          ipAddress: params.ipAddress || undefined,
          userAgent: params.userAgent || undefined,
          severidad: params.severidad || 'INFO'
        }
      });
    } catch (error) {
      console.error('Error recording audit log:', error);
      // No lanzamos el error para no bloquear la acción principal
    }
  },

  history: async (params: {
    inmobiliariaId: number;
    entidad: string;
    entidadId: number;
  }) => {
    return prisma.auditLog.findMany({
      where: {
        inmobiliariaId: params.inmobiliariaId,
        entidad: params.entidad,
        entidadId: params.entidadId
      },
      include: {
        usuario: {
          select: {
            id: true,
            nombreCompleto: true,
            email: true
          }
        }
      },
      orderBy: { fechaCreacion: 'desc' }
    });
  }
};
