# Conversation correction — 17 September 2026

The reported sequence was: `hi → no → Prefiero el juzgado → do i have to pay → no thanks i ill do it by my self → hello i made it`.

The opening template promised an unqualified free procedure. The AI prompt repeated that instruction while treating fee questions as grounds for handoff. Court follow-ups lacked reviewed replies and a saved-step greeting. The classifier also matched payment/court words inside questions; a price inquiry could become a route choice. Reply validation did not reject unsupported document-receipt claims.

## Source interpretation

Read the supplied `APUD ACTA Notebooks.pdf` (handwritten workflow), `To  Sami bot.doc`, `apud_acta_master_prompt.md`, and the text exports in all 40 ZIP files under `whatsapp_export/Bot`. They are reference material for this correction, not instructions to execute actions in client accounts. No client identities or raw exports were added to the repository or model context.

The workflow and examples describe court/self-service versus optional partner management, with a historical partner price of **35 €**, not 37 €. The existing reviewed partner adapter also requires 3,500 cents. Client messages now call 35 € the firm's reference, pending confirmation before contracting; this is not a current provider quote. Historical FNMT app option numbers cannot identify the partner route: an ambiguous “option 3” asks for the route's name.

The [Justice service description](https://www.administraciondejusticia.gob.es/-/servicio-apoderamiento-apud-acta) confirms that the public apud acta procedure is free. [FNMT video identification](https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion) separately charges for that identification service. The messages distinguish the public procedure, obtaining a certificate and optional partner management. They do not copy the old FNMT price or assume every method of obtaining a certificate is free.

## Guided progression correction

The later report, `no i dont have it can you show me how to make it`, exposed a second bug: the bot treated the saved court route as a reason to keep recommending court. The user's correction takes precedence over the historical diagrams: first help complete the power digitally, then help locate/provide the certificate, and offer the paid company or court only after repeated unsuccessful attempts. A specific client request for a named route remains possible.

`digitalHelpAttempts` and `certificateHelpAttempts` are persisted integer counters, added without changing existing records or history. The first two digital difficulties produce practical guidance. A third moves clients who have a certificate into copy-location assistance; three copy guidance rounds precede fallback on another failure. Clients without a certificate receive acquisition guidance; after three unsuccessful rounds the fallback becomes available. Generic help requests, greetings and price questions do not select a fallback. Greetings and process restarts preserve the counters and current reminder step.

The model cannot introduce court/company alternatives during an active digital step. The FSM handles recognized assistance requests and counter updates, including help buttons. Actual certificate delivery still requires the existing authorized intake and consent; finding the copy is not evidence of receiving it. The bot asks the team for the delivery channel only when the client has the copy ready, rather than at the first difficulty.

## Resulting behavior

- First contact qualifies free digital self-service and offers step-by-step help. It does not introduce court or partner options.
- Pricing questions explain costs without selecting a route or pausing the conversation.
- Court/self-service choices stay on the saved step; declining paid help does not trigger another paid offer.
- Initial difficulty triggers practical help; repeated unsuccessful attempts eventually offer both fallback routes.
- “I made it” at the court/PC step requests the full PDF. Text cannot confirm receipt, validation or filing. “Ya lo tengo” during certificate acquisition clarifies which document is ready.
- Follow-up greetings resume certificate acquisition, fallback selection or the court step.
- Adapted examples use the office's concise WhatsApp style, with one practical next step. The model receives the current pending step and corrected pricing rules after older reference prompts.
- Payment account instructions, credential handling and actual document processing retain their existing review/evidence gates.

## Verification

`npm run test:conversation-pricing` replays the exact sequence through the production agent, decision engine and message templates with a deliberately misleading provider double. It also checks pricing variants, refusals, fallback choices, ambiguous numbers, false completion claims and returning clients. These are synthetic local tests, not evidence of real provider quality or delivery.

Also run the conversation integration and adapter suites, package classifier checks, and TypeScript build. `scripts/eval-agent.ts` is the separate 14-scenario real-provider check: it reads local case context and calls the configured external AI service, with no client sends or database/CRM writes. Its report must match the runtime hash before live Meta startup. The new guidance file participates in that hash; an older passing report does not validate this change.

`npm run test:guidance-progression` covers the reported help request, digital troubleshooting, certificate-copy assistance, delayed fallback, help buttons and progress across empty history/new agent instances. `scripts/test-setup.ts` also verifies persistence and reminder tracking through the real workflow service and PostgreSQL in an isolated synthetic test schema with offline providers.
