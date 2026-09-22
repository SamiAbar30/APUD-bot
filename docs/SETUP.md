# Setup de APOD

El alcance solicitado es una instalación local lista para configurar después, con un recorrido real de la aplicación usando datos de negocio MOCK. Runtime Node.js 22 y TypeScript; no se utiliza Python. No hacen falta cuentas de proveedores para este setup.

## Arrancar

Desde la carpeta del proyecto, con Node 22, PostgreSQL 16 y Redis 7 instalados:

```sh
npm ci
npm run setup
npm run setup:check
npm run prisma:generate
npm run local:start
```

`local:start` prepara los servicios propios APOD, aplica las migraciones, compila y mantiene la API en primer plano. PostgreSQL escucha en `127.0.0.1:55432`, Redis en `127.0.0.1:56379`, y el panel en http://127.0.0.1:4720. Los datos se conservan entre arranques. Al cerrar la API, PostgreSQL y Redis siguen disponibles para ejecutar pruebas. No comparte credenciales ni datos con los otros bots.

## Añadir un cliente existente

El botón principal es **Buscar en Kmaleon**. Selecciona `DNI / NIE` o `Nombre`, escribe el dato y pulsa **Buscar en Kmaleon**. APOD consulta el endpoint de lectura de proyectos de Kmaleon y muestra las coincidencias con nombre, identidad, teléfono e ID de expediente. Pulsa **Añadir** en la fila correcta. APOD vuelve a leer ese proyecto y comprueba el DNI, nombre, teléfono e ID antes de crear el seguimiento local; el navegador nunca decide esos valores. Si el expediente ya estaba vinculado, se abre el mismo seguimiento y no se crea un duplicado.

La búsqueda y la vinculación necesitan Kmaleon configurado y revisado (`SERVICE_MODE=live`, `KMALEON_ENABLED=true`, credenciales completas y `config/kmaleon.json` con `mapping.projects`). Mientras el setup conserve Kmaleon desactivado, el botón seguirá visible para mostrar el flujo, pero la consulta responde `KMALEON_NOT_CONFIGURED`; no se puede añadir manualmente un expediente desde el panel.

En otra terminal:

```sh
npm run operator:key
npm test
```

El primer comando muestra la clave local para acceder al panel en tu propia terminal. El test ejecuta las migraciones en un esquema PostgreSQL nuevo, utiliza sus propias colas Redis y guarda PDFs explícitamente ficticios en `.runtime/setup-tests/`. El panel habitual conserva su esquema normal. Consulta [qué comprueba la prueba](SETUP_TEST.md).

## Claves y cuentas

`.env` contiene los 51 campos de configuración; `.env.example` es la plantilla sin secretos. `npm run setup` genera únicamente la contraseña de PostgreSQL, su URL local y la clave de operador. Conserva los valores ya existentes, añade los campos que falten, mantiene el archivo con permisos `600` y no imprime sus valores. Puedes repetirlo después de actualizar el proyecto.

| Grupo | Campos que se completarán más adelante |
| --- | --- |
| WhatsApp | `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_TEMPLATE_CONFIG_FILE` |
| Kmaleon | `KMALEON_BASE_URL`, `KMALEON_CLIENT_ID`, `KMALEON_CLIENT_SECRET`, `KMALEON_AUTH_STATE`, `KMALEON_REDIRECT_URI`; `CARMEN_USER_ID` solo para filing/avisos |
| Demo WhatsApp | `DEMO_DATA_ENABLED` y `DEMO_WHATSAPP_RECIPIENTS` (lista de teléfonos de prueba en dígitos) |
| Apudata | `APUDATA_BASE_URL`, `APUDATA_ACCESS_TOKEN`, `APUDATA_ACCOUNT_ID`, `APUDATA_PAYMENT_IBAN`, `APUDATA_PAYMENT_EVIDENCE_REF`, `APUDATA_CALLBACK_SECRET` |
| Sede y despacho | `SEDE_RECIPE_FILE`, `AIRAM_FULL_NAME`, `REPRESENTATIVES_FILE`, tutorial, consentimiento, guías de revocación y `GEO_CATALOG_FILE` |
| Publicación | `PUBLIC_BASE_URL` y configuración del dominio HTTPS |

Los archivos `config/kmaleon.json`, `config/apudata.json` y `config/sede.json` también están preparados, con `reviewed:false`. Contienen estructura del protocolo y selectores; las cuentas y claves se toman de `.env`. Los archivos `.example.json` documentan la forma inicial: sus rutas/campos vacíos deben mapearse contra el contrato real del proveedor antes de activar. En Kmaleon, `mapping.projects` define los campos de la fila (ID, nombre, DNI y teléfono), la paginación y los filtros revisados de nombre/DNI. Una cuenta adicional en un cuerpo API puede referenciar `{"env":"APUDATA_ACCOUNT_ID"}` dentro de un mapeo; no se necesita escribir su valor en el JSON.

Los certificados personales y sus contraseñas no se guardan en `.env`. El bot no incluye acceso al correo; la regla del token humano sigue vigente.

## Modos y comprobaciones

El panel arranca con `SERVICE_MODE=setup`, `DATA_MODE=real`, todos los conectores desactivados y `OUTBOUND_ENABLED=false`. Aquí `real` identifica el espacio normal del panel, inicialmente vacío: no afirma verificación de producción. Rellenar una clave no habilita su conector ni sus webhooks. `setup:check` valida el archivo privado, la cobertura de campos y las plantillas sin llamar a proveedores.

`npm test` selecciona internamente `NODE_ENV=test`, `SERVICE_MODE=setup` y `DATA_MODE=mock`. Inyecta proveedores offline; la API y los recibos identifican la simulación. El arranque normal rechaza `DATA_MODE=mock`: utiliza el comando de prueba para crear el aislamiento requerido. No cambia las banderas de tu `.env`.

La activación posterior requiere `SERVICE_MODE=live`, la bandera del proveedor (`WHATSAPP_ENABLED`, `KMALEON_ENABLED`, `APUDATA_ENABLED` o `SEDE_ENABLED`), sus claves, revisión de los mapeos y, para ejecutar efectos, `OUTBOUND_ENABLED=true`. Las combinaciones contradictorias abortan. Las entradas reales se comprueban por separado con `npm run test:real`.

Para probar el recorrido con datos locales y WhatsApp real, activa `DEMO_DATA_ENABLED=true` y configura `DEMO_WHATSAPP_RECIPIENTS=34600000000`. Ejecuta `npm run demo:seed` para crear un expediente marcado `DEMO_FIXTURE`; esa orden no llama a ningún proveedor. La lista se aplica antes de cada envío de Meta, por lo que el bot no puede enviar a otro teléfono durante el modo demo. Después de publicar `/webhooks/whatsapp` en una URL HTTPS de Meta, `npm run demo:start` inicia el triaje del expediente y el mensaje real llega al teléfono permitido.

Puedes seleccionar otro archivo con `ENV_FILE=/ruta/privada/apod.env`. Las variables ya exportadas tienen prioridad. Las rutas relativas de materiales, configuración y almacenamiento se resuelven junto a ese archivo; `setup` prepara allí las plantillas. El arranque nativo continúa reservado a los puertos locales anteriores. `SETUP_DATABASE_URL` y `SETUP_REDIS_URL` son overrides opcionales del test para otra instalación local aislada, no claves de producción.

Informes locales: `evidence/setup-check.json`, `evidence/setup-test.json`, `evidence/http-verification.json` y `evidence/ui-verification.json`. No contienen claves. Las evidencias, `.env`, configuración activa, documentos y datos de servicios están excluidos de Git.
