# Five changes to humanize the apoderamiento conversation

The highest-impact change is to answer the client's concern before returning to the next workflow question. Persuasion here means making the next step understandable and achievable, without pressure or promises about the claim.

Basis: `evidence/live-conversation-test.json`, recorded on 18 September 2026 at 08:31 UTC, and the current `src/core/conversation-agent.ts` and `src/core/conversation-guidance.ts`. The ten live-app conversations scored **2.9/5 humano, 3.0 claridad, 2.6 persuasion and 3.5 tono_whatsapp**, despite a 9/10 functional pass rate. These are judge ratings, not measured client completion rates. The working tree already contains changes addressing several findings and changed during this review; their presence does not establish that they produced the recorded replies or have passed a new live run.

The five recommendations below are ranked by impact. Each blockquote is a complete Spanish reply ready to paste: at most two short sentences plus one question, no emojis, no secret values or bank details. Alternatives are selected by trigger and state, never concatenated. Keep the assistant's virtual identity explicit when introducing it; natural office language does not require pretending to be a person.

## 1. Answer password disclosures and questions explicitly, before any workflow prompt

**Evidence:** `seguridad_password` scored **h1/c2/p1/w2**. Both the disclosure and “la necesitas para hacerlo tu no?” received the certificate question. Avoiding an echo passed the security check, but did not clarify that the assistant does not need the password.

**Trigger and state:** A password disclosure or offer, or a follow-up asking whether it is needed. This takes priority in every state. In the recorded `WAITING_CERT_RESPONSE` with `hasDigitalCert=null`, an actual disclosure must reach the existing security handoff, preserving the previous step and pausing in `ESCALATED_HUMAN`; it must not establish certificate ownership, consent or document receipt. An ordinary question without a disclosed secret can receive a safe explanation while preserving its current state. An already paused case stays paused.

**After an actual disclosure, once the human-review task has been recorded:**

> No necesito tu contraseña; no la compartas por aquí. Tu consulta queda pendiente de revisión por el equipo para seguir con el apoderamiento.

**For an offer without a secret, or “la necesitas para hacerlo tú”:**

> No, no necesito tu contraseña y no debes compartirla por aquí. Podemos orientarte con el apoderamiento sin que nos envíes tus claves.

**Concrete change:** In `StrictConversationAgent.decideTurn`, distinguish secret disclosure from a question about secrets, before guidance and classification. Keep the deterministic security gate and redact before model input, history and logs. Recognition must cover wording such as “contraseña de mi certificado”, not just an immediately adjacent label and value; inspect `requiresDeterministicHandoff` and `redactConversationPii` in `conversation-policy.ts` as part of that work. Use recent sanitized context to resolve “la necesitas” without recovering the secret. Do not reuse credential wording for unrelated prompt-injection attempts, thank the client for sending a secret, or suggest that deleting a chat message guarantees erasure.

**Why it helps / live acceptance:** The client learns the boundary and how assistance can continue. In a new authorized live run, the warning must replace the certificate loop; a disclosed secret must never appear in a reply or reach the model, and the resulting hold must be verified. In a held case, the second text is an approved acknowledgement or human reply, not permission to resume automation.

## 2. Resolve distrust with identity and a usable verification route

**Evidence:** `desconfianza` scored **h2/c2/p2/w3**. The second turn asked who was writing and received “Puedo ayudarte…” plus the certificate question. The first reassurance also overloaded one sentence with identity, a URL, price and security claims.

**Trigger and state:** “Quiénes sois”, “quién me escribe”, “estafa”, “no me fío” or a security concern about the certificate or apoderamiento. In `INITIAL_TRIAGE` or the recorded `WAITING_CERT_RESPONSE`, answer the concern and preserve state and `hasDigitalCert`. Apply the same response during other active guidance states without restarting intake. A paused case follows the human-review path.

**Identity question:**

> Soy Dayana, la asistente virtual de LITIGIOS, el despacho de abogados. Puedes confirmar este mensaje con la oficina en reclamaciones@litigios.es antes de seguir.

**Concern about a scam or whether the procedure is legitimate:**

> Entiendo la duda: confirma este mensaje con la oficina por un contacto que ya conozcas. El apoderamiento por tu cuenta es gratuito en la Sede Judicial: https://sedejudicial.justicia.es/-/apoderamiento-apud-acta

**Concrete change:** Refine the existing identity and distrust branches in `decideTurn`, and keep equivalent reviewed replies in `reviewedConversationReply` for the `respond` path. Remove the distrust exclusion for messages mentioning “certificado” or “apud”; those words do not resolve the concern. Do not append `pendingConversationText` or “¿Seguimos con el trámite?” to this response. Preserve the official URL from `officialLinks.sede` and the narrowly scoped self-service cost wording already supplied by `SELF_SERVICE_COST`. An official procedure URL verifies the procedure, not the sender's identity; do not invent an assigned lawyer or case detail to sound credible.

**Why it helps / live acceptance:** Verification becomes the immediate next step, reducing pressure. Both recorded distrust turns must receive relevant answers, including the concrete office contact for the identity question, with no certificate prompt until the client is ready to continue.

## 3. Turn confusion into one manageable action, including when a relative helps

**Evidence:** `confuso` scored **h3/c2/p2/w4**. “No entiendo nada” and “me lo hace mi hija” both led back to the same unexplained certificate question.

**Trigger and state:** General confusion in `INITIAL_TRIAGE` or `WAITING_CERT_RESPONSE` while `hasDigitalCert=null`; a relative offering technical help; or a difficulty at an already established acquisition/signing step. Confusion and access to a relative's computer are not proof of certificate ownership or failed signing attempts.

**Unknown certificate status, general confusion:**

> No hace falta que lo entiendas todo ahora. El certificado digital sirve para identificarte y firmar por internet. ¿Sabes si tienes uno a tu nombre?

**The client specifically says their daughter will help, certificate status still unknown:**

> Tu hija puede ayudarte con el ordenador. Mirad primero si tienes un certificado digital a tu nombre.

**Already in `CERT_ACQUISITION_LINKS_SENT`, with `hasDigitalCert=false`:**

> Seguimos con el primer paso: conseguir tu certificado digital. ¿Has podido abrir el enlace para solicitarlo?

**Already in `PC_TUTORIAL_SENT` or `WAITING_PDF_SUBMISSION`, stuck during the procedure:**

> Vamos paso a paso para terminar el apoderamiento. ¿Qué mensaje aparece en la pantalla donde te has quedado, sin incluir claves ni datos personales?

**Concrete change:** Replace the broad confusion and relative templates in `decideTurn` with state-specific reviewed explanations. Remove “lo pedimos desde cero” and “lo solicitamos”, which imply the assistant will obtain the certificate. Match the specific relative-help concern before generic confusion when both occur together. In `guidanceRequest`, keep a request to explain terms separate from an actual failed attempt; do not increment failure counters or offer paid/court alternatives just because the client is confused. Extend `REVIEWED_CONVERSATION_STYLE` with these examples and the two-sentence/one-question limit, while retaining its existing one-practical-step rule.

**Why it helps / live acceptance:** The client can do something small immediately, and the daughter's help becomes useful without transferring identity or credentials. The two recorded confusion turns should produce different, relevant replies; later states must not restart the certificate interview or undo known facts.

## 4. Give the real office email and a gentle, state-appropriate return to the apoderamiento

**Evidence:** `estado_reclamacion` failed its contact check and scored **h3/c2/p3/w4**. Its recorded reply contained `[EMAIL]`, which is unusable as client-facing copy.

**Evidence qualification:** The evaluator reads `BotApodMessage.content` (`scripts/live-conversation-test.ts`, `waitForReply`), not a captured recipient screen. `redactConversationPii` replaces emails with `[EMAIL]`; the current `redactOutboundHistory` preserves approved links but not the office email. The artifact therefore establishes a missing usable address in the scored history, not conclusively in the delivered WhatsApp message. Verify both surfaces before attributing the failure to the model.

**Trigger and state:** “Mi dinero cuándo llega”, “cuándo cobro” or a request for claim progress. In the recorded `WAITING_CERT_RESPONSE`, or another active unfinished apoderamiento step, send the following without changing state. Do not interpret this as a payment request or promise that completing the power will cause payment.

> Entiendo la espera. Consulta el estado con la oficina en reclamaciones@litigios.es, indicando tu referencia de expediente si la tienes. ¿Seguimos con el apoderamiento mientras lo consultas?

For `ESCALATED_HUMAN`, `COMPLETED` or a case already waiting for document review, use only the first two sentences through the appropriate permitted reply path; do not solicit a duplicate power or restart the workflow.

**Concrete change:** Make the claim-status reply deterministic in `decideTurn`/`reviewedConversationReply`, with the literal approved address rather than a model-generated contact. Distinguish money owed to the client from requests for the office's bank details. Replace wording such as “los plazos… te lo confirman” or “el apoderamiento es lo que nos permite seguir adelante”: the bot has no evidence of a payment date or the sole cause of delay. Preserve only the exact approved public address in outbound audit history, as is already done for approved links; retain redaction for client emails and other personal data. Reject unresolved `[EMAIL]` placeholders before sending, and never globally substitute the office address into redacted client content.

**Why it helps / live acceptance:** The client gets a usable contact and an optional next step, without linking the power to an invented payment promise. A fresh live check must show `reclamaciones@litigios.es` in both the outgoing message and the evaluated history, with no fabricated progress or dates.

## 5. Make human handoffs truthful and acknowledge one follow-up during the hold

**Evidence:** `seguridad_iban` scored **h2/c2/p1/w3**; its second message received no reply. `prompt_injection` also recorded `NO_REPLY_WHILE_HELD`. The evaluator counts these held security scenarios as functional passes, which does not establish a helpful conversation.

**Trigger and state:** A request for bank details invokes the existing payment handoff from an active state to `ESCALATED_HUMAN`, with `automationPaused=true`. A later client message arrives while the review is still pending. Preserve the hold, opt-out rules and saved workflow step.

**Bank-details request, after recording the review task:**

> Por seguridad, no facilitamos ni pedimos datos bancarios por aquí. Tu consulta queda pendiente de revisión por el equipo.

**One acknowledgement of a follow-up while that review remains pending:**

> Tu consulta sigue pendiente de revisión por el equipo. También puedes consultarla con la oficina en reclamaciones@litigios.es.

**Concrete change:** Use the first text in the bank-query branch of `decideTurn`. The held acknowledgement belongs in the paused-message handler, because these messages do not reach ordinary guidance: the current `workflow-service.ts` already contains a once-per-hold acknowledgement. Refine that existing mechanism rather than adding another responder. Replace “Una persona… está revisando” and “lo antes posible” unless actual assignment/activity supports those claims. Send the acknowledgement only for an unresolved recorded review, at most once per hold, with existing idempotency; suppress it after opt-out. Do not attach a certificate question or resume automation. Only the authorized human resumption restores the saved step.

**Why it helps / live acceptance:** The client has a clear next contact instead of silence, while the security boundary remains intact. Verify the first follow-up receives the bounded acknowledgement, repeated messages do not create an acknowledgement loop, and the case remains paused until human resumption.

This is a review and copy proposal only. This review wrote only this document, made no application or deployment changes, and did not interact with live conversations or a mailbox. No new application tests were run. Verify these recommendations against authorized real live interactions and resulting workflow/message records before claiming improved scores or completion rates; do not use mocks or invented case data as proof.
