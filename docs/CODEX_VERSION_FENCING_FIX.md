# Version fencing: smallest safe correction

Design only, 2026-09-21. No implementation, database operations, provider calls or tests were performed for this report. This document is the only file written. Anchors refer to the current working tree on `main`, HEAD `b2eb3523754030e86f1480b8252f23ae2c08253e`, including existing uncommitted changes. The inspected source fingerprints are recorded below.

The named finding is present. In the current `docs/CODEX_MEMORY_SCALE_AUDIT.md:136` it is ranked **2 — High**; rank 1 is cross-client memory contamination. This report addresses the version-fencing finding specified in the request, irrespective of that numbering.

## 1. Recommended change

Keep the existing `BotApodExpediente.version`, all business-action `expectedVersion` checks, the per-case Redis lock, and the transactional compare-and-swap. Exempt **only a validated `CLIENT_SMALL_TALK` reply that changes neither state nor persisted case values** from advancing the version. Continue creating its audit and outbox records and consuming its inbox rows atomically.

The smallest production patch is confined to **two locations in `src/core/workflow-service.ts`**:

1. Bind each small-talk event to the durable inbox source ID before evaluation.
2. Replace the broad “any action means change” condition with a narrow exemption for proven chat-only replies, including a source-ID precondition.

No new version column, database migration, decision-contract field, FSM flag, executor exception or consent bypass is required. The version remains a fence for workflow facts **and business-effect progression**; it is not a count of messages. More than one audit/action may legitimately share a version.

Do **not** simply remove `decision.actionRequired !== 'NO_OP'`. Some business effects advance the workflow without changing the state label or applying a case patch:

- `OPERATOR_PAYMENT_CONFIRMED` schedules partner order creation while remaining in `APUDATA_WAITING_PAYMENT` (`src/domain/fsm/state-machine.ts:1020–1036`).
- `KMALEON_AVISO_VERIFIED` schedules `NOTIFY_DAYANA`, and `DAYANA_NOTIFIED` schedules `COMPLETION_NOTICE`, while remaining in `HANDOFF_DAYANA` (`src/domain/fsm/state-machine.ts:1103–1117`).
- Certificate receipt/inspection schedules inspection or draft preparation while remaining in `MOBILE_ASSIST_PROCESSING` (`src/domain/fsm/state-machine.ts:522–524`, `src/domain/fsm/state-machine.ts:553–562`).

Their current increments must remain. Exempting every WhatsApp action is also unsafe: consent requests, draft review requests and completion notices are business actions even though their transport is chat.

## 2. Root cause and failure path

`WorkflowService.transition()` loads document evidence, evaluates the actual FSM, allowlists its patch and combines it with the caller patch (`src/core/workflow-service.ts:49–64`). It then adds step, reminder and control changes (`src/core/workflow-service.ts:65–73`). Today:

```ts
const changed = decision.nextStep !== c.currentState
  || decision.actionRequired !== 'NO_OP'
  || Object.entries(combined).some(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(c[key as keyof BotApodExpediente]));
```

The small-talk handler explicitly returns the same state and a `SEND_WHATSAPP_MESSAGE`, with no case patch (`src/domain/fsm/state-machine.ts:1254–1262`). Therefore a support answer changes `N` to `N+1` solely because it sends text (`src/core/workflow-service.ts:74–79`). The outgoing support answer has a special executor exception, but the business action it invalidates does not (`src/queue/action-executor.ts:69–72`).

Consequences of one otherwise neutral answer:

| Existing work captured at version N | Current consequence after support changes the case to N+1 |
|---|---|
| Accepted consent/draft-review request | The webhook maps a subsequent button to `E.help` because the request version differs (`src/api/server.ts:238–243`). If an already-enqueued approval reaches the worker, its separate check produces `STALE_CLIENT_CONSENT_OR_REVIEW` (`src/core/workflow-service.ts:248–251`). |
| Pending Kmaleon/Dayana action | Executor marks it `STALE`, `CASE_CHANGED_BEFORE_EFFECT`, without executing it (`src/queue/action-executor.ts:72`). |
| Completion message awaiting delivery | Delivery is recorded as `EXECUTED`, but its completion transition is skipped and `DELIVERY_CONFIRMED_AFTER_STATE_CHANGE` is logged (`src/queue/action-executor.ts:258–261`). |
| Operator document approval or document intake using version N | The service rejects the old version despite no relevant document/fact change (`src/core/workflow-service.ts:94`, `src/core/workflow-service.ts:138`). |

This is reachable through the actual inbox path. The pending-message barrier includes `PENDING`, `RUNNING` and `UNCERTAIN` WhatsApp actions, but **excludes `AWAITING_DELIVERY`** and non-WhatsApp CRM actions (`src/core/workflow-service.ts:183–185`). Consequently, an accepted consent request or completion notice can coexist with a processed support turn. A reproduction that leaves the original WhatsApp request `PENDING` and expects `processInbox()` to process another turn would test an impossible ordering under that barrier.

## 3. Which writes advance the fence

| Write or decision | Version policy in this fix |
|---|---|
| A real `currentState` change, including escalation, recovery and completion | Advance once in the transition. Preserve the compare-and-swap. |
| A changed caller patch or allowlisted FSM patch, including with `NO_OP` | Advance. Compare the final `combined` patch against the original persisted `c`, not the already-patched `snapshot`. |
| Certificate facts and routing counters | Advance when changed: `hasDigitalCert`, `certDevice`, `digitalHelpAttempts`, `certificateHelpAttempts`. The counters affect future routing; a helpful answer that increments them is business progress (`src/domain/fsm/state-machine.ts:345–367`). |
| Consent grant, withdrawal, scope-version or timestamp changes | Advance through the existing transition. `consentGranted`, `consentVersion`, `consentGrantedAt` are business facts. A chat reply must not set, renew or clear them. |
| Document selection, audit, approval, client review and filing progress | Preserve their increments: `documentId`, `auditStatus`, `pageCount`, `documentApproved`, `clientReviewed`, `isProvisionalFiled`, plus the business actions/evidence that accompany document-row changes. See intake/audit/approve at `src/core/workflow-service.ts:102–106`, `src/core/workflow-service.ts:130–132`, `src/core/workflow-service.ts:147–150`. |
| Partner preapproval/order facts | Advance when changed: `apudataOrderId`, `apudataPreApproved`, `apudataApprovalExpiresAt`, `apudataApprovalEvidence`. A same-state `NO_OP` that refreshes approval evidence still advances (`src/domain/fsm/state-machine.ts:1051–1059`). |
| Business effects without state/fact changes | Preserve the existing increment, including the examples in section 1 and reissued business requests. Default to the existing fenced behavior for any action outside the narrow exemption. |
| Step/control changes produced by a transition | Preserve increments, including `stepReached`, `previousState`, escalation pause and opt-out. A step repair performed during a support event is not a neutral transition. Keep the existing derived step/reminder logic. |
| Operator pause/resume and verified address edits | Preserve the explicit increments in `src/api/automation.routes.ts:25–34` and `src/api/assisted.routes.ts:51–56`. Do not weaken their version checks. |
| Same-state, same-fact FSM-approved small-talk/support response | **Do not advance.** Still persist the reply action, audit evidence and consumed inbox status. This includes the FSM's approved rollout replies, not just the literal `CONVERSATION_REPLY` template. |
| Transcript/inbox/audit/outbox lifecycle writes | Do not advance solely because a message was stored, accepted, delivered, retried or recorded in an audit. A resulting business transition may independently advance. |
| Conversation/contact metadata | Keep current non-versioned writes: `lastInboundAt`, `lastOutboundAt`, `priorConversation`, `pendingQuestion`, `pendingQuestionAt`; future summary-only writes should follow that separation. These fields do not themselves grant consent or approve documents. |
| Reminder scheduling/activity metadata | Keep the existing separate `reminderCycle`, anchor, count/day and next-date fencing for activity, reminder creation and acceptance. Do not make every inbound/outbound timestamp reset a business version. A legacy FSM `REMINDER_DUE` that emits a business template remains under the conservative existing action rule. |
| A true hold: same state, `NO_OP`, no changed values | Continue not advancing. No behavioral change. |

The runtime already writes conversation metadata outside `transition()`: inbound activity at `src/core/debounce-buffer.ts:20–22`, accepted outbound history/question/scheduling at `src/queue/action-executor.ts:113–122`, imported history at `src/api/automation.routes.ts:43–48`, and scheduled reminder actions at `src/core/automation.ts:27–30`. Leave those paths intact. Do not copy the whole stale case snapshot back to the database to implement this fix.

**Conservative boundary:** this patch does not add a general field-classification framework or normalize Prisma update expressions. Every changed entry in `combined` still fences; `{ increment: 1 }` remains a change. The existing comparison can conservatively treat `{ set: oldValue }` or JSON-null operations as a change. That is preferable to accidentally exempting a business write. Current neutral support transitions supply an empty case patch. A future feature passing chat timestamps through `combined` would need a separate reviewed persistence split, rather than silently adding fields to an ignore list.

**Existing bypasses are not fixed by this proposal.** Direct early opt-out marking (`src/core/debounce-buffer.ts:23`), the 30-day pause (`src/core/automation.ts:21`), and the refusal-handling unpause (`src/core/workflow-service.ts:211`) do not currently increment at that write. Kmaleon display metadata refresh also bypasses the version (`src/core/workflow-service.ts:34`). Early stop/pause paths have direct executor flag checks (`src/queue/action-executor.ts:60–61`, `src/queue/action-executor.ts:91–94`); the opt-out FSM transition separately fences. Preserve these protections, but do not claim that every case-table write already obeys one universal version rule. Auditing those bypasses is separate from narrowing the support-reply increment.

## 4. Exact proposed edits

### Edit A — bind the event to its durable source

In `src/core/workflow-service.ts:254–265`, immediately before the call to `this.transition(...)` currently at line 262, add:

```ts
if (eventType === EventType.CLIENT_SMALL_TALK) {
  eventPayload = { ...eventPayload, messageId: row.externalId };
}
```

Do this after the conversation-agent payload merge at `src/core/workflow-service.ts:237`. The persisted source ID must win over generated data. For a grouped turn, use the first inbox row's stable `externalId`; the same transaction already consumes every ID in `turnIds`. Keep the incoming `messageSha256` and other existing provenance.

Why include this small edit? `decisionIdFor()` hashes case ID, version, state, event type and the canonical **full event payload** (`src/core/decision-engine.ts:74–76`). With a stable business version, two identical replies must still have distinct decision IDs when they answer different inbound messages. `BotApodAccion.decisionId` and `idempotencyKey` are unique (`prisma/schema.prisma:105–110`). Real webhook payloads already carry `messageId` (`src/api/server.ts:211`, `src/api/server.ts:229`); this makes that dependency explicit at the service boundary, including older inbox records.

Do not add a random UUID to the event, hash just reply text, or change the global decision-ID algorithm. A retry must retain its source identity; separate genuine turns must differ. The existing inbox status/unique external-ID checks remain the replay barrier. A direct duplicate call to the low-level `transition()` is not a substitute for inbox replay handling: its unique-key failure must roll back, not be advertised as an idempotent successful send.

### Edit B — exempt only a proven neutral support reply

Replace `src/core/workflow-service.ts:74–75` with the following block, after **all** current `combined` patch construction, including opt-out and certificate handling:

```ts
const stateChanged = decision.nextStep !== c.currentState;
const casePatchChanged = Object.entries(combined).some(([key, value]) =>
  JSON.stringify(value) !== JSON.stringify(c[key as keyof BotApodExpediente]));

// Only the validated FSM support path can avoid a business-version bump.
// Same-state business effects and support that changes facts remain fenced.
const chatOnly = type === EventType.CLIENT_SMALL_TALK
  && decision.actionRequired === 'SEND_WHATSAPP_MESSAGE'
  && decision.actionPayload.kind === 'SEND_WHATSAPP_MESSAGE'
  && !stateChanged
  && !casePatchChanged
  && payload.requiresHumanReview !== true
  && decision.actionPayload.discardCertificateMaterial !== true;

if (chatOnly && (typeof payload.messageId !== 'string'
    || payload.messageId.trim().length === 0)) {
  throw new AppError('CHAT_SOURCE_MESSAGE_REQUIRED', 400);
}

const changed = stateChanged || casePatchChanged
  || (decision.actionRequired !== 'NO_OP' && !chatOnly);
const nextVersion = c.version + (changed ? 1 : 0);
```

The FSM, not a model-provided `chatOnly` flag or the presence of reply text, establishes the event's meaning. Invalid small-talk payloads escalate or hold before this code (`src/domain/fsm/event-payloads.ts:150–160`, `src/domain/fsm/state-machine.ts:1316–1325`). A small-talk event requesting human review escalates (`src/domain/fsm/state-machine.ts:1261`), so it still increments and pauses. A same-state support event with a changed caller patch also increments. No template list needs to be duplicated in the service: the FSM already validates and selects the permitted reply at `src/domain/fsm/state-machine.ts:240–249`, `src/domain/fsm/state-machine.ts:1254–1262`.

Leave `src/core/workflow-service.ts:76–87` intact:

- `updateMany({ where: { id: c.id, version: c.version }, ... })` must still run even for neutral chat, with its `count === 1` check.
- Audit and outbox inserts still run; the new reply row captures `expectedVersion: nextVersion`, now N for neutral chat.
- Keep `expectedVersion` as an exact equality fence on business consumers. Never “repair” a pending action by assigning it the current version.
- Keep the engine's contract that `decision.actionPayload.expectedVersion` echoes its **input snapshot** (`src/core/decision-engine.ts:136`, `src/core/decision-engine.ts:221`). The persisted action row uses the **post-transition** version. They coincide for neutral chat and can differ for business transitions. This patch does not change that existing distinction.

The source-ID guard is deliberately narrow: only a reply about to receive the exemption requires it. Direct service callers creating such replies must supply their real durable source message ID. It must fail before any write if that identity is absent.

### Consumers that must stay unchanged

| Location | Preserve |
|---|---|
| `src/api/server.ts:238–243` | Consent/review request lookup by quoted message, case, eligible action status, correct template and exact request version. |
| `src/core/workflow-service.ts:248–251` | Worker request ownership, exact version and one-hour request-age checks. |
| `src/core/workflow-service.ts:89–90`, `src/core/workflow-service.ts:94`, `src/core/workflow-service.ts:138` | Operator/event/intake/document concurrency checks. |
| `src/queue/action-executor.ts:69–81` | Business action fencing, existing conversation-step rule and uncertain-outcome handling. Do not extend the conversation exception to CRM actions. |
| `src/queue/action-executor.ts:125–127` | Apply verified business results only to the matching version; preserve evidence if the version changed. |
| `src/queue/action-executor.ts:258–261` | Apply delivery-triggered transitions only to the matching version. |
| `src/api/assisted.routes.ts:85–100` | Fresh scoped consent, identity, address, provenance and withdrawal monitoring. |

## 5. What happens to an action captured before a chat reply

Let A have `expectedVersion=N` and the current case be N. A neutral chat is processed, audited and assigned its own reply action. The case remains N; **A is unchanged**.

- **A is pending:** the ordinary executor equality check passes. A still needs identity, pause/opt-out and its normal document/financial/provider gates. Keeping a version does not itself authorize an effect.
- **A is running under the case lock:** `execute()` holds the same case lock as `processInbox()` (`src/queue/action-executor.ts:52`, `src/core/workflow-service.ts:189`). Normally the chat transition waits; ingestion can still persist new activity. After A finishes, the chat uses the current snapshot. Do not invent a same-case simultaneous transition while that lock is healthy.
- **A is awaiting delivery:** chat may run now. A matching real callback can still execute its `nextEvent`, including completion. An actual business change between send and callback must still prevent that transition.
- **A is uncertain:** keep reconciliation against pinned effect context and recorded receipts. Chat creates no new reason to fail the version check. This does not authorize resending an uncertain WhatsApp message or repeating a CRM write (`src/queue/action-executor.ts:77–81`, `src/queue/action-executor.ts:129–137`, `src/queue/action-executor.ts:151`).
- **A became stale before deployment:** it stays stale. No counter decrement, bulk `expectedVersion` rewrite, automatic resend or fabricated receipt. Reconcile/reissue through existing operator controls with real evidence.
- **A is followed by a real fact/state/business-effect change:** the case becomes N+1, and all existing stale checks continue to operate. This includes changes inside the same state label.

The unchanged compare-and-swap is still meaningful when chat leaves the version unchanged: a business write from N makes a later write based on N fail. Two serialized neutral chats may both use N intentionally. Transcript/inbox/action identities, not a case-version increment, distinguish them. The case update remains sparse, so it does not overwrite unrelated contact metadata with an old snapshot.

## 6. Consent freshness and document scope

Three independent concepts must not be conflated:

1. **Request context:** the original action/message, case and expected business version. A click must quote the matching `ASSIST_CONSENT_REQUEST` or `DRAFT_REVIEW_REQUEST`; an arbitrary “yes” does not satisfy this path (`src/api/server.ts:238–243`).
2. **Request age:** the worker rejects requests whose action `createdAt` is more than 3,600,000 ms old, even if the case version is unchanged (`src/core/workflow-service.ts:251`). Keep the current exact boundary and timestamp source. Queue delay currently consumes this window. Neither a reply nor a delivery-status update changes that creation time.
3. **Granted consent scope/age:** granting consent changes state and writes `consentGrantedAt` from the FSM clock (`src/domain/fsm/state-machine.ts:487–495`). Secure assisted work checks the granted flag, processing state, one-hour grant age, configured `CONSENT_VERSION`, identity and recorded consent evidence (`src/api/assisted.routes.ts:85–92`). The running session checks expiry and durable denial/opt-out evidence (`src/api/assisted.routes.ts:14–32`, `src/api/assisted.routes.ts:93–100`).

`consentVersion` is the consent wording/scope identifier; it is not the integer case version. Neutral chat changes neither. It must not refresh `consentGrantedAt`, request `createdAt`, draft IDs/hashes or evidence references. An expired request remains rejected; a newly approved, correctly bound request/consent is needed. Automatic renewal/re-requesting is outside this smallest patch.

Draft approval retains both its request fence and the stored draft ID/hash/type guard (`src/domain/fsm/state-machine.ts:585–603`). New documents, audit outcomes and actual review changes continue advancing the case version. Operator document approval still checks ID, hash, audit eligibility and client-review evidence (`src/core/workflow-service.ts:136–150`).

Do not overstate the current checks: the WhatsApp ingress path carries the receipt's consent version, while the configured wording comparison is explicitly enforced at assisted-work entry. The worker recheck at line 251 is not a full revalidation of every webhook field. This report preserves these layers; it does not claim to add missing consent validation or to make `flow.transition()` an authorization endpoint.

## 7. Concrete red/green regression through the real FSM and service

### Inputs and execution boundary

Use real PostgreSQL, the actual `WorkflowService` and its real Redis/Redlock, and actual durable WhatsApp input from a permitted case. No fake Prisma client, replacement FSM/decision engine, synthetic case, mocked `ActionExecutor`, manufactured provider receipt or manually assigned `EXECUTED` status is acceptable.

Required real scenario: a case in `MOBILE_ASSIST_CONSENT_REQUESTED`, version N, with a genuine accepted/delivered `ASSIST_CONSENT_REQUEST` action at N less than one hour old, followed by a due, pending support message such as an actually received question about the **estado de mi reclamación**. That existing local policy returns a neutral support answer (`src/core/conversation-agent.ts:230–233`, `src/core/conversation-agent.ts:291`). The step must already be consistent; otherwise the service legitimately repairs the step and advances the version. If these real inputs are unavailable, report the missing inputs; do not manufacture them or claim a pass.

The following proposed test function belongs in a future `scripts/verify-version-fencing-real.ts`. It accepts the normally wired real service and real IDs from the test operator. It calls the actual conversation policy, which calls no model for this recognized input, then **the actual `WorkflowService.transition()`**, which itself invokes `evaluateNextStep()` and the FSM. It exercises real SQL writes inside a transaction that is always rolled back. It does not dispatch outbox actions or alter the input inbox status.

```ts
import assert from 'node:assert/strict';
import { StrictConversationAgent } from '../src/core/conversation-agent.js';
import { WorkflowService } from '../src/core/workflow-service.js';
import { stepFor } from '../src/core/follow-up.js';
import { EventType } from '../src/domain/fsm/states.js';

export async function verifyNeutralReplyKeepsRequestFence(
  flow: WorkflowService,
  caseId: string,
  supportInboxId: string,
  requestActionId: string,
): Promise<void> {
  const rollback = new Error('ROLLBACK_ONLY_VERIFICATION');
  const agent = new StrictConversationAgent(undefined, 3); // real local policy

  await flow.locked(caseId, async signal => {
    try {
      await flow.db.$transaction(async tx => {
        await tx.$queryRaw`
          SELECT id FROM bot_apod_expedientes
          WHERE id = ${caseId} FOR UPDATE
        `;
        const before = await tx.botApodExpediente.findUniqueOrThrow({
          where: { id: caseId },
        });
        const request = await tx.botApodAccion.findUniqueOrThrow({
          where: { id: requestActionId },
        });
        const inbox = await tx.botApodInbox.findUniqueOrThrow({
          where: { id: supportInboxId },
        });
        const input = inbox.payload as Record<string, unknown>;
        const receipt = request.receipt as Record<string, unknown> | null;
        assert.equal(before.currentState, 'MOBILE_ASSIST_CONSENT_REQUESTED');
        assert.equal(before.stepReached, stepFor(before));
        assert.equal(before.identityVerified, true);
        assert.equal(before.automationPaused, false);
        assert.equal(before.optOutAt, null);
        assert.equal(request.expedienteId, caseId);
        assert.equal(request.expectedVersion, before.version);
        assert.ok(['AWAITING_DELIVERY', 'EXECUTED'].includes(request.status));
        assert.equal(receipt?.template, 'ASSIST_CONSENT_REQUEST');
        assert.equal(typeof receipt?.messageId, 'string');
        assert.ok(request.createdAt.getTime() >= Date.now() - 3_600_000);
        assert.equal(inbox.expedienteId, caseId);
        assert.equal(inbox.source, 'WHATSAPP');
        assert.equal(inbox.eventType, 'CONVERSATION_TEXT');
        assert.equal(inbox.status, 'PENDING');
        assert.ok(inbox.createdAt.getTime() >= request.createdAt.getTime());
        assert.ok(inbox.notBefore.getTime() <= Date.now());
        assert.equal(typeof input.text, 'string');
        assert.match(String(input.text), /estado de mi reclamaci[oó]n/i);
        assert.equal(await tx.botApodAccion.count({ where: {
          expedienteId: caseId,
          actionType: { in: [
            'SEND_WHATSAPP_MESSAGE', 'SEND_WHATSAPP_BUTTONS', 'SEND_WHATSAPP_MEDIA',
          ] },
          status: { in: ['PENDING', 'RUNNING', 'UNCERTAIN'] },
        } }), 0);

        const turn = await agent.turn(before, String(input.text));
        assert.equal(turn.type, EventType.CLIENT_SMALL_TALK);
        assert.equal(turn.payload.requiresHumanReview, false);
        const eventPayload: Record<string, unknown> = {
          ...input, ...turn.payload, messageId: inbox.externalId,
        };
        delete eventPayload.text;
        assert.equal(signal.aborted, false);

        const result = await flow.transition(
          tx, before, turn.type, eventPayload, {}, 'WHATSAPP_CLIENT',
        );
        assert.equal(result.decision.currentStep, before.currentState);
        assert.equal(result.decision.nextStep, before.currentState);
        assert.equal(result.decision.actionRequired, 'SEND_WHATSAPP_MESSAGE');
        assert.ok(result.decision.actionPayload.kind === 'SEND_WHATSAPP_MESSAGE');
        assert.equal(result.decision.actionPayload.template, 'CONVERSATION_REPLY');

        // RED on today's code: actual N+1, expected N.
        // GREEN after Edit B: the same assertion passes, without changing it.
        assert.equal(result.version, before.version);
        const after = await tx.botApodExpediente.findUniqueOrThrow({
          where: { id: caseId },
        });
        assert.equal(after.version, before.version);
        const { updatedAt: beforeTime, ...beforeValues } = before;
        const { updatedAt: afterTime, ...afterValues } = after;
        assert.deepEqual(afterValues, beforeValues);
        const reply = await tx.botApodAccion.findUniqueOrThrow({
          where: { decisionId: result.decision.decisionId },
        });
        assert.equal(reply.status, 'PENDING');
        assert.equal(reply.expectedVersion, before.version);
        assert.equal(reply.idempotencyKey, `apod-${result.decision.decisionId}`);
        const unchangedRequest = await tx.botApodAccion.findUniqueOrThrow({
          where: { id: requestActionId },
        });
        assert.deepEqual(unchangedRequest, request);
        assert.equal(unchangedRequest.expectedVersion, after.version);
        const audit = await tx.botApodAuditLog.findFirstOrThrow({ where: {
          expedienteId: caseId,
          event: EventType.CLIENT_SMALL_TALK,
          metadata: { path: ['decision', 'decisionId'], equals: result.decision.decisionId },
        } });
        assert.equal((audit.metadata as Record<string, unknown>).version, before.version);
        assert.equal(signal.aborted, false);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
}
```

This test is deliberately about the service's fence calculation, not a reimplementation of it. Preconditions fail separately from the regression assertion. On current source, `decision.nextStep` remains unchanged, the action is a real support send, and `result.version === before.version` is the precise predicted failure. On fixed source, unchanged case facts, retained request version, real outbox creation and audit insertion all pass. The deliberate exception rolls back successful verification; an assertion failure also rolls back. No uncommitted action is available for another worker to send. The helper is a test specification here, **not an executed result**.

### End-to-end consent acceptance test

Run this separately through the real authorized WhatsApp channel, real API, queues and database; preserve input/action/receipt IDs as evidence.

1. Reach the consent-request state through the real workflow and obtain actual send acceptance for request R at N. Do not set its status by SQL. Keep the request comfortably inside the one-hour window.
2. Have the real participant ask the neutral support question. Let `DebounceBuffer` and `WorkflowService.processInbox()` process the actual webhook. Allow the quiet period to expire naturally. Confirm one processed input, one reply action, a `CLIENT_SMALL_TALK` audit, unchanged facts and version N. Let the support reply reach real API acceptance so it no longer blocks subsequent inbox work.
3. Have the participant press `CONSENT_YES` on **R**, retaining its real quoted `contextId`. Let ingress and inbox processing run normally.
4. Assert the inbox is `PROCESSED`, the case is `MOBILE_ASSIST_PROCESSING`, `consentGranted=true`, `consentVersion` equals R's receipt value, `consentGrantedAt` is newly set, and version is N+1 **because of the grant**. Inspect the consent audit for `requestActionId`, `contextId` and the actual evidence reference. Do not infer acceptance from the text of a bot reply.

Today, step 2 changes N to N+1. Step 3 then takes the webhook's `E.help` branch and cannot satisfy step 4. A button already ingested before the support transition can instead fail at the worker's stale-request check. After the fix, neither rejection is caused by neutral chat. These are distinct ingress/worker orderings and should be recorded separately.

### Business-effect and delivery tests

| Real scenario | Required result after the fix |
|---|---|
| An already authorized Kmaleon/Dayana action is genuinely `PENDING` at N; process a real neutral support input before executing A | Case and A remain at N. Invoke the real executor through its normal queue. Require the actual adapter read-back/receipt and subsequent FSM progress. `STALE` with `CASE_CHANGED_BEFORE_EFFECT` must not result from the chat. The test must not create a second filing to obtain a sample. |
| A real completion notice is `AWAITING_DELIVERY` at N with `receipt.nextEvent`; a support turn commits before a real matching callback | Callback becomes `EXECUTED`, and the case reaches `COMPLETED` at N+1 through `flow.transition()`, with verified final document and Dayana evidence. Today chat causes `DELIVERY_CONFIRMED_AFTER_STATE_CHANGE` and leaves the business transition unapplied. |
| A genuine document approval uses the version captured before a neutral support turn | The version check still passes; all ID/hash/audit/client-review checks must also pass before an upload can be scheduled. No fabricated document or review evidence. |

For deterministic callback ordering, use an explicitly controlled real acceptance environment with its callback worker paused while the genuine callback remains durable; resume it after the support turn. Do not synthesize a delivered callback. `processInbox()` cannot interleave a support transition inside an executor's healthy per-case lock. If a suitable real CRM/consent/document/callback scenario is unavailable, mark that integration test unverified rather than substituting mocked outcomes.

### Required preservation cases

Use real inputs/evidence and the actual FSM/service for the following, with rollback-only transactions where no external outcome is required:

- **Same-state fact change:** `WAITING_CERT_RESPONSE` with `hasDigitalCert=null/false`, then a real `CLIENT_HAS_CERT`: the state stays the same, `hasDigitalCert` becomes true and version advances exactly once (`src/domain/fsm/state-machine.ts:289–292`).
- **Same-state counter change:** a real guided-help event increments `digitalHelpAttempts`/`certificateHelpAttempts`; version advances. A message being supportive is insufficient for exemption.
- **Same-state business effect without patch:** actual payment-confirmation or Dayana-notice evidence schedules its next business action at N+1. This catches the unsafe alternative of removing all action-based increments.
- **Fact-bearing support event:** any legitimate caller patch carried with small-talk must still increment if a stored value changes. The comparison must use `c`, not `snapshot`.
- **Human review/stop:** a real handoff/opt-out still pauses/escalates and fences; a queued old action is cancelled or held by existing safeguards. The new source-ID guard must not stop those safety transitions.
- **Real change between request/action and use:** an actual document, address, consent or workflow change still makes a request/action captured at N fail at N+1. Include a same-state fact change, not only a changed state label.
- **Expired request with unchanged version:** wait past the real request's one-hour lifetime; an actual quoted click remains `HUMAN_REQUIRED` with `STALE_CLIENT_CONSENT_OR_REVIEW`. Do not alter database dates or fake a clock to claim this live result.
- **Expired/withdrawn grant:** actual expiry/denial must still stop assisted work under the existing checks; support must not extend the grant or erase denial evidence. Exercise certificate/document paths only with authorized real material.
- **Wrong request/draft binding:** actual unrelated/old quoted request or mismatched draft must not grant consent/review. Preserve request ownership, template, hash and state guards.
- **Two distinct real messages producing identical reply text:** both neutral transitions stay at N, while decision IDs/idempotency keys differ because their durable source IDs differ. No `P2002` collision and two legitimate audits/replies.
- **Redelivery of the same genuine message ID:** normal webhook/inbox replay does not create an additional action. Use the recorded actual event; do not invent receipt evidence. Existing dedupe remains responsible.
- **Missing source identity:** a direct neutral-support service call without durable `messageId` fails with `CHAT_SOURCE_MESSAGE_REQUIRED` before any write; business/stop transitions retain their existing handling.

Existing `scripts/test-conversation-inbox.ts:27–36` uses synthetic cases, a queue stub and manual action completion, despite having real database/locks. Do not use that harness as proof under the no-mocks requirement. `scripts/verify-real.ts:295–315` exercises recorded engine replays, which is useful but insufficient alone: this defect is in the service's persistence/version calculation after the engine returns.

## 8. Application order and completion criteria

1. **Capture the regression on unchanged source.** Implement the proposed real-input verifier in a later implementation task. Run against an eligible real case using rollback. Record the actual N+1 versus N assertion failure. Capture a real inbox/consent or delivery scenario when available; record missing inputs explicitly.
2. **Apply Edit A** at `src/core/workflow-service.ts:262` to guarantee stable event identity. Confirm two real source messages yield different decision IDs without relying on a version increment.
3. **Apply Edit B** at `src/core/workflow-service.ts:74–75`. Keep patch assembly, optimistic write, audits, outbox creation and consumer fences untouched. Review these two edits as one deployable change.
4. **Run the same regression unchanged.** It must pass through the actual service/FSM/database, including the audit/outbox and preserved-request assertions. Run the preservation cases, especially same-state facts, counters, business effects and human review. Run `npm run typecheck`; use real-input verification for relevant document/consent paths. Typechecking is not end-to-end evidence.
5. **Verify external outcomes separately.** Require the real consent click, CRM read-back and completion callback scenarios before claiming those integrations fixed. A successful service transaction or send acceptance alone does not establish these outcomes.
6. **Deploy only in a later authorized implementation task.** No schema migration/backfill is necessary. All processes that use `WorkflowService.transition()` need the new code; an old worker can still increment on chat during a mixed rollout. Existing N values remain valid; never reset them. Already rejected/stale work needs individual reconciliation with its original evidence.

The proposed edits and test function were type-checked with TypeScript using in-memory source overlays and `noEmit`; the final check produced zero diagnostics and wrote no source/test files. This validates the snippets' types, not their runtime behavior. The fix and regression tests remain unimplemented and unexecuted. No estimate of affected live cases or recovery success is made.

## Source fingerprints

These hashes identify the files used for the line anchors, not a deployment. Subsequent concurrent edits may move the lines.

```text
140e31bc62a700403251c28282216d791a516492dac6ecc3428a606aed600708  src/core/workflow-service.ts
3d207f655baae70d29dbc2e27e64f5d70bf8943b1b7acb5ec0f985008e026856  src/domain/fsm/state-machine.ts
767f50c2ba2e7630ecd998ba9b65a69eb8badb74f08332815bad3bf023bdcba4  src/core/decision-engine.ts
ae59ddc49b7d5ed7ddf4e9d23316ca9aaaab135209defb1657a6cb776ca931bd  src/queue/action-executor.ts
4db2400d80eb878e2487ee333986663abc0ede9cac625d36256647de337be161  src/api/server.ts
9deba46927b691597ed2ae369ea792002b799356911186a41dacabb48b300452  src/api/assisted.routes.ts
f93b51262bbed09f1be37845205f543b694d6efeece3ff51a2856ff810e4b5a7  prisma/schema.prisma
```
