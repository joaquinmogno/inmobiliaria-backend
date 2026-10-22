ALTER TYPE "EstadoPropiedad" ADD VALUE 'PENDIENTE_ENTREGA';
ALTER TYPE "EstadoContrato" ADD VALUE 'EN_CIERRE';
ALTER TYPE "TipoDocumentoContrato" ADD VALUE 'ACTA_RESCISION_FIRMADA';
ALTER TYPE "TipoDocumentoContrato" ADD VALUE 'ACTA_LLAVES_FIRMADA';

ALTER TABLE "Contrato" ADD COLUMN "fechaEntregaLlaves" DATE;

CREATE TABLE "ActaRescision" (
    "id" SERIAL NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "datos" JSONB NOT NULL,
    "motivoRevision" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" INTEGER,
    CONSTRAINT "ActaRescision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActaRescision_contratoId_version_key" ON "ActaRescision"("contratoId", "version");
CREATE INDEX "ActaRescision_inmobiliariaId_contratoId_fechaEmision_idx" ON "ActaRescision"("inmobiliariaId", "contratoId", "fechaEmision");
ALTER TABLE "ActaRescision" ADD CONSTRAINT "ActaRescision_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActaRescision" ADD CONSTRAINT "ActaRescision_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActaRescision" ADD CONSTRAINT "ActaRescision_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ActaEntregaLlaves" (
    "id" SERIAL NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "datos" JSONB NOT NULL,
    "motivoRevision" TEXT,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" INTEGER,
    CONSTRAINT "ActaEntregaLlaves_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActaEntregaLlaves_contratoId_version_key" ON "ActaEntregaLlaves"("contratoId", "version");
CREATE INDEX "ActaEntregaLlaves_inmobiliariaId_contratoId_fechaEmision_idx" ON "ActaEntregaLlaves"("inmobiliariaId", "contratoId", "fechaEmision");
ALTER TABLE "ActaEntregaLlaves" ADD CONSTRAINT "ActaEntregaLlaves_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActaEntregaLlaves" ADD CONSTRAINT "ActaEntregaLlaves_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActaEntregaLlaves" ADD CONSTRAINT "ActaEntregaLlaves_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
