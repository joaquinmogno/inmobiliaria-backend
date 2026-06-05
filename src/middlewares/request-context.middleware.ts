import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../services/logger.service';

export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'];
  req.requestId = typeof requestId === 'string' && requestId.trim() ? requestId : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const startedAt = Date.now();
  logger.info('HTTP request started', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl
  });

  res.on('finish', () => {
    logger.info('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
};
