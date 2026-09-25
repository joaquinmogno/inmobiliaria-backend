-- M-33: explicit account-holder acknowledgement for optional bank details.
ALTER TABLE "Persona"
  ADD COLUMN "titularCuentaBancaria" TEXT,
  ADD COLUMN "titularidadBancariaVerificada" BOOLEAN NOT NULL DEFAULT false;
