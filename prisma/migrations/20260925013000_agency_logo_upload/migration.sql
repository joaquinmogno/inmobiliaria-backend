-- Archivo propio de la inmobiliaria para evitar depender de una URL externa.
-- `logoUrl` se conserva para instalaciones históricas hasta que carguen uno.
ALTER TABLE "Inmobiliaria"
  ADD COLUMN IF NOT EXISTS "logoArchivo" TEXT;
