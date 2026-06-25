CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

ALTER TABLE "Usuario"
    ADD COLUMN "activo" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "mfaSecret" TEXT,
    ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
    ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "UserSession" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioId" INTEGER NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "sessionVersion" INTEGER NOT NULL,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_usuarioId_idx" ON "UserSession"("usuarioId");
CREATE INDEX "UserSession_inmobiliariaId_idx" ON "UserSession"("inmobiliariaId");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");
CREATE INDEX "UserSession_revokedAt_idx" ON "UserSession"("revokedAt");

ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_usuarioId_fkey"
    FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_inmobiliariaId_fkey"
    FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog"
    ADD COLUMN "ipAddress" TEXT,
    ADD COLUMN "userAgent" TEXT,
    ADD COLUMN "severidad" "AuditSeverity" NOT NULL DEFAULT 'INFO';

-- Backups are global artifacts. Tenant roles must not receive global backup access by default.
DELETE FROM "RolPermiso" rp
USING "Permiso" p
WHERE rp."permisoId" = p.id
  AND rp.rol IN ('OWNER', 'JEFE', 'ADMIN', 'AGENTE')
  AND p.clave IN (
      'configuracion.backups.ver',
      'configuracion.backups.crear',
      'configuracion.backups.eliminar',
      'configuracion.backups.descargar'
  );

-- Force privileged roles to enroll MFA before continuing in the UI.
UPDATE "Usuario"
SET "mustChangePassword" = true
WHERE rol IN ('SUPERADMIN', 'OWNER', 'JEFE', 'ADMIN');
