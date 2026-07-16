import { prisma } from '../prisma';
import { logger } from './logger.service';
import { deleteContractPermanently } from './contract-deletion.service';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.TRASH_RETENTION_DAYS || '90', 10) || 90);

export async function runMaintenance() {
  const now = new Date();
  const revokedBefore = new Date(now.getTime() - 7 * DAY_MS);
  const trashBefore = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);

  const deletedSessions = await prisma.userSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { lt: revokedBefore } }
      ]
    }
  });

  const expiredContracts = await prisma.contrato.findMany({
    where: { estado: 'PAPELERA', eliminadoEn: { lte: trashBefore } },
    select: { id: true, inmobiliariaId: true },
    orderBy: { eliminadoEn: 'asc' },
    take: 100
  });

  let purgedContracts = 0;
  for (const contract of expiredContracts) {
    try {
      await deleteContractPermanently(contract.id, contract.inmobiliariaId);
      purgedContracts += 1;
    } catch (error) {
      logger.warn('Trash purge skipped contract', { contractId: contract.id, inmobiliariaId: contract.inmobiliariaId, error });
    }
  }

  logger.info('Maintenance completed', { deletedSessions: deletedSessions.count, purgedContracts, retentionDays: TRASH_RETENTION_DAYS });
}

export function startMaintenanceJobs() {
  const initialRun = setTimeout(() => void runMaintenance().catch(error => logger.error('Initial maintenance failed', { error })), 30_000);
  const interval = setInterval(() => void runMaintenance().catch(error => logger.error('Scheduled maintenance failed', { error })), DAY_MS);
  initialRun.unref();
  interval.unref();
}
