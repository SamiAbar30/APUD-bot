/**
 * `evaluateNextStep(expediente, event)` — the central deterministic brain.
 *
 * Pure: no database, no queue, no LLM, no network. Same snapshot + same event (+ same injected
 * clock) => identical `DecisionContract`, including the deterministic `decisionId`.
 *
 * Pipeline
 *   1. validate the snapshot (id, version, currentState) — programming errors throw;
 *   2. run the transition table (`src/domain/fsm/state-machine.ts`);
 *   3. hold at the current state if identity is unverified and the action would go outbound;
 *   4. build the 11-field contract, fill `expectedVersion` / `idempotencyKey`;
 *   5. enforce cross-field invariants and the strict schema — violations throw
 *      `ContractViolationError` so the orchestrator's transaction rolls back (fail-closed).
 *
 * The orchestrator MUST:
 *   - persist `nextStep`, `actionPayload.expedientePatch` and the outbox row in ONE transaction
 *     guarded by `expectedVersion` (optimistic concurrency);
 *   - NOT bump the version for NO_OP decisions whose `nextStep === currentStep` and that carry no
 *     effective `expedientePatch` (otherwise pending effect rows become STALE) — the current
 *     `WorkflowService.transition` already implements this with its `changed` check;
 *   - wipe RAM-held certificate material when `discardCertificateMaterial` is set;
 *   - validate payloads with `validateEventPayload` at the API edge to reject bad input with 400
 *     instead of creating an escalation.
 */

import { createHash } from 'node:crypto';
import { assertDecisionContract, type DecisionContract } from '../contracts/decision.contract.js';
import { ApudataOperation, AwaitingParty, BlockingCondition, SedePhase, TemplateId, type ActionPayload } from '../domain/fsm/actions.js';
import { EventType, State, isState, type WorkflowEvent } from '../domain/fsm/states.js';
import { financialGate, isOutboundAction, transition, type ActionSpec, type TransitionResult } from '../domain/fsm/state-machine.js';
import { ContractViolationError, InvalidArgumentError, InvalidStateError } from '../domain/errors/index.js';
import type { Expediente, ExpedientePatch } from '../domain/models/expediente.js';

export interface EvaluateOptions {
  /** Injected clock for expiry checks and consent timestamps. Defaults to `new Date()`. */
  now?: Date;
}

// ---------------------------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------------------------

/** Canonical JSON: sorted keys, Dates as ISO strings, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortValue(child);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** RFC 4122 layout (version 5 nibble, variant 10xx) derived from SHA-256 of `seed`. */
export function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '5';
  bytes[16] = ['8', '9', 'a', 'b'][Number.parseInt(bytes[16] ?? '0', 16) % 4] ?? '8';
  const s = bytes.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function decisionIdFor(expediente: Pick<Expediente, 'id' | 'version' | 'currentState'>, event: WorkflowEvent): string {
  const seed = ['apod-decision', expediente.id, String(expediente.version), String(expediente.currentState), String(event.type), canonicalJson(event.payload ?? {})].join('|');
  return deterministicUuid(seed);
}

// ---------------------------------------------------------------------------------------------
// Snapshot validation
// ---------------------------------------------------------------------------------------------

function assertSnapshot(expediente: Expediente): void {
  if (!expediente || typeof expediente !== 'object') throw new InvalidArgumentError('expediente snapshot required');
  if (typeof expediente.id !== 'string' || expediente.id.trim().length === 0) throw new InvalidArgumentError('expediente.id required');
  if (!Number.isInteger(expediente.version) || expediente.version < 0) {
    throw new InvalidArgumentError('expediente.version must be a non-negative integer', { version: String(expediente.version) });
  }
  if (!isState(expediente.currentState)) {
    throw new InvalidStateError('expediente.currentState is not a known State', { currentState: String(expediente.currentState) });
  }
  for (const key of ['dni', 'nombre', 'telefono'] as const) {
    if (typeof expediente[key] !== 'string') throw new InvalidArgumentError(`expediente.${key} must be a string`);
  }
}

// ---------------------------------------------------------------------------------------------
// Identity gate
// ---------------------------------------------------------------------------------------------

function identityGate(expediente: Expediente, result: TransitionResult): TransitionResult {
  if (expediente.identityVerified !== false || !isOutboundAction(result.action)) return result;
  const patch: ExpedientePatch | undefined = result.action.expedientePatch;
  const held: ActionSpec = {
    kind: 'NO_OP',
    awaiting: AwaitingParty.OPERATOR_IDENTITY_VERIFICATION,
    note: `Identity not verified: ${result.action.kind} withheld until an operator verifies the client`,
    ...(patch ? { expedientePatch: patch } : {}),
    ...(result.action.discardCertificateMaterial ? { discardCertificateMaterial: true } : {}),
  };
  return {
    ...result,
    nextStep: expediente.currentState,
    action: held,
    blockingConditions: [...new Set([BlockingCondition.IDENTITY_NOT_VERIFIED, ...result.blockingConditions])],
    evidenceRequired: 'Operator marks identityVerified=true after checking the client identity through the authorized channel.',
    summary: `${expediente.currentState} + hold [NO_OP]: identity not verified; intended ${result.action.kind} -> ${result.nextStep} withheld`,
  };
}

// ---------------------------------------------------------------------------------------------
// Invariants (defense in depth; the transition table should already respect them)
// ---------------------------------------------------------------------------------------------

function effective<K extends keyof Expediente & keyof ExpedientePatch>(expediente: Expediente, patch: ExpedientePatch | undefined, key: K): Expediente[K] | ExpedientePatch[K] {
  return patch && patch[key] !== undefined ? patch[key] : expediente[key];
}

function assertInvariants(expediente: Expediente, event: WorkflowEvent, decision: DecisionContract, now: Date): void {
  const p = decision.actionPayload;
  const patch = p.expedientePatch;
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ContractViolationError(message, { ...details, currentStep: decision.currentStep, nextStep: decision.nextStep, actionRequired: decision.actionRequired });
  };

  if (p.expectedVersion !== expediente.version) fail('expectedVersion must echo the snapshot version');

  switch (p.kind) {
    case 'UPLOAD_KMALEON_DOCUMENT': {
      if (decision.nextStep !== State.KMALEON_FILING) fail('UPLOAD_KMALEON_DOCUMENT must move to KMALEON_FILING');
      if (event.type !== EventType.OPERATOR_APPROVED_DOCUMENT) fail('UPLOAD_KMALEON_DOCUMENT requires an operator approval event');
      if (effective(expediente, patch, 'documentApproved') !== true) fail('upload without documentApproved');
      if (effective(expediente, patch, 'clientReviewed') !== true) fail('upload without clientReviewed');
      if (!p.kmaleonExpedienteId || p.kmaleonExpedienteId !== expediente.kmaleonExpedienteId) fail('upload without matching kmaleonExpedienteId');
      if (p.documentId !== expediente.documentId) fail('upload documentId must match the snapshot');
      if (expediente.documentSha256 && p.documentSha256 !== expediente.documentSha256) fail('upload sha256 must match the snapshot');
      if (!p.approvedBy) fail('upload without approvedBy');
      break;
    }
    case 'CREATE_KMALEON_AVISO':
    case 'NOTIFY_DAYANA': {
      if (!p.kmaleonExpedienteId || !p.kmaleonDocumentId) fail('Kmaleon notice without expediente/document ids');
      if (!effective(expediente, patch, 'kmaleonDocumentId')) fail('Kmaleon notice before a verified filing');
      if (effective(expediente, patch, 'documentApproved') !== true) fail('Kmaleon notice for an unapproved document');
      break;
    }
    case 'SEND_WHATSAPP_MESSAGE': {
      if (p.template === TemplateId.APUDATA_PAYMENT_DETAILS) {
        const snapshotAfter: Expediente = { ...expediente, ...(patch ?? {}) } as Expediente;
        const gate = p.financialGate && financialGate(snapshotAfter, now);
        if (!gate || !p.financialGate || p.financialGate.evidenceRef !== gate.evidenceRef) fail('payment details without an open financial gate');
        if (decision.nextStep !== State.APUDATA_WAITING_PAYMENT) fail('payment details outside APUDATA_WAITING_PAYMENT');
      }
      break;
    }
    case 'CALL_APUDATA_PREAPPROVAL': {
      if (p.operation === ApudataOperation.CREATE_ORDER) {
        if (!p.financialGate || !p.paymentEvidenceRef) fail('order creation without gate evidence and payment evidence');
        if (event.type !== EventType.OPERATOR_PAYMENT_CONFIRMED) fail('order creation requires operator payment confirmation');
      }
      break;
    }
    case 'TRIGGER_SEDE_AUTOMATION': {
      if (effective(expediente, patch, 'consentGranted') !== true) fail('Sede automation without consent');
      if (decision.nextStep !== State.MOBILE_ASSIST_PROCESSING) fail('Sede automation outside MOBILE_ASSIST_PROCESSING');
      if (p.phase === SedePhase.AWAIT_OPERATOR_SUBMISSION && effective(expediente, patch, 'clientReviewed') !== true) fail('submission phase without client review');
      break;
    }
    case 'ESCALATE_HUMAN':
      if (decision.nextStep !== State.ESCALATED_HUMAN) fail('ESCALATE_HUMAN must move to ESCALATED_HUMAN');
      break;
    case 'NO_OP':
      break;
    default:
      break;
  }

  if (decision.nextStep === State.COMPLETED) {
    if (event.type !== EventType.CLIENT_NOTIFICATION_DELIVERED) fail('COMPLETED only on CLIENT_NOTIFICATION_DELIVERED');
    if (decision.currentStep !== State.HANDOFF_DAYANA) fail('COMPLETED only from HANDOFF_DAYANA');
    if (!expediente.kmaleonDocumentId || !expediente.documentApproved || expediente.isProvisionalFiled) fail('COMPLETED without a verified final filing');
  }
  if (decision.currentStep === State.COMPLETED && decision.nextStep !== State.COMPLETED && decision.nextStep !== State.ESCALATED_HUMAN) {
    fail('COMPLETED may only be left through escalation');
  }
  if (decision.currentStep === State.ESCALATED_HUMAN && decision.nextStep !== State.ESCALATED_HUMAN && event.type !== EventType.OPERATOR_RESUME) {
    fail('ESCALATED_HUMAN may only be left through OPERATOR_RESUME');
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Evaluates one event against a case snapshot and returns the 11-field decision contract.
 * Throws only for programming errors (invalid snapshot) or contract violations; every
 * business situation, including unknown events, maps to a safe decision.
 */
export function evaluateNextStep(expediente: Expediente, event: WorkflowEvent, options: EvaluateOptions = {}): DecisionContract {
  assertSnapshot(expediente);
  if (!event || typeof event !== 'object') throw new InvalidArgumentError('event required');
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new InvalidArgumentError('options.now must be a valid Date');

  const raw = transition({ expediente, event, now });
  const result = identityGate(expediente, raw);
  const decisionId = decisionIdFor(expediente, event);
  const actionPayload: ActionPayload = {
    ...result.action,
    expectedVersion: expediente.version,
    idempotencyKey: `apod-${decisionId}`,
  } as ActionPayload;

  const decision: DecisionContract = {
    decisionId,
    expedienteId: expediente.id,
    currentStep: expediente.currentState,
    nextStep: result.nextStep,
    actionRequired: actionPayload.kind,
    actionPayload,
    blockingConditions: result.blockingConditions.map(String),
    isViabilizable: result.isViabilizable,
    requiresClientRevocation: result.requiresClientRevocation,
    evidenceRequired: result.evidenceRequired,
    auditTrailSummary: result.summary,
  };

  const validated = assertDecisionContract(decision);
  assertInvariants(expediente, event, validated, now);
  return validated;
}

/** Convenience for the orchestrator: which internal job, if any, a NO_OP decision requests. */
export function internalJobOf(decision: DecisionContract): { job: string; documentId?: string; documentSha256?: string } | null {
  const p = decision.actionPayload;
  if (p.kind !== 'NO_OP' || !p.internalJob) return null;
  return { job: p.internalJob, ...(p.documentId ? { documentId: p.documentId } : {}), ...(p.documentSha256 ? { documentSha256: p.documentSha256 } : {}) };
}
