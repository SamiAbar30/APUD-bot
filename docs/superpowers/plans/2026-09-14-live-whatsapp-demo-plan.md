# Live WhatsApp demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a real Meta WhatsApp conversation against `34663094035` using an explicitly seeded local demo case while allowing Kmaleon read-only search without Carmen's recipient code.

**Architecture:** Keep local demo data in PostgreSQL and mark its provenance on the case and audit log. Keep Kmaleon search/read operations independent from the optional Carmen recipient code, while document filing and notices require that code at the gateway boundary. Enforce a demo WhatsApp recipient allowlist inside `WhatsAppClient` before any outbound Meta request; inbound traffic remains the existing signed webhook and durable queue flow.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Prisma/PostgreSQL, Redis/BullMQ, Zod, Meta WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-09-14-live-whatsapp-demo-design.md`

## Global Constraints

- `CARMEN_USER_ID` is optional for Kmaleon search, project selection, and address reads.
- Kmaleon filing and Carmen notification fail closed with `KMALEON_RECIPIENT_NOT_CONFIGURED` when no recipient code exists.
- Demo fixture data is synthetic local data and is never evidence of an external provider result.
- Real WhatsApp sends are allowed only to the configured demo recipient allowlist and only when `OUTBOUND_ENABLED=true`.
- No email connection or mailbox mutation is introduced.
- Tests use the real application code and local PostgreSQL/Redis where persistence is required; no fake Meta response is treated as provider verification.

### Task 1: Make Carmen optional for Kmaleon read paths

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/adapters/configured.ts`
- Modify: `src/contracts/kmaleon.contract.ts`
- Modify: `src/adapters/kmaleon/kmaleon-gateway.ts`
- Modify: `scripts/check-setup.ts`
- Modify: `config/kmaleon.example.json`
- Test: `scripts/test-live-guards.ts`

**Interfaces:**
- `loadEnv()` continues returning `CARMEN_USER_ID?: string` without requiring it when Kmaleon is enabled.
- `KmaleonGatewayOptions.recipientCode?: number` is optional.
- Search and address methods remain callable without `recipientCode`; filing and `notifyCarmen()` call a private `requiredRecipientCode()` guard and throw `KMALEON_RECIPIENT_NOT_CONFIGURED` when absent.

- [ ] **Step 1: Write the failing test**

Add assertions to `scripts/test-live-guards.ts` that `loadEnv()` accepts live Kmaleon configuration without `CARMEN_USER_ID`, and that a gateway created without `recipientCode` rejects a notice before any client write.

```ts
const env = loadEnv({ ...baseValues, SERVICE_MODE: 'live', KMALEON_ENABLED: 'true', CARMEN_USER_ID: '' });
assert.equal(env.CARMEN_USER_ID, undefined);
await assert.rejects(() => gatewayWithoutRecipient.notifyCarmen(noticeInput), (error: any) => error.code === 'KMALEON_RECIPIENT_NOT_CONFIGURED');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx scripts/test-live-guards.ts`

Expected: FAIL because the current environment schema requires `CARMEN_USER_ID` and `KmaleonGateway` requires a positive recipient code.

- [ ] **Step 3: Write minimal implementation**

Remove `CARMEN_USER_ID` from the Kmaleon `needs()` list and remove Carmen from the readiness boolean. Make `recipientCode` optional in the config schema and gateway options. Add `requiredRecipientCode()` and use it in `exact()`, `annotation()`, filing, and notice paths. Preserve all existing identity and mapping checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx scripts/test-live-guards.ts && npm run typecheck`

Expected: PASS, with no network calls and no secret values printed.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/adapters/configured.ts src/contracts/kmaleon.contract.ts src/adapters/kmaleon/kmaleon-gateway.ts scripts/check-setup.ts config/kmaleon.example.json scripts/test-live-guards.ts
git commit -m "feat: make Carmen recipient optional for Kmaleon reads"
```

### Task 2: Add demo provenance and deterministic local fixture seeding

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260914120000_demo_case_source/migration.sql`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Create: `src/demo/demo-fixture.ts`
- Create: `scripts/demo-seed.ts`
- Modify: `package.json`
- Test: `scripts/test-live-guards.ts`

**Interfaces:**
- `BotApodExpediente.source: string` defaults to `OPERATOR`.
- `demoFixture(phone: string)` returns `{ source:'DEMO_FIXTURE', dni:'12345678Z', nombre:'DEMO APOD CLIENT', telefono, kmaleonExpedienteId:'demo-kmaleon-<phone>' }` after validating the phone.
- `npm run demo:seed` requires `DEMO_DATA_ENABLED=true` and the phone in `DEMO_WHATSAPP_RECIPIENTS`; it creates or reuses the matching case and writes `DEMO_FIXTURE_SEEDED` with `source:'DEMO_FIXTURE'`.

- [ ] **Step 1: Write the failing test**

Extend `scripts/test-live-guards.ts` with a real local database assertion that the fixture helper exposes the deterministic source and that a second seed finds the same unique phone/DNI instead of creating a duplicate. The test must use a transaction and a temporary PostgreSQL schema selected through `SETUP_DATABASE_URL`.

```ts
const fixture = demoFixture('34663094035');
assert.deepEqual(fixture, { source:'DEMO_FIXTURE', dni:'12345678Z', nombre:'DEMO APOD CLIENT', telefono:'34663094035', kmaleonExpedienteId:'demo-kmaleon-34663094035' });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx scripts/test-live-guards.ts`

Expected: FAIL because the schema has no `source` field and the demo fixture module/command does not exist.

- [ ] **Step 3: Write minimal implementation**

Add the nullable-safe migration with `source TEXT NOT NULL DEFAULT 'OPERATOR'`, add `DEMO_DATA_ENABLED` and parsed `DEMO_WHATSAPP_RECIPIENTS` to the environment schema, implement the fixture helper, and implement the CLI using Prisma. The CLI must compare existing phone, DNI, name, and Kmaleon ID before reuse; any mismatch throws `DEMO_FIXTURE_CONFLICT` and no update occurs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx prisma migrate deploy && node --import tsx scripts/test-live-guards.ts && npm run typecheck`

Expected: PASS with one deterministic local demo case and one provenance audit row.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260914120000_demo_case_source/migration.sql src/config/env.ts .env.example src/demo/demo-fixture.ts scripts/demo-seed.ts package.json scripts/test-live-guards.ts
git commit -m "feat: add guarded local WhatsApp demo fixture"
```

### Task 3: Enforce the demo WhatsApp recipient allowlist

**Files:**
- Modify: `src/adapters/whatsapp/whatsapp-client.ts`
- Modify: `src/main.ts`
- Modify: `scripts/test-live-guards.ts`
- Modify: `docs/SETUP.md`

**Interfaces:**
- `WhatsAppOptions.allowedRecipients?: readonly string[]` is passed only when `DEMO_DATA_ENABLED=true`.
- Every send method validates its `to` value against `allowedRecipients` before `requestJson`; a mismatch throws `DEMO_RECIPIENT_NOT_ALLOWED`.
- `uploadMedia()` remains recipient-independent and still requires `writesEnabled`.

- [ ] **Step 1: Write the failing test**

Add a test that constructs `WhatsAppClient` with `writesEnabled:true` and `allowedRecipients:['34663094035']`, then calls `sendText('34663094036','probe')` and asserts `DEMO_RECIPIENT_NOT_ALLOWED`. Add a second assertion that `sendText('34663094035','probe')` does not fail the allowlist check; it may fail later only if the network is reached, so the test must use a pure exported `assertWhatsAppRecipientAllowed()` helper for the positive case.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx scripts/test-live-guards.ts`

Expected: FAIL because `WhatsAppClient` currently has no allowlist and no recipient policy helper.

- [ ] **Step 3: Write minimal implementation**

Add `assertWhatsAppRecipientAllowed(to, allowedRecipients)` with strict digits-only normalization and use it in the private `send()` method. In `main.ts`, pass the parsed allowlist only for demo mode. Reject an empty allowlist during environment validation when demo mode is enabled.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx scripts/test-live-guards.ts && npm run typecheck`

Expected: PASS, and the disallowed call must fail before any HTTP request.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/whatsapp/whatsapp-client.ts src/main.ts scripts/test-live-guards.ts docs/SETUP.md
git commit -m "feat: restrict demo WhatsApp sends to allowlist"
```

### Task 4: Add operator commands and real-flow verification

**Files:**
- Create: `scripts/demo-start.ts`
- Modify: `package.json`
- Modify: `scripts/check-setup.ts`
- Modify: `docs/SETUP.md`
- Modify: `README.md`
- Modify: `docs/STATUS.md`
- Test: `scripts/test-live-guards.ts`

**Interfaces:**
- `npm run demo:start` finds the `DEMO_FIXTURE` case through the authenticated local API and posts `CASE_OPENED`; it never fabricates a webhook or calls Meta directly.
- `scripts/check-setup.ts` reports demo enablement and recipient count only, never phone numbers or secrets.

- [ ] **Step 1: Write the failing test**

Add a CLI contract assertion that `demo:start` refuses to run when `DEMO_DATA_ENABLED=false`, and that setup reports `demoData` and `demoRecipientCount` without the actual recipient string.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx scripts/test-live-guards.ts`

Expected: FAIL because the command and setup fields do not exist.

- [ ] **Step 3: Write minimal implementation**

Implement the authenticated HTTP command using `OPERATOR_TOKEN`, validate the local API origin, select exactly one demo case by `source`, and post the current version with event `CASE_OPENED`. Add scripts and documentation for the required Meta variables, public webhook URL, and the distinction between local fixture data and real WhatsApp traffic.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx scripts/test-live-guards.ts && npm run build && npm run verify:http && npm run verify:ui`

Expected: PASS for all local checks. The report must state that no external provider call occurred.

- [ ] **Step 5: Commit**

```bash
git add scripts/demo-start.ts package.json scripts/check-setup.ts docs/SETUP.md README.md docs/STATUS.md scripts/test-live-guards.ts
git commit -m "feat: add live WhatsApp demo start command"
```

### Task 5: Execute the guarded live test when credentials are complete

**Files:**
- Runtime only: `.env` and `config/kmaleon.json` supplied by the operator; do not commit either file.
- Evidence: `evidence/demo-live-check.json`

**Interfaces:**
- Required runtime values: `SERVICE_MODE=live`, `DATA_MODE=real`, `DEMO_DATA_ENABLED=true`, `DEMO_WHATSAPP_RECIPIENTS=34663094035`, `WHATSAPP_ENABLED=true`, `OUTBOUND_ENABLED=true`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, and a public `PUBLIC_BASE_URL`.

- [ ] **Step 1: Run configuration checks**

Run: `npm run setup:check && npm run build`; confirm the report contains no secret values and no pending required Meta fields.

- [ ] **Step 2: Seed the local demo case**

Run: `npm run demo:seed`; confirm one `source=DEMO_FIXTURE` case exists in PostgreSQL.

- [ ] **Step 3: Start the first real message**

Run: `npm run demo:start`; confirm the resulting action is queued for `34663094035` and inspect the action receipt for Meta acceptance without printing tokens.

- [ ] **Step 4: Verify inbound traffic**

Send a real reply from the phone, let Meta call `/webhooks/whatsapp`, then confirm the signed callback creates one durable inbox row and the worker advances the case. Do not generate a synthetic callback for this evidence.

- [ ] **Step 5: Record outcome**

Write only status, message IDs, case ID, and counts to `evidence/demo-live-check.json`; separate local code verification from Meta's external acceptance and inbound delivery.
