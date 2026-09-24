-- El estado documental no representa más el circuito de cobro/pago. Se
-- conserva la liquidación y cada parte avanza con su propio saldo.
CREATE TYPE "EstadoLiquidacion_new" AS ENUM ('BORRADOR', 'CONFIRMADA', 'ANULADA');

ALTER TABLE "Liquidacion" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "Liquidacion"
  ALTER COLUMN "estado" TYPE "EstadoLiquidacion_new"
  USING (CASE
    WHEN "estado"::text = 'BORRADOR' THEN 'BORRADOR'::"EstadoLiquidacion_new"
    ELSE 'CONFIRMADA'::"EstadoLiquidacion_new"
  END);
DROP TYPE "EstadoLiquidacion";
ALTER TYPE "EstadoLiquidacion_new" RENAME TO "EstadoLiquidacion";
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" SET DEFAULT 'BORRADOR';

CREATE TYPE "EstadoCobroInquilino" AS ENUM ('PENDIENTE', 'PARCIAL', 'COBRADO');
CREATE TYPE "EstadoPagoPropietario" AS ENUM ('PENDIENTE', 'PARCIAL', 'PAGADO');
CREATE TYPE "OrigenPagoPropietario" AS ENUM ('FONDOS_COBRADOS', 'ADELANTO_PROPIO', 'MIXTO');

ALTER TABLE "Liquidacion"
  ADD COLUMN "estadoCobroInquilino" "EstadoCobroInquilino" NOT NULL DEFAULT 'PENDIENTE',
  ADD COLUMN "estadoPagoPropietario" "EstadoPagoPropietario" NOT NULL DEFAULT 'PENDIENTE';

CREATE TABLE "PagoPropietario" (
  "id" SERIAL NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "liquidacionId" INTEGER NOT NULL,
  "propietarioId" INTEGER NOT NULL,
  "inmobiliariaId" INTEGER NOT NULL,
  "monto" DECIMAL(10,2) NOT NULL,
  "moneda" "Moneda" NOT NULL,
  "fechaPago" DATE NOT NULL,
  "metodoPago" "MetodoPago" NOT NULL,
  "cuenta" "CuentaCaja" NOT NULL,
  "comprobante" VARCHAR(120),
  "observaciones" TEXT,
  "motivoAdelanto" TEXT,
  "origen" "OrigenPagoPropietario" NOT NULL DEFAULT 'FONDOS_COBRADOS',
  "montoFondosCobrados" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "montoAdelantoPropio" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPorId" INTEGER NOT NULL,
  "anuladoEn" TIMESTAMP(3),
  "anuladoPorId" INTEGER,
  "motivoAnulacion" TEXT,
  "movimientoCajaId" INTEGER,
  CONSTRAINT "PagoPropietario_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PagoPropietario_movimientoCajaId_key" ON "PagoPropietario"("movimientoCajaId");
CREATE INDEX "PagoPropietario_liquidacionId_anuladoEn_fechaPago_idx" ON "PagoPropietario"("liquidacionId", "anuladoEn", "fechaPago");
CREATE INDEX "PagoPropietario_inmobiliariaId_anuladoEn_fechaPago_idx" ON "PagoPropietario"("inmobiliariaId", "anuladoEn", "fechaPago");
CREATE INDEX "PagoPropietario_propietarioId_fechaPago_idx" ON "PagoPropietario"("propietarioId", "fechaPago");
CREATE INDEX "Liquidacion_inmobiliariaId_estadoCobroInquilino_periodo_idx" ON "Liquidacion"("inmobiliariaId", "estadoCobroInquilino", "periodo");
CREATE INDEX "Liquidacion_inmobiliariaId_estadoPagoPropietario_periodo_idx" ON "Liquidacion"("inmobiliariaId", "estadoPagoPropietario", "periodo");

ALTER TABLE "PagoPropietario"
  ADD CONSTRAINT "PagoPropietario_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PagoPropietario_propietarioId_fkey" FOREIGN KEY ("propietarioId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PagoPropietario_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PagoPropietario_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PagoPropietario_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PagoPropietario_movimientoCajaId_fkey" FOREIGN KEY ("movimientoCajaId") REFERENCES "MovimientoCaja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
