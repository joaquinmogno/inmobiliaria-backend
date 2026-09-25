-- Corregir contratos históricos cuyo estado no representa su vigencia real.
UPDATE "Contrato"
SET "estado" = 'FINALIZADO'
WHERE "estado" = 'ACTIVO'
  AND "fechaFin" < CURRENT_DATE;

UPDATE "Contrato"
SET "estado" = 'PROGRAMADO'
WHERE "estado" = 'ACTIVO'
  AND "fechaInicio" > CURRENT_DATE;

-- La ocupación se deriva exclusivamente de contratos vigentes.
UPDATE "Propiedad" p
SET "estado" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "Contrato" c
    WHERE c."propiedadId" = p."id"
      AND c."estado" = 'ACTIVO'
      AND c."fechaInicio" <= CURRENT_DATE
      AND c."fechaFin" >= CURRENT_DATE
  ) THEN 'ALQUILADO'::"EstadoPropiedad"
  ELSE 'DISPONIBLE'::"EstadoPropiedad"
END
WHERE p."estado" <> 'INACTIVO';
