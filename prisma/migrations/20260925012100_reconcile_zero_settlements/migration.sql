-- Se ejecuta en una migración separada porque PostgreSQL no permite usar un
-- valor de enum recién creado dentro de la misma transacción que lo agregó.
-- Una obligación corregida completamente a cero no está cobrada/pagada: no
-- requiere acción. La reconciliación es idempotente y sólo cambia resúmenes.
WITH cobros_inquilino AS (
  SELECT "liquidacionId", COALESCE(SUM(monto), 0) AS total
  FROM "Pago"
  WHERE "anuladoEn" IS NULL
  GROUP BY "liquidacionId"
), creditos_aplicados AS (
  SELECT "liquidacionId", COALESCE(SUM(monto), 0) AS total
  FROM "AplicacionCreditoInquilino"
  GROUP BY "liquidacionId"
), pagos_propietario AS (
  SELECT "liquidacionId", COALESCE(SUM(monto), 0) AS total
  FROM "PagoPropietario"
  WHERE "anuladoEn" IS NULL
  GROUP BY "liquidacionId"
), estados AS (
  SELECT
    l.id,
    COALESCE(ci.total, 0) + COALESCE(ca.total, 0) AS "totalAplicadoInquilino",
    COALESCE(pp.total, 0) AS "totalPagadoPropietario",
    CASE
      WHEN l."netoACobrar" <= 0 THEN 'NO_APLICA'::"EstadoCobroInquilino"
      WHEN COALESCE(ci.total, 0) + COALESCE(ca.total, 0) <= 0 THEN 'PENDIENTE'::"EstadoCobroInquilino"
      WHEN COALESCE(ci.total, 0) + COALESCE(ca.total, 0) < l."netoACobrar" THEN 'PARCIAL'::"EstadoCobroInquilino"
      ELSE 'COBRADO'::"EstadoCobroInquilino"
    END AS "estadoCobro",
    CASE
      WHEN l."montoPropietario" <= 0 THEN 'NO_APLICA'::"EstadoPagoPropietario"
      WHEN COALESCE(pp.total, 0) <= 0 THEN 'PENDIENTE'::"EstadoPagoPropietario"
      WHEN COALESCE(pp.total, 0) < l."montoPropietario" THEN 'PARCIAL'::"EstadoPagoPropietario"
      ELSE 'PAGADO'::"EstadoPagoPropietario"
    END AS "estadoPago"
  FROM "Liquidacion" l
  LEFT JOIN cobros_inquilino ci ON ci."liquidacionId" = l.id
  LEFT JOIN creditos_aplicados ca ON ca."liquidacionId" = l.id
  LEFT JOIN pagos_propietario pp ON pp."liquidacionId" = l.id
)
UPDATE "Liquidacion" l
SET
  "estadoCobroInquilino" = e."estadoCobro",
  "estadoPagoPropietario" = e."estadoPago",
  "montoPagadoPropietario" = e."totalPagadoPropietario"
FROM estados e
WHERE l.id = e.id
  AND (
    l."estadoCobroInquilino" IS DISTINCT FROM e."estadoCobro"
    OR l."estadoPagoPropietario" IS DISTINCT FROM e."estadoPago"
    OR l."montoPagadoPropietario" IS DISTINCT FROM e."totalPagadoPropietario"
  );
