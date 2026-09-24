-- Búsqueda operativa de registros ampliados y papelera recuperable para el
-- dossier documental de inmuebles.
ALTER TABLE "AdjuntoPropiedad"
  ADD COLUMN "eliminadoEn" TIMESTAMP(3),
  ADD COLUMN "eliminadoPorId" INTEGER,
  ADD COLUMN "motivoEliminacion" TEXT;

UPDATE "Persona"
SET "cbu" = regexp_replace("cbu", '[^0-9]', '', 'g')
WHERE "cbu" IS NOT NULL;

UPDATE "Persona"
SET "aliasBancario" = upper("aliasBancario")
WHERE "aliasBancario" IS NOT NULL;

UPDATE "Propiedad"
SET
  "partidaInmobiliaria" = upper("partidaInmobiliaria"),
  "matricula" = upper("matricula")
WHERE "partidaInmobiliaria" IS NOT NULL OR "matricula" IS NOT NULL;

ALTER TABLE "AdjuntoPropiedad"
  ADD CONSTRAINT "AdjuntoPropiedad_eliminadoPorId_fkey"
  FOREIGN KEY ("eliminadoPorId") REFERENCES "Usuario"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Persona_inmobiliariaId_cbu_idx" ON "Persona"("inmobiliariaId", "cbu");
CREATE INDEX "Persona_inmobiliariaId_aliasBancario_idx" ON "Persona"("inmobiliariaId", "aliasBancario");
CREATE INDEX "Propiedad_inmobiliariaId_partidaInmobiliaria_idx" ON "Propiedad"("inmobiliariaId", "partidaInmobiliaria");
CREATE INDEX "Propiedad_inmobiliariaId_matricula_idx" ON "Propiedad"("inmobiliariaId", "matricula");
CREATE INDEX "AdjuntoPropiedad_propiedadId_eliminadoEn_idx" ON "AdjuntoPropiedad"("propiedadId", "eliminadoEn");
CREATE INDEX "AdjuntoPropiedad_eliminadoEn_idx" ON "AdjuntoPropiedad"("eliminadoEn");
