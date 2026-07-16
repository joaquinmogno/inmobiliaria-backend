import 'dotenv/config';
import './config/env';
import app from './app';
import { logger } from './services/logger.service';
import { startMaintenanceJobs } from './services/maintenance.service';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info('Backend started', { port: PORT });
  startMaintenanceJobs();
});

server.on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('Port already in use', { port: PORT, error });
  } else {
    logger.error('Error starting server', { port: PORT, error });
  }
  process.exit(1);
});
