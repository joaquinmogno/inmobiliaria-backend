#!/bin/sh
set -e

APP_USER="${APP_USER:-node}"
UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
BACKUPS_DIR="${BACKUPS_DIR:-/app/backups}"
SEED_STATE_DIR="${SEED_STATE_DIR:-/app/.seed-data}"
PRISMA_ENGINES_CACHE_DIR="${PRISMA_ENGINES_CACHE_DIR:-/app/prisma-engines}"
APP_DIRS="$UPLOAD_DIR $BACKUPS_DIR $SEED_STATE_DIR $PRISMA_ENGINES_CACHE_DIR"

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su-exec "$APP_USER" "$@"
  else
    "$@"
  fi
}

if [ "$(id -u)" = "0" ]; then
  echo "Preparando permisos de volúmenes..."
  for dir in $APP_DIRS; do
    mkdir -p "$dir"
  done
  chown -R node:node $APP_DIRS
fi

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
run_as_node npx prisma migrate deploy

if [ "$RUN_DEMO_SEED" = "true" ] && [ ! -f "$SEED_STATE_DIR/.seed-completed" ]; then
  echo "Ejecutando seed demo..."
  run_as_node npx prisma db seed
  run_as_node sh -c "mkdir -p '$SEED_STATE_DIR' && touch '$SEED_STATE_DIR/.seed-completed'"
  echo "Seed demo completado."
else
  echo "Seed demo omitido."
fi

echo "Iniciando aplicación..."
if [ "$(id -u)" = "0" ]; then
  exec su-exec "$APP_USER" "$@"
else
  exec "$@"
fi
