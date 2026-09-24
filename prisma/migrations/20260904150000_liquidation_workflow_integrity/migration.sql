-- LIQ-007/012/014: trazabilidad del pago al propietario y vencimiento mensual.
ALTER TABLE "Liquidacion"
  ADD COLUMN "fechaVencimiento" DATE,
  ADD COLUMN "propietarioPagoId" INTEGER,
  ADD COLUMN "pagoPropietarioMovimientoId" INTEGER;

-- Calcula el vencimiento histórico respetando meses cortos.
UPDATE "Liquidacion" l
SET "fechaVencimiento" = make_date(
  EXTRACT(YEAR FROM l."periodo")::INTEGER,
  EXTRACT(MONTH FROM l."periodo")::INTEGER,
  LEAST(
    GREATEST(c."diaVencimiento", 1),
    EXTRACT(DAY FROM (
      date_trunc('month', l."periodo") + interval '1 month - 1 day'
    ))::INTEGER
  )
)
FROM "Contrato" c
WHERE c.id = l."contratoId";

-- En registros históricos, vincula el egreso inequívoco cuando existe uno solo.
WITH candidatos AS (
  SELECT mc."liquidacionId", MIN(mc.id) AS id
  FROM "MovimientoCaja" mc
  JOIN "Liquidacion" l ON l.id = mc."liquidacionId"
  WHERE mc.tipo = 'EGRESO'
    AND mc."reversionDeId" IS NULL
    AND mc."anuladoEn" IS NULL
    AND l.estado = 'LIQUIDADA'
  GROUP BY mc."liquidacionId"
  HAVING COUNT(*) = 1
)
UPDATE "Liquidacion" l
SET "pagoPropietarioMovimientoId" = c.id
FROM candidatos c
WHERE c."liquidacionId" = l.id;

-- Conserva como destinatario al propietario principal vigente para históricos.
UPDATE "Liquidacion" l
SET "propietarioPagoId" = cp."personaId"
FROM "ContratoPropietario" cp
WHERE cp."contratoId" = l."contratoId"
  AND cp."esPrincipal" = TRUE
  AND l."fechaPagoPropietario" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ContratoPropietario" otro
    WHERE otro."contratoId" = cp."contratoId"
      AND otro."esPrincipal" = TRUE
      AND otro.id <> cp.id
  );

CREATE UNIQUE INDEX "Liquidacion_pagoPropietarioMovimientoId_key"
  ON "Liquidacion"("pagoPropietarioMovimientoId");
CREATE INDEX "Liquidacion_propietarioPagoId_idx"
  ON "Liquidacion"("propietarioPagoId");

ALTER TABLE "Liquidacion"
  ADD CONSTRAINT "Liquidacion_propietarioPagoId_fkey"
    FOREIGN KEY ("propietarioPagoId") REFERENCES "Persona"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Liquidacion_pagoPropietarioMovimientoId_fkey"
    FOREIGN KEY ("pagoPropietarioMovimientoId") REFERENCES "MovimientoCaja"(id) ON DELETE SET NULL ON UPDATE CASCADE;

-- LIQ-013: separa las capacidades operativas sensibles.
INSERT INTO "Permiso" ("clave", "descripcion", "modulo", "accion") VALUES
  ('liquidaciones.confirmar', 'Confirmar liquidaciones', 'Liquidaciones', 'confirmar'),
  ('liquidaciones.pagar_propietario', 'Registrar pagos a propietarios', 'Liquidaciones', 'pagar_propietario'),
  ('liquidaciones.anular_pago_propietario', 'Anular pagos a propietarios', 'Liquidaciones', 'anular_pago_propietario')
ON CONFLICT ("clave") DO UPDATE SET
  "descripcion" = EXCLUDED."descripcion",
  "modulo" = EXCLUDED."modulo",
  "accion" = EXCLUDED."accion";

-- Mantiene las capacidades de los roles que antes recibían todo mediante editar.
INSERT INTO "RolPermiso" ("rolId", "permisoId")
SELECT rp."rolId", nuevo.id
FROM "RolPermiso" rp
JOIN "Permiso" anterior ON anterior.id = rp."permisoId" AND anterior."clave" = 'liquidaciones.editar'
CROSS JOIN "Permiso" nuevo
WHERE nuevo."clave" IN (
  'liquidaciones.confirmar',
  'liquidaciones.pagar_propietario',
  'liquidaciones.anular_pago_propietario'
)
ON CONFLICT ("rolId", "permisoId") DO NOTHING;
