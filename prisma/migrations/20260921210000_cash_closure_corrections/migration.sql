-- Las correcciones de sueldos son comprobantes independientes y conservan el
-- asiento original, incluso cuando su período ya se encuentra cerrado.
CREATE TYPE "TipoAjusteSueldo" AS ENUM ('PAGO_ADICIONAL', 'RECUPERO');

CREATE TABLE "AjustePagoSueldo" (
    "id" SERIAL NOT NULL,
    "pagoSueldoId" INTEGER NOT NULL,
    "tipo" "TipoAjusteSueldo" NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "moneda" "Moneda" NOT NULL,
    "fecha" DATE NOT NULL,
    "metodoPago" "MetodoPago" NOT NULL,
    "motivo" TEXT NOT NULL,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" INTEGER NOT NULL,
    "movimientoCajaId" INTEGER NOT NULL,

    CONSTRAINT "AjustePagoSueldo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AjustePagoSueldo_movimientoCajaId_key" ON "AjustePagoSueldo"("movimientoCajaId");
CREATE INDEX "AjustePagoSueldo_pagoSueldoId_fecha_idx" ON "AjustePagoSueldo"("pagoSueldoId", "fecha");
CREATE INDEX "AjustePagoSueldo_creadoPorId_idx" ON "AjustePagoSueldo"("creadoPorId");

ALTER TABLE "AjustePagoSueldo"
  ADD CONSTRAINT "AjustePagoSueldo_pagoSueldoId_fkey"
  FOREIGN KEY ("pagoSueldoId") REFERENCES "PagoSueldo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AjustePagoSueldo"
  ADD CONSTRAINT "AjustePagoSueldo_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AjustePagoSueldo"
  ADD CONSTRAINT "AjustePagoSueldo_movimientoCajaId_fkey"
  FOREIGN KEY ("movimientoCajaId") REFERENCES "MovimientoCaja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
