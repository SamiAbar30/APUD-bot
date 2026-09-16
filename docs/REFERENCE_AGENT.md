# Paquete de referencia del agente de apoderamientos

APOD puede leer el paquete separado creado en:

`/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento/`

El directorio se configura con `APOD_AGENT_PACKAGE_DIR`. `npm run wce:setup` conserva ese valor en `.env.wce` con permisos `600`, por lo que el emulador puede arrancar con la misma referencia local.

El cargador usa `system_prompt.md`, `flow.json`, `placeholders.json` y los recuentos de `training/redaction_report.json`. No carga los JSONL de 29 MB en cada arranque ni envía el corpus completo al proveedor. Expone al adaptador únicamente:

- la identidad, la definición de apud acta y el tono de las secciones revisadas del prompt;
- etiquetas del árbol y nombres de intenciones globales;
- recuentos agregados del corpus y sus redacciones;
- los placeholders que siguen en `TODO`.

La referencia aporta estilo y contexto para clasificar mensajes. APOD sigue siendo la autoridad para estados, eventos, botones, plantillas, URLs, macros, trabajadores y revisiones humanas. El prompt de referencia contiene instrucciones antiguas para certificados, contraseñas y pagos; el adaptador las excluye y añade una regla final que obliga a usar el canal seguro de APOD, no WhatsApp. Los datos de pago y los secretos nunca se incorporan al contexto del modelo.

El estado se puede consultar con `GET /api/capabilities` autenticado. En este equipo aparece `referenceAgentStatus: LOADED`, `referenceAgentPackage: apoderamiento_apud_acta` y los recuentos `355 / 4745 / 225`. El proveedor conversacional continúa en `DISABLED` porque `CONVERSATION_AI_PROVIDER=none`; la referencia no activa llamadas de IA por sí sola.

En WCE, `npm run wce:setup` genera además `.runtime/wce-demo-representatives.json` a partir de esa lista y usa `docs/guia_cliente_apud_acta.pdf` como material local de demostración. El archivo se marca `WCE_LOCAL_DEMO_SOURCE_AGENT`, queda ignorado y con permisos `600`; la lista todavía necesita aprobación operativa antes de cualquier uso con clientes.

Cuando exista un endpoint aprobado, se puede activar de forma explícita en `.env`:

```dotenv
APOD_AGENT_PACKAGE_DIR=/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento
CONVERSATION_AI_PROVIDER=openai-compatible
AI_BASE_URL=https://endpoint-aprobado/v1
AI_API_KEY=
AI_MODEL=gpt-5.6-luna
AI_REDACT_PII=true
AI_SIN_TEMPERATURE=true
```

Las conversaciones nuevas siguen necesitando anonimización y revisión humana antes de incorporarse al corpus o a un ajuste fino. Un archivo nuevo no cambia automáticamente el comportamiento del bot.
