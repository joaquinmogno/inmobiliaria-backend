-- PC-025: un mismo DNI/CUIT no puede identificar a dos personas de la instalación.
-- Se normalizan los formatos habituales antes de crear la restricción para que
-- 12.345.678, 12-345-678 y 12345678 sean el mismo documento.
BEGIN;

LOCK TABLE "Persona" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "Persona"
SET "dni" = NULLIF(
  regexp_replace(upper(btrim("dni")), '[^A-Z0-9]', '', 'g'),
  ''
)
WHERE "dni" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Persona"
    WHERE "dni" IS NOT NULL
    GROUP BY "inmobiliariaId", "dni"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'No se puede aplicar la unicidad de DNI: existen personas con el mismo DNI normalizado'
      USING HINT = 'Unifique manualmente las fichas duplicadas y vuelva a ejecutar la migración.';
  END IF;
END $$;

CREATE UNIQUE INDEX "Persona_inmobiliariaId_dni_key"
ON "Persona"("inmobiliariaId", "dni");

COMMIT;
