import type { Request } from 'express';
import { prisma } from '../prisma';
import { parsePagination } from '../utils/pagination';
import { logger } from './logger.service';
import { getRequestAuditContext } from './request-audit-context.service';

export type AuditLogParams = {
  usuarioId?: number | null;
  inmobiliariaId: number;
  accion: string;
  entidad: string;
  entidadId?: number;
  detalle?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  severidad?: 'INFO' | 'WARNING' | 'CRITICAL';
  resultado?: 'EXITO' | 'FALLIDO';
};

export const getAuditRequestMetadata = (req: Request & { requestId?: string }) => ({
  ipAddress: req.ip || req.socket.remoteAddress || null,
  userAgent: req.get('user-agent')?.slice(0, 500) || null,
  requestId: req.requestId || null
});

export const auditService = {
  log: async (params: AuditLogParams): Promise<boolean> => {
    const requestContext = getRequestAuditContext();
    try {
      await prisma.auditLog.create({
        data: {
          usuarioId: params.usuarioId ?? null,
          inmobiliariaId: params.inmobiliariaId,
          accion: params.accion,
          entidad: params.entidad,
          entidadId: params.entidadId,
          detalle: params.detalle,
          ipAddress: params.ipAddress || requestContext?.ipAddress || undefined,
          userAgent: params.userAgent || requestContext?.userAgent || undefined,
          requestId: params.requestId || requestContext?.requestId || undefined,
          severidad: params.severidad || 'INFO',
          resultado: params.resultado || 'EXITO'
        }
      });
      return true;
    } catch (error) {
      logger.error('AUDIT_SINK_FAILURE', {
        alert: true,
        requestId: params.requestId || requestContext?.requestId,
        inmobiliariaId: params.inmobiliariaId,
        usuarioId: params.usuarioId,
        accion: params.accion,
        entidad: params.entidad,
        entidadId: params.entidadId,
        resultado: params.resultado || 'EXITO',
        error
      });
      return false;
    }
  },

  history: async (params: {
    inmobiliariaId: number;
    entidad: string;
    entidadId: number;
    page?: number;
    limit?: number;
  }) => {
    const pagination = parsePagination(params.page, params.limit, 10);
    const where = {
      inmobiliariaId: params.inmobiliariaId,
      entidad: params.entidad,
      entidadId: params.entidadId
    };
    const [total, data] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: {
          usuario: {
            select: {
              id: true,
              nombreCompleto: true,
              email: true
            }
          }
        },
        orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.limit
      })
    ]);
    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit)
      }
    };
  }
};
