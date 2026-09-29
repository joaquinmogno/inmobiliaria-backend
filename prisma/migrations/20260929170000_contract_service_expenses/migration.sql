CREATE TYPE "ResponsableServicioGastoContrato" AS ENUM ('INQUILINO', 'PROPIETARIO');

CREATE TABLE "ServicioGastoContrato" (
    "id" SERIAL NOT NULL,
    "concepto" VARCHAR(120) NOT NULL,
    "responsable" "ResponsableServicioGastoContrato" NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "contratoId" INTEGER NOT NULL,

    CONSTRAINT "ServicioGastoContrato_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServicioGastoContrato_contratoId_orden_idx"
    ON "ServicioGastoContrato"("contratoId", "orden");

ALTER TABLE "ServicioGastoContrato"
    ADD CONSTRAINT "ServicioGastoContrato_contratoId_fkey"
    FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;
