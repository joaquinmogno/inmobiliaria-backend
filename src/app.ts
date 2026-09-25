import express from 'express';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes';
import propiedadesRoutes from './routes/propiedades.routes';
import contratosRoutes from './routes/contratos.routes';
import usuariosRoutes from './routes/usuarios.routes';
import rolesRoutes from './routes/roles.routes';
import personasRoutes from './routes/personas.routes';
import liquidacionesRoutes from './routes/liquidaciones.routes';
import pagosRoutes from './routes/pagos.routes';
import backupsRoutes from './routes/backups.routes';
import inmobiliariaRoutes from './routes/inmobiliaria.routes';
import reportesRoutes from './routes/reportes.routes';
import cajachicaRoutes from './routes/cajachica.routes';
import planesCuotasRoutes from './routes/planes-cuotas.routes';
import sueldosRoutes from './routes/sueldos.routes';
import alertasOperativasRoutes from './routes/alertas-operativas.routes';
import filesRoutes from './routes/files.routes';
import { apiLimiter, expensiveApiLimiter } from './middlewares/rateLimiter.middleware';
import multer from 'multer';
import { requestContext } from './middlewares/request-context.middleware';
import { logger } from './services/logger.service';
import { AppError } from './errors/app-error';
import { prisma } from './prisma';
import { invalidatePerformanceCache } from './services/performance-cache.service';
import { authenticateToken } from './middlewares/auth.middleware';

import helmet from 'helmet';

const app = express();
app.set('trust proxy', 1);
app.set('etag', false);
app.use(requestContext);

// Security middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow loading images from different origins
}));

const allowedOrigins = [
  ...(process.env.NODE_ENV === 'production' ? [] : [
    'http://localhost:5173',
    'http://localhost:3000'
  ]),
  process.env.FRONTEND_URL
].filter(Boolean) as string[];

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origen no permitido por CORS'));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition']
}));

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => {
      const user = (req as express.Request & { user?: { inmobiliariaId: number } }).user;
      if (user && res.statusCode < 400) invalidatePerformanceCache(user.inmobiliariaId);
    });
  }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
// El login posee un backoff persistente por IP + cuenta. El resto de la API se
// dimensiona por sesión para que una oficina detrás de NAT no comparta cuota.
const sessionRateLimit = [authenticateToken, apiLimiter];
app.use('/api/propiedades', ...sessionRateLimit, propiedadesRoutes);
app.use('/api/contratos', ...sessionRateLimit, contratosRoutes);
app.use('/api/usuarios', ...sessionRateLimit, usuariosRoutes);
app.use('/api/roles', ...sessionRateLimit, rolesRoutes);
app.use('/api/personas', ...sessionRateLimit, personasRoutes);
app.use('/api/liquidaciones', ...sessionRateLimit, liquidacionesRoutes);
app.use('/api/pagos', ...sessionRateLimit, pagosRoutes);
app.use('/api/backups', ...sessionRateLimit, expensiveApiLimiter, backupsRoutes);
app.use('/api/inmobiliaria', ...sessionRateLimit, inmobiliariaRoutes);
app.use('/api/reportes', ...sessionRateLimit, expensiveApiLimiter, reportesRoutes);
app.use('/api/cajachica', ...sessionRateLimit, cajachicaRoutes);
app.use('/api/planes-cuotas', ...sessionRateLimit, planesCuotasRoutes);
app.use('/api/sueldos', ...sessionRateLimit, sueldosRoutes);
app.use('/api/alertas-operativas', ...sessionRateLimit, alertasOperativasRoutes);
app.use('/api/files', ...sessionRateLimit, expensiveApiLimiter, filesRoutes);

app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/ready', async (_req, res) => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Database readiness timeout')), 3000);
      })
    ]);
    res.json({ status: 'ready', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'unavailable' });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.get('/health', (_req, res) => {
  res.redirect(307, '/health/ready');
});

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const requestId = (req as express.Request & { requestId?: string }).requestId;

  // Si una descarga o stream falla después de comenzar la respuesta, Express debe
  // cerrar la conexión mediante su manejador por defecto; ya no es posible enviar JSON.
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    logger.warn('Application error', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      code: err.code,
      details: err.details
    });

    return res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
      details: err.details,
      requestId
    });
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      message: 'El archivo supera el límite máximo de 30 MB',
      code: 'FILE_TOO_LARGE',
      requestId
    });
  }
  if (err instanceof Error && err.message.includes('Tipo de archivo no permitido')) {
    return res.status(400).json({
      message: err.message,
      code: 'INVALID_FILE_TYPE',
      requestId
    });
  }
  if (err instanceof Error && err.message.includes('contrato principal')) {
    return res.status(400).json({
      message: err.message,
      code: 'INVALID_MAIN_CONTRACT_FILE',
      requestId
    });
  }

  logger.error('Unhandled error', {
    requestId,
    method: req.method,
    path: req.originalUrl,
    error: err
  });
  res.status(500).json({
    message: 'Error interno del servidor',
    code: 'INTERNAL_SERVER_ERROR',
    requestId
  });
});

export default app;
