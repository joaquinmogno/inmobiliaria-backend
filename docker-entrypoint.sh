#!/bin/sh
set -e

echo "Esperando a que la base de datos esté lista..."
DB_HOST="${POSTGRES_HOST:-postgres}"
DB_PORT="${POSTGRES_PORT:-5432}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

if [ -n "$POSTGRES_HOST" ] && [ -n "$POSTGRES_USER" ]; then
  until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; do
    sleep 2
  done
else
  DATABASE_READY_URL="${DATABASE_URL%%\?*}"
  until pg_isready -d "$DATABASE_READY_URL" >/dev/null 2>&1; do
    sleep 2
  done
fi

if [ -n "$POSTGRES_DB" ] && [ -n "$POSTGRES_USER" ]; then
  if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q 1; then
    echo "Creando base de datos $POSTGRES_DB..."
    createdb -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB"
  fi
fi

echo "Ejecutando migraciones de Prisma..."
npx prisma migrate deploy

if [ "$RUN_DEMO_SEED" = "true" ] && [ ! -f /app/.seed-data/.seed-completed ]; then
  echo "Ejecutando seed demo..."
  npx prisma db seed
  mkdir -p /app/.seed-data
  touch /app/.seed-data/.seed-completed
  echo "Seed demo completado."
else
  echo "Seed demo omitido."
fi

echo "Iniciando aplicación..."
exec "$@"
