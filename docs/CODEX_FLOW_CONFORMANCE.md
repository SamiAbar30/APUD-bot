# Approved-flow conformance audit

Date: 2026-09-18. Scope: the current working tree on `main`, HEAD `b2eb3523754030e86f1480b8252f23ae2c08253e`, including pre-existing uncommitted changes. This is a source-code audit, not an audit of HEAD alone or proof of the deployed bot's behavior. No application, model, database, messaging, or external-service test was run. No mock or synthetic test was used. Only this report was written.

**Verdict: the bot does not fully implement the supplied schema.** It represents the main certificate/device routes, document review, and completion, but merges distinct schema branches, substitutes different assistance/payment paths, and lacks some required transitions. In the Head of Claims path, the free-court/optional-€35 fallback exists, but a separate “file located” turn can put the case on human hold before the refusal arrives. That later refusal cannot automatically reach the fallback.

## Evidence and interpretation

The inventory below covers **20 nodes, all 24 explicit node transitions** (`next`, `on`, `on_event`), **8 global intents, 6 handoff reasons, and all 22 FSM states**. Terminal flags and handoff actions are covered in the node and handoff tables. `states.ts:5` still says “21”; the actual enum contains 22.

Reference abbreviations below always mean the following exact files; suffixes are one-based source line numbers:

| Reference | File |
| --- | --- |
| FLOW | `/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento/flow.json` |
| MASTER | `docs/source/apud_acta_master_prompt.md` |
| FSM | `src/domain/fsm/state-machine.ts` |
| ENGINE | `src/core/decision-engine.ts` |
| MSG | `src/core/messages.ts` |
| STATES | `src/domain/fsm/states.ts` |
| ACTIONS | `src/domain/fsm/actions.ts` |
| AGENT | `src/core/conversation-agent.ts` |
| POLICY | `src/core/conversation-policy.ts` |
| GUIDANCE | `src/core/conversation-guidance.ts` |
| SERVICE | `src/core/workflow-service.ts` |
| FOLLOWUP | `src/core/follow-up.ts` |

**MATCH** means a semantic counterpart exists; a separate state for each JSON node is not required. **DIVERGENT** means related behavior exists but its routing, content, conditions, or effects differ. **MISSING** means the specified distinction/action/transition has no implementation in the inspected route. A missing literal enum name alone is not treated as a missing behavior. Added review/evidence gates are identified as extensions, not recommendations to remove them.

All ordinary transition mappings assume a valid event payload and a verified, active case. `ENGINE:101–118` can retain the old state and withhold an outbound action when identity is unverified; `SERVICE:202–214` stops ordinary text processing when automation is paused. `ENGINE:210–241` delegates routing to `transition()` and enforces invariants; it does not translate JSON node names into FSM states.

The flow is loaded and structurally validated by `src/core/package-agent/package.ts:6–21`, but the audited engine uses the hard-coded `STATE_HANDLERS` and dispatch at `FSM:1196–1219,1291–1331`. Loading the package is not evidence that its branches are executed.

### Differences between the two approved sources

| Subject | `flow.json` | Master prompt / current implementation consequence |
| --- | --- | --- |
| Cannot/will not obtain certificate | `A_clave_no_firma.no_puede_o_no_quiere` goes to `A_procurador_firma`: procurator signs, human handoff (`FLOW:35,39–43`). | Master requires **both fallback options** for DNI/NIE failure (`MASTER:69–79,99–103`). There is no procurator-signing branch in the FSM. This is a schema/master difference as well as a missing JSON branch. |
| Cannot/will not share certificate | Both JSON assistance nodes expose only `envia_certificado_y_contrasena` (`FLOW:71–92`). There is no refusal edge. | Master explicitly requires dual fallback for desktop refusal and mobile failure (`MASTER:85–95,99–103`); the user's requested Head of Claims outcome makes this requirement explicit. The refusal gap therefore cannot be judged from JSON alone. |
| Court and partner | JSON mentions a company doing the complete procedure and routes paid selection to a terminal `HANDOFF_PAGO` (`FLOW:94–98,119`). No court-selection or partner-processing node exists. | Master explicitly requires free court and approximately €35 partner routes. `FALLBACK_OPTIONS`, court guidance and partner-processing states extend JSON and partly implement Master. |
| Cl@ve | JSON explicitly says Cl@ve PIN cannot sign (`FLOW:9,29–31`). | Master initial-triage wording lists Cl@ve alongside certificates (`MASTER:32`). Current model instructions say Cl@ve PIN cannot sign (`src/adapters/ai/openai-compatible-conversation.ts:205`), but deterministic triage does not preserve the JSON Cl@ve branch. |
| Credential delivery | JSON asks for the certificate password in a separate message (`FLOW:74,91`); Master also specifies certificate/password assistance (`MASTER:85–95`). | Current templates require consent and a manager-provided secure channel, and warn against passwords in chat (`MSG:54–59,136`; `AGENT:213–229`). This changes the specified delivery behavior; this audit does not recommend weakening the safeguards. |

The model adapter itself declares the master authoritative over older training branches and keeps actions under the runtime FSM (`src/adapters/ai/openai-compatible-conversation.ts:265–267`). This explains part of the difference; it does not make the missing JSON branches conformant.

## Head of Claims path

This is a **static trace of separately processed turns**, not a replay of the historical conversation. The user supplied the semantic path, not its exact stored transcript. Text matching and batching can change which event is produced; the evidence below distinguishes deterministic paths from model-dependent input.

| Client step | Event and persisted result | Conformance / exact evidence |
| --- | --- | --- |
| Tiene certificado | `CLIENT_HAS_CERT` → `WAITING_CERT_RESPONSE`, `hasDigitalCert=true`; ask device. | **MATCH.** `FSM:289–292,413–416`; `MSG:51`. |
| En el móvil | `CLIENT_HAS_CERT_MOBILE` → `MOBILE_TRIAGE_PC_CHECK`, `certDevice=MOBILE`; ask about computer. | Mobile route represented, with an extra PC-availability question before JSON's installation guide. `FSM:294–300,420–421`; `MSG:52`. |
| No tiene ordenador | `CLIENT_HAS_NO_PC` is intercepted by `guidedHelp()`; **stays `MOBILE_TRIAGE_PC_CHECK`**, increments help counters, emits `CERTIFICATE_COPY_HELP`. | `FSM:1328–1329` runs **before** state handlers. With a certificate, `FSM:346–361` takes the copy-help branch immediately. The apparent consent transition at `FSM:424–427` is bypassed here. `MSG:85–92` tells the client to open the certificate app. |
| No tiene la app | There is no app-absent event, state or persisted fact. Exact text such as “no tengo la app” has no dedicated local classification; it may go through the model or conversational fallback. If interpreted as assistance/failure, it only increments counters in the same state. | **MISSING distinction.** Vocabulary `STATES:128–160`; case fields `src/domain/models/expediente.ts:43–86`; local options `POLICY:145–148`; guidance detection `GUIDANCE:39–54`. The copy templates continue saying open/export from the app at `MSG:88–92`, including at later attempts. No deterministic branch acknowledges that the app is unavailable. |
| Localiza el archivo | A separate “ya tengo el archivo”, “ya encontré la copia”, or corresponding recognized phrase, with `certificateHelpAttempts>0`, produces `CLIENT_SMALL_TALK` with `requiresHumanReview=true`, `handoffReason=FALTA_DATO`. “Sí” also does this at exactly two copy-help attempts. | **DIVERGENT for the requested continuation.** `AGENT:258,271`; `FSM:1253–1260` → `ESCALATED_HUMAN`. It assumes locating the file is sufficient to hand off, before recording willingness to send it. `SERVICE:64–65` persists `automationPaused=true`. |
| Después NO quiere enviarlo | Normal service processing sees the pause and records the text for a person; it does not call the agent to choose a route. Even if `CLIENT_CONSENT_DENIED` is supplied directly to the engine, `ESCALATED_HUMAN` retains its state. | **DIVERGENT: no automatic dual fallback after the separate found-file handoff.** `SERVICE:202–214`; `FSM:1167–1192`; `ENGINE:196–197`. Only `OPERATOR_RESUME` can leave that hold. |
| Required result | Free court **or** optional partner around €35. | The desired content is implemented in `MSG:46` and selection handlers at `FSM:1210`. The gap is reaching it after the premature handoff, not absence of the fallback wording/state. |

**Important qualifying paths:**

- If refusal arrives **before** the found-file handoff and is recognized as `CLIENT_CONSENT_DENIED`, the mobile triage/export handlers delegate to `triageAnswer()` and reach `FALLBACK_OPTIONS` (`FSM:434–441,461–483`). Refusal in `MOBILE_ASSIST_CONSENT_REQUESTED` also reaches it (`FSM:496–497`). These implemented transitions must not be reported as missing.
- If file-found and refusal are in the **same processed turn**, the explicit refusal check at `AGENT:205–209` precedes the file-found check at `AGENT:258`, so a matching refusal can win. Service batching is conditional (`SERVICE:188–198`); it does not rescue separately processed turns.
- The explicit refusal matcher at `AGENT:207–209` includes “no quiero enviarlo”: `enviar` matches the verb prefix and the final `lo` satisfies its `lo\b` alternative. Thus that wording can reach fallback **before** the handoff; its later arrival in a paused case is the decisive problem. This is a source inspection finding, not a claimed live classifier result.
- Desktop copy-help remains in `PC_TUTORIAL_SENT` or `WAITING_PDF_SUBMISSION`; their shared handler has **no `CLIENT_CONSENT_DENIED` case** (`FSM:648–670`). That event falls to `NO_OP + UNEXPECTED_EVENT` (`FSM:1269–1274`). The mobile refusal implementation does not cover desktop refusal.
- During `MOBILE_ASSIST_PROCESSING`, refusal instead escalates with `CONSENT_DENIED` (`FSM:636–640`), rather than showing both alternatives. This differs from the earlier consent-request state's behavior.

## Conformance table: every JSON node

| # | JSON node and source | FSM state / implementing event(s) | Result and evidence |
| --- | --- | --- | --- |
| N01 | `I_necesita_apoderamiento` (`FLOW:15–19`) | `INITIAL_TRIAGE + CASE_OPENED` → `WAITING_CERT_RESPONSE`; `ASK_HAS_CERT`. | **MATCH, merged opening.** Introduction and initial question are one message (`FSM:282–284,447–450`; `MSG:22–24,50`). There is no separate persisted introduction node. |
| N02 | `II_tiene_certificado` (`FLOW:20–28`) | `WAITING_CERT_RESPONSE`; `CLIENT_HAS_CERT`, `CLIENT_HAS_NO_CERT`, device-specific answers. | **DIVERGENT.** Yes is represented; `no_pero_clave` and `no_ni_clave` both reduce to `CLIENT_HAS_NO_CERT` and certificate acquisition (`FSM:413–429`; `POLICY:113,216–218`). |
| N03 | `A_clave_no_firma` (`FLOW:29–38`) | Closest: `CERT_ACQUISITION_LINKS_SENT` after `CLIENT_HAS_NO_CERT`. | **MISSING distinct Cl@ve node.** Acquisition is chosen by DNI/NIE, not Cl@ve possession (`FSM:324–338`). Templates do not render the required Cl@ve-cannot-sign explanation (`MSG:95–99`); model instructions alone mention it. Four JSON choices are not represented as this node's choices. |
| N04 | `A_procurador_firma` (`FLOW:39–44`) | No specific state/event. Closest generic handoff: `CLIENT_REQUESTS_HUMAN` → `ESCALATED_HUMAN`. | **MISSING.** No procurator-signing message/action. `CLIENT_CANNOT_GET_CERT` sends the court checklist instead (`FSM:430–431,939–940`); generic handoff only promises review (`FSM:1245–1248`; `MSG:125`). Source conflict with Master's fallback is noted above. |
| N05 | `A2_nie_ayuntamiento` (`FLOW:45–49`) | `CERT_ACQUISITION_LINKS_SENT` with NIE-specific template; `CLIENT_CERT_ACQUIRED` / `CLIENT_HAS_CERT` → device question. | **MATCH for the main behavior, merged state.** `FSM:324–338,930–938`; `MSG:98`. A declared NIE can also select guidance through `guidanceDocumentType`; it is not a separate FSM node. See T08 for the limitations of the incoming `nie` edge. |
| N06 | `B_movil_u_ordenador` (`FLOW:50–54`) | `WAITING_CERT_RESPONSE` with `hasDigitalCert=true`; PC/mobile events. | **MATCH.** Persistent flag distinguishes the device question from initial certificate triage (`FSM:289–300,413–421,452–456`; `MSG:51,142`). |
| N07 | `B1_1_pdf_procuradores` (`FLOW:55–64`) | `PC_TUTORIAL_SENT`; entered via `CLIENT_HAS_CERT_PC` or `CLIENT_EXPORT_SUCCEEDED`. | **DIVERGENT content/assistance edge.** Tutorial plus representatives are requested (`FSM:302–306`), AutoFirma and Sede certificate entry appear (`MSG:66`), but **incognito is absent from the outgoing template**. The attached configured tutorial's contents were not audited. Stuck behavior differs (T13). |
| N08 | `B1_1_1_apud_acta_recibido` (`FLOW:65–70`) | `CLIENT_PDF_RECEIVED` → `AUDITING_DOCUMENT`, internal `PDF_AUDIT`. | **DIVERGENT.** Actual document reference is required; the route creates an operator-review task, but the engine does not send the specified immediate “Recibido… lo revisamos” acknowledgment or use `APUD_ACTA_RECIBIDO` as its transition reason (`FSM:384–400,651–652`; `SERVICE:81–84`). |
| N09 | `B1_2_1_como_enviar_certificado` (`FLOW:71–76`) | Closest ordinary route: still `PC_TUTORIAL_SENT` / `WAITING_PDF_SUBMISSION`, help counters. Nominal assistance states also exist. | **DIVERGENT.** Stuck is intercepted into step/copy guidance (`FSM:345–367,1328–1329`), rather than entering the specified certificate/password delivery node. The nominal consent edge at `FSM:653–654` is shadowed. Templates use secure-channel assistance, not separate-message password delivery (`MSG:54–59,81–93`). |
| N10 | `B1_2_2_certificado_recibido` (`FLOW:77–83`) | Closest: `MOBILE_ASSIST_PROCESSING + CLIENT_CERT_FILE_RECEIVED(certRef)` → same state, certificate inspection; service creates Dayana task. | **DIVERGENT.** Certificate arrival does not directly produce the schema acknowledgment and `WAIT_CONFIRMACION`; it starts inspection/draft/review/submission machinery (`FSM:512–635`). `SERVICE:71,81–84` records secure assistance and creates a review task. Raw credential disclosure can instead cause a generic human hold (`AGENT:213–217`). |
| N11 | `B2_1_instalar_en_ordenador` (`FLOW:84–88`) | `MOBILE_TRIAGE_PC_CHECK` first; `CLIENT_HAS_PC` → `MOBILE_EXPORT_GUIDE_SENT`. | **DIVERGENT sequence, main route represented.** JSON sends installation instructions immediately; FSM first asks PC availability (`FSM:294–313,422–427`; `MSG:52–53`). Successful installation reaches desktop tutorial. No-PC/stuck is intercepted into guidance. |
| N12 | `B2_2_1_como_enviar_certificado_movil` (`FLOW:89–93`) | Closest: same mobile triage/export state plus copy-help counters; nominal consent/processing states. | **DIVERGENT.** No direct mobile-specific certificate/password delivery node after failure (`FSM:345–367,1328–1329`). `MSG:81–93` supplies copy-location help; `MSG:58` defers delivery to a manager. Found-file handoff interrupts later refusal (`AGENT:258`). |
| N13 | `RARO_sin_certificado_ni_clave` (`FLOW:94–99`) | `CLIENT_HAS_NO_CERT` → `CERT_ACQUISITION_LINKS_SENT`. | **DIVERGENT, merged with N03.** No distinction for “neither”. DNI template lists DNIe/video routes; NIE gets Ayuntamiento. It does not render the JSON's differentiated online-certificate/company options as a complete menu (`FSM:331–338`; `MSG:95–99`; `POLICY:216–218`). |
| N14 | `WAIT_DOCUMENTO_APUD_ACTA` (`FLOW:100–104`) | `WAITING_PDF_SUBMISSION + CLIENT_PDF_RECEIVED` → audit; ordinary self-service also waits in `PC_TUTORIAL_SENT`. | **MATCH for document waiting/receipt, merged normal route.** `FSM:628–635,648–670,783`; `MSG:35–36,158`. **JSON has no incoming edge to this node**; absence of an exact ordinary entry transition is not independently a bot defect. |
| N15 | `WAIT_CLIENTE_OBTIENE_ACCESO` (`FLOW:105–109`) | `CERT_ACQUISITION_LINKS_SENT`; `CLIENT_CERT_ACQUIRED` / `CLIENT_HAS_CERT` → `WAITING_CERT_RESPONSE` with certificate flag. | **MATCH for wait/resume, merged with acquisition guidance.** `FSM:930–946`. There is no separate “selected acquisition, now waiting” state/event, and the exact acknowledgment is not a dedicated template (`MSG:95–99`; `GUIDANCE:15–23`). |
| N16 | `WAIT_CONFIRMACION` (`FLOW:110–113`) | Closest composite: `AUDITING_DOCUMENT` → `KMALEON_FILING` → `HANDOFF_DAYANA`. | **DIVERGENT.** Generic team confirmation is replaced by operator document approval and verified external-effect events (`FSM:672–760,801–830,1102–1139`). `APODERAMIENTO_CONFIRMADO` is absent from `STATES:121–199`. Certificate-assisted work follows a different path before reaching audit. |
| N17 | `FIN_cierre` (`FLOW:114–118`) | `HANDOFF_DAYANA + CLIENT_NOTIFICATION_DELIVERED` → `COMPLETED`; notice is sent earlier on `DAYANA_NOTIFIED`. | **DIVERGENT trigger, represented terminal outcome.** `FSM:1111–1139,1156–1164`; `ENGINE:188–195`; `MSG:120–123`. Exact `MENSAJE_CIERRE` substitution is not used by these templates; its external placeholder value is outside this audit. |
| N18 | `HANDOFF_PAGO` (`FLOW:119`) | Payment questions can become `CLIENT_SMALL_TALK(requiresHumanReview=true,PAGO)` → `ESCALATED_HUMAN`; paid-route selection → `APUDATA_PENDING_PREAPPROVAL`. | **DIVERGENT by entry branch.** Invoice/transfer questions hand off (`AGENT:220,271`; `FSM:1260`); `opcion_pago` selection starts partner automation instead of the JSON terminal handoff (`FSM:369–381,941–942`). |
| N19 | `HANDOFF_HUMANO` (`FLOW:120`) | `CLIENT_REQUESTS_HUMAN`, or human-review conversational reply → `ESCALATED_HUMAN`. | **MATCH for active cases.** `FSM:1245–1248,1260`; `AGENT:219,271`; `MSG:125`. Human hold stops automatic progress but permits authenticated resume (`FSM:1167–1192`); it is not irreversible completion. |
| N20 | `HANDOFF_DESCONFIANZA` (`FLOW:121`) | No dedicated event/state; generic human hold can carry conversational metadata. | **MISSING deterministic persistent-distrust routing.** `AGENT:257` responds with reassurance and `requiresHumanReview=false`; no persisted distrust count exists. Repeated matches do not reach the model's handoff instruction. `FSM:1253–1261` only sees the reply/human-review flag. |

## Conformance table: every explicit JSON transition

These 24 rows enumerate every `next`, `on` and `on_event` entry; no wildcard stands in for an omitted branch.

| # | Source node · branch → target node | FSM state + event → result | Assessment / evidence |
| --- | --- | --- | --- |
| T01 | `I_necesita_apoderamiento` · `next` → `II_tiene_certificado` | `INITIAL_TRIAGE + CASE_OPENED` → `WAITING_CERT_RESPONSE`, combined introduction/question. | **MATCH.** `FLOW:18`; `FSM:282–284,447–450`; `MSG:24,50`. |
| T02 | `II_tiene_certificado` · `si` → `B_movil_u_ordenador` | `WAITING_CERT_RESPONSE + CLIENT_HAS_CERT` → same state, `hasDigitalCert=true`, device question. | **MATCH.** `FLOW:24`; `FSM:289–292,413–416`. |
| T03 | `II_tiene_certificado` · `no_pero_clave` → `A_clave_no_firma` | `CLIENT_HAS_NO_CERT` → `CERT_ACQUISITION_LINKS_SENT`. | **DIVERGENT.** No Cl@ve-specific branch/explanation; same event as T04. `FLOW:25`; `POLICY:113`; `FSM:324–338,428–429`. |
| T04 | `II_tiene_certificado` · `no_ni_clave` → `RARO_sin_certificado_ni_clave` | `CLIENT_HAS_NO_CERT` → `CERT_ACQUISITION_LINKS_SENT`. | **DIVERGENT.** No “neither” distinction/menu. `FLOW:26`; `POLICY:216–218`; `MSG:95–99`. |
| T05 | `A_clave_no_firma` · `quiere_sacar_certificado` → `WAIT_CLIENTE_OBTIENE_ACCESO` | Closest: remain in `CERT_ACQUISITION_LINKS_SENT`; route explanations/acknowledgments use `CLIENT_SMALL_TALK`. | **DIVERGENT, merged wait.** No distinct selection event; agent describes DNIe/video without changing acquisition state. `FLOW:33`; `AGENT:235–246,271`; `FSM:930–950,1253–1261`. |
| T06 | `A_clave_no_firma` · `opcion_pago` → `HANDOFF_PAGO` | `CERT_ACQUISITION_LINKS_SENT + CLIENT_REQUESTS_URGENT_PAID` → `APUDATA_PENDING_PREAPPROVAL`. | **DIVERGENT.** Partner call replaces terminal payment handoff. `FLOW:34`; `FSM:369–381,941–942`. |
| T07 | `A_clave_no_firma` · `no_puede_o_no_quiere` → `A_procurador_firma` | Closest `CLIENT_CANNOT_GET_CERT` → `COURT_FALLBACK_GUIDE_SENT`; ordinary difficulty may instead stay in guidance. | **MISSING requested procurator route.** `FLOW:35`; `FSM:939–940,1328–1329`; no corresponding message at `MSG:95–100,125`. |
| T08 | `A_clave_no_firma` · `nie` → `A2_nie_ayuntamiento` | Acquisition selects NIE from identity or `guidanceDocumentType`; declaration can produce `CLIENT_REQUESTS_ASSISTANCE` and NIE guidance while holding state. | **DIVERGENT edge, NIE content present.** No `nie` event or Cl@ve parent node. `FLOW:36`; `FSM:324–338,363–365`; `GUIDANCE:26–33,46–54`; `MSG:71–73,98`. The declaration is conversational guidance, not a persisted identity update. |
| T09 | `A2_nie_ayuntamiento` · `ya_tiene_certificado` → `B_movil_u_ordenador` | `CERT_ACQUISITION_LINKS_SENT + CLIENT_CERT_ACQUIRED` / `CLIENT_HAS_CERT` → `WAITING_CERT_RESPONSE`, ask device. | **MATCH.** `FLOW:48`; `FSM:930–938`. |
| T10 | `B_movil_u_ordenador` · `ordenador` → `B1_1_pdf_procuradores` | `WAITING_CERT_RESPONSE + CLIENT_HAS_CERT_PC` → `PC_TUTORIAL_SENT`. | **MATCH routing; N07 content gap remains.** `FLOW:53`; `FSM:302–306,417–419`. |
| T11 | `B_movil_u_ordenador` · `movil` → `B2_1_instalar_en_ordenador` | `CLIENT_HAS_CERT_MOBILE` → `MOBILE_TRIAGE_PC_CHECK`; only subsequent `CLIENT_HAS_PC` sends export guide. | **DIVERGENT sequence.** `FLOW:53`; `FSM:294–313,420–423`; `MSG:52–53`. |
| T12 | `B1_1_pdf_procuradores` · `envia_apud_acta` → `B1_1_1_apud_acta_recibido` | `PC_TUTORIAL_SENT + CLIENT_PDF_RECEIVED(documentId,sha256)` → `AUDITING_DOCUMENT`. | **DIVERGENT acknowledgment/handoff; receipt processing exists.** `FLOW:63`; `FSM:384–400,651–652`; `SERVICE:81–84`. |
| T13 | `B1_1_pdf_procuradores` · `atascado` → `B1_2_1_como_enviar_certificado` | `CLIENT_REQUESTS_ASSISTANCE` / `CLIENT_EXPORT_FAILED` → same state, step guidance then copy guidance; repeated failure can reach `FALLBACK_OPTIONS`. | **DIVERGENT.** Pre-dispatch `guidedHelp` overrides nominal assistance transition. `FLOW:63`; `FSM:345–367,653–654,1328–1329`. |
| T14 | `B1_1_1_apud_acta_recibido` · `next` → `WAIT_CONFIRMACION` | Receiving the PDF already enters `AUDITING_DOCUMENT`; audit completion holds for operator approval. | **MATCH in human-review-wait purpose, merged nodes; no separate automatic `next`.** `FLOW:69`; `FSM:394–400,690–710`; `SERVICE:81–84`. Exact schema confirmation event is still absent (T24). |
| T15 | `B1_2_1_como_enviar_certificado` · `envia_certificado_y_contrasena` → `B1_2_2_certificado_recibido` | `CLIENT_CERT_FILE_RECEIVED` is actionable only in `MOBILE_ASSIST_PROCESSING` with consent; desktop copy-help has not entered that state. | **DIVERGENT / missing ordinary connection.** `FLOW:75`; `FSM:512–523,648–670,1269–1274,1328–1329`. Payload is opaque `certRef`, not password text (`src/domain/fsm/event-payloads.ts:137`). |
| T16 | `B1_2_2_certificado_recibido` · `next` → `WAIT_CONFIRMACION` | Certificate inspection → draft → client review → operator submission, all initially in `MOBILE_ASSIST_PROCESSING`; then PDF wait/audit. | **DIVERGENT.** No immediate generic confirmation wait/receipt acknowledgment. `FLOW:82`; `FSM:521–635`; `SERVICE:81–84` does create a human assistance task. |
| T17 | `B2_1_instalar_en_ordenador` · `ya_en_ordenador` → `B1_1_pdf_procuradores` | `MOBILE_EXPORT_GUIDE_SENT` or mobile triage + `CLIENT_HAS_CERT_PC` / `CLIENT_EXPORT_SUCCEEDED` → `PC_TUTORIAL_SENT`. | **MATCH.** `FLOW:87`; `FSM:417–419,461–483`. |
| T18 | `B2_1_instalar_en_ordenador` · `atascado` → `B2_2_1_como_enviar_certificado_movil` | `CLIENT_EXPORT_FAILED` / `CLIENT_REQUESTS_ASSISTANCE` → same mobile state and help counters. | **DIVERGENT.** No direct delivery node; consent handler is shadowed. `FLOW:87`; `FSM:345–367,424–427,1328–1329`. |
| T19 | `B2_2_1_como_enviar_certificado_movil` · `envia_certificado_y_contrasena` → `B1_2_2_certificado_recibido` | Same guarded `CLIENT_CERT_FILE_RECEIVED` handler as T15, in `MOBILE_ASSIST_PROCESSING`. | **DIVERGENT / missing ordinary connection.** Copy-help leaves client outside that state; file-found text instead escalates. `FLOW:92`; `FSM:512–523,1269–1274`; `AGENT:258,271`. |
| T20 | `RARO_sin_certificado_ni_clave` · `opcion_gratuita` → `WAIT_CLIENTE_OBTIENE_ACCESO` | Closest: DNIe explanation while holding `CERT_ACQUISITION_LINKS_SENT`, eventually `CLIENT_CERT_ACQUIRED`. | **DIVERGENT, merged acquisition wait.** No dedicated free-acquisition selection event; **`COURT_APPOINTMENT` is not an equivalent**, because it means granting the power at court, not obtaining a certificate. `FLOW:98`; `AGENT:235–246`; `POLICY:106`; `FSM:930–940`. |
| T21 | `RARO_sin_certificado_ni_clave` · `opcion_pago` → `HANDOFF_PAGO` | `CLIENT_REQUESTS_URGENT_PAID` → `APUDATA_PENDING_PREAPPROVAL`. | **DIVERGENT.** No distinct FSM selection for paid FNMT acquisition versus paid complete partner service. FNMT video is conversational explanation (`AGENT:246`); partner event starts automation (`FSM:369–381,941–942`). `FLOW:97–98`. |
| T22 | `WAIT_DOCUMENTO_APUD_ACTA` · `envia_apud_acta` → `B1_1_1_apud_acta_recibido` | `WAITING_PDF_SUBMISSION + CLIENT_PDF_RECEIVED` → `AUDITING_DOCUMENT`. | **MATCH receipt route; N08 acknowledgment gap remains.** `FLOW:103`; `FSM:648–670`. Source node is orphaned in JSON. |
| T23 | `WAIT_CLIENTE_OBTIENE_ACCESO` · `tiene_certificado` → `B_movil_u_ordenador` | `CERT_ACQUISITION_LINKS_SENT + CLIENT_CERT_ACQUIRED` / `CLIENT_HAS_CERT` → device question. | **MATCH.** `FLOW:108`; `FSM:932–934`. |
| T24 | `WAIT_CONFIRMACION` · `APODERAMIENTO_CONFIRMADO` → `FIN_cierre` | No such event. Closest chain ends with `HANDOFF_DAYANA + CLIENT_NOTIFICATION_DELIVERED` → `COMPLETED`. | **MISSING named confirmation transition; DIVERGENT replacement protocol.** `FLOW:112`; `STATES:121–199`; `FSM:1111–1139`; `ENGINE:188–191`. Service rejects an unknown event at `SERVICE:49`; direct engine submission would escalate at `FSM:1296–1302`. |

## Global intents

For active nonterminal cases, FAQ replies usually become `CLIENT_SMALL_TALK(responseId=CONVERSATION_REPLY, requiresHumanReview=false)` and retain the current state (`AGENT:271`; `FSM:1253–1261`; `MSG:131–134`). This can implement `return:true` without a dedicated state. It does **not** encode which global intent was answered or persistent-distrust progress.

| JSON global intent | State/event implementation | Assessment and evidence |
| --- | --- | --- |
| `estado_reclamacion` (`FLOW:124`) | Same state + conversational reply for claim status/when money arrives. | **MATCH for recognized questions.** `AGENT:224–227` gives `reclamaciones@litigios.es` without inventing status. Returns via `AGENT:271` / `FSM:1261`. |
| `que_es_apoderamiento` (`FLOW:125`) | Same state + reviewed conversational definition. | **DIVERGENT content, return implemented.** `GUIDANCE:104–105` explains representation and free self-service/optional partner, but omits JSON's computer/certificate requirements from that reply. `FSM:1261`. |
| `puede_desde_movil` (`FLOW:126`) | No dedicated global event or fixed FAQ reply; mobile triage template says a computer is needed. Other questions use model/support replies. | **DIVERGENT / missing deterministic global answer.** `MSG:52` is state-specific. `AGENT:152–176,301–305` gives model-dependent or generic support outside that route; provider prompt states the rule at `src/adapters/ai/openai-compatible-conversation.ts:205`. The model is forbidden to say mobile signing is possible (`POLICY:305`), which is not the same as always delivering the required answer. |
| `precio` (`FLOW:127`) | Same state + reviewed price reply. | **DIVERGENT detail, core distinction represented.** `GUIDANCE:71–80` / `GUIDANCE:6–7` explain free self-service and optional ~€35 partner. FNMT cost is referred to its site, not resolved as `PRECIO_FNMT`. Generic price reply unnecessarily asks certificate ownership even in an advanced state. `FSM:1261` preserves state. |
| `eres_una_persona` (`FLOW:128`) | Identity explanation can stay in state; a message containing `humano` can instead request a handoff. | **DIVERGENT.** `AGENT:231` identifies the virtual assistant, but earlier `AGENT:219` matches `humano` without distinguishing a question from a request. “¿Eres humano?” therefore selects human review rather than `return:true`. `MSG:24` identifies a virtual assistant but does not implement the global distinction. |
| `desconfianza` (`FLOW:129`) | Reassurance → same-state `CLIENT_SMALL_TALK`; human review is representable only via a generic flag/event. | **MISSING `if_persists` transition.** Matching distrust text always gets `requiresHumanReview=false` at `AGENT:257`; no distrust counter/event in `STATES:121–199` or domain fields. Repeating it repeats reassurance; provider instruction at `src/adapters/ai/openai-compatible-conversation.ts:223–225` is bypassed for those deterministic matches. |
| `pago_factura_transferencia` (`FLOW:130`) | Recognized account/invoice/transfer query → `CLIENT_SMALL_TALK(requiresHumanReview=true, PAGO)` → `ESCALATED_HUMAN`. | **MATCH for those handoff queries; DIVERGENT for paid choice.** `AGENT:220,271`; `FSM:1260`; original reason preserved by `SERVICE:78–84`. Partner selection uses `CLIENT_REQUESTS_URGENT_PAID` and is not terminal. Ordinary cost questions intentionally stay in state (`GUIDANCE:71–80`). |
| `enfado_o_pide_humano` (`FLOW:131`) | Explicit request → `CLIENT_REQUESTS_HUMAN` or human-review reply → `ESCALATED_HUMAN`; some frustration is handled as guidance. | **DIVERGENT for the anger branch, human request represented.** `AGENT:219,222–227` requires frustration without a request to continue or a money/status query for its frustration handoff. `GUIDANCE:123` explicitly says frustration alone is not a handoff. `FSM:1245–1248,1260`. |

**Global scope limitation:** state handlers run before `globalHandler()` (`FSM:1330–1331`). `COMPLETED` consumes almost all events (`FSM:1156–1164`), and `ESCALATED_HUMAN` consumes all except authenticated resume (`FSM:1167–1192`). Thus the JSON global `return`/`goto` behavior is not available in every state. The service also bypasses ordinary classification while paused (`SERVICE:202–214`).

## Handoff reasons and terminal behavior

All six JSON labels are accepted by the conversation reply schema (`POLICY:26–33`), so they are **not wholly absent**. None is an enum member of the engine's `EscalationReason` (`ACTIONS:285–314`). Conversational handoffs collapse to `CLIENT_NEEDS_HUMAN` in the engine (`FSM:1260`), while the service preserves `handoffReason` in action payloads and human-task metadata (`SERVICE:78–84`). This distinction matters when assessing conformance or reading an audit trail.

| JSON reason (`FLOW:6`) | Implementing state/event/action | Conformance |
| --- | --- | --- |
| `APUD_ACTA_RECIBIDO` | `CLIENT_PDF_RECEIVED` → `AUDITING_DOCUMENT`; `DOCUMENT_REVIEW` task assigned to Dayana. | **DIVERGENT label/acknowledgment, human review present.** `FSM:384–400,651–652`; `SERVICE:81–84`. It does not use the JSON reason or send N08's immediate acknowledgment. |
| `CERTIFICADO_RECIBIDO` | Secure `CLIENT_CERT_FILE_RECEIVED` in `MOBILE_ASSIST_PROCESSING` starts inspection and an `ASSISTED_PROCESSING` task; secret-like chat can use this conversation reason and escalate. | **DIVERGENT.** `FSM:521–523`; `SERVICE:71,81–84`; `AGENT:213–217`. A secret-like message alone can carry the reason without verified receipt of both certificate and password; it is not equivalent to N10. |
| `PAGO` | Conversational payment query → generic human hold, reason retained by service. Paid route selection → partner preapproval. | **DIVERGENT by entry path.** `AGENT:220`; `FSM:369–381,1260`; `SERVICE:78–84`. |
| `DESCONFIANZA` | Accepted conversation metadata; no deterministic persistent-distrust trigger. | **MISSING guaranteed schema trigger.** `POLICY:31`; `AGENT:257`; `FSM:1260`. |
| `HUMANO` | `CLIENT_REQUESTS_HUMAN` or human-review reply → `ESCALATED_HUMAN`; manager notice/task. | **MATCH in purpose.** `FSM:1245–1248,1260`; `SERVICE:78–84`. Resumable human hold corresponds to stopping automatic conversation at JSON `end:true`. |
| `FALTA_DATO` | File-found reply → `CLIENT_SMALL_TALK` with human-review flag → `ESCALATED_HUMAN`. | **Represented, but the found-file trigger is extra.** `AGENT:258,271`; `FSM:1260`. JSON declares this reason but gives it no node/edge trigger; it cannot justify inventing a particular required transition. |

## Reachable conversation branches the FSM cannot fully represent

This list distinguishes absent business distinctions from branches whose broad outcome exists but is unreachable from the conversational state. Ordinary merged states such as initial-question/device-question are not included as gaps when persistent fields disambiguate them.

| Conversation / schema branch | What cannot be represented or reached | Exact evidence |
| --- | --- | --- |
| “No certificado, pero Cl@ve” versus “ni certificado ni Cl@ve” (T03/T04) | Separate JSON branches and their pending choices. Both reduce to `hasDigitalCert=false`; no Cl@ve field/event. | `POLICY:113,216–218`; `FSM:324–338`; `src/domain/models/expediente.ts:43–86`; `STATES:128–160`. |
| “No puedo/no quiero sacarlo; que lo firme el procurador” (T07) | `A_procurador_firma` outcome and its specific human task/message. | `FSM:939–940` routes inability to court; `MSG:95–100,125` has no procurator-signing template. |
| Choosing free acquisition versus paid FNMT versus paid complete partner service (T05/T20/T21) | Persisted acquisition method/selected option and distinct payment-handoff semantics. Conversation may describe DNIe/video, but retains the same state; partner selection instead starts an external preapproval action. | `AGENT:235–246,271`; `FSM:369–381,930–950`; `POLICY:153–156`; domain fields at `src/domain/models/expediente.ts:43–86`. |
| Stuck → send certificate/password, from desktop/mobile (T13/T15/T18/T19) | Normal connection into consent/secure delivery. Guidance intercepts the event that nominal handlers use to request consent; counters do not transition into consent after success. | `FSM:316–321,345–367,424–427,653–654,1328–1329`. No ordinary client transition in the inspected dispatch reaches the consent state through those shadowed handlers; operator resume remains possible (`FSM:1169–1185`). |
| No PC → no app → file located (detail of mobile branch) | PC unavailable, app unavailable, and file located are not distinct persisted facts/steps. Copy counters record attempts, not those facts. File-found changes to human hold instead. | `FSM:346–365`; `MSG:81–93`; domain fields `src/domain/models/expediente.ts:43–86`; `AGENT:258`; `FOLLOWUP:7–15`. |
| Refusal after found-file human hold (Master / requested test path) | No transition from `ESCALATED_HUMAN` to dual fallback on client refusal. | `SERVICE:64–65,202–214`; `FSM:1167–1192`; `ENGINE:196–197`. |
| Desktop refusal while searching/sharing certificate (Master) | `CLIENT_CONSENT_DENIED` cannot choose fallback from `PC_TUTORIAL_SENT` / `WAITING_PDF_SUBMISSION`; consent withdrawal during processing also chooses human hold. | `FSM:636–640,648–670,1269–1274`; contrast mobile support at `FSM:434–441,496–497`. |
| Repeated distrust (`global_intents.desconfianza.if_persists`) | First reassurance versus persistent distrust is not represented; no deterministic transition to its handoff. | `AGENT:257`; `STATES:121–199`; `FSM:1253–1261`. |
| “Are you human?” versus “I want a human” (two global intents) | Both can become a human request; no intent-specific disambiguation for `humano`. | `AGENT:219` precedes `AGENT:231`; event vocabulary `STATES:150–159`. |
| Team confirms power (`WAIT_CONFIRMACION.on_event`) | Exact `APODERAMIENTO_CONFIRMADO` event cannot be processed as schema confirmation. A longer approved-document/filing/notification chain exists instead. | `SERVICE:49`; `FSM:1296–1302,1111–1139`; `ENGINE:188–191`. |

Two source limitations must not be misclassified as implementation bugs: `WAIT_DOCUMENTO_APUD_ACTA` has no inbound edge in JSON, and `FALTA_DATO` is declared without a JSON trigger. Conversely, the requested refusal-to-alternatives branch is absent from JSON but explicitly present in Master and in this audit's user instruction.

## Reverse inventory: every FSM state and its JSON counterpart

“No explicit counterpart” identifies added states, including implementation refinements and Master-only routes. It does not by itself mean the state is wrong.

| FSM state (enum line) | JSON counterpart | Scope / transition evidence |
| --- | --- | --- |
| `INITIAL_TRIAGE` (`STATES:18`) | `I_necesita_apoderamiento` | Before first question; `CASE_OPENED` at `FSM:447–450`. |
| `WAITING_CERT_RESPONSE` (`STATES:20`) | `II_tiene_certificado`, `B_movil_u_ordenador` | Two nodes represented by one state plus certificate flag (`FSM:289–292,452–459`). |
| `MOBILE_TRIAGE_PC_CHECK` (`STATES:22`) | **No explicit counterpart** | Added PC-availability substep before `B2_1_instalar_en_ordenador` (`FSM:294–300,461–472`). It also holds later copy-help despite its original meaning. |
| `MOBILE_EXPORT_GUIDE_SENT` (`STATES:24`) | `B2_1_instalar_en_ordenador` | Export instructions and success to PC (`FSM:309–313,474–484`). |
| `MOBILE_ASSIST_CONSENT_REQUESTED` (`STATES:26`) | **No explicit counterpart** | Added consent gate for desktop and mobile assistance, not only mobile. Normal help-entry handlers are shadowed (`FSM:316–321,486–510,1328–1329`). |
| `MOBILE_ASSIST_PROCESSING` (`STATES:28`) | Partial overlap with `B1_2_1`, `B2_2_1`, `B1_2_2` | Delivery overlaps, but automated inspection/draft/review/operator submission has **no explicit JSON counterpart** (`FSM:512–646`). Not equivalent to simply waiting for team confirmation. |
| `PC_TUTORIAL_SENT` (`STATES:30`) | `B1_1_pdf_procuradores`; normal PDF waiting | Also holds desktop copy-help through counters (`FSM:648–670,1328–1329`). |
| `WAITING_PDF_SUBMISSION` (`STATES:32`) | `WAIT_DOCUMENTO_APUD_ACTA` | Additional entries on rejection/operator submission (`FSM:628–631,783`). |
| `AUDITING_DOCUMENT` (`STATES:34`) | Combined `B1_1_1_apud_acta_recibido` / `WAIT_CONFIRMACION` | Internal audit and mandatory approval refine the broad human-review wait (`FSM:384–400,672–792`). |
| `PROVISIONAL_VIABILIZED` (`STATES:36`) | **No counterpart** | Provisional defective-but-usable filing and notices (`FSM:825–829,868–895`). No provisional branch in JSON or the supplied master tree. |
| `REVOCATION_GUIDE_SENT` (`STATES:38`) | **No counterpart** | Revoke/correct defective power (`FSM:770–775,876–882,898–912`). |
| `WAITING_REVOCATION_REISSUE` (`STATES:40`) | **No counterpart** | Wait for replacement after revocation (`FSM:889–890,900–901,914–928`). |
| `CERT_ACQUISITION_LINKS_SENT` (`STATES:42`) | `A_clave_no_firma`, `A2_nie_ayuntamiento`, `RARO_sin_certificado_ni_clave`, `WAIT_CLIENTE_OBTIENE_ACCESO` | Many-to-one with DNI/NIE template selection; Cl@ve and method distinctions are lost (`FSM:324–338,930–950`). |
| `FALLBACK_OPTIONS` (`STATES:44`) | **No counterpart in JSON; explicit in Master** | Dual free-court/paid-partner choice (`MASTER:99–103`; `FSM:351–357,434–441,496–497,1210`). |
| `COURT_FALLBACK_GUIDE_SENT` (`STATES:45`) | **No counterpart in JSON; explicit in Master** | In-person court instructions/receipt (`FSM:341–343,952–975`). Not the same as `A_procurador_firma`. |
| `APUDATA_PENDING_PREAPPROVAL` (`STATES:47`) | **No executable counterpart** | JSON paid selection ends at `HANDOFF_PAGO`; this state automates partner eligibility (`FSM:369–381,977–1014`). Master names partner route but not this protocol. |
| `APUDATA_WAITING_PAYMENT` (`STATES:49`) | **No executable counterpart** | Payment details and operator-evidenced payment/order creation (`FSM:994–999,1016–1079`). |
| `APUDATA_VIDEO_IN_PROGRESS` (`STATES:51`) | **No executable counterpart** | Partner video/document delivery (`FSM:1045–1048,1081–1100`). |
| `KMALEON_FILING` (`STATES:53`) | **No explicit JSON state**; internal refinement of confirmation | Master explicitly requires filing/Macro 10. `FSM:745–760,801–842`; not an extra client choice. |
| `HANDOFF_DAYANA` (`STATES:55`) | Partial `WAIT_CONFIRMACION` / transition to `FIN_cierre` | Means **already filed**, waiting on verified notices; unlike `ESCALATED_HUMAN`, not a generic takeover on certificate receipt (`FSM:825–829,1102–1154`). Master supports Dayana notification. |
| `COMPLETED` (`STATES:57`) | `FIN_cierre` | Stronger completion conditions, different event (`FSM:1117–1139,1156–1164`; `ENGINE:188–191`). |
| `ESCALATED_HUMAN` (`STATES:59`) | `HANDOFF_HUMANO`; partial payment/distrust handoffs | Also used for many errors absent from JSON. Generic hold cannot stand in for the missing procurator action or persistent-distrust trigger (`FSM:207–230,1167–1192,1245–1260`). |

## Fixed rules and additional master requirements

| Requirement | Finding and exact evidence |
| --- | --- |
| Computer-only online signing (`FLOW:8`) | **Represented.** Mobile triage explains computer requirement (`MSG:52`), and export success leads to PC tutorial (`FSM:417–419`). Global mobile-question coverage is weaker, as recorded above. No legal claim about external services was verified. |
| Certificate required; Cl@ve PIN cannot sign (`FLOW:9`) | **Partial.** Model instructions and output validation enforce the prohibition (`src/adapters/ai/openai-compatible-conversation.ts:205`; `POLICY:305`), but the deterministic Cl@ve explanation/branch is absent (N03/T03). |
| AutoFirma before signing (`FLOW:10`) | **Represented in PC tutorial.** Link and instruction at `MSG:66`; step help at `MSG:77`. |
| Sede, Certificate Digital entry, incognito (`FLOW:11`) | **DIVERGENT message.** Sede and certificate option appear at `MSG:66,79`; incognito does not. Configured tutorial PDF may add it, but that content was not inspected; do not infer its absence from the attachment. |
| Do not ask for SMS/Cl@ve PIN/bank secrets or repeat received credentials (`FLOW:12`, N10 `never_echo_credentials`) | Source safeguards exist: redaction at `POLICY:39–58`; warnings at `AGENT:212–217`; output guard at `POLICY:305`; opaque certificate reference at `src/domain/fsm/event-payloads.ts:137`. This is source evidence, not an end-to-end credential-handling certification. Current password delivery differs from JSON as documented above. |
| Fresh versus continuing introduction (`MASTER:23–32`) | `MSG:22–24` uses a fixed introduction and ignores its optional case argument; duplicate-introduction/history checks exist in `SERVICE:218–224` and `AGENT:197–200`. This is partial continuity support, not the specified context-dependent “good news” wording. |
| DNI/NIE acquisition failure → both alternatives (`MASTER:69–79,99–103`) | **DIVERGENT by event.** Repeated failed guidance can offer both at `FSM:351–357`. `CLIENT_CANNOT_GET_CERT` directly selects court (`FSM:939–940`). A deterministic conversational “cannot obtain” explanation names both but stays in the acquisition state and asks only about court (`AGENT:255,271`). |
| Desktop/mobile failure or refusal → both alternatives (`MASTER:85–95,99–103`) | **Partial / reachability gaps.** Mobile refusal before hold works, desktop refusal does not, found-file hold prevents later refusal, and assisted-processing withdrawal escalates. See Head of Claims trace and T13–T19. Content correctly states free court and optional ~€35 partner (`MSG:46`). |
| Never reset progress; exact-step reminders at 3/7/15/30 days (`MASTER:36–51`) | Saved step, counters and timestamps exist (`SERVICE:60–75`; `FOLLOWUP:4–47`); scheduler uses 3/7/15 days and management review at 30 (`src/core/automation.ts:9–30`). **Granularity gap:** copy-search is a single `LOCALIZAR_COPIA_CERTIFICADO` step, so app absence/found-file/refusal cannot be resumed as distinct saved steps (`FOLLOWUP:7–15`). A declared guidance NIE can select current NIE text without changing identity; later step/template derivation still uses stored DNI (`FSM:945–946`; `FOLLOWUP:10`). |
| Day-30 contractual charges (`MASTER:47–51`) | **DIVERGENT literal action.** Scheduler pauses and creates management review with `chargesApplied:false`; it does not automatically apply a charge (`src/core/automation.ts:19–24`). This audit records the difference without recommending automatic charging. |
| Aviso 27 trigger (`MASTER:18–21`) | Present in source: `src/core/automation.ts:35–52` and worker scheduling at `src/queue/workers.ts:50–51`. Whether enabled/deployed was not verified. |
| Valid PDF → Macro 10 filing, client reply, Dayana review (`MASTER:107–115`) | Filing/notification chain exists (`FSM:712–760,801–830,1102–1139`), with Macro 10 in `src/adapters/kmaleon/kmaleon-gateway.ts:123–140`. **DIVERGENT ordering/content:** operator review precedes filing, Dayana notification precedes client completion notice, and `MSG:122` says the firm will continue processing rather than asserting the lawsuit is being submitted. Actual filing/delivery was not tested. |

## Verification boundary and snapshot

Conformance was checked by reading the named sources, tracing dispatch precedence and caller behavior, and enumerating the real JSON/TypeScript vocabulary. Existing working-tree changes were preserved. No inference of deployed success, historic actor behavior, real delivery, or model reliability is made from this static trace. In particular, the Head of Claims finding explains a current code path; it does not prove the exact historical conversation followed it.

SHA-256 values identify the source snapshot behind the critical findings:

| Source | SHA-256 |
| --- | --- |
| FLOW | `9e172038811535f2e461bc56ea3e8db1253213d1a5684d9fb3f59b89d59cb369` |
| MASTER | `c2e22799c6b129b2f207ecc576711ddffbb1830ff1ef558ab1f8c14e00ac8efd` |
| FSM | `1d575611e5822dcc562db83765a72a2b8fa2b748665b15158274851f9ddf2abc` |
| ENGINE | `767f50c2ba2e7630ecd998ba9b65a69eb8badb74f08332815bad3bf023bdcba4` |
| MSG | `e1437e73c593714cb5b7ae7885f0be0c6b137b7eeef8b6ca79202a2925940704` |
| AGENT | `e0ed308c2feec5fecb31a4620a05ab1a65259042844127df11b924af3882d7ae` |
| SERVICE | `3f6e449c0c1e81b15286839a3beaf350b177d6b14385e9be90c02ae1f9fb54b3` |
