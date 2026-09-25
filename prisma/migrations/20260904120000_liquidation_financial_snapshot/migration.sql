-- LIQ-001/003/005: cada liquidación conserva las condiciones económicas
-- aplicadas y expone un único neto canónico para el propietario.
ALTER TABLE "Liquidacion"
  ADD COLUMN "montoAlquilerBase" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "montoPropietario" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "pagaHonorarios" "PagadorHonorarios" NOT NULL DEFAULT 'INQUILINO';

UPDATE "Liquidacion" l
SET
  "montoAlquilerBase" = COALESCE((
    SELECT m.monto
    FROM "Movimiento" m
    WHERE m."liquidacionId" = l.id
      AND m.tipo = 'INGRESO'
      AND m.concepto = 'Alquiler Mensual'
    ORDER BY m.id ASC
    LIMIT 1
  ), 0),
  "pagaHonorarios" = c."pagaHonorarios"
FROM "Contrato" c
WHERE c.id = l."contratoId";

WITH totals AS (
  SELECT
    l.id,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'INGRESO'), 0) AS ingresos,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo <> 'INGRESO'), 0) AS descuentos,
    COALESCE(SUM(m.monto) FILTER (WHERE m.tipo <> 'INGRESO' AND m."esParaInmobiliaria" = false), 0) AS descuentos_inquilino,
    COALESCE(SUM(m.monto) FILTER (WHERE m."esParaInmobiliaria" = true), 0) AS conceptos_inmobiliaria
  FROM "Liquidacion" l
  LEFT JOIN "Movimiento" m ON m."liquidacionId" = l.id
  GROUP BY l.id
), calculated AS (
  SELECT
    l.id,
    t.ingresos,
    t.descuentos,
    t.ingresos - t.descuentos_inquilino
      + CASE WHEN l."pagaHonorarios" = 'INQUILINO' THEN l."montoHonorarios" ELSE 0 END AS total_inquilino,
    t.conceptos_inmobiliaria
  FROM "Liquidacion" l
  JOIN totals t ON t.id = l.id
)
UPDATE "Liquidacion" l
SET
  "totalIngresos" = c.ingresos,
  "totalDescuentos" = c.descuentos,
  -- Los borradores todavía pueden corregirse. En documentos confirmados se
  -- conserva el importe efectivamente comunicado/cobrado para no inventar
  -- deuda retroactiva al instalar esta mejora.
  "netoACobrar" = CASE
    WHEN l.estado = 'BORRADOR' THEN c.total_inquilino
    ELSE l."netoACobrar"
  END,
  "montoPropietario" = (
    CASE WHEN l.estado = 'BORRADOR' THEN c.total_inquilino ELSE l."netoACobrar" END
  ) - l."montoHonorarios" - c.conceptos_inmobiliaria
FROM calculated c
WHERE c.id = l.id;
