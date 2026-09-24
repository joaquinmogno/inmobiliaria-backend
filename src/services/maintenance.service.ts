import { prisma } from '../prisma';
import { logger } from './logger.service';
import { deleteContractPermanently } from './contract-deletion.service';
import { syncContractLifecycle } from './contract-lifecycle.service';
import { removeUploadedFile } from '../middlewares/upload.middleware';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.TRASH_RETENTION_DAYS || '90', 10) || 90);
export const PROPERTY_ATTACHMENT_TRASH_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.PROPERTY_ATTACHMENT_TRASH_RETENTION_DAYS || String(TRASH_RETENTION_DAYS), 10) || TRASH_RETENTION_DAYS);
export const AUDIT_RETENTION_DAYS = Math.max(30, Number.parseInt(process.env.AUDIT_RETENTION_DAYS || '730', 10) || 730);

export async function runMaintenance() {
  const now = new Date();
  const revokedBefore = new Date(now.getTime() - 7 * DAY_MS);
  const trashBefore = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const propertyAttachmentTrashBefore = new Date(now.getTime() - PROPERTY_ATTACHMENT_TRASH_RETENTION_DAYS * DAY_MS);
  const auditBefore = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);

  const lifecycle = await syncContractLifecycle(undefined, now);
  const deletedSessions = await prisma.userSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { lt: revokedBefore } }
      ]
    }
  });
  const deletedLoginThrottles = await prisma.loginThrottle.deleteMany({
    where: { expiresAt: { lt: now } }
  });
  const deletedAuditLogs = await prisma.auditLog.deleteMany({
    where: { fechaCreacion: { lt: auditBefore } }
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

  const expiredPropertyAttachments = await prisma.adjuntoPropiedad.findMany({
    where: { eliminadoEn: { lte: propertyAttachmentTrashBefore } },
    select: { id: true, rutaArchivo: true, propiedadId: true },
    orderBy: { eliminadoEn: 'asc' },
    take: 100
  });
  let purgedPropertyAttachments = 0;
  for (const attachment of expiredPropertyAttachments) {
    try {
      await prisma.adjuntoPropiedad.delete({ where: { id: attachment.id } });
      await removeUploadedFile(attachment.rutaArchivo);
      purgedPropertyAttachments += 1;
    } catch (error) {
      logger.warn('Trash purge skipped property attachment', { attachmentId: attachment.id, propertyId: attachment.propiedadId, error });
    }
  }

  logger.info('Maintenance completed', {
    deletedSessions: deletedSessions.count,
    deletedLoginThrottles: deletedLoginThrottles.count,
    deletedAuditLogs: deletedAuditLogs.count,
    activatedContracts: lifecycle.activated,
    finalizedContracts: lifecycle.finalized,
    purgedContracts,
    purgedPropertyAttachments,
    trashRetentionDays: TRASH_RETENTION_DAYS,
    propertyAttachmentTrashRetentionDays: PROPERTY_ATTACHMENT_TRASH_RETENTION_DAYS,
    auditRetentionDays: AUDIT_RETENTION_DAYS
  });
}

export function startMaintenanceJobs() {
  const initialRun = setTimeout(() => void runMaintenance().catch(error => logger.error('Initial maintenance failed', { error })), 30_000);
  const interval = setInterval(() => void runMaintenance().catch(error => logger.error('Scheduled maintenance failed', { error })), DAY_MS);
  initialRun.unref();
  interval.unref();
}
