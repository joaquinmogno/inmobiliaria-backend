CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Persona_nombreCompleto_trgm_idx"
ON "Persona" USING GIN ("nombreCompleto" gin_trgm_ops);

CREATE INDEX "Persona_dni_trgm_idx"
ON "Persona" USING GIN ("dni" gin_trgm_ops);

CREATE INDEX "Propiedad_direccion_trgm_idx"
ON "Propiedad" USING GIN ("direccion" gin_trgm_ops);

CREATE INDEX "Contrato_estado_eliminadoEn_idx"
ON "Contrato"("estado", "eliminadoEn");
