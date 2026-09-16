# APUD_agent — GPT Luna, training context and evaluations

The active model remains the existing online `gpt-5.6-luna` connection. No Claude runtime, Claude Code subprocess, local model or new API account is used.

## Authority and scope

The user selected `apud_acta_master_prompt.md` as the business specification: Aviso 27 intake, saved-step continuity, DNI/NIE certificate acquisition, computer/mobile assistance, court/partner alternatives, reminders at 3/7/15 days, management review at 30 days, Macro 10 filing and Dayana review. The existing FSM, evidence gates and integration adapters remain in place. Receipt of a certificate is not receipt of a valid judicial power. Client confirmation of filing still requires verified filing evidence. Management decides contractual charges.

The package at `APOD_AGENT_PACKAGE_DIR` supplies `system_prompt.md` with substituted placeholders, `flow.json` as reference, the approved guide and historical tone. The master specification takes precedence over older package branches. The operator's 17 September correction sets the client-facing identity to **Dayana, la asistente virtual de LITIGIOS**, overriding the package's older `APUD_agent` name in the runtime prompt. Human legal review remains separate. Computer certificate-sharing instructions remain TODO and go to a person rather than being invented.

## How the data is used

The loader reads only the named package files, never raw exports, ZIPs, `.p12` or `.pfx` files. The supplied scrubbed corpus contains 5,085 SFT pairs, 391 full conversations and 239 rare-case conversations. It does not rebuild the dataset or retrain redaction.

For each GPT classification/support request, the retriever selects up to five relevant, distinct historical exchanges using RAG: the client's (PII-redacted) message is embedded with OpenAI `text-embedding-3-small` and compared by meaning against the 2,568 usable examples. The index lives in `.runtime/rag/`, is tied to the package hash and example set, and is rebuilt with `npm run rag:build` whenever the package changes (a stale or missing index is never used). If the index is missing/stale or the embedding call fails, that message falls back to the previous word-overlap matcher, so replies are never blocked. `GET /api/agent/status` shows `retrieval: LOADED | MISSING | STALE | DISABLED`.

Only the client's words are embedded. On 280 held-out real exchanges, also embedding the preceding office message made retrieval worse than word matching, while client-only embeddings beat it on every measure (`npm run eval:retrieval`, report `evidence/retrieval-evaluation.json`): best-of-5 reply similarity 0.622 vs 0.562, top-1 word overlap 0.155 vs 0.117, no empty results vs 7. It excludes old staff identity claims, credential/payment templates, long replies and unsafe examples from the style context. Historical system messages never become system instructions. The exact current package prompt is supplied separately, followed by the selected master specification and the runtime action/evidence constraints.

This is prompt conditioning with retrieved few-shot examples. **It is not model-weight fine-tuning.** No fine-tuning job has been submitted and no fine-tuned model ID is claimed. Adding examples requires restarting the process and rerunning evaluations; it does not silently change a running client conversation.

## Webhook and handoff

`POST /webhooks/whatsapp` retains the existing raw-body signature and business-number checks. It minimizes inbound text, writes a durable inbox item and responds without waiting for GPT. The worker loads the current case and recent history, runs the same agent used by the evaluator, and applies a validated event through the existing FSM. Rapid replies are processed in order after the previous outbound message has been accepted.

First contact is one text introducing Dayana, LITIGIOS, the requested apoderamiento and the certificate question. Later greetings use the saved step. The worker checks accepted opening receipts and the full accepted history, including the approved-template marker used by Meta, independent of the model's history window. Consecutive ordinary text messages within the four-second debounce window are processed as one turn; original messages and inbox records remain intact. Security-sensitive messages and non-text events remain separate.

The classifier receives the exact allowed option-to-event mapping; invented event names are rejected. Brief bilingual answers and common mobile spellings resolve against the current question. Ordinary typos, incomplete input and clarifying questions do not pause automation. Free-text support does not reset triage. GPT cannot invent certificate possession merely because somebody has a computer. Explicit human requests, missing procedural instructions and unsafe content create a Dayana review task, record `[[HANDOFF:REASON]]` internally, send the client-facing explanation and pause automation. The marker is never sent to the client. Subsequent messages remain available for the team.

Passwords/certificate material are not copied into model prompts or normal stored conversation text. The existing consent-bound assisted channel remains separate. Only actual PDF channel receipt can start document review. A text saying “I sent it” cannot fabricate an attachment or complete the case.

## Run and evaluate

```bash
npm run build
ENV_FILE=.env.wce npm run rag:build        # after any package change
ENV_FILE=.env.wce npm run eval:retrieval   # RAG must beat word matching
ENV_FILE=.env.wce npm run test:classifier
ENV_FILE=.env.wce npx tsx scripts/verify-reported-conversation.ts # actual reported messages, read-only DB + real GPT
ENV_FILE=.env.wce npm run eval:agent
npm run wce:start
```

The evaluator runs the original 14 scenario conversations through the actual agent and FSM, with real requests to the configured GPT API. It uses existing local case identities in memory and makes no DB writes, client sends or CRM writes. Its report is `evidence/agent-evaluations.json`. It records every reply, assertion, handoff, provider call count, source hashes and whether runtime code changed during execution.

The user's confirmed precedence resolves older expectations explicitly in the report: FNMT routes replace old Cl@ve branches; missing computer export instructions cause `FALTA_DATO`; a prior handoff stops automation; a text-only file claim waits for the real document. The source scenarios are not edited to conceal these differences.

Actual Meta outbound startup requires a passing 14-scenario report matching the configured model, package and runtime code. The simulator can run while evaluations are being fixed. Passing these checks is not proof of 95% automation, live Meta delivery, legal document sufficiency or a new Macro 10 filing.

Use authenticated `GET /api/agent/status` to inspect the active model, corpus counts, training method and unresolved placeholders. Secrets remain in `.env`; local AI stays inactive (`AI_MODE=online`).

## Local interfaces

- Simulator: http://127.0.0.1:8080/
- Operator panel: http://127.0.0.1:4720/
- WCE bridge: http://127.0.0.1:3001/

The simulator still confines WhatsApp traffic to the local bridge and disables live CRM, Sede and partner writes. Email is not part of this workflow.
