CREATE TABLE "AdjuntoMovimientoCaja" (
  "id" SERIAL NOT NULL,
  "rutaArchivo" TEXT NOT NULL,
  "nombreArchivo" VARCHAR(255) NOT NULL,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "movimientoCajaId" INTEGER NOT NULL,
  "creadoPorId" INTEGER,

  CONSTRAINT "AdjuntoMovimientoCaja_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdjuntoMovimientoCaja_movimientoCajaId_fechaCreacion_idx"
  ON "AdjuntoMovimientoCaja"("movimientoCajaId", "fechaCreacion");

CREATE INDEX "AdjuntoMovimientoCaja_creadoPorId_idx"
  ON "AdjuntoMovimientoCaja"("creadoPorId");

ALTER TABLE "AdjuntoMovimientoCaja"
  ADD CONSTRAINT "AdjuntoMovimientoCaja_movimientoCajaId_fkey"
  FOREIGN KEY ("movimientoCajaId") REFERENCES "MovimientoCaja"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdjuntoMovimientoCaja"
  ADD CONSTRAINT "AdjuntoMovimientoCaja_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
