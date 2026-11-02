CREATE TYPE "DestinatarioNotaLiquidacion" AS ENUM ('INQUILINO', 'PROPIETARIO', 'AMBOS');

ALTER TABLE "Liquidacion"
    ADD COLUMN "notaLiquidacion" TEXT,
    ADD COLUMN "destinatarioNotaLiquidacion" "DestinatarioNotaLiquidacion" NOT NULL DEFAULT 'AMBOS';
