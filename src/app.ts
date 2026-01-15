import express from 'express';
import cors from 'cors';
import path from 'path';
import authRoutes from './routes/auth.routes';
import propietariosRoutes from './routes/propietarios.routes';
import inquilinosRoutes from './routes/inquilinos.routes';
import propiedadesRoutes from './routes/propiedades.routes';
import contratosRoutes from './routes/contratos.routes';
import usuariosRoutes from './routes/usuarios.routes';

const app = express();

app.use(cors());
app.use(express.json());

// Serve uploads
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
app.use('/uploads', (req, res, next) => {
  res.set('Content-Disposition', 'inline');
  next();
}, express.static(uploadDir));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/propietarios', propietariosRoutes);
app.use('/api/inquilinos', inquilinosRoutes);
app.use('/api/propiedades', propiedadesRoutes);
app.use('/api/contratos', contratosRoutes);
app.use('/api/usuarios', usuariosRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export default app;
