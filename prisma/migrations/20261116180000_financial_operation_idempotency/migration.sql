CREATE TABLE "OperacionFinanciera" (
  "id" SERIAL PRIMARY KEY,
  "inmobiliariaId" INTEGER NOT NULL,
  "usuarioId" INTEGER NOT NULL,
  "clave" VARCHAR(100) NOT NULL,
  "alcance" VARCHAR(200) NOT NULL,
  "hashSolicitud" VARCHAR(64) NOT NULL,
  "respuesta" JSONB NOT NULL,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OperacionFinanciera_inmobiliariaId_clave_key" ON "OperacionFinanciera"("inmobiliariaId", "clave");
CREATE INDEX "OperacionFinanciera_usuarioId_idx" ON "OperacionFinanciera"("usuarioId");
