import 'dotenv/config';
import app from './app';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Backend corriendo en puerto ${PORT}`);
});

server.on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Error: El puerto ${PORT} ya está en uso.`);
  } else {
    console.error('Error al iniciar el servidor:', error);
  }
  process.exit(1);
});
