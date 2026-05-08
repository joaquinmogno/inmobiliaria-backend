#!/bin/sh
set -e

echo "Esperando a que la base de datos esté lista..."
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  sleep 2
done

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
