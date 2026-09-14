# APOD · Apoderamientos

Servicio de Litigios Judiciales para acompañar la obtención, revisión y archivo de apoderamientos apud acta. Runtime **Node.js 22**; TypeScript se compila a JavaScript. No utiliza Python.

Incluye panel de gestión en español, API autenticada, máquina de estados determinista, PostgreSQL, Redis/BullMQ, webhooks firmados, almacenamiento privado de PDF, controles de identidad y facultades, aprobación humana y conectores configurables de WhatsApp, Kmaleon, Apudata y Sede Judicial. Los expedientes se incorporan buscando en Kmaleon por DNI/NIE o nombre y pulsando **Añadir**; el panel ya no pide crear manualmente el expediente.

**Alcance actual: setup local y recorrido demo controlado.** Las claves se conservan en `.env`; los datos de negocio demo se marcan `DEMO_FIXTURE`. `npm test` mantiene sus proveedores offline y no envía nada. Para una conversación real de WhatsApp, el modo demo permite únicamente el teléfono incluido en `DEMO_WHATSAPP_RECIPIENTS`; Kmaleon continúa siendo lectura revisada. Consulta [guía de setup](docs/SETUP.md), [estado y evidencias](docs/STATUS.md) y [preguntas para la activación posterior](docs/PREGUNTAS_PENDIENTES.md).

## Arranque local

Requisitos: Node 22, npm, PostgreSQL 16 y Redis 7. Cada servicio utiliza datos y puertos propios de APOD.

```sh
npm ci
npm run setup
npm run setup:check
npm run prisma:generate
npm run local:start
```

El script prepara PostgreSQL en `.runtime/postgres` (puerto 55432), Redis (56379), aplica las migraciones y levanta el servicio en [http://127.0.0.1:4720](http://127.0.0.1:4720). Si no existe `.env`, crea claves locales aleatorias sin mostrarlas. No se reutilizan credenciales ni bases de otros bots.

En otra terminal propia puedes consultar la clave del panel:

```sh
npm run operator:key
```

La clave no se guarda en el navegador. En despliegues remotos usa HTTPS y acceso limitado a operadores; el panel permite consultar documentos personales. Reiniciar la API con `npm start` conserva la base y las colas. No abrir el servicio directamente a Internet sin HTTPS.

## Docker

```sh
npm run setup
docker compose up -d postgres redis
npm run prisma:generate
npm run prisma:migrate
docker compose --profile app up -d --build
```

Los puertos están publicados sólo en loopback. Si ya usas los servicios nativos locales, detén únicamente las instancias APOD antes de utilizar los mismos puertos de Docker. No emplees `docker compose down -v` para mantenimiento: borraría los volúmenes.

## Configuración de integraciones

- WhatsApp: `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` y versión de Graph. Webhook público `POST /webhooks/whatsapp`, verificación `GET /webhooks/whatsapp`. Firma sobre cuerpo HTTP exacto. Se ignoran cuerpos de texto libres y nombres de archivos para evitar persistir contraseñas; las respuestas estructuradas usan botones. Los textos ambiguos pasan a revisión.
- Demo WhatsApp: `DEMO_DATA_ENABLED=true` y `DEMO_WHATSAPP_RECIPIENTS=34663094035` habilitan el expediente local de prueba. `npm run demo:seed` sólo escribe el expediente demo; `npm run demo:start` inicia el evento `CASE_OPENED` a través de la API local. Los envíos posteriores son reales y se bloquean para cualquier otro destinatario.
- Kmaleon: `KMALEON_CONFIG_FILE` apunta a un JSON revisado. Debe mapear la búsqueda de proyectos por DNI/nombre, campos de identidad/contacto, paginación, anotaciones y lectura de bytes. Al pulsar **Añadir**, APOD vuelve a leer y valida el proyecto seleccionado antes de vincularlo. La subida se confirma por proyecto, referencia única y SHA-256 leído del documento remoto. No basta nombre de archivo ni respuesta HTTP 200.
- Apudata: `APUDATA_CONFIG_FILE` exige un proveedor real, mapeo revisado de preaprobación/pedidos y cuenta verificada. La cuenta de cobro sólo se muestra con preaprobación vigente vinculada al cliente. El callback requiere protocolo explícitamente revisado y firma. No hay correo automático.
- Sede: `SEDE_RECIPE_FILE` exige selectores y endpoints revisados para preparar un borrador. La sesión comprueba identidad y consentimiento. El otorgamiento, firma o revocación jurídicamente efectivos no se ejecutan automáticamente.
- Documentación: `AIRAM_FULL_NAME`, `REPRESENTATIVES_FILE`, `TUTORIAL_FILE`, `CONSENT_VERSION`, `CONSENT_TEXT_FILE`, `REVOCATION_GUIDE_FILE`, `REVOCATION_SCREENSHOTS_FILE`, `WA_TEMPLATE_CONFIG_FILE`. La revisión identifica a la persona y el hash del PDF aprobado.
- `SERVICE_MODE=setup` y los indicadores `*_ENABLED=false` conservan las integraciones desactivadas incluso al rellenar claves. La activación posterior requiere `SERVICE_MODE=live`, la bandera del conector, sus credenciales y un mapeo revisado; los efectos externos requieren además `OUTBOUND_ENABLED=true`.

La asistencia segura utiliza [un proceso Node aislado](docs/ASSISTED_CERTIFICATE.md); el panel recoge consentimiento, dirección, revisión del borrador y constancia de presentación. Para uso nativo instala el navegador con `npx playwright install chromium`; Docker ya lo incorpora. `GEO_CATALOG_FILE` permite resolver demarcaciones desde un catálogo revisado.

Los esquemas y nombres exactos están en [interfaces de integración](docs/agents/gemini-interfaces.md). No copies dominios, cuentas o códigos de los ejemplos del documento original como si fueran reales.

## Verificación

```sh
npm run typecheck
npm run build
npm run verify:infra
npm run verify:http
npm run verify:ui
npm run verify:geography
npm test
```

`verify:infra` usa PostgreSQL y Redis reales y ejecuta un trabajo real BullMQ de diagnóstico; no crea clientes ficticios. `verify:http` consulta el servidor real y comprueba acceso autenticado/no autenticado sin crear expedientes. `npm test` ejecuta [el recorrido local con datos MOCK](docs/SETUP_TEST.md) en un esquema y colas nuevos para cada ejecución. Comprueba los recorridos final, provisional y de pago, las revisiones humanas y la idempotencia. `npm run test:real` mantiene separado el verificador con documentos reales: falla si faltan entradas o evidencias.

Los PDF y certificados reales se mantienen fuera de Git. Las evidencias locales se guardan en `evidence/`; no prueban por sí solas integración legal/externa. El recorrido real de aceptación requiere entrada real → auditoría → PostgreSQL → Kmaleon verificado → aviso verificado → entrega WhatsApp confirmada.

## Recuperación operativa

La bandeja PostgreSQL y las acciones pendientes son la fuente de verdad. Redis transporta referencias, no certificados, contraseñas ni texto libre. Los procesos usan bloqueo por expediente y comparan la versión antes de escribir. Los reintentos ambiguos de una operación externa requieren conciliación. No se reenvía una notificación por el mero hecho de que falló el guardado de su recibo.

Estados de acción: `PENDING`, `RUNNING`, `AWAITING_DELIVERY`, `EXECUTED`, `BLOCKED`, `FAILED`, `UNCERTAIN`, `HUMAN_REQUIRED`, `STALE`, `CANCELLED`. Las acciones antiguas no pueden aplicar decisiones a una versión nueva del expediente.

En el panel, revisa primero la evidencia y la causa; después usa el endpoint de reintento. Un WhatsApp incierto requiere evidencia externa de entrega. Un documento provisional mantiene abierta la corrección; no se presenta como expediente finalizado.

## Reglas del despacho

No se accede al correo sin Token de Autorización Humana aportado por el usuario. No se marcan correos como leídos. Los datos ficticios están autorizados exclusivamente para este setup; sus resultados se etiquetan como simulados y no prueban éxito con proveedores reales. Las cinco páginas son un criterio interno y nunca una certificación de autenticidad o suficiencia jurídica. Consulta [fuentes y decisiones](docs/SOURCES.md).
