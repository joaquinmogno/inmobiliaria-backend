ALTER TABLE "Contrato"
  ADD COLUMN "modalidadCobroInquilino" "MetodoPago",
  ADD COLUMN "modalidadPagoPropietario" "MetodoPago",
  ADD COLUMN "cuentaCobroAcordadaId" INTEGER;

CREATE INDEX "Contrato_cuentaCobroAcordadaId_idx" ON "Contrato"("cuentaCobroAcordadaId");
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_cuentaCobroAcordadaId_fkey"
  FOREIGN KEY ("cuentaCobroAcordadaId") REFERENCES "CuentaBancaria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ImputacionPagoCuota" (
  "id" SERIAL NOT NULL,
  "pagoId" INTEGER NOT NULL,
  "cuotaId" INTEGER NOT NULL,
  "monto" DECIMAL(10,2) NOT NULL,
  CONSTRAINT "ImputacionPagoCuota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImputacionPagoCuota_pagoId_cuotaId_key" ON "ImputacionPagoCuota"("pagoId", "cuotaId");
CREATE INDEX "ImputacionPagoCuota_cuotaId_idx" ON "ImputacionPagoCuota"("cuotaId");

ALTER TABLE "ImputacionPagoCuota" ADD CONSTRAINT "ImputacionPagoCuota_pagoId_fkey"
  FOREIGN KEY ("pagoId") REFERENCES "Pago"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImputacionPagoCuota" ADD CONSTRAINT "ImputacionPagoCuota_cuotaId_fkey"
  FOREIGN KEY ("cuotaId") REFERENCES "CuotaPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
