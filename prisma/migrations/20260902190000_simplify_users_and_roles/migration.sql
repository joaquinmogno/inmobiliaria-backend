-- Simplifica el acceso a ADMIN/USUARIO y roles configurables reutilizables.
-- Los OWNER existentes conservan acceso total. Para el resto se preserva exactamente
-- el conjunto efectivo anterior (rol + permisos directos - denegaciones).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Usuario"
    GROUP BY lower("email") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede migrar: existen emails duplicados ignorando mayúsculas';
  END IF;
END $$;

UPDATE "Usuario" SET "email" = lower(trim("email"));
CREATE UNIQUE INDEX IF NOT EXISTS "Usuario_email_normalized_key" ON "Usuario" (lower("email"));
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_email_normalized_check" CHECK ("email" = lower(trim("email")));

ALTER TABLE "AuditLog" ADD COLUMN "resultado" TEXT NOT NULL DEFAULT 'EXITO';
UPDATE "AuditLog" SET "resultado" = 'FALLIDO' WHERE "accion" LIKE '%FALL%';
CREATE INDEX "AuditLog_inmobiliariaId_resultado_fechaCreacion_idx" ON "AuditLog"("inmobiliariaId", "resultado", "fechaCreacion");

ALTER TABLE "Permiso"
  ADD COLUMN "modulo" TEXT,
  ADD COLUMN "accion" TEXT;

UPDATE "Permiso"
SET "modulo" = split_part("clave", '.', 1),
    "accion" = regexp_replace("clave", '^.*\.', '');

ALTER TABLE "Permiso"
  ALTER COLUMN "modulo" SET NOT NULL,
  ALTER COLUMN "accion" SET NOT NULL;

CREATE TYPE "TipoUsuario" AS ENUM ('ADMIN', 'USUARIO');

CREATE TABLE "Rol" (
  "id" SERIAL NOT NULL,
  "nombre" TEXT NOT NULL,
  "descripcion" TEXT,
  "activo" BOOLEAN NOT NULL DEFAULT true,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fechaActualizacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inmobiliariaId" INTEGER NOT NULL,
  CONSTRAINT "Rol_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Rol_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Rol_inmobiliariaId_nombre_key" ON "Rol"("inmobiliariaId", "nombre");
CREATE UNIQUE INDEX "Rol_inmobiliariaId_nombre_normalized_key" ON "Rol"("inmobiliariaId", lower("nombre"));
CREATE INDEX "Rol_inmobiliariaId_activo_idx" ON "Rol"("inmobiliariaId", "activo");

ALTER TABLE "RolPermiso" RENAME TO "RolPermisoLegacy";
ALTER INDEX "RolPermiso_pkey" RENAME TO "RolPermisoLegacy_pkey";
ALTER INDEX "RolPermiso_rol_permisoId_key" RENAME TO "RolPermisoLegacy_rol_permisoId_key";
ALTER INDEX "RolPermiso_rol_idx" RENAME TO "RolPermisoLegacy_rol_idx";

CREATE TABLE "RolPermiso" (
  "id" SERIAL NOT NULL,
  "rolId" INTEGER NOT NULL,
  "permisoId" INTEGER NOT NULL,
  CONSTRAINT "RolPermiso_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RolPermiso_rolId_fkey" FOREIGN KEY ("rolId") REFERENCES "Rol"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RolPermiso_permisoId_fkey" FOREIGN KEY ("permisoId") REFERENCES "Permiso"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RolPermiso_rolId_permisoId_key" ON "RolPermiso"("rolId", "permisoId");
CREATE INDEX "RolPermiso_rolId_idx" ON "RolPermiso"("rolId");

ALTER TABLE "Usuario"
  ADD COLUMN "tipo" "TipoUsuario" NOT NULL DEFAULT 'USUARIO',
  ADD COLUMN "rolId" INTEGER,
  ADD COLUMN "ultimoAcceso" TIMESTAMP(3);

UPDATE "Usuario" SET "tipo" = 'ADMIN' WHERE "rol" = 'OWNER';

-- Defensa para instalaciones históricas que no tengan un administrador activo:
-- promover y reactivar una sola cuenta, priorizando una que ya estuviera activa
-- y luego el rol anterior más privilegiado.
WITH candidato AS (
  SELECT "id"
  FROM "Usuario"
  WHERE NOT EXISTS (SELECT 1 FROM "Usuario" WHERE "tipo" = 'ADMIN' AND "activo" = true)
  ORDER BY "activo" DESC,
           CASE "rol"::text WHEN 'JEFE' THEN 1 WHEN 'ADMIN' THEN 2 ELSE 3 END,
           "id"
  LIMIT 1
)
UPDATE "Usuario"
SET "tipo" = 'ADMIN', "activo" = true, "rolId" = NULL
WHERE "id" IN (SELECT "id" FROM candidato);

INSERT INTO "Rol" ("nombre", "descripcion", "inmobiliariaId")
SELECT 'Acceso migrado - usuario ' || u."id",
       'Rol generado automáticamente al simplificar el sistema de permisos',
       u."inmobiliariaId"
FROM "Usuario" u
WHERE u."tipo" = 'USUARIO';

UPDATE "Usuario" u
SET "rolId" = r."id"
FROM "Rol" r
WHERE r."inmobiliariaId" = u."inmobiliariaId"
  AND r."nombre" = 'Acceso migrado - usuario ' || u."id"
  AND u."tipo" = 'USUARIO';

INSERT INTO "RolPermiso" ("rolId", "permisoId")
SELECT DISTINCT u."rolId", efectivos."permisoId"
FROM "Usuario" u
JOIN LATERAL (
  (
    SELECT legacy."permisoId"
    FROM "RolPermisoLegacy" legacy
    WHERE legacy."rol" = u."rol"
    UNION
    SELECT directo."permisoId"
    FROM "UsuarioPermiso" directo
    WHERE directo."usuarioId" = u."id"
  )
  EXCEPT
  SELECT denegado."permisoId"
  FROM "UsuarioPermisoDenegado" denegado
  WHERE denegado."usuarioId" = u."id"
) efectivos ON true
JOIN "Permiso" permiso_efectivo ON permiso_efectivo."id" = efectivos."permisoId"
WHERE u."tipo" = 'USUARIO'
  AND permiso_efectivo."clave" NOT LIKE 'usuarios.%'
  AND permiso_efectivo."clave" NOT LIKE 'configuracion.backups.%'
  AND permiso_efectivo."clave" <> 'configuracion.auditoria.ver';

ALTER TABLE "Usuario"
  ADD CONSTRAINT "Usuario_rolId_fkey" FOREIGN KEY ("rolId") REFERENCES "Rol"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Usuario_tipo_rol_check" CHECK (
    ("tipo" = 'ADMIN' AND "rolId" IS NULL) OR
    ("tipo" = 'USUARIO' AND "rolId" IS NOT NULL)
  );

CREATE INDEX "Usuario_rolId_idx" ON "Usuario"("rolId");
CREATE INDEX "Usuario_inmobiliariaId_tipo_activo_idx" ON "Usuario"("inmobiliariaId", "tipo", "activo");

ALTER TABLE "Usuario" DROP COLUMN "googleId";
ALTER TABLE "Usuario" DROP COLUMN "authProvider";
ALTER TABLE "Usuario" DROP COLUMN "rol";

DROP TABLE "PasswordResetToken";
DROP TABLE "UsuarioPermisoDenegado";
DROP TABLE "UsuarioPermiso";
DROP TABLE "RolPermisoLegacy";
DROP TYPE "RolUsuario";

CREATE OR REPLACE FUNCTION proteger_ultimo_admin_activo() RETURNS trigger AS $$
DECLARE
  agencia_id INTEGER;
  era_admin_activo BOOLEAN;
  seguira_admin_activo BOOLEAN;
BEGIN
  agencia_id := OLD."inmobiliariaId";
  era_admin_activo := OLD."tipo" = 'ADMIN' AND OLD."activo" = true;
  seguira_admin_activo := TG_OP <> 'DELETE'
    AND NEW."tipo" = 'ADMIN'
    AND NEW."activo" = true
    AND NEW."inmobiliariaId" = agencia_id;

  IF era_admin_activo AND NOT seguira_admin_activo THEN
    PERFORM pg_advisory_xact_lock(81726355, agencia_id);
    IF NOT EXISTS (
      SELECT 1 FROM "Usuario"
      WHERE "inmobiliariaId" = agencia_id
        AND "tipo" = 'ADMIN'
        AND "activo" = true
        AND "id" <> OLD."id"
    ) THEN
      RAISE EXCEPTION 'No se puede dejar la instalación sin un administrador activo' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Usuario_proteger_ultimo_admin_activo"
BEFORE UPDATE OF "tipo", "activo", "inmobiliariaId" OR DELETE ON "Usuario"
FOR EACH ROW EXECUTE FUNCTION proteger_ultimo_admin_activo();

CREATE OR REPLACE FUNCTION validar_rol_usuario() RETURNS trigger AS $$
BEGIN
  IF NEW."tipo" = 'USUARIO' AND NOT EXISTS (
    SELECT 1 FROM "Rol"
    WHERE "id" = NEW."rolId"
      AND "inmobiliariaId" = NEW."inmobiliariaId"
      AND "activo" = true
  ) THEN
    RAISE EXCEPTION 'El usuario debe tener un rol activo de la misma instalación' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Usuario_validar_rol"
BEFORE INSERT OR UPDATE OF "tipo", "rolId", "inmobiliariaId", "activo" ON "Usuario"
FOR EACH ROW EXECUTE FUNCTION validar_rol_usuario();

CREATE OR REPLACE FUNCTION proteger_rol_en_uso() RETURNS trigger AS $$
BEGIN
  IF OLD."activo" = true AND NEW."activo" = false AND EXISTS (
    SELECT 1 FROM "Usuario" WHERE "rolId" = OLD."id" AND "activo" = true
  ) THEN
    RAISE EXCEPTION 'No se puede deshabilitar un rol asignado a usuarios activos' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Rol_proteger_en_uso"
BEFORE UPDATE OF "activo" ON "Rol"
FOR EACH ROW EXECUTE FUNCTION proteger_rol_en_uso();
