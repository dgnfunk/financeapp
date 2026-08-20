# Respaldo y restauración

## Respaldo

Configura `RESTIC_REPOSITORY` y `RESTIC_PASSWORD_FILE`, verifica que el repositorio esté inicializado y ejecuta `ops/restic/backup.sh` diariamente desde cron o systemd. Conserva una copia adicional de `.env` en un gestor de secretos.

## Restauración de prueba

1. Detén `api` y `worker`.
2. Restaura el dump de PostgreSQL y el volumen de documentos en un directorio temporal.
3. Verifica que `DOCUMENT_KEY_B64` corresponda a los archivos restaurados.
4. Restaura PostgreSQL con `pg_restore --clean --if-exists` dentro de una base vacía.
5. Copia los documentos cifrados al volumen `encrypted-documents`.
6. Inicia solo el perfil `core` y comprueba `/api/v1/health`, cuentas, movimientos e importaciones.
7. Prueba descifrar un documento desde el worker antes de considerar válida la restauración.

Nunca pruebes una restauración destructiva sobre el único entorno con datos reales.

