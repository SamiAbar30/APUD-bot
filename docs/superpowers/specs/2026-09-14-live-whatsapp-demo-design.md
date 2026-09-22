# Live WhatsApp demo with Kmaleon search

## Goal

Allow the operator to exercise the APOD conversation with one real WhatsApp recipient while using clearly labelled local demo case data. Kmaleon search and selection remain read-only provider calls. Carmen's recipient identifier is not required for search or local case linking.

## Behavior

- `CARMEN_USER_ID` is optional while the Kmaleon adapter is used for search, project selection, or address reads.
- Kmaleon document filing and Carmen notification fail closed with `KMALEON_RECIPIENT_NOT_CONFIGURED` when the recipient code is absent.
- A demo fixture command creates or reuses one local case for `34600000000`, marks its provenance as demo data, and never calls Kmaleon or WhatsApp.
- Demo WhatsApp sends are real Meta API sends, restricted to an explicit recipient allowlist containing `34600000000`. The allowlist is enforced in the client before every outbound operation.
- Incoming WhatsApp messages continue through the signed Meta webhook, durable inbox, and worker flow. No synthetic webhook is used for the live test.
- `OUTBOUND_ENABLED` remains the final global write gate. Demo mode cannot bypass it.

## Configuration

Add explicit demo settings to `.env.example` and the loader:

- `DEMO_DATA_ENABLED` (default `false`)
- `DEMO_WHATSAPP_RECIPIENTS` (comma-separated E.164 digits; empty by default)

The live test requires `SERVICE_MODE=live`, `DATA_MODE=real`, `WHATSAPP_ENABLED=true`, `OUTBOUND_ENABLED=true`, a valid `WA_PHONE_NUMBER_ID`, Meta credentials, and a publicly reachable `PUBLIC_BASE_URL` for the webhook. Kmaleon still requires a reviewed response mapping for live search.

## Data flow

1. `npm run demo:seed` validates demo mode and the configured recipient, then upserts a deterministic local case with a synthetic name/DNI and the real test phone number.
2. The operator starts the normal workflow from the panel or a dedicated demo command. The action executor applies the existing state and human-review gates.
3. WhatsAppClient checks the recipient allowlist, then calls Meta only when outbound is enabled.
4. Meta posts signed callbacks to `/webhooks/whatsapp`; the server validates the signature and phone-number ID, persists inbox/status rows, and workers process them.

## Failure handling and verification

- Missing demo settings, an unallowlisted recipient, disabled outbound, missing Meta identifiers, or an unreviewed Kmaleon mapping produce explicit errors before network calls.
- Tests use the real local PostgreSQL/Redis setup and real application code. Fixture data is for exercising the UI and workflow; it is not evidence that an external provider succeeded.
- Verification records build, typecheck, local demo seeding, signed webhook handling, and the no-network guard for invalid configuration. A real Meta send is reported separately from local verification.
