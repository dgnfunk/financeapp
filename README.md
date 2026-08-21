# Finanzas personales privadas

PWA móvil y panel de escritorio self-hosted para una sola persona. La interfaz sigue la dirección visual aprobada: captura conversacional, lectura rápida del día y revisión antes de contabilizar.

## Estado actual

Esta entrega deja un MVP ejecutable con:

- PWA instalable, manifest, service worker, iconos y borradores de texto cifrados en el dispositivo.
- Inicio, movimientos, presupuesto, proyección y chat en una misma interfaz responsive.
- Panel desktop para administración y auditoría desde 1024 px, con navegación lateral, KPIs reconciliados, filtros, gráficas de flujo/presupuesto/proyección, cuentas, tablas, revisión de importaciones, bitácora y estado de seguridad.
- Captura de texto y archivos con revisión previa.
- API FastAPI con CRUD de cuentas, libro mayor de doble partida, transferencias, divisiones, presupuestos con rollover, recurrencias, metas, FX manual, escenarios, importaciones, analítica, chat y auditoría.
- Parser determinista de XML CFDI y CSV; extracción de texto de PDF; OCR local opcional con RapidOCR.
- Documentos originales cifrados con AES-256-GCM y deduplicación por SHA-256.
- Tokens independientes y revocables para Atajos de iOS, limitados a `capture:create`.
- PostgreSQL, migraciones Alembic, Redis, worker serial, Ollama opcional y
  publicación HTTPS mediante Tailscale Serve; Nginx puede habilitar de forma
  explícita un listener HTTP limitado a la IPv4 doméstica de `eth0`.
- Passkeys WebAuthn, códigos de recuperación, sesiones cortas, refresh rotatorio y revocación por dispositivo.
- Pruebas unitarias y de API del libro mayor, archivos, CFDI/CSV, cuentas, presupuesto, sesiones y proyecciones.

El `MASTER_TOKEN` se usa únicamente para enlazar el primer dispositivo. Después se puede registrar una passkey desde Ajustes. Debe mantenerse fuera del navegador y únicamente dentro del tailnet.

## Arranque local

Requisitos: Docker Compose, Tailscale en el host y al menos 4 GB de RAM para el perfil base.

```sh
cp .env.example .env
openssl rand -base64 32
openssl rand -hex 32
```

Guarda el primer valor en `DOCUMENT_KEY_B64`, el segundo en `MASTER_TOKEN` y define una contraseña distinta para PostgreSQL.
Configura también `WEBAUTHN_RP_ID` con el hostname de Tailscale (sin `https://`) y `WEBAUTHN_ORIGIN` con el origen HTTPS completo.

Perfil base, sin modelo local:

```sh
docker compose --profile core up -d --build
```

Perfil con OCR y Ollama:

```sh
docker compose --profile ai up -d --build
docker compose --profile ai exec ollama ollama pull qwen3:4b-q4_K_M
```

La aplicación solo escucha en `127.0.0.1:8080`. Publícala dentro del tailnet:

```sh
./ops/tailscale-serve.sh
```

Después abre la URL HTTPS que muestre Tailscale y, en Safari del iPhone, usa Compartir → Añadir a pantalla de inicio.

## Desarrollo

Frontend:

```sh
cd web
npm ci
npm run dev -- --host 0.0.0.0 --port 4173
```

API y pruebas:

```sh
cd server
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
.venv/bin/ruff check app tests
```

## Seguridad

- No expongas el puerto 8080 al router ni a una interfaz pública.
- Conserva `DOCUMENT_KEY_B64` fuera del repositorio y dentro del respaldo de secretos.
- Crea un token distinto por Atajo y revócalo si el teléfono se pierde.
- Los archivos se validan por contenido, no solo por extensión.
- El texto extraído se marca como no confiable y nunca se usa como instrucción para el modelo.
- Las escrituras del chat son propuestas; no hay herramientas de borrado, restauración ni manejo de claves.
- Web Push permanece fuera del perfil inicial y nunca debe incluir cantidades.

## Alcance verificado y pendientes operativos

La aplicación ya no utiliza movimientos, presupuestos o gráficas demostrativas en producción. Las inversiones se registran por saldo y ajustes manuales; no se consultan precios de mercado. Antes de depender de ella como única copia, ejecuta una restauración de prueba con tu repositorio restic y valida la ceremonia passkey en tus dispositivos reales y en el dominio HTTPS definitivo.

Consulta [SECURITY.md](./SECURITY.md), [Atajos de iOS](./docs/ios-shortcuts.md) y [restauración](./docs/restore.md).

## Proxmox LXC

Para una instalación dedicada y actualizable en Proxmox, usa el instalador Debian 13 de [`ops/proxmox/financeapp-lxc.sh`](./ops/proxmox/financeapp-lxc.sh). Cada LXC ejecuta PostgreSQL 17 local, PWA, API, Redis y worker sin depender de otra instancia de base de datos.

El comando `financeapp-update` obtiene el último commit o una versión concreta, construye una release paralela, crea un dump PostgreSQL, ejecuta Alembic, cambia la release activa y realiza un health check. Consulta la [guía completa de Proxmox](./docs/proxmox-lxc.md).

Para acceso opcional por IP dentro de una LAN doméstica confiable, ejecuta
`financeapp-configure-lan enable`. Solo Nginx abre TCP 80 en la IPv4 de `eth0`;
PostgreSQL, Redis y la API interna permanecen en loopback. No reenvíes ese
puerto en el router y conserva Tailscale HTTPS para passkeys y la PWA completa.

Antes de publicar o hacer push, ejecuta `scripts/security-check.sh`. Revisa el árbol con Gitleaks, rechaza IPs privadas, rutas personales y archivos sensibles, y también inspecciona el historial cuando ya exista un repositorio Git.

## Estructura

- `web/`: PWA responsive y panel administrativo de escritorio.
- `server/`: API, modelos financieros, procesamiento y pruebas.
- `compose.yaml`: servicios privados y perfiles `core` / `ai`.
- `ops/`: publicación por Tailscale y respaldo con restic.
- `docs/`: procedimientos operativos.
