-- Un ajuste documenta importes independientes para inquilino y propietario.
-- El campo `monto` anterior se conserva como dato histórico, pero los nuevos
-- flujos no lo usan para calcular saldos ni emitir el detalle del comprobante.
ALTER TABLE "AjusteLiquidacion"
  ADD COLUMN IF NOT EXISTS "montoInquilino" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "montoPropietario" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Los ajustes existentes conservaron los impactos con signo. Se reconstruye
-- el importe documental de cada parte sin alterar ni la liquidación ni caja.
UPDATE "AjusteLiquidacion"
SET
  "montoInquilino" = ABS("impactoInquilino"),
  "montoPropietario" = ABS("impactoPropietario")
WHERE "montoInquilino" = 0
  AND "montoPropietario" = 0
  AND ("impactoInquilino" <> 0 OR "impactoPropietario" <> 0);

ALTER TYPE "EstadoCobroInquilino" ADD VALUE IF NOT EXISTS 'NO_APLICA';
ALTER TYPE "EstadoPagoPropietario" ADD VALUE IF NOT EXISTS 'NO_APLICA';
