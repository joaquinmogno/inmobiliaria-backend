-- M-34: institutional and billing profile for the single real-estate agency.
CREATE TYPE "CondicionIva" AS ENUM ('NO_INFORMADO', 'RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'EXENTO', 'CONSUMIDOR_FINAL');

ALTER TABLE "Inmobiliaria"
  ADD COLUMN "razonSocial" TEXT,
  ADD COLUMN "cuit" TEXT,
  ADD COLUMN "domicilioFiscal" TEXT,
  ADD COLUMN "contactoAdministrativo" TEXT,
  ADD COLUMN "condicionIva" "CondicionIva" NOT NULL DEFAULT 'NO_INFORMADO',
  ADD COLUMN "ingresosBrutos" TEXT,
  ADD COLUMN "puntoVenta" INTEGER,
  ADD COLUMN "inicioActividades" DATE;
