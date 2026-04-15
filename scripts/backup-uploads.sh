#!/bin/sh
# Script para backup manual/automático de archivos subidos
BACKUPS_DIR="${BACKUPS_DIR:-/app/backups}"
BACKUP_DIR="$BACKUPS_DIR/uploads"
SOURCE_DIR="${UPLOAD_DIR:-/app/uploads}"
# Extraer solo el nombre de la carpeta origen para el comando tar
SOURCE_NAME=$(basename "$SOURCE_DIR")
SOURCE_PARENT=$(dirname "$SOURCE_DIR")
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
FILENAME="uploads-backup-$TIMESTAMP.tar.gz"

echo "Iniciando backup de archivos..."
echo "Configuración: BACKUP_DIR=$BACKUP_DIR, SOURCE_DIR=$SOURCE_DIR"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: La carpeta de origen $SOURCE_DIR no existe."
    exit 1
fi

mkdir -p "$BACKUP_DIR"
if [ ! -w "$BACKUP_DIR" ]; then
    echo "ERROR: No hay permisos de escritura en $BACKUP_DIR."
    exit 1
fi

# Comprimir la carpeta uploads
echo "Comprimiendo $SOURCE_NAME desde $SOURCE_PARENT..."
tar -czf "$BACKUP_DIR/$FILENAME" -C "$SOURCE_PARENT" "$SOURCE_NAME"

if [ $? -eq 0 ]; then
    echo "Backup completado exitosamente: $FILENAME"
    # Limpieza de backups viejos (más de 7 días)
    find "$BACKUP_DIR" -type f -name "uploads-backup-*.tar.gz" -mtime +7 -delete
else
    echo "ERROR: Falló la creación del archivo comprimido."
    exit 1
fi
