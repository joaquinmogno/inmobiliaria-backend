-- Correcciones inmutables de liquidaciones y pagos parciales al propietario.
CREATE TYPE "TipoAjusteLiquidacion" AS ENUM ('CREDITO', 'DEBITO');

ALTER TABLE "Liquidacion"
  ADD COLUMN "montoPagadoPropietario" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "MovimientoCaja"
  ADD COLUMN "esPagoPropietario" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AjusteLiquidacion" (
  "id" SERIAL NOT NULL,
  "liquidacionId" INTEGER NOT NULL,
  "tipo" "TipoAjusteLiquidacion" NOT NULL,
  "concepto" VARCHAR(255) NOT NULL,
  "motivo" TEXT NOT NULL,
  "monto" DECIMAL(10,2) NOT NULL,
  "moneda" "Moneda" NOT NULL,
  "impactoInquilino" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "impactoPropietario" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPorId" INTEGER NOT NULL,
  CONSTRAINT "AjusteLiquidacion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AjusteLiquidacion_liquidacionId_fechaCreacion_idx"
  ON "AjusteLiquidacion"("liquidacionId", "fechaCreacion");
ALTER TABLE "AjusteLiquidacion" ADD CONSTRAINT "AjusteLiquidacion_liquidacionId_fkey"
  FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AjusteLiquidacion" ADD CONSTRAINT "AjusteLiquidacion_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
