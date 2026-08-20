# Atajos de iOS

Primero crea un token con alcance mínimo mediante `POST /api/v1/admin/shortcut-tokens`, autenticándote como propietario y enviando `{"label":"iPhone personal"}`. Hazlo desde un cliente local dentro del tailnet y coloca el token del propietario en su campo seguro de autorización; no lo escribas en scripts, historial del shell o documentación.

El valor `token` se muestra una sola vez.

## Agregar gasto

1. Crea un Atajo llamado “Agregar gasto”.
2. Añade “Solicitar entrada” y permite texto o dictado.
3. Añade “Obtener contenido de URL”.
4. URL: `https://TU-HOST.TAILNET/api/v1/capture/text`.
5. Método: POST; cuerpo JSON: `{"text": Entrada proporcionada, "client": "shortcut"}`.
6. Encabezado: `Authorization` = `Bearer TU_TOKEN_DE_ATAJO`.
7. Muestra `review_url` en Vista rápida o abre esa URL.

Puedes activarlo desde Siri, el icono o Back Tap.

## Enviar a Finanzas

1. Crea un Atajo llamado “Enviar a Finanzas”.
2. Activa “Mostrar en hoja Compartir”.
3. Limita la entrada a archivos, PDFs e imágenes.
4. Añade “Obtener contenido de URL”.
5. URL: `https://TU-HOST.TAILNET/api/v1/capture/file`.
6. Método: POST; cuerpo Formulario; campo `document` = Entrada del Atajo.
7. Encabezado: `Authorization` = `Bearer TU_TOKEN_DE_ATAJO`.
8. Muestra el enlace de revisión devuelto.

No reutilices el token del propietario. Si pierdes el teléfono, revoca el token por su ID con `DELETE /api/v1/admin/shortcut-tokens/{id}`.
