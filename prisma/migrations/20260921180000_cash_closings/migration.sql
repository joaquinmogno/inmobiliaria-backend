CREATE TYPE "EstadoCierreCaja" AS ENUM ('CERRADO', 'REABIERTO');
CREATE TABLE "CierreCaja" (
 "id" SERIAL PRIMARY KEY, "periodo" DATE NOT NULL, "cuenta" "CuentaCaja" NOT NULL,
 "moneda" "Moneda" NOT NULL, "saldoSistema" DECIMAL(10,2) NOT NULL,
 "saldoDeclarado" DECIMAL(10,2) NOT NULL, "diferencia" DECIMAL(10,2) NOT NULL,
 "estado" "EstadoCierreCaja" NOT NULL DEFAULT 'CERRADO', "motivoDiferencia" TEXT,
 "cerradoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "cerradoPorId" INTEGER NOT NULL,
 "reabiertoEn" TIMESTAMP(3), "reabiertoPorId" INTEGER, "motivoReapertura" TEXT,
 "inmobiliariaId" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "CierreCaja_inmobiliariaId_periodo_cuenta_moneda_key" ON "CierreCaja"("inmobiliariaId","periodo","cuenta","moneda");
CREATE INDEX "CierreCaja_inmobiliariaId_periodo_estado_idx" ON "CierreCaja"("inmobiliariaId","periodo","estado");
ALTER TABLE "CierreCaja" ADD CONSTRAINT "CierreCaja_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE CASCADE;
ALTER TABLE "CierreCaja" ADD CONSTRAINT "CierreCaja_cerradoPorId_fkey" FOREIGN KEY ("cerradoPorId") REFERENCES "Usuario"("id");
ALTER TABLE "CierreCaja" ADD CONSTRAINT "CierreCaja_reabiertoPorId_fkey" FOREIGN KEY ("reabiertoPorId") REFERENCES "Usuario"("id");
