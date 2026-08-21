# Modelo de seguridad

## Límites de confianza

- La ruta recomendada publica la API mediante Tailscale Serve y HTTPS. El
  administrador puede habilitar explícitamente HTTP en la IPv4 de `eth0` para
  una LAN doméstica de confianza; esa excepción no debe reenviarse a Internet.
- PostgreSQL, Redis, workers y Ollama viven en una red interna de Docker sin puertos públicos.
- Los Atajos reciben tokens de escritura limitada; no pueden consultar saldos ni modificar movimientos.
- PDF, XML, CSV, imágenes y texto OCR son entrada hostil. No se ejecutan y no se convierten en instrucciones del modelo.

## Archivos

El servidor detecta ejecutables y formatos disfrazados, limita cada carga a 25 MiB y cada PDF a 250 páginas. El nombre se reduce a un basename seguro. El original se cifra con AES-256-GCM usando un nonce aleatorio y el hash SHA-256 como datos autenticados.

## Secretos

No confirmes `.env`. Guarda por separado:

- contraseña de PostgreSQL;
- token inicial del propietario;
- clave maestra de documentos;
- contraseña y repositorio de restic.

La pérdida de `DOCUMENT_KEY_B64` hace irrecuperables los originales cifrados. Inclúyela en un respaldo de secretos distinto del respaldo de datos.

## Acceso y sesiones

`MASTER_TOKEN` solo enlaza un dispositivo y entrega una sesión de acceso corta. Los refresh tokens se guardan como hash, rotan en cada uso y pueden revocarse por dispositivo. WebAuthn/passkeys permite entrar sin conservar el token maestro; los códigos de recuperación son de un solo uso y se muestran una sola vez.

Configura el RP ID y origen WebAuthn con el hostname HTTPS exacto de Tailscale. Mantén al menos una passkey y los códigos de recuperación en ubicaciones distintas antes de cerrar la sesión inicial.

## Verificación operativa pendiente

Antes de usar la aplicación como única copia, realiza una restauración completa desde restic y prueba el registro/autenticación passkey en cada navegador y dispositivo real. El servicio no debe publicarse fuera del tailnet.

## Proxmox LXC

El despliegue LXC es no privilegiado; PostgreSQL, Redis y la API interna
escuchan únicamente en loopback y Tailscale Serve termina HTTPS dentro del
tailnet. Nginx conserva loopback y puede añadir de forma explícita y reversible
un listener HTTP limitado a la IPv4 de `eth0`. La contraseña
PostgreSQL generada queda en `/etc/financeapp/postgres.env` con permisos `0600`,
mientras que el entorno de la API usa `0640`. Cada actualización y el timer
diario crean dumps verificados, pero estos no sustituyen un respaldo Proxmox o
restic fuera del contenedor.
