WITH last_installments AS (
  SELECT DISTINCT ON (cuota."planId")
    cuota."id",
    cuota."planId"
  FROM "CuotaPlan" AS cuota
  ORDER BY cuota."planId", cuota."numeroCuota" DESC
),
other_totals AS (
  SELECT
    cuota."planId",
    COALESCE(SUM(cuota."monto"), 0) AS "otherTotal"
  FROM "CuotaPlan" AS cuota
  INNER JOIN last_installments AS last
    ON last."planId" = cuota."planId"
   AND last."id" <> cuota."id"
  GROUP BY cuota."planId"
)
UPDATE "CuotaPlan" AS target
SET "monto" = plan."montoTotal" - COALESCE(other_totals."otherTotal", 0)
FROM last_installments
INNER JOIN "PlanCuotas" AS plan
  ON plan."id" = last_installments."planId"
LEFT JOIN other_totals
  ON other_totals."planId" = last_installments."planId"
WHERE target."id" = last_installments."id"
  AND target."estado" = 'PENDIENTE'
  AND target."liquidacionId" IS NULL
  AND target."movimientoId" IS NULL
  AND plan."montoTotal" - COALESCE(other_totals."otherTotal", 0) > 0
  AND target."monto" <> plan."montoTotal" - COALESCE(other_totals."otherTotal", 0);
