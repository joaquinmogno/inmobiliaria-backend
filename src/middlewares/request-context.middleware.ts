import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger.service';
import { runWithRequestAuditContext } from '../services/request-audit-context.service';

type RequestWithRequestId = Request & { requestId?: string };

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const request = req as RequestWithRequestId;
  const requestId = req.headers['x-request-id'];
  request.requestId = typeof requestId === 'string' && requestId.trim()
    ? requestId.trim().slice(0, 100)
    : randomUUID();
  res.setHeader('X-Request-Id', request.requestId);

  runWithRequestAuditContext({
    requestId: request.requestId,
    ipAddress: req.ip || req.socket.remoteAddress || null,
    userAgent: req.get('user-agent')?.slice(0, 500) || null
  }, () => {
    const startedAt = Date.now();
    logger.info('HTTP request started', {
      requestId: request.requestId,
      method: req.method,
      path: req.originalUrl
    });

    res.on('finish', () => {
      logger.info('HTTP request completed', {
        requestId: request.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    });

    next();
  });
};
