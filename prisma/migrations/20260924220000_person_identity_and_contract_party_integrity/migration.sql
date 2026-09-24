-- M-31: compare identity data in a canonical format and stop new duplicate parties.
ALTER TABLE "Persona"
  ADD COLUMN "cuitNormalizado" TEXT,
  ADD COLUMN "emailNormalizado" TEXT,
  ADD COLUMN "telefonoNormalizado" TEXT;

UPDATE "Persona"
SET
  "cuitNormalizado" = NULLIF(regexp_replace(COALESCE("cuit", ''), '[^0-9]', '', 'g'), ''),
  "emailNormalizado" = NULLIF(lower(btrim(COALESCE("email", ''))), ''),
  "telefonoNormalizado" = NULLIF(regexp_replace(COALESCE("telefono", ''), '[^0-9]', '', 'g'), '');

-- Preserve legacy records.  Only the first record in an existing duplicate
-- group retains the canonical key, so the unique indexes can be introduced
-- without deleting data. The application exposes those records for review.
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "inmobiliariaId", "cuitNormalizado" ORDER BY "id") AS position
  FROM "Persona" WHERE "cuitNormalizado" IS NOT NULL
)
UPDATE "Persona" p SET "cuitNormalizado" = NULL FROM ranked r WHERE p."id" = r."id" AND r.position > 1;

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "inmobiliariaId", "emailNormalizado" ORDER BY "id") AS position
  FROM "Persona" WHERE "emailNormalizado" IS NOT NULL
)
UPDATE "Persona" p SET "emailNormalizado" = NULL FROM ranked r WHERE p."id" = r."id" AND r.position > 1;

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "inmobiliariaId", "telefonoNormalizado" ORDER BY "id") AS position
  FROM "Persona" WHERE "telefonoNormalizado" IS NOT NULL
)
UPDATE "Persona" p SET "telefonoNormalizado" = NULL FROM ranked r WHERE p."id" = r."id" AND r.position > 1;

CREATE UNIQUE INDEX "Persona_inmobiliariaId_cuitNormalizado_key" ON "Persona"("inmobiliariaId", "cuitNormalizado");
CREATE UNIQUE INDEX "Persona_inmobiliariaId_emailNormalizado_key" ON "Persona"("inmobiliariaId", "emailNormalizado");
CREATE UNIQUE INDEX "Persona_inmobiliariaId_telefonoNormalizado_key" ON "Persona"("inmobiliariaId", "telefonoNormalizado");

-- Historical repeated relation rows are consolidated before adding the keys.
-- If either record was the principal, the retained relation remains principal.
WITH grouped AS (
  SELECT min("id") AS keep_id, "contratoId", "personaId", bool_or("esPrincipal") AS principal
  FROM "ContratoInquilino"
  GROUP BY "contratoId", "personaId"
)
UPDATE "ContratoInquilino" relation
SET "esPrincipal" = grouped.principal
FROM grouped
WHERE relation."id" = grouped.keep_id;

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "contratoId", "personaId" ORDER BY "id") AS position
  FROM "ContratoInquilino"
)
DELETE FROM "ContratoInquilino" relation USING ranked
WHERE relation."id" = ranked."id" AND ranked.position > 1;

WITH grouped AS (
  SELECT min("id") AS keep_id, "contratoId", "personaId", bool_or("esPrincipal") AS principal
  FROM "ContratoPropietario"
  GROUP BY "contratoId", "personaId"
)
UPDATE "ContratoPropietario" relation
SET "esPrincipal" = grouped.principal
FROM grouped
WHERE relation."id" = grouped.keep_id;

WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "contratoId", "personaId" ORDER BY "id") AS position
  FROM "ContratoPropietario"
)
DELETE FROM "ContratoPropietario" relation USING ranked
WHERE relation."id" = ranked."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "ContratoInquilino_contratoId_personaId_key" ON "ContratoInquilino"("contratoId", "personaId");
CREATE UNIQUE INDEX "ContratoPropietario_contratoId_personaId_key" ON "ContratoPropietario"("contratoId", "personaId");

-- A composite unique key protects a role list. This trigger protects the
-- cross-table invariant: a person cannot be both owner and tenant in one contract.
CREATE OR REPLACE FUNCTION prevent_contract_party_role_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'ContratoInquilino' THEN
    IF EXISTS (
      SELECT 1 FROM "ContratoPropietario"
      WHERE "contratoId" = NEW."contratoId" AND "personaId" = NEW."personaId"
    ) THEN
      RAISE EXCEPTION 'Una persona no puede ser propietario e inquilino del mismo contrato' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM "ContratoInquilino"
      WHERE "contratoId" = NEW."contratoId" AND "personaId" = NEW."personaId"
    ) THEN
      RAISE EXCEPTION 'Una persona no puede ser propietario e inquilino del mismo contrato' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContratoInquilino_prevent_role_overlap"
  BEFORE INSERT OR UPDATE OF "contratoId", "personaId" ON "ContratoInquilino"
  FOR EACH ROW EXECUTE FUNCTION prevent_contract_party_role_overlap();

CREATE TRIGGER "ContratoPropietario_prevent_role_overlap"
  BEFORE INSERT OR UPDATE OF "contratoId", "personaId" ON "ContratoPropietario"
  FOR EACH ROW EXECUTE FUNCTION prevent_contract_party_role_overlap();
