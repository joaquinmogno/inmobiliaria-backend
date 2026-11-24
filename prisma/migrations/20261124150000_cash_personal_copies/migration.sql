ALTER TABLE "MovimientoInterno" ADD COLUMN "movimientoCajaOrigenId" INTEGER;

CREATE UNIQUE INDEX "MovimientoCaja_id_inmobiliariaId_key" ON "MovimientoCaja"("id", "inmobiliariaId");
CREATE UNIQUE INDEX "MovimientoInterno_movimientoCajaOrigenId_ambito_key" ON "MovimientoInterno"("movimientoCajaOrigenId", "ambito");

ALTER TABLE "MovimientoInterno" ADD CONSTRAINT "MovimientoInterno_movimientoCajaOrigenId_inmobiliariaId_fkey"
FOREIGN KEY ("movimientoCajaOrigenId", "inmobiliariaId") REFERENCES "MovimientoCaja"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;
