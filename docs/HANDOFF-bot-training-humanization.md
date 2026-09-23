# Handoff — APOD-bot training and humanization

Written 2026-09-23. For whoever continues the conversational work on the apud acta bot: a
person, a Claude Code session or a Codex agent. Everything here was verified in this repo; where
something is a measurement it says when it was taken.

## What the bot is

WhatsApp assistant ("Dayana, la asistente virtual de LITIGIOS") that gets a client through the
*apoderamiento apud acta* for their claim. Deterministic finite state machine owns the workflow;
the model may only propose validated options and bounded replies. Stack: Node 22, TypeScript
strict, Fastify, Prisma/PostgreSQL (port 55432), Redis/BullMQ (port 56379), Redlock per case.

Repo: https://github.com/SamiAbar30/APUD-bot — local checkout `~/Documents/ChatGPT/APOD-bot`.

## Branches, and which to work on

| Branch | Tip | Meaning |
|---|---|---|
| `main` | `f15643c` | Codex's V1. Tested by the manager and liked. **Do not touch.** |
| `humanized-conversation` | `2d4d929` | Experiments in reading context and answering like a person. **Work here.** Contains everything below. |
| `codex/apud-v2` | `dadf5e8` | V2 preparation (credential vault, receipt handling). Automatic signing unfinished. |
| `codex/apud-humanized-v1` | `f15643c` | Same commit as main, kept as a named branch. |

The owner's instruction: keep all branches, **do not merge yet**. When a merge happens, the
decisions already taken are recorded in commit `35f89f7` (main's infrastructure kept, humanized
protocol replies kept, Codex's per-turn memory and the file-based pause kept).

## The firm's protocol — facts the bot may state

Source of truth: `system_prompt.md` in the agent package (`APOD_AGENT_PACKAGE_DIR`, currently
`~/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento`). Do not invent beyond it.

- Doing it yourself is free: Sede Judicial with a certificate, or in person at the juzgado
  (cita in the decanato).
- The partner company ("empresa colaboradora") is optional and costs 35 €, confirmed before
  contracting.
- Certificate comes from the FNMT: DNIe + PIN, or video identification. NIE holders go to the
  Ayuntamiento (FNMT accreditation office) and get a document with link and password. Never ask
  for an FNMT code.
- **When the client is stuck or asks the office to do it (§1.2 / §2.2): ask for the certificate
  file and its password over WhatsApp, password in a separate message.** On receipt reply exactly
  "Recibido, gracias. Lo gestionamos y te aviso." and hand off `CERTIFICADO_RECIBIDO`. This was an
  explicit owner decision on 2026-09-22 after I had built the opposite; earlier "canal seguro"
  wording is wrong and has been removed wherever found.
- Never ask for SMS codes, Cl@ve PIN, bank data, DNI photos. Never repeat a received password.
- If they refuse to send it: the two options above (juzgado free / partner 35 €).

## Owner's standing rules

- **No mock tests.** Verify live: emulator or real WhatsApp, real Postgres, real model.
- **Reset the demo at the end of every session** (memory file `apod-demo-reset-after-work`):
  `ENV_FILE=.env.wce npx tsx scripts/reset-demo.ts --label "<what was tested>"` — archives the
  chat to `evidence/conversations/`, clears every viewer, sends the presentation.
- The security posture is about protecting the bot *from* clients (injection, data leaks), not
  about refusing the client's own certificate.
- He wants context and memory, not phrase-by-phrase patches ("read the context and answer in a
  logical way"). See the intent layer below — that is the answer to that demand.

## Architecture of a turn (`src/core/conversation-agent.ts`, `decideTurn`)

1. Security gates: stop/opt-out, SMS/PIN refusal, `requiresDeterministicHandoff`, prompt
   injection (`isPromptInjection` in `conversation-policy.ts`).
2. Certificate refusal → `CLIENT_CONSENT_DENIED` → `FALLBACK_OPTIONS`.
3. **Takeover request** ("te envío el certificado y lo haces tú", "do it for me", ES+EN) →
   emits `CLIENT_REQUESTS_ASSISTANCE` with `takeoverRequested: true` so the FSM *moves* into the
   assisted branch. Returning text alone left the state unchanged and caused the tutorial loop.
4. ~60 deterministic branches (bereavement, health, identity doubt, callbacks, lost password,
   "already sent it", "nobody answered", availability, paying the lender, paper signing, Cl@ve,
   what the court said, where to send the password, blockers). Shared wording via
   `takeoverOffer()`.
5. `topic-routing.ts` — is the message about the claim, a charge, a letter, a lender, missing
   documents, scope? Route to `reclamaciones@litigios.es` with the subject named.
6. **Intent layer** (`src/core/conversation-intent.ts`, adapter method `intent()`): if nothing
   above matched, the model reads history + `caseMemory` and returns one of 15 closed intents
   (`DEFER_LATER`, `READY_TO_SEND`, `ASKS_WHERE_TO_SEND`, `ASKS_WHICH_APP`,
   `WANTS_OFFICE_TO_DO_IT`, `REFUSES_TO_SEND`, `STUCK`, `CONFUSED`, `ACK_ONLY`,
   `ALREADY_DID_IT`, `CLAIM_TOPIC`, `PERSONAL_SITUATION`, `ASKS_FOR_CALL`, `DOUBTS_IDENTITY`,
   `OTHER`). `replyForIntent()` holds the approved text per intent. `LOW` confidence → ignored.
   Comprehension is open; wording is closed. Verified live with unseen English phrasings.
7. `conversationYield` (soft acks), `guidanceRequest` (pending-step templates), reviewed
   replies, then `classify()` → workflow option or `respond()` → model free text validated by
   `validateModelReply`.
8. `compound-reply.ts` appends the missing half of a two-part message (cost+timing, purpose+email,
   takeover offer for STUCK, empathy prefix for personal situations, next-step sentence after a
   routing reply, "with them do not negotiate").
9. Repeat guard, then **silent turn**: two bare acks in a row ("vale", "ok") → payload
   `{silent:true, requiresHumanReview:false}` → FSM `hold`. Never send "Perdona la insistencia"
   twice. `event-payloads.ts` allows `silent` without `responseText`.

Memory: `case-memory.ts` (durable facts, passed **per turn** — Codex's design — never on the
agent instance), `historicalCaseMemory` in the worker for messages older than the window.
Redaction: `redactConversationPii` — note the fix that a bare `.p12`/`.pfx` mention is *not*
secret material; the bot's own copy-help text was being redacted into
`[CONTENIDO_SENSIBLE_OMITIDO]` in its own history, which destroyed context. Labelled passwords
without a connector ("password 13245679") are now caught.

Re-engagement: `src/api/server.ts`, inside the phase-3 ingest block — a paused/opted-out case is
resumed when the client comes back with a question, a certificate word or an attachment. Filler
keeps the silence. (First version sat after a `continue` and never ran — check placement if
touching that block.)

## Running it

```bash
# stack: app 4720, bridge+password gate 3001, emulator UI 8080
WCE_PUBLIC_PASSWORD='ApodDemo2026' npm run wce:start          # from APOD-bot
pkill -f "scripts/start-wce.mjs"                              # stop
# public demo (quick tunnel, URL changes on restart)
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3001
# reset / presentation
ENV_FILE=.env.wce npx tsx scripts/reset-demo.ts --label "x"
# live walkthrough through the real webhook -> queue -> worker -> model -> outbox
node scripts/live-walkthrough.mjs "hola" "si" "btn:DEVICE_MOBILE:En el móvil" "btn:NO_PC:No tengo ordenador" "not now"
```

`btn:ID:Title` sends a real quick-reply *with* the context id of the last bot message; consent
buttons are refused without it (that is by design — consent must answer the message that asked).

`scripts/setup-wce.mjs` **regenerates `.env.wce` on every start**, so put demo settings there, not
in the file. It sets `CONVERSATION_QUIET_MS=1000` (production default 60 s, which batches a burst
into one turn) and `CONSENT_VERSION=DEMO-SIMULADOR` (without a version every consent click was
refused and discarded the certificate). Production needs the lawyer-approved version.

Prisma: migrations up to `20260922010000_apud_existing_reminder_anchor` are applied to the demo DB.
After a schema change run `npx prisma generate`.

## Measuring

Offline suites (all pass at `2d4d929`):
`test-manager-findings`, `test-conversation-classifier`, `test-redaction`,
`test-guidance-progression`, `test-conversation-pacing`, `test-conversation-continuity` —
`ENV_FILE=.env.wce npx tsx scripts/<name>.ts`.

Coverage on real client messages:

```bash
for s in 7 11; do ENV_FILE=.env.wce npx tsx scripts/eval-hard-cases.ts --sample=60 --seed=$s; done
```

Samples hard turns from the imported WhatsApp corpus, replays through agent+FSM+model in four
plausible states, GPT judge, **median of three votes** (single votes swung ±8 points on the same
build). The judge rubric was rewritten on 2026-09-22 to score against the firm's protocol —
asking for the certificate is correct, inventing amounts/dates or asking for bank data is not.
Under that rubric: 65% → 78% → **80.8%** (120 messages) after the takeover/empathy rounds. The
intent layer has **not** been re-measured yet; that is the first thing to run. Seed 7 is what most
tuning was done on; seed 11 is the honest held-out number.

`docs/HARD_CASE_COVERAGE.md` records the history. `evidence/hard-case-coverage*.json` hold the
per-case results. `evidence/` is gitignored (client data).

## Known open problems, in priority order

1. **Model improvises interface detail** — "flecha azul", "Mis certificados instalados", "canal
   seguro de entrega" appeared in live logs. None approved. Constrain `validateModelReply` so
   free text is acknowledgement + routing only, and app/UI steps come from the approved guide.
   This is the remaining hallucination class; everything else is template-bound.
2. Re-run the coverage eval on the intent layer; then look at `personal` and `desconfianza`,
   the weakest categories in the last runs.
3. Classifier nondeterminism: the same message sometimes gets an option, sometimes falls to the
   branches. The deterministic layer wins where it matches; widen matches there rather than in
   the model.
4. `README`/docs for the assisted `MOBILE_ASSIST_*` path now that it actually works end to end.

## Gotchas that cost hours

- Every live test found bugs the offline suites cannot: run the walkthrough after each change.
- Silent turns: `CLIENT_SMALL_TALK` without `responseText` was `INVALID_EVENT_PAYLOAD` → escalate
  → pause. Fixed in the schema; keep `requiresHumanReview:false` on silent payloads because the
  webhook may have pre-set it to true and payloads are merged.
- "sí" is an answer, not filler — never treat it as a bare ack.
- The `cobro` guard once blocked a genuine "necesito ayuda" because the client wrote "cobro yo".
  Guards must match actual complaints, not a topic word.
- A named tool problem ("AutoFirma no funciona") gets real troubleshooting first; the takeover
  offer is appended, not substituted (`test-guidance-progression` enforces this).
- The permission classifier in Claude Code frequently blocked builds/evals in this project; the
  owner granted allow rules for the exact commands above. Use those literal forms.

## Related

The WhatsApp connection (Meta app, gateway on Render, the `gateway` transport still to build) has its own handoff: `HANDOFF-whatsapp-connection.md` in https://github.com/SamiAbar30/whatsapp-gateway.
