ALTER TABLE "Persona" ADD COLUMN "cuit" TEXT, ADD COLUMN "banco" TEXT, ADD COLUMN "cbu" TEXT, ADD COLUMN "aliasBancario" TEXT, ADD COLUMN "contactoAlternativo" TEXT, ADD COLUMN "telefonoAlternativo" TEXT;
ALTER TABLE "Propiedad" ADD COLUMN "partidaInmobiliaria" TEXT, ADD COLUMN "matricula" TEXT, ADD COLUMN "superficieM2" DECIMAL(10,2);
CREATE INDEX "Persona_inmobiliariaId_cuit_idx" ON "Persona"("inmobiliariaId", "cuit");
