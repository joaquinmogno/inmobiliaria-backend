-- PropControl is distributed as one customer per installation.
-- Keep inmobiliariaId as an ownership boundary, but make a second customer
-- impossible at the database level.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "Inmobiliaria") > 1 THEN
    RAISE EXCEPTION
      'No se puede convertir a instalación de cliente único: existen varias inmobiliarias. Sepárelas en bases independientes antes de aplicar esta migración.';
  END IF;
END $$;

-- A legacy SaaS administrator becomes the owner of the only installation.
UPDATE "Usuario"
SET "rol" = 'OWNER'
WHERE "rol" = 'SUPERADMIN';

DELETE FROM "RolPermiso"
WHERE "rol" = 'SUPERADMIN';

-- PostgreSQL enums cannot drop a value in place. Rebuild it after migrating
-- every legacy SUPERADMIN row above.
ALTER TABLE "Usuario" ALTER COLUMN "rol" DROP DEFAULT;
ALTER TYPE "RolUsuario" RENAME TO "RolUsuario_legacy";
CREATE TYPE "RolUsuario" AS ENUM ('OWNER', 'JEFE', 'ADMIN', 'AGENTE');

ALTER TABLE "Usuario"
  ALTER COLUMN "rol" TYPE "RolUsuario"
  USING ("rol"::text::"RolUsuario");

ALTER TABLE "RolPermiso"
  ALTER COLUMN "rol" TYPE "RolUsuario"
  USING ("rol"::text::"RolUsuario");

ALTER TABLE "Usuario" ALTER COLUMN "rol" SET DEFAULT 'AGENTE';
DROP TYPE "RolUsuario_legacy";

CREATE UNIQUE INDEX "Inmobiliaria_single_installation_key"
ON "Inmobiliaria" ((true));
