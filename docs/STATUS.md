# Estado — 14 de septiembre de 2026

**Setup local y modo demo controlado implementados.** Node.js 22 y TypeScript exclusivamente. Las claves/cuentas permanecen en `.env`; el expediente demo se marca `DEMO_FIXTURE` y el teléfono permitido se configura por lista explícita. Se conservaron las claves locales existentes. El archivo se mantiene privado con permisos `600`, está excluido de Git y no se han impreso secretos.

Se han aplicado patrones de configuración, aislamiento y simulación de [RECLAMACION y FACTURACION](REFERENCE_PATTERNS.md). Los proyectos de referencia se consultaron en solo lectura. APOD utiliza PostgreSQL y Redis propios y el panel local http://127.0.0.1:4720.

## Comprobaciones de este setup

| Comprobación | Resultado | Evidencia local |
| --- | --- | --- |
| TypeScript estricto y compilación Node | Superada | `npm run typecheck`, `npm run build` |
| Configuración privada, 51 campos y plantillas | Superada; repetir setup conserva los valores | `evidence/setup-check.json` |
| Arranque nativo, migraciones PostgreSQL, Redis | Superada | `npm run local:start` |
| Redis/BullMQ y exclusión/liberación Redlock reales | Superada | `evidence/infra-verification.json` |
| HTTP real, autenticación y panel normal sin casos de negocio | Superada | `evidence/http-verification.json` |
| Navegador real, navegación y pantalla móvil | Superada; sin errores de página ni desbordamiento horizontal | `evidence/ui-verification.json`, capturas `evidence/panel-*.png` |
| Flujo con datos MOCK y proveedores offline | **29 comprobaciones superadas** | `evidence/setup-test.json` |
| Selección de `ENV_FILE` y exclusión de cuentas externas en el test | Superada con archivo alternativo y claves artificiales | Incluida en revisión y prueba de setup |
| Webhooks desactivados con claves ya presentes | Rechazados con HTTP 503, sin mutaciones | Incluida en `evidence/setup-test.json` |
| Búsqueda y vinculación de expedientes Kmaleon | Implementada como lectura + relectura de identidad; la UI no crea expedientes manualmente | `GET /api/kmaleon/search`, `POST /api/cases/from-kmaleon` |
| Carmen opcional para lecturas Kmaleon | Superada; filing/avisos siguen bloqueados sin código de destinatario | `scripts/test-live-guards.ts` |
| Fixture local para WhatsApp demo | Implementada; un expediente determinista para `34663094035`, sin llamadas externas | `npm run demo:seed`, `npm run demo:start` |
| Allowlist de envíos WhatsApp demo | Implementada; se rechaza cualquier otro teléfono antes de HTTP | `scripts/test-live-guards.ts` |

El test usa PostgreSQL, Redis/BullMQ, Fastify HTTP, almacenamiento y auditor PDF reales. Genera casos y PDF identificados como MOCK y utiliza puertos de proveedor offline. Comprueba revisión humana, recorrido final, provisional/revocación/reemisión, preaprobación, evidencia de pago, idempotencia y rechazos de documentos incorrectos. Dos casos llegan a `COMPLETED` dentro del esquema aislado de prueba. El caso de pago permanece en `APUDATA_VIDEO_IN_PROGRESS`, pendiente del vídeo simulado.

Los informes identifican `SETUP_WITH_MOCK_DATA`, `productionVerified:false`, cero llamadas externas y ninguna interacción con correo. Cada ejecución conserva su esquema y archivos propios y limpia únicamente sus colas. El esquema normal del panel mantiene cero expedientes de negocio. La prueba no modifica `.env` ni utiliza cuentas de clientes reales.

## Activación posterior

Los conectores quedan sujetos a las banderas explícitas: rellenar claves por sí solo no activa conectores o webhooks. Las plantillas JSON siguen con `reviewed:false`. El modo demo puede usar WhatsApp real sólo con `SERVICE_MODE=live`, `WHATSAPP_ENABLED=true`, `OUTBOUND_ENABLED=true`, credenciales Meta completas, webhook HTTPS y la lista de destinatarios configurada. Las [preguntas pendientes](PREGUNTAS_PENDIENTES.md) se refieren a la activación futura y no bloquean el setup local.

Faltan para operar con clientes: cuentas y contratos API revisados, materiales/identidades del despacho, consentimiento aprobado, receta de Sede, documentos reales autorizados y dominio HTTPS. `npm run test:real` conserva el verificador de entradas reales, que falla si faltan documentos. No se ha verificado un flujo de producción con WhatsApp, Kmaleon, Sede o Apudata. No se han enviado mensajes, accedido al correo, transferido dinero ni otorgado/revocado poderes.

La implementación incluye 21 estados, contrato determinista de 11 campos, panel de operador, auditor PDF, almacenamiento privado, colas/bandeja duraderas, conciliación de efectos inciertos y sesión Node aislada para inspección de certificados y preparación de borradores. El inspector no sustituye validación de cadena, revocación ni autenticidad jurídica. La Sede requiere revisión y presentación humana.

## Evidencias anteriores conservadas

Se mantienen los informes anteriores de códigos INE (`geography-verification.json`), auditoría npm, construcción Docker con Chromium y arranque del navegador en contenedor sin red. No son nuevas validaciones de los cambios de configuración de este setup. Docker dispone de puertos loopback, datos propios y montaje de los mapeos en solo lectura; el arranque verificado para esta fase es el nativo local.

## Subagentes

Claude Code se ejecutó realmente y creó el núcleo de dominio; alcanzó su límite de sesión en dos ejecuciones. Gemini CLI respondió `401 UNAUTHENTICATED / ACCESS_TOKEN_TYPE_UNSUPPORTED`. Codex completó conectores, integración, revisión y setup. No se atribuye a Gemini código que no produjo. Sus logs se conservan en `evidence/claude-build.log`, `evidence/claude-resume.log` y `evidence/gemini-build.log`.
