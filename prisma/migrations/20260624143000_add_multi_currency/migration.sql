CREATE TYPE "Moneda" AS ENUM ('ARS', 'USD');

ALTER TABLE "Contrato" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "Liquidacion" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "Movimiento" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "Pago" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "MovimientoCaja" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "ActualizacionContrato" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "PlanCuotas" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "CuotaPlan" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
ALTER TABLE "PagoSueldo" ADD COLUMN "moneda" "Moneda" NOT NULL DEFAULT 'ARS';
