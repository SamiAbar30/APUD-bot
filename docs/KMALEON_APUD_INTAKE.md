# APUD intake: Sami's macro 24 and 27 avisos

`listPendingApudActa()` discovers the unique Kmaleon `USUARIO` card whose complete name is `ABAR, SAMI`. The user must be active. `SAMI_USER_ID` may optionally pin its numeric card ID; this adds an identity check and does not bypass discovery or the active-user gate. Keep the ID in local configuration rather than committed evidence.

The adapter reads the complete live macro catalogue and requires the reviewed full descriptions:

- **24:** `-- PARA PEDIR APUD Y PAGO DE LOS 50€ AVISAME CUANDO ESTÉ PORFA`
- **27:** `-- A LA ESPERA DE APUD ACTA AVISADME CUANDO ESTE PORFA`

The amount in macro 24 is a catalogue identifier. Intake does not treat it as permission to charge or as a client-facing payment instruction.

The vendor's annotation API exposes text rather than an originating macro code. The adapter reads notices using each macro's first-line text filter, then checks the full canonical catalogue text, exact Sami recipient, pending option `P`, aviso type `R`, empty macro-processing comment, and an open project. It never scans all annotations across all recipients. The macro-specific query may return other recipients' matching notices; those cannot become candidates.

Every page is read before a result is returned. Repeated IDs, changed totals, missing pages, malformed envelopes, and the 1,000-page safety bound fail the complete batch. There is no 250-client truncation. The returned logical page has `hasMore:false` only after the underlying scans complete. Project reads are reused within this scan, but contact identity and the exact triggering notice are read again when resolving a candidate.

Each accepted item includes `externalId`, `projectId`, `source: KMALEON_AVISO`, `macroCode`, `recipientCode`, `macroEvidenceRef`, `recipientEvidenceRef`, and `evidenceRef`. Persist these with the local trigger. Call `resolveTriggerExpediente(item.projectId, item)` before linking/contacting: a different notice on the same project cannot substitute for the original notice, and reassignment/removal/completion causes rejection.

## Live verification on 21 September 2026

Read-only authenticated catalogue and card responses confirmed both macro descriptions and a unique `ABAR, SAMI` user card. The card was inactive (`desactivada: 1`). Intake therefore stops with `KMALEON_SAMI_RECIPIENT_INACTIVE` before reading notices. The user will reactivate the account; the adapter does not change its status. After reactivation, verify the full real scan and exact-notice resolution before enabling the poller.

This verification performed no Kmaleon writes, mailbox access, WhatsApp sends, DB intake, or end-to-end production run. Sensitive card details and the suggested local ID pin stay in ignored `.runtime/` evidence.

`APUD_VERSION=1` is the business-process version and defaults to phase-one client conversation/intake. It is independent of `CONVERSATION_PHASE`, which selects conversation capabilities. `KMALEON_POLLER_ENABLED` stays opt-in.
