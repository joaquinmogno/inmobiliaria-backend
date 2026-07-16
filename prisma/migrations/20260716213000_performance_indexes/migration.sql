CREATE INDEX "Persona_inmobiliariaId_nombreCompleto_idx" ON "Persona"("inmobiliariaId", "nombreCompleto");
CREATE INDEX "Propiedad_inmobiliariaId_direccion_idx" ON "Propiedad"("inmobiliariaId", "direccion");
CREATE INDEX "Contrato_inmobiliariaId_estado_fechaFin_idx" ON "Contrato"("inmobiliariaId", "estado", "fechaFin");
CREATE INDEX "Liquidacion_inmobiliariaId_periodo_idx" ON "Liquidacion"("inmobiliariaId", "periodo");
CREATE INDEX "Liquidacion_inmobiliariaId_estado_periodo_idx" ON "Liquidacion"("inmobiliariaId", "estado", "periodo");
CREATE INDEX "Pago_inmobiliariaId_fechaPago_idx" ON "Pago"("inmobiliariaId", "fechaPago");
CREATE INDEX "AuditLog_inmobiliariaId_fechaCreacion_idx" ON "AuditLog"("inmobiliariaId", "fechaCreacion");
CREATE INDEX "MovimientoCaja_inmobiliariaId_fecha_idx" ON "MovimientoCaja"("inmobiliariaId", "fecha");
CREATE INDEX "MovimientoCaja_inmobiliariaId_moneda_tipo_fecha_idx" ON "MovimientoCaja"("inmobiliariaId", "moneda", "tipo", "fecha");

CREATE INDEX "Persona_email_trgm_idx" ON "Persona" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "Persona_telefono_trgm_idx" ON "Persona" USING GIN ("telefono" gin_trgm_ops);
