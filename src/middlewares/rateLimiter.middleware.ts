import { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { prisma } from '../prisma';
import { SESSION_COOKIE, sha256 } from '../services/security.service';
import type { AuthRequest } from './auth.middleware';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BACKOFF_START = 5;
const API_WINDOW_MS = 60 * 1000;

type LoginThrottleRequest = Request & { loginThrottleKey?: string };

function requestIp(req: Request) {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');
}

export function getLoginThrottleKey(req: Request) {
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase().slice(0, 254)
    : '';
  return sha256(`login:v1:${requestIp(req)}:${email}`);
}

export function getApiRateLimitKey(req: Request) {
  const authenticated = req as AuthRequest;
  if (authenticated.user && authenticated.sessionId) {
    return `user:${authenticated.user.id}:session:${authenticated.sessionId}`;
  }
  const sessionToken = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    return `session:${sha256(sessionToken)}`;
  }
  return `ip:${requestIp(req)}`;
}

export function loginBackoffSeconds(failureCount: number) {
  if (failureCount < LOGIN_BACKOFF_START) return 0;
  return Math.min(15 * 60, 30 * (2 ** (failureCount - LOGIN_BACKOFF_START)));
}

function rejectLogin(res: Response, retryAfterSeconds: number) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    message: `Demasiados intentos para esta cuenta. Volvé a intentar en ${retryAfterSeconds} segundos.`,
    code: 'LOGIN_BACKOFF',
    retryAfterSeconds
  });
}

export async function loginThrottle(req: Request, res: Response, next: NextFunction) {
  const key = getLoginThrottleKey(req);
  (req as LoginThrottleRequest).loginThrottleKey = key;

  try {
    const bucket = await prisma.loginThrottle.findUnique({ where: { key } });
    const now = new Date();
    if (!bucket) return next();
    if (bucket.expiresAt <= now) {
      await prisma.loginThrottle.deleteMany({ where: { key, expiresAt: { lte: now } } });
      return next();
    }
    if (bucket.blockedUntil && bucket.blockedUntil > now) {
      return rejectLogin(res, Math.max(1, Math.ceil((bucket.blockedUntil.getTime() - now.getTime()) / 1000)));
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function recordLoginFailure(req: Request) {
  const key = (req as LoginThrottleRequest).loginThrottleKey || getLoginThrottleKey(req);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const now = new Date();
    const current = await tx.loginThrottle.findUnique({ where: { key } });
    const isCurrent = Boolean(current && current.expiresAt > now);
    const failureCount = isCurrent ? current!.failureCount + 1 : 1;
    const retryAfterSeconds = loginBackoffSeconds(failureCount);
    const blockedUntil = retryAfterSeconds > 0 ? new Date(now.getTime() + retryAfterSeconds * 1000) : null;
    const expiresAt = new Date(now.getTime() + LOGIN_WINDOW_MS);

    await tx.loginThrottle.upsert({
      where: { key },
      create: { key, failureCount, firstFailureAt: now, lastFailureAt: now, blockedUntil, expiresAt },
      update: {
        failureCount,
        firstFailureAt: isCurrent ? current!.firstFailureAt : now,
        lastFailureAt: now,
        blockedUntil,
        expiresAt
      }
    });
    return { failureCount, retryAfterSeconds };
  });
}

export async function clearLoginThrottle(req: Request) {
  const key = (req as LoginThrottleRequest).loginThrottleKey || getLoginThrottleKey(req);
  await prisma.loginThrottle.deleteMany({ where: { key } });
}

export function sendLoginBackoffIfNeeded(res: Response, retryAfterSeconds: number) {
  if (retryAfterSeconds <= 0) return false;
  rejectLogin(res, retryAfterSeconds);
  return true;
}

export const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  limit: 600,
  keyGenerator: getApiRateLimitKey,
  skip: req => req.method === 'OPTIONS',
  message: { message: 'Límite de peticiones de la sesión excedido. Esperá un momento.', code: 'API_RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false
});

export const expensiveApiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  limit: 30,
  keyGenerator: getApiRateLimitKey,
  skip: req => req.method === 'OPTIONS',
  message: { message: 'Límite temporal para esta operación excedido. Esperá un momento.', code: 'EXPENSIVE_RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false
});
