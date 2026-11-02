-- Referencia informativa e independiente de los asientos de caja o banco.
-- Los registros anteriores quedan sin cuenta, sin inferir información histórica.
ALTER TABLE "MovimientoInterno" ADD COLUMN "cuentaPago" VARCHAR(220);
