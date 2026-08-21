# Despliegue en Proxmox LXC

Este despliegue crea un contenedor Debian 13 no privilegiado y autocontenido para
FinanceApp. Dentro del LXC se instalan PostgreSQL 17, API, PWA, Nginx, Redis y
el worker de documentos. PostgreSQL escucha exclusivamente en loopback.

## Requisitos

- Proxmox VE con acceso a una plantilla Debian 13.
- Repositorio público de GitHub que contenga este proyecto.
- Tailscale con MagicDNS y HTTPS habilitado en el tailnet.

El perfil predeterminado usa 2 CPU, 4 GiB de RAM, 512 MiB de swap y 12 GiB de disco. OCR/Docling no se instala inicialmente; puede activarse con `INSTALL_AI=yes` y al menos 9 GiB de RAM.
El instalador rechaza anticipadamente menos de 1.8 GiB de RAM para el perfil
base, menos de 8.7 GiB para AI o menos de 2 GiB libres.

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

El instalador solo solicita recursos del contenedor. Crea automáticamente la
base `financeapp`, el rol `financeapp_app` y una contraseña aleatoria. Esas
credenciales permanecen dentro del LXC en archivos `0600/0640`; no aparecen en
la terminal, los argumentos de procesos ni el repositorio. Pueden cambiarse los
nombres con `POSTGRES_DB` y `POSTGRES_USER` antes de la primera instalación.

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
Los builds de Node se ejecutan con una ruta explícita y mínima que incluye
`/usr/local/bin`, independientemente del `PATH` que Debian asigne a `runuser`.
Cada release conserva checkpoints verificados para el entorno Python, las
dependencias web y el build PWA. Si una etapa posterior falla, el siguiente
intento reutiliza esas etapas para el mismo commit en lugar de descargarlas y
compilarlas nuevamente. Las descargas pip y npm también usan caches persistentes
en `/opt/financeapp/shared`, por lo que una release nueva puede reutilizar
paquetes aunque su commit sea distinto.

Mientras una instalación no finalice, `/root/financeapp-install.env` permanece
dentro del LXC con modo `0600`. Una reanudación lo reutiliza por defecto y omite
la regeneración de claves. Para descartarlo de
forma explícita puede usarse `REUSE_SAVED_CONFIG=no`. El archivo se elimina
automáticamente únicamente después de una instalación exitosa.
El repositorio y la rama guardados deben coincidir con el instalador usado para
reanudar; una discrepancia se rechaza antes de continuar.

El instalador también recupera CT 106 y otras instalaciones afectadas por el
antiguo falso positivo: si el archivo temporal ya no existe, conserva
`MASTER_TOKEN` y `DOCUMENT_KEY_B64` desde `/etc/financeapp`, genera credenciales
para una base PostgreSQL local nueva y no vuelve a contactar la base externa.

PostgreSQL se administra mediante la unidad concreta
`postgresql@17-main.service`; la unidad genérica `postgresql.service` no basta
para confirmar que el clúster esté ejecutándose. Si el clúster no inicia, el
instalador muestra automáticamente `pg_lsclusters` y su journal. También puede
consultarse manualmente con:

```sh
systemctl status postgresql@17-main.service --no-pager
pg_lsclusters
journalctl -u postgresql@17-main.service --no-pager -n 100
```

Cada reanudación normaliza a una sola entrada exacta
`listen_addresses = '127.0.0.1'` y
`password_encryption = 'scram-sha-256'`, eliminando variantes inválidas
anteriores. Después hace que el propio servidor analice ambos valores antes de
arrancar.

El build PWA es obligatorio porque Git conserva el código React/TypeScript y
excluye `dist/`; Nginx necesita los assets de producción generados en
`web/dist/client`. El instalador valida que `index.html` exista antes de marcar
esa etapa como completa.

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
Si se instala con `ENABLE_TAILSCALE=no`, Nginx continúa escuchando únicamente en
loopback: el script no expone automáticamente un puerto inseguro en la LAN.

## Actualizaciones

Dentro del LXC:

```sh
financeapp-update --check
financeapp-update
```

El actualizador:

1. descarga el último commit de `main`;
2. crea y compila una release separada;
3. comprueba que servidor, `psql`, `pg_dump` y `pg_restore` pertenecen a
   PostgreSQL 17;
4. crea `/var/backups/financeapp/pre-update-*.dump`;
5. detiene API y worker;
6. ejecuta Alembic;
7. cambia `/opt/financeapp/current` de forma atómica;
8. inicia servicios y comprueba PostgreSQL, Redis, Nginx, API, worker y
   `/api/v1/health`;
9. instala los comandos administrativos de la nueva release solo después de
   superar esas comprobaciones;
10. conserva un historial acotado de releases y los siete dumps más recientes.

También se puede desplegar un tag o commit concreto:

```sh
financeapp-update v0.2.0
financeapp-update 0123456789abcdef
financeapp-update --force
```

`--force` reconstruye el mismo commit en una release paralela; no modifica en
sitio los archivos que están atendiendo solicitudes.

Si el health check falla, el actualizador vuelve automáticamente a la release de aplicación anterior. Las migraciones de base no se revierten automáticamente. El respaldo previo queda indicado en la salida.

Rollback manual de la aplicación:

```sh
financeapp-update --rollback
```

## Operación

```sh
systemctl status postgresql@17-main financeapp-api financeapp-worker nginx redis-server
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
- `/var/lib/postgresql`: datos del servidor PostgreSQL local.
- `/var/backups/financeapp`: dumps de actualización y backups diarios.

Los dumps y sus directorios pertenecen exclusivamente a `root` (`0600/0700`);
el usuario que ejecuta la API no puede leerlos ni sustituirlos.

Antes de compilar, el actualizador exige espacio para el piso configurado más el
tamaño actual de PostgreSQL. Los valores `KEEP_RELEASES`, `KEEP_BACKUPS` y
`MIN_FREE_DISK_MB` se pueden ajustar en `/etc/financeapp/deploy.conf`.

`financeapp-backup` crea manualmente un dump verificado. El timer
`financeapp-backup.timer` lo ejecuta diariamente y conserva los siete más
recientes:

```sh
systemctl list-timers financeapp-backup.timer
financeapp-backup
```

## Respaldo completo

El dump previo a una actualización no sustituye el respaldo operativo. Incluye en restic:

- `/etc/financeapp`;
- `/var/lib/financeapp`;
- `/var/lib/postgresql`;
- `/var/backups/financeapp`.

La clave `DOCUMENT_KEY_B64` es necesaria para recuperar documentos cifrados.
