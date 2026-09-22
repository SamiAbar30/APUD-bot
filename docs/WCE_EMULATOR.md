# WCE local emulator

The APOD project now includes a separate local copy of [DonnC/wce-emulator](https://github.com/DonnC/wce-emulator). The upstream project provides a React WhatsApp-like UI and a Node bridge; this checkout is pinned to the cloned commit and is ignored by the APOD repository so the emulator remains an independent project.

The local bridge has three APOD-specific changes:

- it uses the test sender `34600000000` and the same local phone-number ID as APOD;
- it signs UI replies with the local `WA_APP_SECRET`, so APOD's normal webhook HMAC check remains enabled;
- it accepts a configurable port and webhook URL instead of hardcoded production values.

The APOD WhatsApp client supports `WHATSAPP_TRANSPORT=emulator` only with a loopback `WA_API_BASE_URL`. In emulator mode the client never calls Meta. PDF media gets a deterministic local WCE media identifier; no media is uploaded externally.

## Start it

From the APOD project:

```bash
npm run wce:install
npm run wce:start
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) for the WhatsApp-like chat. The APOD operator panel remains at [http://127.0.0.1:4720/](http://127.0.0.1:4720/). `wce:start` creates `.env.wce` with local-only WhatsApp credentials, a recipient allowlist containing `34600000000`, and a separate `apod-wce` queue prefix. It preserves the existing local PostgreSQL data but disables Kmaleon, Apudata, Sede, and Meta. Conversation AI stays disabled unless `CONVERSATION_AI_PROVIDER` and the `AI_*` variables are explicitly configured in `.env`; those values are copied into the mode-600 demo environment so the same reviewed provider can be exercised locally. If `APOD_AGENT_PACKAGE_DIR` points to the separately built agent package, WCE reports it as a loaded reference while keeping the provider opt-in. The setup also creates a local-only representatives roster and uses the package's client guide PDF, so the demo can display the tutorial; these materials are never used by Meta production.

Select the local demo expediente for `34600000000` in the APOD panel and open the conversation. The first approved question appears in WCE. Reply with a button or text; the bridge signs the webhook and the APOD FSM processes it through the same durable inbox and worker path.

The WCE bridge is based on the repository's documented contract: bot sends go to `POST /send-to-emulator`, while UI replies are translated into signed WhatsApp webhook payloads. The upstream README describes this bridge/UI architecture and local ports. [WCE README](https://github.com/DonnC/wce-emulator#connecting-your-bot)

The local bridge keeps the latest messages briefly in memory, so opening the UI after APOD starts still shows the live bot message. It does not persist chat history outside the emulator UI's own local browser storage.

Stop all three processes with `Ctrl-C`. Do not set `WHATSAPP_TRANSPORT=emulator` in a production environment; APOD rejects emulator transport outside local live mode and only accepts loopback URLs.
