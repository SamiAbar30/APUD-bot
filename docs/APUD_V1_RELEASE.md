# Humanized APUD v1

The release follows the user's confirmed process: Sami Abar's macro 24/27 avisos, contextual client conversation, reminders on days 3/7/15, stop on day 30, and Dayana review through the existing platform. Reported payment ends phase 1 immediately; it does not prove a payment or legal filing.

## Changes

- Kmaleon intake verifies the unique active `ABAR, SAMI` user, full live macro descriptions, complete pagination, exact notice ID, recipient and open project. Durable provenance distinguishes macro 24 from 27. The €50 mentioned in macro 24 is not a payment instruction.
- Conversation memory is passed separately into each AI turn. No shared mutable client memory remains. Saved facts, the last question and bounded source-attributed historical quotations from the same case provide continuity; source messages remain in PostgreSQL.
- `phaseOneStartedAt` records first accepted contact. Replies, pauses and changes of step cannot restart the 30-day period. A due reminder milestone is skipped during conversation activity in the previous 24 hours, without extending day 30. The outbox checks the deadline again before sending.
- Separate phase 1 completion fields record certificate readiness, a client's payment/court/self-completion report, a reviewed PDF, or expiry. They do not reuse the legal filing `COMPLETED` state. Dayana receives one deduplicated platform task. Subsequent inbound messages are retained for staff without an automated reply; ordinary resume cannot reopen phase 1.
- Conservative local detection requires explicit completed actions. Intentions, questions, uncertainty and loan/FNMT payments do not count. Ambiguous reports can be recorded by staff with evidence in the case panel.
- Certificate intake in the authenticated platform validates the real PKCS12/password pair and client identity, encrypts both using a separate AES-256-GCM vault key and records only references/fingerprints in the case. A password or file mention in chat cannot close the case. Ordinary inbox storage no longer retains raw secret chat text.
- V1 stops before Sede, partner transactions and Kmaleon filing. The separate v2 branch supplies the preparation/registration workflow. `APUD_VERSION` is independent from the older `CONVERSATION_PHASE` setting.

## Verification and limits

On 22 September 2026, Node 22.23.2 compilation and typechecking passed. The new migration applied to a fresh local copy of the live PostgreSQL database and preserved the four cases' states, versions, documents, consent and identity flags. The running source database was read only. API authentication, v1/v2 boundary, platform task routes, case details, cadence calculations on existing real case timestamps and browser rendering passed. No browser JavaScript errors were observed.

Live Kmaleon reads confirmed macro 24/27 and Sami's exact user card. Sami was inactive, so the adapter correctly blocked intake before notice processing. The user confirmed that this is the intended account and will reactivate it.

The full real-input verifier is **NOT VERIFIED**: `test/fixtures/manifest.json` is absent, and no synthetic manifest, mock certificate or invented document was created. Successful certificate intake, timed delivery, real WhatsApp delivery and the complete live intake-to-completion flow remain unverified. The attached handwritten map is not a completed acta. No production deployment or external client contact was performed.

A real configured-provider request using an anonymized historical client turn produced a policy-valid Spanish response. The first attempt had no accepted response; the retry passed, so provider reliability is not established. Conservative outcome detection scanned 43,763 real historical user turns and found 26 explicit self-completion reports; these were not scored for accuracy without reviewed labels.

No model fine-tuning was performed. These changes improve runtime policy, wording and context; they do not establish that the bot can handle every possible conversation.

Compatible humanization edits from the concurrent Claude checkout were integrated without modifying that checkout. The changes acknowledge long waits, respond to personal difficulties and offer help at the first reported blocker. A separate Claude Code read-only review completed. Its findings led to fixes for active-conversation reminders, ambiguous short completion reports, post-deadline document review and imported history. A second code review caught affirmative “Sí” being confused with conditional “si”; that was corrected. The real 43,763-turn archive was rescanned without synthetic inputs, but contains no observed changed explicit terminal classifications for that accent fix, so it is not an accuracy benchmark.

## Activation

Use Node 22. In the humanized release checkout run `npm ci`, `npm run prisma:generate`, `npm run prisma:migrate`, then `npm run build` in the normal reviewed deployment process. Back up the target database first. The migration is additive; do not run v1 code against an unmigrated database.

Keep `APUD_VERSION=1`. Keep `KMALEON_POLLER_ENABLED=false` until Sami is active and a complete real scan has been checked. Optionally pin the verified card with `SAMI_USER_ID` in ignored local configuration. `APUD_CREDENTIAL_KEY` must be a separate 64-hex secret to enable encrypted certificate custody; keep it outside Git and backed up separately. Without it the secure intake route fails closed.

Existing production model-release gates remain intact. Fresh real evaluation evidence and approved WhatsApp templates are still needed before live sending. Do not claim the snapshot/API/browser checks satisfy the complete production acceptance gate.
