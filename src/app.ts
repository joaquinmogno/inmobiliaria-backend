import express from 'express';
import cors from 'cors';
import path from 'path';
import authRoutes from './routes/auth.routes';
// import propietariosRoutes from './routes/propietarios.routes';
// import inquilinosRoutes from './routes/inquilinos.routes';
import propiedadesRoutes from './routes/propiedades.routes';
import contratosRoutes from './routes/contratos.routes';
import usuariosRoutes from './routes/usuarios.routes';
import personasRoutes from './routes/personas.routes';
import liquidacionesRoutes from './routes/liquidaciones.routes';
import pagosRoutes from './routes/pagos.routes';
import backupsRoutes from './routes/backups.routes';
import inmobiliariaRoutes from './routes/inmobiliaria.routes';
import reportesRoutes from './routes/reportes.routes';
import cajachicaRoutes from './routes/cajachica.routes';
import superadminRoutes from './routes/superadmin.routes';
import planesCuotasRoutes from './routes/planes-cuotas.routes';
import sueldosRoutes from './routes/sueldos.routes';
import { apiLimiter } from './middlewares/rateLimiter.middleware';

import helmet from 'helmet';

const app = express();

// Security middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow loading images from different origins
}));
app.use(apiLimiter);

const allowedOrigins = [
  'http://localhost:5173', // Vite default
  'http://localhost:3000', // Local backend
  process.env.FRONTEND_URL
].filter(Boolean) as string[];

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));

// Serve uploads
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
app.use('/uploads', (req, res, next) => {
  res.set('Content-Disposition', 'inline');
  next();
}, express.static(uploadDir));

// Routes
app.use('/api/auth', authRoutes);
// app.use('/api/propietarios', propietariosRoutes);
// app.use('/api/inquilinos', inquilinosRoutes);
app.use('/api/propiedades', propiedadesRoutes);
app.use('/api/contratos', contratosRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/personas', personasRoutes);
app.use('/api/liquidaciones', liquidacionesRoutes);
app.use('/api/pagos', pagosRoutes);
app.use('/api/backups', backupsRoutes);
app.use('/api/inmobiliaria', inmobiliariaRoutes);
app.use('/api/reportes', reportesRoutes);
app.use('/api/cajachica', cajachicaRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/planes-cuotas', planesCuotasRoutes);
app.use('/api/sueldos', sueldosRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export default app;
