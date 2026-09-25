-- Preserva cada instrumento del contrato. La ruta histórica deja de depender del
-- puntero mutable Contrato.rutaArchivoContrato.
CREATE TYPE "TipoDocumentoContrato" AS ENUM ('CONTRATO_PRINCIPAL', 'ADENDA', 'ADJUNTO');

ALTER TABLE "AdjuntoContrato"
    ADD COLUMN "tipo" "TipoDocumentoContrato" NOT NULL DEFAULT 'ADJUNTO',
    ADD COLUMN "fechaDocumento" DATE NOT NULL DEFAULT CURRENT_DATE,
    ADD COLUMN "observacion" TEXT,
    ADD COLUMN "versionDocumento" INTEGER,
    ADD COLUMN "esVigente" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "creadoPorId" INTEGER;

-- Todo contrato que ya tenía un archivo principal obtiene su primera versión
-- documental, sin mover ni borrar el archivo original.
INSERT INTO "AdjuntoContrato" (
    "rutaArchivo", "nombreArchivo", "tipo", "fechaDocumento", "versionDocumento",
    "esVigente", "fechaCreacion", "contratoId", "creadoPorId"
)
SELECT
    "rutaArchivoContrato", NULL, 'CONTRATO_PRINCIPAL', "fechaCreacion"::date, 1,
    true, "fechaCreacion", "id", "creadoPorId"
FROM "Contrato"
WHERE "rutaArchivoContrato" IS NOT NULL;

CREATE UNIQUE INDEX "AdjuntoContrato_contratoId_tipo_versionDocumento_key"
    ON "AdjuntoContrato"("contratoId", "tipo", "versionDocumento");

CREATE INDEX "AdjuntoContrato_contratoId_tipo_esVigente_idx"
    ON "AdjuntoContrato"("contratoId", "tipo", "esVigente");

CREATE INDEX "AdjuntoContrato_creadoPorId_idx"
    ON "AdjuntoContrato"("creadoPorId");

ALTER TABLE "AdjuntoContrato"
    ADD CONSTRAINT "AdjuntoContrato_creadoPorId_fkey"
    FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
