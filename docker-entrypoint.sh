#!/bin/sh
set -e

echo "Esperando a que la base de datos esté lista..."
sleep 5

echo "Ejecutando migraciones de Prisma..."
npx prisma migrate deploy

# Verificar si ya se ejecutó el seed
if [ ! -f /app/.seed-data/.seed-completed ]; then
  echo "Ejecutando seed inicial..."
  npx prisma db seed
  mkdir -p /app/.seed-data
  touch /app/.seed-data/.seed-completed
  echo "Seed completado."
else
  echo "Seed ya fue ejecutado anteriormente."
fi

echo "Iniciando aplicación..."
exec "$@"
