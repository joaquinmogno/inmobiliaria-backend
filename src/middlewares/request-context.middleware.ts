import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger.service';

type RequestWithRequestId = Request & { requestId?: string };

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const request = req as RequestWithRequestId;
  const requestId = req.headers['x-request-id'];
  request.requestId = typeof requestId === 'string' && requestId.trim() ? requestId : randomUUID();
  res.setHeader('X-Request-Id', request.requestId);

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
};
