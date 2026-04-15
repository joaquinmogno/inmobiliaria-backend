import { prisma } from '../prisma';

export const auditService = {
  log: async (params: {
    usuarioId: number;
    inmobiliariaId: number;
    accion: string;
    entidad: string;
    entidadId?: number;
    detalle?: string;
  }) => {
    try {
      await prisma.auditLog.create({
        data: {
          usuarioId: params.usuarioId,
          inmobiliariaId: params.inmobiliariaId,
          accion: params.accion,
          entidad: params.entidad,
          entidadId: params.entidadId,
          detalle: params.detalle
        }
      });
    } catch (error) {
      console.error('Error recording audit log:', error);
      // No lanzamos el error para no bloquear la acción principal
    }
  }
};
