# Despliegue en Proxmox LXC

Este despliegue crea un contenedor Debian 13 no privilegiado dedicado a FinanceApp. PostgreSQL permanece en una instancia externa indicada durante la instalación; dentro del LXC se instalan la API, PWA, Nginx, Redis y el worker de documentos.

## Requisitos

- Proxmox VE con acceso a una plantilla Debian 13 y una red con DHCP.
- Una base y un rol dedicados existentes en PostgreSQL; sus nombres se solicitan durante la instalación.
- `pg_hba.conf` debe permitir el IP que recibirá el LXC, preferiblemente como `/32`.
- Repositorio público de GitHub que contenga este proyecto.
- Tailscale con MagicDNS y HTTPS habilitado en el tailnet.

El perfil predeterminado usa 2 CPU, 4 GiB de RAM, 512 MiB de swap y 12 GiB de disco. OCR/Docling no se instala inicialmente; puede activarse con `INSTALL_AI=yes` y al menos 9 GiB de RAM.

## Publicar el repositorio

Antes del primer despliegue, crea un repositorio público sin añadir `.env`, volcados, documentos ni contraseñas. La configuración de producción se genera directamente en `/etc/financeapp` dentro del LXC y nunca se obtiene de Git.

Desde la raíz del proyecto:

```sh
git init
git add .
git commit -m "Initial FinanceApp release"
git branch -M main
git remote add origin https://github.com/USUARIO/financeapp.git
git push -u origin main
```

Antes del commit, ejecuta `scripts/security-check.sh` y revisa el contenido staged con `git status`. `.gitignore` excluye secretos, `.env`, documentos cifrados, dumps, dependencias, builds y resultados de Playwright. Si usas `pre-commit`, instala el hook con `pre-commit install` para ejecutar Gitleaks en cada commit.

## Crear el LXC

Ejecuta esto en el shell del nodo Proxmox, sustituyendo la URL:

```sh
FINANCEAPP_REPO_URL=https://github.com/USUARIO/financeapp.git \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/USUARIO/financeapp/main/ops/proxmox/financeapp-lxc.sh)"
```

El instalador solicitará los recursos del contenedor y la contraseña del rol PostgreSQL. La contraseña solo se transporta mediante archivos temporales con permisos `0600`; no se incluye en argumentos de procesos ni en el repositorio.

Como no se configura una contraseña root del sistema, la consola de Proxmox
inicia sesión automáticamente como root, igual que los Community Scripts. Esto
solo afecta `container-getty` dentro de la consola: no habilita autenticación
root por contraseña mediante SSH. Puede desactivarse ejecutando el instalador
con `CONSOLE_AUTOLOGIN=no`; desde el shell del nodo, `pct enter ID` siempre
permite entrar administrativamente sin contraseña del guest.

Debian 13 usa systemd 257, por lo que el instalador habilita `nesting=1` y `keyctl=1` en el LXC no privilegiado. Proxmox advierte que `nesting` expone partes de `procfs` y `sysfs` del host al guest; por ese motivo el contenedor debe dedicarse exclusivamente a FinanceApp y no ejecutar código de terceros.

El instalador selecciona exclusivamente una plantilla que coincida con la
arquitectura del nodo (`amd64` o `arm64`). También impide reanudar un contenedor
de otra arquitectura, porque un rootfs ya extraído no se puede corregir con
`RESUME_EXISTING=yes`.

Al terminar, guarda el token inicial del propietario mostrado una sola vez.

Si una versión anterior del instalador alcanzó a crear el contenedor pero falló al iniciarlo por systemd 257, conserva el disco y reanuda así:

```sh
CTID=ID_EXISTENTE RESUME_EXISTING=yes \
FINANCEAPP_REPO_URL=https://github.com/USUARIO/financeapp.git \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/USUARIO/financeapp/main/ops/proxmox/financeapp-lxc.sh)"
```

Usa `RESUME_EXISTING=yes` únicamente con un LXC vacío creado por este instalador.
También puede usarse para continuar una instalación que se detuvo durante la
instalación de paquetes: las operaciones del instalador son repetibles y
conservan el mismo contenedor y disco. Al reanudar, cualquier fuente APT de
Tailscale dejada por una ejecución interrumpida se deshabilita durante el
bootstrap y se crea de nuevo con permisos compatibles con Debian 13.
El checkout existente también se actualiza mediante fast-forward como el usuario
`financeapp`; Git nunca necesita una excepción global `safe.directory` para un
repositorio propiedad de otro usuario.

Si LXC todavía no puede iniciar, el instalador imprime automáticamente la
salida completa de `pct start --debug`, la configuración generada, la versión y
arquitectura del host y el estado de `/dev/net/tun`. Conserva ese bloque
completo: `sync_wait` por sí solo es un error genérico y no identifica el mount,
hook, binario o permiso que falló.

## Activar acceso privado HTTPS

El Nginx del LXC escucha únicamente en `127.0.0.1:80`. Entra al contenedor y enlázalo a Tailscale:

```sh
pct enter ID_DEL_CONTENEDOR
tailscale up
financeapp-configure-tailscale
```

El último comando detecta el nombre MagicDNS, configura WebAuthn y publica `https://NODO.TAILNET.ts.net` mediante Tailscale Serve. No utiliza Funnel ni abre FinanceApp a Internet.

## Actualizaciones

Dentro del LXC:

```sh
financeapp-update --check
financeapp-update
```

El actualizador:

1. descarga el último commit de `main`;
2. crea y compila una release separada;
3. prueba la conexión PostgreSQL;
4. crea `/var/backups/financeapp/pre-update-*.dump`;
5. detiene API y worker;
6. ejecuta Alembic;
7. cambia `/opt/financeapp/current` de forma atómica;
8. inicia servicios y comprueba PostgreSQL y `/api/v1/health`.

También se puede desplegar un tag o commit concreto:

```sh
financeapp-update v0.2.0
financeapp-update 0123456789abcdef
```

Si el health check falla, el actualizador vuelve automáticamente a la release de aplicación anterior. Las migraciones de base no se revierten automáticamente. El respaldo previo queda indicado en la salida.

Rollback manual de la aplicación:

```sh
financeapp-update --rollback
```

## Operación

```sh
systemctl status financeapp-api financeapp-worker nginx redis-server
journalctl -u financeapp-api -u financeapp-worker -f
tailscale serve status
```

Archivos importantes:

- `/etc/financeapp/financeapp.env`: configuración de la aplicación, `0640`.
- `/etc/financeapp/postgres.env`: credenciales para backup y health checks, `0600`.
- `/etc/financeapp/deploy.conf`: repositorio, branch y retención.
- `/opt/financeapp/current`: release activa.
- `/opt/financeapp/previous`: release anterior.
- `/var/lib/financeapp/documents`: originales cifrados.
- `/var/backups/financeapp`: dumps anteriores a cada actualización.

Para cambiar la contraseña PostgreSQL, actualiza de manera consistente `DATABASE_URL` en `financeapp.env` y `PGPASSWORD` en `postgres.env`, prueba con `financeapp-update --check` y reinicia la API/worker.

## Respaldo completo

El dump previo a una actualización no sustituye el respaldo operativo. Incluye en restic:

- `/etc/financeapp`;
- `/var/lib/financeapp`;
- `/var/backups/financeapp`.

La clave `DOCUMENT_KEY_B64` es necesaria para recuperar documentos cifrados.
