CREATE TABLE "BorradorContrato" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "datos" JSONB NOT NULL,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaActualizacion" TIMESTAMP(3) NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER NOT NULL,
    "actualizadoPorId" INTEGER,

    CONSTRAINT "BorradorContrato_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdjuntoBorradorContrato" (
    "id" SERIAL NOT NULL,
    "rutaArchivo" TEXT NOT NULL,
    "nombreArchivo" TEXT NOT NULL,
    "tipo" "TipoDocumentoContrato" NOT NULL DEFAULT 'ADJUNTO',
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "borradorId" INTEGER NOT NULL,
    "creadoPorId" INTEGER,

    CONSTRAINT "AdjuntoBorradorContrato_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BorradorContrato_inmobiliariaId_fechaActualizacion_idx"
  ON "BorradorContrato"("inmobiliariaId", "fechaActualizacion");
CREATE INDEX "BorradorContrato_creadoPorId_fechaActualizacion_idx"
  ON "BorradorContrato"("creadoPorId", "fechaActualizacion");
CREATE INDEX "BorradorContrato_actualizadoPorId_idx"
  ON "BorradorContrato"("actualizadoPorId");
CREATE INDEX "AdjuntoBorradorContrato_borradorId_tipo_idx"
  ON "AdjuntoBorradorContrato"("borradorId", "tipo");
CREATE INDEX "AdjuntoBorradorContrato_creadoPorId_idx"
  ON "AdjuntoBorradorContrato"("creadoPorId");

ALTER TABLE "BorradorContrato"
  ADD CONSTRAINT "BorradorContrato_inmobiliariaId_fkey"
  FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BorradorContrato"
  ADD CONSTRAINT "BorradorContrato_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BorradorContrato"
  ADD CONSTRAINT "BorradorContrato_actualizadoPorId_fkey"
  FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdjuntoBorradorContrato"
  ADD CONSTRAINT "AdjuntoBorradorContrato_borradorId_fkey"
  FOREIGN KEY ("borradorId") REFERENCES "BorradorContrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdjuntoBorradorContrato"
  ADD CONSTRAINT "AdjuntoBorradorContrato_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
