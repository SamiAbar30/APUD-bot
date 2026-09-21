# Hard-case reply fixes

Analysis of `evidence/hard-case-coverage.json`, recorded at **2026-09-21T00:58:02.455Z**: **17/40 handled (42.5%); 23 failed replays, representing 22 distinct client messages**. A failure means `failure !== '' || util < 4`. Case numbers below are **one-based indexes into `results`**, whose complete messages take precedence over the truncated `failures` array. Cases #11 and #18 repeat the same complaint in different states.

**Concurrent-change boundary:** during final verification, another workspace change replaced the artifact with a **26/40 (65%)** run dated **2026-09-21T06:36:32.408Z** and added topic routing to the agent. This report deliberately analyzes the requested 42.5% baseline. “Current” source descriptions and line numbers below refer to the initially inspected snapshots, identified by hashes at the end; they must not be read as assertions that every defect survives the later edits. The newer run retains the same indexed client messages. Its outcomes require a separate comparison, not substitution into this failure inventory.

This is an implementation specification, not a report that the bot has been fixed. Only this document was written. The Spanish blockquotes are complete replacement replies: verb first, no emojis, at most two short sentences plus one question. Prices and service facts below are limited to the supplied requirement and existing reviewed wording: self-service apud acta is free; partner management is optional, with a reference price of 35 EUR. No reply promises a payment date, legal outcome, document acceptance, appointment or completed escalation without evidence.

## Evidence and attribution limits

- The artifact contains client text, reply, state, next state and score, but no selected event, branch ID, model candidate or source revision. An exact template match identifies its renderer; it does not always identify which upstream branch selected it. Model/fallback attribution is explicitly qualified below.
- The replay script uses real client messages and a real model, but assigns four rotating contexts from a database case (`scripts/eval-hard-cases.ts:86–94`), with empty conversation history. These are replay contexts, not verified original client states. Do not infer that a client really has a certificate from the assigned `PC_TUTORIAL_SENT` state.
- Read-only inspection invoked the actual `guidanceRequest`, `reviewedConversationReply`, `conversationYield` and `pendingConversationText` functions on the saved failed messages and the contexts recorded by the replay script. This verifies local predicates and text matches, not new model coverage, database effects or WhatsApp delivery. No mock provider, invented client message, mailbox access or external send was used.
- Current source differs from the recorded behavior in #38: `conversation-agent.ts:226` already catches `numero de cuenta` before guidance. Preserve that safety gate; improve its routing and wording rather than claiming the recorded FNMT reply is still produced by the current branch.
- The evaluator renders only `actionPayload.template` (`scripts/eval-hard-cases.ts:123–127`). Escalations carry `clientNoticeTemplate` instead (`state-machine.ts:207–229`). `workflow-service.ts:79–85` separately creates the client notice and human task, including the original `responseText` for conversational handoffs. Thus #6/#35 prove empty evaluator output, not missing production delivery.
- The evaluator also renders with the old case plus `currentState`, omitting `actionPayload.expedientePatch`. Its `digitalHelpAttempts: 1` can produce first-attempt wording after `guidedHelp` has calculated attempt 2; its mobile copy count can likewise be stale. This affects wording attribution, but does not excuse routing a bank or creditor problem into certificate help.

## Failure inventory

| Root cause | Failed cases | Recorded symptom | Main source of reply |
| --- | --- | --- | --- |
| R1: Missed money, timing and total-cost language | #2, #30, #37 | Certificate pivot instead of answering/routing | Agent money guard and fallback; guidance; templates |
| R2: Payment complaint treated as APOD price or confusion | #11, #16, #18, #23 | Free/35 EUR pitch or certificate explanation | `reviewedConversationReply/priceQuestion`; deterministic confusion; guidance |
| R3: Payment action mistaken for route enquiry or technical help | #9, #38 | Explains self-service or FNMT instead of handling payment | Model path; bank guard; guidance and templates |
| R4: Different subject swallowed by APOD support | #4, #7, #17 | Certificate copy, PC guide or intake question | `guidanceRequest`; agent pending fallback; `guidedHelp` |
| R5: Already-contacted complaint gets the same instruction | #14 | Tells client to email again | Model/support reply; missing follow-up branch |
| R6: Third-party calls lack reliable topic routing and visible notice | #6, #27, #35 | Silence in evaluator or PC guide | Agent handoff/pending paths; FSM escalation; notice rendering |
| R7: Specific screen problems lose their technical detail | #3, #24 | Generic PC entry or certificate-copy instructions | `helpTopic`; `guidedHelp`; `DIGITAL_STEP_HELP` / `CERTIFICATE_COPY_HELP` |
| R8: Purpose/alternative request treated as export difficulty | #32 | Repeats mobile copy advice | Guidance before reviewed explanation; `guidedHelp` |
| R9: Availability mistaken for technical inability | #31 | Immediate PC instructions despite later availability and Cl@ve PIN | `conversationYield`; broad `failed` matcher; template |
| R10: Intake confusion gets a definition without a next step | #25 | Asks again whether client remembers a certificate | Agent deterministic confusion branch |
| R11: Distress has no contextual acknowledgement | #33 | Certificate question | Missing wellbeing branch; pending intake text |
| R12: Ambiguous credential is presumed to be a certificate password | #36 | Guesses the credential and gives incomplete recovery advice | Model reply path; missing credential-type clarification |

The original labels are sampling categories, not root causes: money failed 6/6, technical 5/6, confusion 5/6, complaint 3/5, distrust 2/5, personal 1/6 and question 1/6.

## Routing contract for the proposed fixes

The trigger expressions below are **proposed**, unless explicitly labelled current. They use the same normalized text for multiline client bursts:

```ts
const n = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const inGuidanceState = DIGITAL_GUIDANCE_STATES.has(c.currentState);
```

Keep existing opt-out, actual-secret, injection, consent and financial authorization gates. Before generic confusion, guidance, `priceQuestion` or model fallback, resolve the **subject of the message**: distress; third-party legal calls; payment complaint/action and claim status; other-company documents/access; already-contacted follow-up; then APOD questions and technical help. A pure deferral may yield immediately; a mixed deferral must still acknowledge a substantive money/claim question.

Use the R1–R6 predicates as a shared subject exclusion for `guidanceRequest` and `priceQuestion`, including direct calls through `respond` and `classify`. Do not make an APOD price branch true merely because the state is digital or the text contains `pago`, `cobrar` or `pero`. A genuine APOD price question needs an explicit APOD/partner subject or an unambiguous antecedent in the saved conversation; an unspecified total budget belongs to R1.

For ordinary routing replies, use `CLIENT_SMALL_TALK` / `CONVERSATION_REPLY` without changing certificate, device, consent, payment or completion facts. Do not increment assistance counters for another subject, scheduling, credential clarification or distress. Human-review variants must retain `requiresHumanReview: true` through the FSM and create the existing notice/task transaction before sending wording such as “Paso a revisión”. Preserve the pending APOD step for operator resumption.

Restrict `respond`'s suppression of model handoffs (`conversation-agent.ts:171–176`) to a positively identified APOD support topic. Its current word list is not a reliable subject classifier. Restrict the repeated-reply replacement (`:283–289`) similarly: a repeated claim-status question must never become a court/partner sales prompt. Do not append `pendingConversationText` to any replacement below.

## R1 — Money/timing and total-cost language miss the deterministic route

**Cases:** #2 “Que coste tiene / Y cuanto se tarda en reclamar y recibir el dinero”; #30 “Cuánto costaría todo esto”; #37 money owed by Moneyman and no answer from Avafin.

**Current cause and source:** `conversation-agent.ts:230–233` recognizes `mi dinero`, specific `cuando ...` forms and `estado de mi reclamacion`; all three messages miss it. In `conversation-guidance.ts:72–74`, #2 has `coste` but fails the question/contrast qualifier: `isConversationQuestion` does not recognize “que coste” without punctuation. #30 has question syntax but `costaria` is absent from the price vocabulary. Both recorded replies exactly match the composition at agent `:185–188` plus `pendingConversationText` in `messages.ts:37–39`; the preceding model outcome is not recorded. #37 hits `guidanceRequest.failed` through `todavia no`, then the unknown-certificate template at `messages.ts:71`.

**Proposed triggers, before guidance and generic pricing:**

```ts
const claimTiming = /\b(?:cuanto se tarda|cuando|plazos?)\b/.test(n)
  && /\b(?:reclamar|reclamacion|recibir el dinero|cobrar|cobro)\b/.test(n);
const totalBudget = !/\b(?:apud acta|apoderamiento|fnmt|certificado|empresa colaboradora)\b/.test(n)
  && /\b(?:que coste tiene|cuanto costaria(?: todo esto)?|cuanto cuesta todo|coste total|precio total)\b/.test(n);
const moneyOwed = /\b(?:transfieran el dinero|dinero que me deben|pago pendiente|cobro pendiente)\b/.test(n);
```

**Reply for #2 — belongs in `src/core/conversation-agent.ts`, money/timing branch:**

> Consulta el coste y los plazos de reclamación y cobro en reclamaciones@litigios.es. El apud acta por tu cuenta es gratis; la gestión opcional con la empresa colaboradora tiene una referencia de 35 EUR.

**Reply for #30 — same file, unspecified total-budget branch:**

> Consulta el presupuesto completo en reclamaciones@litigios.es. El apud acta por tu cuenta es gratis; la gestión opcional con la empresa colaboradora tiene una referencia de 35 EUR.

**Reply for #37 — same file, outstanding-money/status branch:**

> Consulta en reclamaciones@litigios.es el pago pendiente de Moneyman y la falta de respuesta de Avafin. El equipo debe revisar ambas reclamaciones.

Treat 35 EUR as the existing reference for the optional partner service, never as the claim's total cost or an instruction to pay. Entity names in this case-specific copy come from the client's message; other entities require their own grounded wording.

## R2 — Broad pricing and confusion branches capture payment disputes

**Cases:** #11/#18 additional charge plus an allegedly incorrect no-response reminder; #16 wants to collect from Moneyman before continuing; #23 alleges duplicate charging and asks about outstanding claims.

**Current cause and source:** #16 and #23 exactly match `reviewedConversationReply` at `conversation-guidance.ts:79–81`: `cobrar`/`pagar` plus `pero` makes `priceQuestion` true despite the non-APOD subject. In #11, `no entiendo` causes `guidanceRequest` to return assistance **before** reviewed pricing (`conversation-agent.ts:275–276`), reaching `DIGITAL_STEP_HELP` at `messages.ts:81`. In #18, the earlier deterministic confusion branch at agent `:259–260` wins because the state is `CERT_ACQUISITION_LINKS_SENT` and `hasDigitalCert !== true`. That same complaint therefore gets two unrelated certificate replies.

**Proposed triggers, before both confusion and pricing:**

```ts
const chargeDispute = /\b(?:cobrar mas|cobro (?:adicional|duplicado)|ya (?:les |os )?pague|ya cobraron)\b/.test(n);
const incorrectReminder = /\b(?:fallo vuestro|sin responder)\b/.test(n)
  && /\b(?:enviado|enviar|envie)\b/.test(n);
const collectBeforeContinuing = /\b(?:primero quiero cobrar|quiero cobrar primero)\b/.test(n);
```

**Reply for #11/#18 — belongs in `src/core/conversation-agent.ts`, disputed charge/reminder branch:**

> Solicita en reclamaciones@litigios.es que revisen el cobro adicional y el aviso de falta de respuesta. Indica que ya lo enviaste y la fecha del envío.

**Reply for #16 — same file, collection-before-continuation branch:**

> Consulta el cobro de Moneyman en reclamaciones@litigios.es. Retomamos el apoderamiento cuando quieras continuar.

**Reply for #23 — same file, duplicate-charge branch:**

> Solicita en reclamaciones@litigios.es la revisión del posible cobro duplicado y de las reclamaciones pendientes. Indica que ya pagaste y pide que confirmen qué documentación falta.

These replies acknowledge the allegation without confirming that payment occurred, that the charge is wrong or that a document was received. A request to collect first is not permanent opt-out and must not authorize a paid route.

**Companion repair in `src/core/conversation-guidance.ts`:** run claim/payment exclusions before `declinesPayment` and `priceQuestion`, and remove the certificate question from the actual APOD price answer. For an explicitly identified APOD/partner price question, use:

> Elige si prefieres hacer el apud acta gratis por tu cuenta o consultar la gestión opcional con la empresa colaboradora. Esta última tiene una referencia de 35 EUR, que debe confirmarse antes de contratar.

This is an explanation, not `APUDATA_REQUEST`, preapproval, consent or payment authorization. Questions specifically about obtaining a certificate retain their separate reviewed route; never apply the partner's 35 EUR to FNMT.

## R3 — Wanting to pay or failing to pay is not an APOD pricing question

**Cases:** #9 “Yo quiero pagarlo mañana”; #38 already made one payment, but the account used for the first now does not work.

**Current cause and source:** #9 misses the current money guard and the bounded word `pagar` in `priceQuestion` because it says `pagarlo`. Its wording is not a literal in the four reviewed files, so the precise model path cannot be proved from the artifact. The reply treats a payment action as a choice between certificate and partner services. The saved #38 reply matches `messages.ts:76` after `no me deja` becomes `CLIENT_EXPORT_FAILED`; `guidanceRequest`'s exclusion includes `pagar`, but not `pago`. **Current drift:** agent `:226` now intercepts its `numero de cuenta` first. Its present text still omits the required claims-team email and promises contact through the chat.

**Proposed triggers:**

```ts
const wantsToPay = /\b(?:quiero|voy a|necesito) pagar(?:lo)?\b/.test(n);
const failedPayment = /\b(?:numero de cuenta|cuenta bancaria|transferencia)\b/.test(n)
  && /\b(?:no me deja|no funciona|error|rechazad[oa])\b/.test(n);
```

**Reply for #9 — belongs in `src/core/conversation-agent.ts`, payment-intent branch:**

> Consulta en reclamaciones@litigios.es cómo realizar el pago que quieres hacer mañana. Confirma con el equipo a qué servicio corresponde antes de pagar.

**Reply for #38 — same file, existing bank/payment guard:**

> Consulta en reclamaciones@litigios.es el problema con el segundo pago y pide instrucciones verificadas. Evita repetir el pago hasta que el equipo lo aclare.

Retain the bank-details/financial gate and its human-review behavior. Do not collect an account number, invent payment instructions or mark the first payment verified.

## R4 — Emails, missing contracts and another company's portal are different subjects

**Cases:** #4 asks what emails and an abono demand mean; #7 cannot obtain a contract despite calls/emails; #17 cannot access Oneprestamo, names Luzo, and says a signature was completed.

**Current cause and source:** #4's `no entiendo` becomes generic help; in mobile triage `hasDigitalCert === true && certificateHelpAttempts > 0` selects copy assistance (`state-machine.ts:357–362`, `messages.ts:90–91`). #17's `no me deja` becomes export failure and its `firma` becomes `AUTOFIRMA`, although the failure is on a lender's portal; `hasDigitalCert === null` then overrides the topic at `messages.ts:71`. #7 exactly matches the PC pending template (`messages.ts:35–36`), reachable through model-handoff suppression at agent `:171–176`; the artifact cannot distinguish suppression from a model returning identical text.

**Proposed subject triggers, before generic difficulty detection:**

```ts
const explainOtherMail = /\b(?:correos?|email|mail)\b/.test(n)
  && /\b(?:explicar|no entiendo|abono|reclamo)\b/.test(n);
const missingContract = /\bcontrato\b/.test(n)
  && /\b(?:no lo encuentro|no encuentro|vuelvan a enviar|no contestan)\b/.test(n);
const otherCompanyAccess = /\b(?:oneprestamo|luzo)\b/.test(n)
  && /\b(?:no me deja entrar|bloqueado el acceso|no puedo entrar)\b/.test(n);
```

These are concrete coverage triggers, not an exhaustive company dictionary. Generalize the same routing to a company/site explicitly named in the message or grounded recent context. Do not route every occurrence of `correo` away from APOD: requests about signing an APOD document by email belong to R8.

**Reply for #4 — belongs in `src/core/conversation-agent.ts`, other-email/abono branch:**

> Consulta en reclamaciones@litigios.es el significado de esos correos y del abono que te reclaman. Indica quién los envió y a qué reclamación se refieren.

**Reply for #7 — same file, missing-contract branch:**

> Solicita ayuda en reclamaciones@litigios.es para conseguir el contrato que no localizas. Explica que la compañía no responde por teléfono ni por correo.

**Reply for #17 — same file, other-company access branch:**

> Consulta en reclamaciones@litigios.es el problema de acceso a Oneprestamo y la situación con Luzo. ¿Qué documento has firmado?

Do not state that the account is blocked, that a contract is unnecessary or that the reported signature completes the apud acta. These are routing instructions for the client, not instructions for the bot to access email or another company's account.

## R5 — “I already emailed” requires an actual follow-up route

**Case:** #14 “Envie el email y todavia nadie me ha contestado / De banco … tampoco se nada”.

**Current cause and source:** the deterministic frustration matcher at `conversation-agent.ts:229` recognizes `nadie me contesta`, but misses `nadie me ha contestado`; there is no already-contacted branch. The saved acknowledgement is not a literal in the reviewed files and is consistent with the model reply path. Merely repeating the address leaves the reported failure unchanged.

**Proposed trigger:**

```ts
const alreadyContacted = /\b(?:envie|he enviado|ya he escrito|ya escribi)\b/.test(n)
  && /\b(?:email|correo|reclamaciones)\b/.test(n)
  && /\b(?:nadie me ha contestado|no he recibido (?:ninguna )?respuesta|sin respuesta|no me contestan)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-agent.ts`, follow-up handoff branch:**

> Paso tu consulta al equipo de reclamaciones@litigios.es para revisar el correo pendiente y las novedades del banco. No necesitas repetir aquí la explicación.

Set `requiresHumanReview: true`, preserve the original message in the authorized review flow, and create the existing human task plus notice. Use this text only when that routing is committed; an email address in prose alone is not a handoff. Do not promise an answer time or pretend to have inspected the email.

## R6 — Third-party legal calls need review; the evaluator hides escalation notices

**Cases:** #6 Recovery Legal allegedly threatens to sue and the client already emailed without a reply; #27 BJS Legal allegedly reports judicial progress; #35 Smart keeps calling and the client says they paid.

**Current cause and source:** #27 exactly matches `pendingConversationText` for PC. Agent `:171` may suppress a model-requested handoff unless a short exact-word list matches; `despacho juridico`, `proceso judicial`, creditor names and inflected `demandar` are not a robust substitute for topic routing. For #35, `estoy harto` matches `frustrated`, while `asksToContinue` and `asksAboutMoney` are false, so the current branch at `:231` asks for human review. The artifact does not establish #6's selected model event. Both #6/#35 reach `ESCALATED_HUMAN`; the evaluator ignores the separate notice path described above.

**Proposed triggers, before generic frustration/help/pricing:**

```ts
const legalCall = /\b(?:llamaron|llamado|llaman|llamar|llamadas)\b/.test(n)
  && /\b(?:recovery legal|bjs legal|despacho juridico|demandar|demanda|proceso judicial)\b/.test(n);
const repeatedCreditorCalls = /\b(?:smart|compan(?:ia|ias)|empresa|acreedor)\b/.test(n)
  && /\b(?:acosar|acoso|no paran|llamadas insistentes)\b/.test(n);
```

**Reply for #6 — belongs in `src/core/conversation-agent.ts`, third-party legal-call handoff:**

> Paso a revisión la llamada de Recovery Legal y el correo que ya enviaste sin respuesta. El equipo de reclamaciones@litigios.es debe indicarte cómo actuar.

**Reply for #27 — same file, judicial-progress allegation handoff:**

> Consulta en reclamaciones@litigios.es la llamada de BJS Legal y su aviso sobre el proceso judicial. No puedo confirmar ese avance judicial por este chat.

**Reply for #35 — same file, repeated-creditor-calls handoff:**

> Paso a revisión las llamadas insistentes de Smart y lo que indicas sobre el pago. El equipo de reclamaciones@litigios.es debe revisar ambas cuestiones.

All three require human review, with a visible notice and no certificate prompt. Do not interpret a third party's statement as a verified lawsuit, deadline, debt or payment.

**FSM/template contract:** retain `CLIENT_SMALL_TALK && payload.requiresHumanReview === true` → `ESCALATED_HUMAN` at `src/domain/fsm/state-machine.ts:1254–1262`, with `clientNoticeTemplate: CONVERSATION_REPLY`. `src/core/messages.ts:133–136` renders the exact `replyText` above. Do not replace the existing transactionally queued notice with a second notice or remove the human gate to satisfy the evaluator. Subsequent validation must inspect both the human task and the notice's actual send/delivery evidence; rendering only `decision.actionPayload.template` cannot establish either.

## R7 — Screen details disappear before the technical renderer runs

**Cases:** #3 logo-only screen, three unclickable choices, client will resume after returning home; #24 camera opens, no code to scan, cannot select Photos.

**Current cause and source:** `guidanceRequest` at `conversation-guidance.ts:43–54` maps both to `CLIENT_EXPORT_FAILED` with empty `helpTopic`. It only distinguishes `AUTOFIRMA` and `DOWNLOAD`; there is no screen/UI or camera topic. `guidedHelp` at `state-machine.ts:346–367` selects by certificate ownership and attempt counters. #3 therefore gets `DIGITAL_STEP_HELP`'s PC entry text (`messages.ts:81`), while #24's mobile copy count makes `CERTIFICATE_COPY_HELP` win (`:90–91`). A camera problem is not evidence of failed certificate export.

**Proposed triggers, after excluding R1–R6:**

```ts
const screenChoicesBlocked = inGuidanceState
  && /\b(?:solo aparece el logotipo|no da opciones|no me deja pinchar|no me da opcion a elegir)\b/.test(n);
const cameraInsteadOfPhotos = inGuidanceState
  && /\b(?:camara|escanear|qr)\b/.test(n)
  && /\b(?:no tengo(?: yo)? el codigo|no me deja en fotos|no puedo elegir fotos)\b/.test(n);
```

**Required mapping:** introduce explicit `helpTopic` values such as `SCREEN_CHOICES_BLOCKED` and `CAMERA_INSTEAD_OF_PHOTOS` in `src/core/conversation-guidance.ts`. In `src/domain/fsm/state-machine.ts`, handle these topics before the copy-attempt branch. In `src/core/messages.ts`, render them before generic `hasDigitalCert`, device or attempt tests. Preserve current state and assistance counts while identifying the app/page; clarification is not an unsuccessful attempt. Only verified APOD export failures should advance export/copy escalation.

**Reply for #3 — belongs in `src/core/messages.ts`, `DIGITAL_STEP_HELP`, screen-choice topic:**

> Retómalo cuando llegues a casa; si las opciones siguen sin responder, recarga la página una vez. ¿En qué aplicación o web ocurre?

**Reply for #24 — same file/template, camera topic:**

> Vuelve a la pantalla anterior sin escanear nada. ¿Qué aplicación te abre la cámara sin dejarte elegir Fotos?

The application/site is absent from both saved messages. These are specific diagnostic next steps, not an invented repair for an unidentified app. Do not assume the three options belong to Sede Judicial or that an unspecified code is a QR code the client can obtain on another device. Once the client names the app/page, give that screen's reviewed next step rather than repeating the whole certificate tutorial.

## R8 — Purpose and a proposed alternative are misread as export trouble

**Case:** #32 asks for another way, asks what it is for, and proposes signing a document sent by email.

**Current cause and source:** `no entiendo` reaches `guidanceRequest` before `reviewedConversationReply`. The purpose matcher at `conversation-guidance.ts:105` is anchored to the start and requires `apud`, `apoderamiento` or `poder`; this burst starts “No es asi” and uses pronouns. Mobile attempt state then selects `CERTIFICATE_COPY_HELP`. Neither the purpose nor the proposed alternative is addressed.

**Proposed trigger:**

```ts
const purposeAndAlternative = inGuidanceState
  && /\b(?:otra manera|para que (?:te )?sirve)\b/.test(n)
  && /\b(?:correo|firmo|firmar)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-guidance.ts`, `reviewedConversationReply`, purpose/alternative branch:**

> Elige la vía gratuita por tu cuenta en el juzgado para dar poder de representación a los procuradores. ¿Qué documento propones firmar por correo?

Make `guidanceRequest` return `null` for this explanation request so the reviewed reply is reachable. Use the known APOD conversational context to explain the purpose, but clarify the document before judging the proposed email signature. Do not assert that an email signature is legally valid or invalid. Describing an alternative does not select it or authorize partner management; do not consume a copy-help attempt.

## R9 — “I cannot during work” becomes “the process does not work”

**Case:** #31 says they have Cl@ve PIN, cannot use the phone during work, and could do it tomorrow morning.

**Current cause and source:** `conversationYield` at `conversation-guidance.ts:19–22` examines the final deferral line but its return pattern misses “mañana por la mañana lo podría hacer”. The broad `no puedo` pattern in `guidanceRequest.failed` then treats work availability as a technical failure. `messages.ts:81` tells a replay-assigned PC/certificate user to enter Sede, without resolving what credential the client actually named.

**Proposed trigger, before digital failure matching:**

```ts
const availabilityWithCredential = /\bcl[a@]ve pin\b/.test(n)
  && /\b(?:trabajando|horario de trabajo)\b/.test(n)
  && /\b(?:manana por la manana|lo podria hacer|cuando salga)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-agent.ts`, availability/credential clarification branch:**

> Retómalo cuando puedas mañana por la mañana. ¿Te refieres a Cl@ve PIN o al PIN del DNI electrónico?

Improve `conversationYield` in `src/core/conversation-guidance.ts` for comparable pure deferrals, but retain the credential clarification for this mixed message. Do not book an appointment, promise an operator will be available, offer signing with Cl@ve PIN, overwrite `hasDigitalCert` or increment help attempts. The quoted time is the client's stated availability, not an invented deadline.

## R10 — Intake confusion lacks an actionable answer and a “don't know” path

**Case:** #25 “No entiendo entonces que tengo que hacer”.

**Current trigger and source:** agent `:260` matches `no entiendo`, an intake/acquisition state, and `hasDigitalCert !== true`. Its exact definition-plus-“¿Recuerdas…?” reply scores 3 because it does not explain what to do if the client does not know.

**Proposed narrowed trigger, after subject routing:**

```ts
const intakeConfusion = ['INITIAL_TRIAGE', 'WAITING_CERT_RESPONSE', 'CERT_ACQUISITION_LINKS_SENT'].includes(c.currentState)
  && c.hasDigitalCert !== true
  && /\b(?:no entiendo|no se que tengo que hacer|que tengo que hacer)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-agent.ts`, existing deterministic confusion branch:**

> Comprueba si tienes un certificado digital a tu nombre para empezar el apoderamiento. Si no lo tienes o no lo sabes, dímelo y te indico cómo seguir.

Keep “no lo sé” distinct from a verified “no tengo certificado”. Route the next answer against the saved pending question; do not begin a new introduction.

## R11 — Distress is answered with a workflow question

**Case:** #33 reports anxiety and asks to be taken from work to hospital.

**Current cause and source:** no deterministic wellbeing branch precedes the certificate workflow. The reply exactly equals `pendingConversationText` in `messages.ts:31` for `WAITING_CERT_RESPONSE` with unknown certificate ownership. Model-handoff suppression at agent `:171–172` is one reachable route; the artifact does not record whether that branch or a model-generated identical reply ran.

**Proposed trigger, before workflow prompts:**

```ts
const needsImmediatePersonalSupport = /\b(?:ansiedad|me encuentro mal|me siento mal)\b/.test(n)
  && /\b(?:hospital|urgencias|me lleven|pedir ayuda)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-agent.ts`, wellbeing acknowledgement branch:**

> Pide ayuda a alguien cercano para que te acompañe a recibir atención médica. Dejamos el trámite para cuando puedas retomarlo.

Preserve the pending step and require human review of further contact. Do not diagnose the client, promise medical assistance or keep asking about certificates. Any statement that follow-ups are paused must correspond to the existing persisted pause behavior.

## R12 — DNI PIN and certificate-copy password are conflated

**Case:** #36 asks whether the forgotten password is the DNI credential and says they need to change it.

**Current cause and source:** the saved reply is not a deterministic literal in the four reviewed files. It is consistent with `respond`'s validated model reply (`conversation-agent.ts:157–178`), which guesses the certificate-copy password without settling the DNI ambiguity. The deterministic password question at `:234–235` only handles whether the bot needs the password, not which credential was forgotten. `CERTIFICATE_COPY_HELP` and `ASSIST_CERT_PASSWORD_INVALID` in `messages.ts` must not be used as general DNI PIN recovery instructions.

**Proposed trigger, for questions without an actual disclosed secret:**

```ts
const forgottenAmbiguousCredential = /\b(?:contrasena|clave|pin)\b/.test(n)
  && /\b(?:dni|dnie|certificado)\b/.test(n)
  && /\b(?:no me acuerdo|no recuerdo|olvidad[oa]|cambiarla|cambiarlo)\b/.test(n);
```

**Reply — belongs in `src/core/conversation-agent.ts`, credential-type clarification branch:**

> Aclara qué credencial necesitas recuperar sin escribirla aquí. ¿Te refieres al PIN del DNI electrónico o a la contraseña de la copia del certificado?

This gives one concrete next step without inventing a recovery procedure. Keep the real-secret gate ahead of this branch; the redacted placeholder in the artifact is not evidence of a usable credential. Do not ask the client to send a PIN, password, code or certificate, and do not infer consent from a recovery question.

## Acceptance checks for implementation

1. Replay the **same 23 failed rows**, including both #11 and #18, with real provider/FSM integration. Record the selected event, topic, renderer, resulting state and the full reply. Do not substitute invented client examples or claim success from matcher checks alone.
2. Assert that R1–R6 messages select the relevant topic before generic APOD help/pricing in all four saved replay states. Confirm no certificate question/tutorial is appended, no assistance counter changes, and no payment or consent event is inferred.
3. Verify the exact Spanish copies above satisfy the length/question limit. Generic APOD price replies must retain free self-service and optional partner pricing; money, claim status and disputed charges must include `reclamaciones@litigios.es`.
4. For #3/#24, preserve the reported screen problem in the selected `helpTopic`; verify it survives the FSM and reaches the topic-specific renderer before certificate-copy progression. For #31, do not convert availability into an export failure.
5. For #6/#14/#27/#35 and any other handoff, verify the persisted human-review task and one client notice, then distinguish outbox creation, send acceptance and delivery. Do not count the evaluator's empty `template` result as proof of silence or clear the review gate to get a reply score.
6. Render against the post-transition case patch and include escalation notices when measuring coverage. Preserve the original artifact for comparison; recompute the original 17/40 figure only from a fresh, correctly observed replay. This document makes no projected coverage claim.

Analysis snapshot: `evidence/hard-case-coverage.json` SHA-256 `bbbb1061c07a7663a324037344d7df3107b07d02bb556ba852b9de3b8a1d0f02`. Source references point to the working tree inspected on 2026-09-21, not a clean committed revision.

| Initially inspected source | SHA-256 |
| --- | --- |
| `src/core/conversation-agent.ts` | `d71f0df01008b52a5a53084cc404f3187c501cbbb6d2eb1dbda62582d0e02bc2` |
| `src/core/conversation-guidance.ts` | `9a08be6554fe854908cb4bf6e864688d1644efa1a8dc0a53b52c2aabb2d9020c` |
| `src/core/messages.ts` | `e498ea93e428029281eae3eb23c6dbd59f5226df8edebbec2f3b5defc488ab3c` |
| `src/domain/fsm/state-machine.ts` | `3d207f655baae70d29dbc2e27e64f5d70bf8943b1b7acb5ec0f985008e026856` |

Later artifact observed during verification: SHA-256 `908464cb1c359b20224c38ae2f413b65ea1f12b90d03fb0cc6cec3e47417d40a`. Neither that run nor the concurrent source edits were produced by this documentation task.
