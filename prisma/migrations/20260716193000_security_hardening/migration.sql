ALTER TABLE "UserSession" ADD COLUMN "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioId" INTEGER NOT NULL,
    "creadoPorId" INTEGER NOT NULL,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_usuarioId_idx" ON "PasswordResetToken"("usuarioId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permiso" ("clave", "descripcion", "fechaCreacion")
VALUES ('usuarios.asignar_rol', 'Asignar roles a usuarios', CURRENT_TIMESTAMP)
ON CONFLICT ("clave") DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT role_name::"RolUsuario", p."id"
FROM (VALUES ('SUPERADMIN'), ('OWNER')) AS roles(role_name)
CROSS JOIN "Permiso" p
WHERE p."clave" = 'usuarios.asignar_rol'
ON CONFLICT DO NOTHING;

DELETE FROM "RolPermiso" rp
USING "Permiso" p
WHERE rp."permisoId" = p."id"
  AND p."clave" LIKE 'configuracion.backups.%'
  AND rp."rol" <> 'SUPERADMIN';

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT 'SUPERADMIN'::"RolUsuario", p."id"
FROM "Permiso" p
WHERE p."clave" LIKE 'configuracion.backups.%'
ON CONFLICT DO NOTHING;
