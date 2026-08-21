# Finanzas personales privadas — especificación viva

## 1. Resumen del proyecto

Aplicación personal, self-hosted y de un solo usuario para registrar, importar, presupuestar y proyectar finanzas desde una PWA móvil o un panel administrativo de escritorio. Los datos, documentos, OCR y chat permanecen en el equipo del propietario y la aplicación solo se publica mediante Tailscale Serve.

## 2. Objetivos

- Reducir la fricción de captura mediante texto, archivos, cámara y Atajos de iOS.
- Mantener un libro mayor de doble partida como fuente única de saldos.
- Administrar cuentas, tarjetas, deuda e inversiones con valuación manual.
- Crear presupuestos mensuales con rollover y proyecciones de 3, 6 y 12 meses.
- Ofrecer análisis reconciliado, revisión de importaciones y chat local con confirmación de escrituras.
- Proteger el acceso con passkeys, sesiones revocables, cifrado y auditoría.

## 3. Restricciones

- Next.js/TypeScript fue sustituido en el prototipo existente por React/Vite/TypeScript; se conserva esa base para no reemplazar el runtime móvil aprobado.
- FastAPI, PostgreSQL, Redis, workers seriales, Docling/RapidOCR opcionales y Ollama local.
- MXN es la moneda base; USD usa tipos de cambio manuales con fecha.
- Un usuario, una instalación y ningún servicio externo salvo Tailscale optativo.
- Los documentos originales se cifran con AES-256-GCM.
- Todos los importes usan `Decimal`/`NUMERIC`; no se usan números flotantes para contabilidad.

## 4. Fuera de alcance

- Sincronización bancaria, precios de mercado, posiciones de inversión, fiscalidad, colaboración familiar y multimoneda avanzada.
- Telegram, WhatsApp, App Store y proveedores externos de IA.

## 5. Hitos

1. **Especificación y conexión real:** cliente API tipado, estados reales y fixtures solo en desarrollo.
2. **Cuentas y movimientos:** CRUD/archivo, crédito, inversión manual, transferencias, divisiones y conciliación.
3. **Presupuestos:** CRUD mensual, copia, rollover, ejecución y alertas.
4. **Proyección:** recurrencias, metas, deuda y escenarios persistentes a 3/6/12 meses.
5. **Analítica, importación y chat:** agregados reales, revisión editable y herramientas tipadas.
6. **Seguridad y operación:** passkeys, recuperación, sesiones rotatorias, sincronización offline y restauración.

## 6. Requisitos verificables

### Cuentas y libro mayor

- Tipos visibles: efectivo, débito, ahorro, crédito, deuda e inversión manual.
- Las cuentas con movimientos se archivan; no se eliminan.
- Crédito conserva límite, corte y vencimiento; inversión acepta ajustes de valuación auditables.
- Saldos, utilización, patrimonio y analítica se derivan de postings balanceados.
- Transferencias y divisiones deben mantener suma cero por moneda.

### Presupuestos y proyección

- Un presupuesto es único por mes y categoría, puede copiarse y aplicar rollover positivo.
- Usado y disponible cambian al confirmar o reclasificar un movimiento.
- Las proyecciones combinan saldos, recurrencias confirmadas, presupuestos, deuda, metas y ajustes del escenario.
- Escenarios soportados: base, conservador y personalizado persistente.

### Seguridad y operación

- Mutaciones aceptan `Idempotency-Key` y generan auditoría.
- El chat no elimina, restaura ni administra seguridad o claves.
- Los borradores offline se cifran y se reintentan al recuperar conexión.
- Ningún texto financiero sensible aparece en Web Push.

## 7. Criterios de aceptación

- Crear cuentas de débito, crédito e inversión en móvil y escritorio y conservarlas tras recargar.
- Registrar gasto, ingreso, transferencia, pago de tarjeta, división y valuación sin romper doble partida.
- Crear/copiar un presupuesto y observar ejecución y rollover desde movimientos confirmados.
- Confirmar una recurrencia y verla reflejada en horizontes de 3, 6 y 12 meses.
- Todas las tarjetas, gráficas y tablas deben reconciliar con la API y mostrar fuente/fecha.
- Importar dos veces el mismo documento no duplica el archivo ni sus movimientos.
- Passkey, recuperación, revocación, offline y restauración tienen pruebas o procedimiento verificable.

## 8. Estrategia de verificación

- Pruebas unitarias para libro mayor, rollover, recurrencias, FX y proyección.
- Pruebas API con base aislada para CRUD, idempotencia, permisos y agregados.
- Pruebas de migración Alembic desde el esquema inicial.
- Flujos Playwright a 390, 1024 y 1440 px.
- Build de producción, comprobación del runtime móvil y restauración documentada.

## 9. Estado al inicio de esta implementación

| Área | Estado | Evidencia inicial |
|---|---|---|
| Captura móvil | Parcialmente implementado | `web/src/Prototype.tsx` llama únicamente a `/capture/*`. |
| Cuentas | Parcialmente implementado | Alta/listado básico en `server/app/main.py`; escritorio usa fixtures. |
| Presupuestos | Parcialmente implementado | Modelo y GET/PUT básicos; UI sin mutaciones y datos fijos. |
| Proyección | Parcialmente implementado | Fórmula estática; `custom` equivale a `base`. |
| Analítica | Faltante | Solo conteos; las series están declaradas en el frontend. |
| Recurrencias/metas/FX | Faltante | Sin modelos ni endpoints. |
| Chat financiero | Parcialmente implementado | Respuesta local y propuesta de captura, sin herramientas de consulta. |
| Seguridad completa | Faltante | `MASTER_TOKEN` como autenticación temporal. |

## 10. Brechas priorizadas

- **Ahora / Alta:** fuente contable reconciliada, CRUD de cuentas, presupuestos y proyección real.
- **Ahora / Alta:** retirar fixtures del modo de producción y añadir manejo de estados de API.
- **Siguiente / Alta:** importaciones editables, analítica real y chat tipado.
- **Siguiente / Alta:** passkeys, recuperación y sesiones revocables antes de datos bancarios reales.
- **Después / Media:** Web Push optativo y respaldo offsite.

## 11. Estado de cierre — 19 de agosto de 2026

| Hito | Estado | Evidencia |
|---|---|---|
| 0. Especificación y conexión real | Implementado | `spec.md`, `web/src/api.ts`, `web/src/FinanceContext.tsx`; sin fixtures financieros en el runtime. |
| 1. Cuentas y movimientos | Implementado | CRUD/archivo de cuentas; crédito, deuda e inversión; transferencias, divisiones, conciliación y valuación en `server/app/main.py` y `server/app/services/ledger.py`. |
| 2. Presupuestos | Implementado | Alta, edición, borrado, copia, rollover acumulado y ejecución reconciliada con postings. |
| 3. Proyecciones | Implementado | Recurrencias confirmadas, metas, escenarios persistentes y horizontes 3/6/12 desde PostgreSQL. |
| 4. Analítica, importación y chat | Implementado | Series y KPIs reales, revisión editable, deduplicación y herramientas tipadas con confirmación. |
| 5. Seguridad y operación | Implementado en código; validación operativa pendiente | WebAuthn, recuperación, rotación/revocación, offline cifrado, auditoría, restic y Tailscale. |

## 12. Verificación ejecutada

- Ruff sin hallazgos y 17 pruebas Python aprobadas.
- Build TypeScript/Vite de producción aprobado y runtime móvil protegido verificado.
- Cuatro pruebas de empaquetado web y once pruebas Playwright aprobadas.
- Playwright cubre estados provenientes de API en 390, 1024 y 1440 px.
- Cadena Alembic validada hasta `c73e4f9a0d21` y SQL PostgreSQL generado en modo offline.

No fue posible ejecutar contenedores ni una migración contra PostgreSQL real porque Docker no está instalado en este entorno. La ceremonia WebAuthn y la restauración restic requieren el hostname HTTPS, dispositivo y repositorio de respaldo definitivos; ambas deben comprobarse antes de usar la instalación como única copia de datos reales.

## 13. Decisiones y estado del despliegue Proxmox — 20 de agosto de 2026

### Decisiones confirmadas

- El despliegue objetivo es un LXC Debian 13 no privilegiado; PostgreSQL queda
  externo y Redis, Nginx, API, worker y PWA viven dentro del LXC.
- La plantilla debe coincidir con la arquitectura del host. Debian 13 usa
  `nesting=1,keyctl=1`; Tailscale recibe `/dev/net/tun` sin publicar puertos del
  contenedor.
- El código se descarga como usuario `financeapp`; todas las operaciones Git
  posteriores se ejecutan con el mismo usuario, sin excepciones globales
  `safe.directory`.
- Node se instala en `/usr/local/lib/nodejs` como software legible/ejecutable
  por usuarios del sistema. Los builds usan `/usr/local/bin/npm` y un `PATH`
  mínimo explícito.
- El build PWA permanece en el LXC: el repositorio excluye artefactos `dist/` y
  Nginx sirve el resultado verificado en `web/dist/client`.
- La consola Proxmox usa autologin root cuando no se configura una contraseña
  del sistema. Esto no habilita autenticación root por contraseña mediante SSH.

### Recuperación y checkpoints

- La configuración inicial permanece en `/root/financeapp-install.env` con modo
  `0600` hasta completar la instalación. `RESUME_EXISTING=yes` la reutiliza por
  defecto y no vuelve a solicitar PostgreSQL ni regenera claves. El operador
  puede descartarla explícitamente con `REUSE_SAVED_CONFIG=no`.
- Bootstrap guarda checkpoints versionados en
  `/var/lib/financeapp-installer` para paquetes base, Node y Tailscale.
- Cada release por commit guarda checkpoints separados para el entorno Python,
  dependencias npm y build PWA. Antes de adoptar un entorno Python preexistente
  se verifican imports; antes de aceptar el build PWA se exige
  `web/dist/client/index.html`.
- Las descargas pip y npm se conservan bajo `/opt/financeapp/shared` para que
  nuevos commits reutilicen artefactos aunque, por corrección, no compartan el
  entorno virtual ni el build final de otra release.
- Los checkpoints pertenecen a etapas versionadas. Cambiar la implementación de
  una etapa requiere incrementar el sufijo del marcador correspondiente.
- El actualizador valida RAM, espacio libre, tamaño de la base, PostgreSQL,
  Redis y los cuatro servicios antes de aceptar una release. Releases y dumps
  tienen retención acotada; `--force` construye en un worktree paralelo.
- PostgreSQL admite `prefer`, `require` y `verify-full` mediante
  `DB_SSLMODE`. El acceso web continúa limitado a loopback aunque Tailscale se
  desactive.

### Evidencia operativa actual

| Elemento | Estado | Evidencia |
|---|---|---|
| Creación LXC amd64 | Implementado y confirmado | El usuario confirmó que CT 106 inicia con plantilla amd64. |
| Bootstrap Debian/Tailscale | Implementado y confirmado parcialmente | Paquetes base y Tailscale 1.102.3 se instalaron dentro de CT 106. |
| Conexión PostgreSQL | Implementado y confirmado | La instalación superó la comprobación `psql` contra la instancia externa. |
| Build backend Python | Implementado y confirmado | `finanzas-api` creó e instaló su wheel dentro de CT 106. |
| Permisos Node/npm | Corregido en código; sin verificar en CT | El último intento falló al ejecutar npm como `financeapp`; ahora el árbol Node recibe permisos `a+rX` y npm se valida con ese usuario. |
| Reanudación sin preguntas | Implementado en código; sin verificar en CT | Reutiliza el archivo `0600` dejado por el intento fallido. |
| Checkpoints de etapas | Implementado y validado estáticamente; sin verificar en CT | Marcadores versionados, imports Python, árbol npm y artefacto PWA. |
| Pruebas del despliegue | Implementado localmente | `test-proxmox-scripts.sh`, `bash -n`, ShellCheck y escaneo Gitleaks; falta la ejecución real en Proxmox. |
| Build PWA, migración y health check | Bloqueado por el reintento operativo | Deben confirmarse en CT 106 después de publicar y reanudar. |

### Próximo trabajo priorizado

1. **Ahora:** publicar los cambios del instalador y reanudar CT 106 sin volver a
   introducir credenciales.
2. **Ahora:** confirmar que se reutiliza el entorno Python, que npm se ejecuta
   como `financeapp` y que se genera `web/dist/client/index.html`.
3. **Ahora:** verificar migración Alembic, servicios systemd y health check.
4. **Siguiente:** ejecutar `tailscale up` y configurar el hostname HTTPS antes
   de validar passkeys y acceso PWA desde iPhone.
