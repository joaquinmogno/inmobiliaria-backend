DELETE FROM "RolPermiso" AS rp
USING "Permiso" AS p
WHERE rp."permisoId" = p."id"
  AND p."clave" IN ('sueldos.ver', 'sueldos.crear', 'sueldos.editar', 'sueldos.eliminar');

DELETE FROM "Permiso"
WHERE "clave" IN ('sueldos.ver', 'sueldos.crear', 'sueldos.editar', 'sueldos.eliminar');

DROP TABLE "AjustePagoSueldo";

ALTER TABLE "MovimientoCaja"
  DROP CONSTRAINT "MovimientoCaja_pagoSueldoId_fkey",
  DROP COLUMN "pagoSueldoId";

DROP TABLE "PagoSueldo";
DROP TYPE "TipoAjusteSueldo";
