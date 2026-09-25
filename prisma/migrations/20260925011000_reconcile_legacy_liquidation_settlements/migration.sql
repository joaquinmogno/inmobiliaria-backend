-- Reconciliación de instalaciones que ya tenían cobranzas antes de separar
-- los ciclos de inquilino y propietario. La migración es idempotente: los
-- documentos de entrega se vinculan al asiento de caja con una clave única y
-- los resúmenes se recalculan siempre desde los registros vigentes.

-- 1. Convierte en PagoPropietario cada egreso histórico inequívoco. Sólo se
-- toma un asiento que ya estaba marcado/enlazado como pago al propietario;
-- nunca un gasto general de la liquidación. Los movimientos revertidos o
-- anulados no representan una entrega vigente.
WITH movimientos_candidatos AS (
  SELECT
    mc.id AS "movimientoCajaId",
    l.id AS "liquidacionId",
    l."inmobiliariaId",
    l."contratoId",
    mc.monto,
    mc.moneda,
    mc.fecha,
    mc."metodoPago",
    mc.cuenta,
    mc.comprobante,
    mc.observaciones,
    mc."fechaCreacion",
    COALESCE(l."propietarioPagoId", propietario_principal."personaId") AS "propietarioId",
    COALESCE(mc."creadoPorId", l."confirmadoPorId", l."cerradoPorId", l."creadoPorId", usuario_respaldo.id) AS "creadoPorId",
    COALESCE(
      SUM(mc.monto) OVER (
        PARTITION BY l.id
        ORDER BY mc.fecha, mc.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS "entregadoAntes",
    COALESCE((
      SELECT SUM(p.monto)
      FROM "Pago" p
      WHERE p."liquidacionId" = l.id
        AND p."anuladoEn" IS NULL
        AND p."fechaPago" <= mc.fecha
    ), 0) AS "cobradoHastaEntrega"
  FROM "MovimientoCaja" mc
  JOIN "Liquidacion" l ON l.id = mc."liquidacionId"
  LEFT JOIN LATERAL (
    SELECT cp."personaId"
    FROM "ContratoPropietario" cp
    WHERE cp."contratoId" = l."contratoId" AND cp."esPrincipal" = TRUE
    ORDER BY cp.id
    LIMIT 1
  ) propietario_principal ON TRUE
  LEFT JOIN LATERAL (
    SELECT u.id
    FROM "Usuario" u
    WHERE u."inmobiliariaId" = l."inmobiliariaId" AND u.activo = TRUE
    ORDER BY (u.tipo = 'ADMIN') DESC, u.id
    LIMIT 1
  ) usuario_respaldo ON TRUE
  WHERE mc.tipo = 'EGRESO'
    AND mc."reversionDeId" IS NULL
    AND mc."anuladoEn" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "MovimientoCaja" reverso
      WHERE reverso."reversionDeId" = mc.id
    )
    AND (mc."esPagoPropietario" = TRUE OR l."pagoPropietarioMovimientoId" = mc.id)
    AND NOT EXISTS (
      SELECT 1 FROM "PagoPropietario" pp
      WHERE pp."movimientoCajaId" = mc.id
    )
), entregas_reconstruidas AS (
  SELECT
    *,
    LEAST(
      monto,
      GREATEST(0::numeric, "cobradoHastaEntrega" - "entregadoAntes")
    ) AS "montoFondosCobrados"
  FROM movimientos_candidatos
  WHERE "propietarioId" IS NOT NULL AND "creadoPorId" IS NOT NULL
)
INSERT INTO "PagoPropietario" (
  "liquidacionId", "propietarioId", "inmobiliariaId", monto, moneda,
  "fechaPago", "metodoPago", cuenta, comprobante, observaciones,
  "motivoAdelanto", origen, "montoFondosCobrados", "montoAdelantoPropio",
  "fechaCreacion", "creadoPorId", "movimientoCajaId"
)
SELECT
  "liquidacionId",
  "propietarioId",
  "inmobiliariaId",
  monto,
  moneda,
  fecha,
  "metodoPago",
  cuenta,
  comprobante,
  COALESCE(observaciones, 'Entrega histórica reconciliada desde el asiento de caja #' || "movimientoCajaId"),
  CASE
    WHEN monto > "montoFondosCobrados" THEN 'Entrega histórica: el excedente se registra como adelanto propio reconciliado.'
    ELSE NULL
  END,
  CASE
    WHEN "montoFondosCobrados" = 0 THEN 'ADELANTO_PROPIO'::"OrigenPagoPropietario"
    WHEN "montoFondosCobrados" = monto THEN 'FONDOS_COBRADOS'::"OrigenPagoPropietario"
    ELSE 'MIXTO'::"OrigenPagoPropietario"
  END,
  "montoFondosCobrados",
  monto - "montoFondosCobrados",
  "fechaCreacion",
  "creadoPorId",
  "movimientoCajaId"
FROM entregas_reconstruidas
ON CONFLICT ("movimientoCajaId") DO NOTHING;

-- 2. El estado del inquilino surge de los cobros no anulados y de los créditos
-- aplicados. El pago al propietario surge exclusivamente de las entregas
-- vigentes recién reconstruidas o ya existentes. No se cambian importes de la
-- liquidación ni movimientos de caja.
WITH cobros_inquilino AS (
  SELECT p."liquidacionId", COALESCE(SUM(p.monto), 0) AS total
  FROM "Pago" p
  WHERE p."anuladoEn" IS NULL
  GROUP BY p."liquidacionId"
), creditos_aplicados AS (
  SELECT ac."liquidacionId", COALESCE(SUM(ac.monto), 0) AS total
  FROM "AplicacionCreditoInquilino" ac
  GROUP BY ac."liquidacionId"
), entregas_propietario AS (
  SELECT pp."liquidacionId", COALESCE(SUM(pp.monto), 0) AS total
  FROM "PagoPropietario" pp
  WHERE pp."anuladoEn" IS NULL
  GROUP BY pp."liquidacionId"
), reconciliado AS (
  SELECT
    l.id,
    COALESCE(ci.total, 0) + COALESCE(ca.total, 0) AS "totalAplicadoInquilino",
    COALESCE(ep.total, 0) AS "totalPagadoPropietario",
    CASE
      WHEN COALESCE(ci.total, 0) + COALESCE(ca.total, 0) <= 0 THEN 'PENDIENTE'::"EstadoCobroInquilino"
      WHEN COALESCE(ci.total, 0) + COALESCE(ca.total, 0) < l."netoACobrar" THEN 'PARCIAL'::"EstadoCobroInquilino"
      ELSE 'COBRADO'::"EstadoCobroInquilino"
    END AS "nuevoEstadoCobro",
    CASE
      WHEN COALESCE(ep.total, 0) <= 0 THEN 'PENDIENTE'::"EstadoPagoPropietario"
      WHEN COALESCE(ep.total, 0) < l."montoPropietario" THEN 'PARCIAL'::"EstadoPagoPropietario"
      ELSE 'PAGADO'::"EstadoPagoPropietario"
    END AS "nuevoEstadoPagoPropietario"
  FROM "Liquidacion" l
  LEFT JOIN cobros_inquilino ci ON ci."liquidacionId" = l.id
  LEFT JOIN creditos_aplicados ca ON ca."liquidacionId" = l.id
  LEFT JOIN entregas_propietario ep ON ep."liquidacionId" = l.id
)
UPDATE "Liquidacion" l
SET
  "estadoCobroInquilino" = r."nuevoEstadoCobro",
  "estadoPagoPropietario" = r."nuevoEstadoPagoPropietario",
  "montoPagadoPropietario" = r."totalPagadoPropietario"
FROM reconciliado r
WHERE l.id = r.id
  AND (
    l."estadoCobroInquilino" IS DISTINCT FROM r."nuevoEstadoCobro"
    OR l."estadoPagoPropietario" IS DISTINCT FROM r."nuevoEstadoPagoPropietario"
    OR l."montoPagadoPropietario" IS DISTINCT FROM r."totalPagadoPropietario"
  );
