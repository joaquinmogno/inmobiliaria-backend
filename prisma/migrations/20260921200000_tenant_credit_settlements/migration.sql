-- Créditos generados cuando una nota de crédito reduce una liquidación ya
-- cobrada. El crédito se devuelve por caja o se compensa una única vez contra
-- otra liquidación del mismo contrato.
CREATE TYPE "DestinoCreditoInquilino" AS ENUM ('DEVOLUCION', 'SALDO_A_FAVOR', 'COMPENSACION');
CREATE TYPE "EstadoCreditoInquilino" AS ENUM ('DISPONIBLE', 'APLICADO', 'DEVUELTO');

CREATE TABLE "CreditoInquilino" (
  "id" SERIAL NOT NULL,
  "liquidacionOrigenId" INTEGER NOT NULL,
  "ajusteLiquidacionId" INTEGER NOT NULL,
  "contratoId" INTEGER NOT NULL,
  "inmobiliariaId" INTEGER NOT NULL,
  "montoOriginal" DECIMAL(10,2) NOT NULL,
  "saldoPendiente" DECIMAL(10,2) NOT NULL,
  "moneda" "Moneda" NOT NULL,
  "destino" "DestinoCreditoInquilino" NOT NULL,
  "estado" "EstadoCreditoInquilino" NOT NULL DEFAULT 'DISPONIBLE',
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPorId" INTEGER NOT NULL,
  "movimientoDevolucionId" INTEGER,
  CONSTRAINT "CreditoInquilino_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AplicacionCreditoInquilino" (
  "id" SERIAL NOT NULL,
  "creditoInquilinoId" INTEGER NOT NULL,
  "liquidacionId" INTEGER NOT NULL,
  "monto" DECIMAL(10,2) NOT NULL,
  "fechaAplicacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPorId" INTEGER NOT NULL,
  CONSTRAINT "AplicacionCreditoInquilino_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditoInquilino_ajusteLiquidacionId_key" ON "CreditoInquilino"("ajusteLiquidacionId");
CREATE UNIQUE INDEX "CreditoInquilino_movimientoDevolucionId_key" ON "CreditoInquilino"("movimientoDevolucionId");
CREATE INDEX "CreditoInquilino_inmobiliariaId_estado_moneda_idx" ON "CreditoInquilino"("inmobiliariaId", "estado", "moneda");
CREATE INDEX "CreditoInquilino_contratoId_estado_moneda_idx" ON "CreditoInquilino"("contratoId", "estado", "moneda");
CREATE INDEX "CreditoInquilino_liquidacionOrigenId_idx" ON "CreditoInquilino"("liquidacionOrigenId");
CREATE UNIQUE INDEX "AplicacionCreditoInquilino_creditoInquilinoId_liquidacionId_key" ON "AplicacionCreditoInquilino"("creditoInquilinoId", "liquidacionId");
CREATE INDEX "AplicacionCreditoInquilino_liquidacionId_idx" ON "AplicacionCreditoInquilino"("liquidacionId");
CREATE INDEX "AplicacionCreditoInquilino_creadoPorId_idx" ON "AplicacionCreditoInquilino"("creadoPorId");

ALTER TABLE "CreditoInquilino"
  ADD CONSTRAINT "CreditoInquilino_liquidacionOrigenId_fkey" FOREIGN KEY ("liquidacionOrigenId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreditoInquilino_ajusteLiquidacionId_fkey" FOREIGN KEY ("ajusteLiquidacionId") REFERENCES "AjusteLiquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreditoInquilino_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreditoInquilino_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreditoInquilino_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CreditoInquilino_movimientoDevolucionId_fkey" FOREIGN KEY ("movimientoDevolucionId") REFERENCES "MovimientoCaja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AplicacionCreditoInquilino"
  ADD CONSTRAINT "AplicacionCreditoInquilino_creditoInquilinoId_fkey" FOREIGN KEY ("creditoInquilinoId") REFERENCES "CreditoInquilino"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AplicacionCreditoInquilino_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AplicacionCreditoInquilino_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
