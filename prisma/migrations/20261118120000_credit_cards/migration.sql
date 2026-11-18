ALTER TYPE "MetodoPago" ADD VALUE 'TARJETA_CREDITO';
ALTER TYPE "CuentaCaja" ADD VALUE 'TARJETA';
CREATE TYPE "AmbitoTarjeta" AS ENUM ('CAJA', 'INTERNO', 'TEODORO', 'DANIEL');
CREATE TABLE "TarjetaCredito" (
 "id" SERIAL PRIMARY KEY,
 "inmobiliariaId" INTEGER NOT NULL REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "ambito" "AmbitoTarjeta" NOT NULL,
 "nombre" VARCHAR(80) NOT NULL,
 "banco" VARCHAR(80) NOT NULL,
 "ultimosCuatro" VARCHAR(4) NOT NULL CHECK ("ultimosCuatro" ~ '^[0-9]{4}$'),
 "activa" BOOLEAN NOT NULL DEFAULT true,
 "version" INTEGER NOT NULL DEFAULT 1,
 "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TarjetaCredito_id_inmobiliariaId_key" ON "TarjetaCredito"("id", "inmobiliariaId");
CREATE UNIQUE INDEX "TarjetaCredito_identidad_key" ON "TarjetaCredito"("inmobiliariaId", "ambito", "nombre", "banco", "ultimosCuatro");
CREATE INDEX "TarjetaCredito_inmobiliariaId_ambito_activa_idx" ON "TarjetaCredito"("inmobiliariaId", "ambito", "activa");

ALTER TABLE "MovimientoCaja" ADD COLUMN "tarjetaId" INTEGER, ADD COLUMN "tarjetaDescripcion" VARCHAR(200);
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_tarjetaId_inmobiliariaId_fkey" FOREIGN KEY ("tarjetaId", "inmobiliariaId") REFERENCES "TarjetaCredito"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MovimientoCaja_inmobiliariaId_tarjetaId_fecha_idx" ON "MovimientoCaja"("inmobiliariaId", "tarjetaId", "fecha");

ALTER TABLE "MovimientoInterno" ADD COLUMN "tarjetaId" INTEGER, ADD COLUMN "tarjetaDescripcion" VARCHAR(200);
ALTER TABLE "MovimientoInterno" ADD CONSTRAINT "MovimientoInterno_tarjetaId_inmobiliariaId_fkey" FOREIGN KEY ("tarjetaId", "inmobiliariaId") REFERENCES "TarjetaCredito"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MovimientoInterno_inmobiliariaId_tarjetaId_fecha_idx" ON "MovimientoInterno"("inmobiliariaId", "tarjetaId", "fecha");

ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_tarjeta_check" CHECK (
 ("metodoPago"::text = 'TARJETA_CREDITO' AND "cuenta"::text = 'TARJETA' AND "tarjetaId" IS NOT NULL AND "tarjetaDescripcion" IS NOT NULL AND "cuentaBancariaId" IS NULL)
 OR ("metodoPago"::text <> 'TARJETA_CREDITO' AND "cuenta"::text <> 'TARJETA' AND "tarjetaId" IS NULL)
);
