/**
 * The 11-field decision contract (binding interface, see docs/ARCHITECTURE.md §6 of the source
 * master prompt). Every call to `evaluateNextStep` returns exactly these eleven fields, no more,
 * no less. The orchestrator persists the object verbatim in the audit log and derives the outbox
 * row from `actionRequired` / `actionPayload`.
 *
 * Field semantics
 *   decisionId               Deterministic UUID (v5-style, SHA-256 based) computed from the
 *                            expediente id, version, current state, event type and canonical
 *                            payload. Re-evaluating the same event at the same version yields the
 *                            same id, so the outbox unique constraint dedupes replays.
 *   expedienteId             The case id the decision was computed for.
 *   currentStep              State the case was in when the event was evaluated.
 *   nextStep                 State the orchestrator MUST persist atomically with the outbox row.
 *   actionRequired           One of the ten allowed action types.
 *   actionPayload            Typed payload (`ActionPayload`), always carrying `kind`,
 *                            `expectedVersion` and `idempotencyKey`; optionally `expedientePatch`
 *                            which the orchestrator applies in the same transaction.
 *   blockingConditions       Stable identifiers (`BlockingCondition`) explaining why progress is
 *                            held or which precondition the next actor must satisfy.
 *   isViabilizable           The current document may be (or already is) filed provisionally.
 *   requiresClientRevocation The client still has to revoke a defective power before re-issuing.
 *   evidenceRequired         Human-readable description of the proof needed before the effect is
 *                            considered done (delivery status, read-back hash, operator evidence).
 *   auditTrailSummary        One log-safe sentence (no DNI, no names, no PDF text, no secrets).
 */

import { z } from 'zod';
import { State } from '../domain/fsm/states.js';
import { ACTION_TYPES, type ActionPayload, type ActionType } from '../domain/fsm/actions.js';
import { ContractViolationError } from '../domain/errors/index.js';

/** Exact field list, in contract order. */
export const DECISION_CONTRACT_FIELDS = [
  'decisionId',
  'expedienteId',
  'currentStep',
  'nextStep',
  'actionRequired',
  'actionPayload',
  'blockingConditions',
  'isViabilizable',
  'requiresClientRevocation',
  'evidenceRequired',
  'auditTrailSummary',
] as const;

export type DecisionContractField = (typeof DECISION_CONTRACT_FIELDS)[number];

/** Runtime schema. `.strict()` rejects any extra key so the contract stays at eleven fields. */
export const DecisionContractSchema = z
  .object({
    decisionId: z.string().uuid(),
    expedienteId: z.string().min(1).max(200),
    currentStep: z.nativeEnum(State),
    nextStep: z.nativeEnum(State),
    actionRequired: z.enum(ACTION_TYPES),
    actionPayload: z.record(z.unknown()),
    blockingConditions: z.array(z.string().min(1)),
    isViabilizable: z.boolean(),
    requiresClientRevocation: z.boolean(),
    evidenceRequired: z.string().min(1),
    auditTrailSummary: z.string().min(1).max(2000),
  })
  .strict();

/** Compile-time view with the typed payload union. */
export interface DecisionContract {
  decisionId: string;
  expedienteId: string;
  currentStep: State;
  nextStep: State;
  actionRequired: ActionType;
  actionPayload: ActionPayload;
  blockingConditions: string[];
  isViabilizable: boolean;
  requiresClientRevocation: boolean;
  evidenceRequired: string;
  auditTrailSummary: string;
}

/** Hard cap on a serialised decision so audit rows never grow unbounded. */
export const MAX_DECISION_JSON_BYTES = 64 * 1024;

/** Keys that must never appear anywhere inside a decision (secrets or raw document text). */
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passphrase',
  'pfx',
  'p12',
  'pin',
  'secret',
  'accessToken',
  'extractedText',
]);

function findForbiddenKey(value: unknown, path: string, depth: number): string | null {
  if (depth > 12 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return `${path}.${key}`;
    const hit = findForbiddenKey(child, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validates an object against the eleven-field contract plus the structural invariants that
 * bind `actionRequired` to `actionPayload`. Throws `ContractViolationError` (fail-closed).
 */
export function assertDecisionContract(value: unknown): DecisionContract {
  const parsed = DecisionContractSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractViolationError('Decision does not satisfy the 11-field contract', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const decision = parsed.data;
  const payload = decision.actionPayload;

  if (payload.kind !== decision.actionRequired) {
    throw new ContractViolationError('actionPayload.kind must equal actionRequired', {
      actionRequired: decision.actionRequired,
      kind: String(payload.kind),
    });
  }
  if (typeof payload.expectedVersion !== 'number' || !Number.isInteger(payload.expectedVersion) || payload.expectedVersion < 0) {
    throw new ContractViolationError('actionPayload.expectedVersion must be a non-negative integer');
  }
  if (payload.idempotencyKey !== `apod-${decision.decisionId}`) {
    throw new ContractViolationError('actionPayload.idempotencyKey must be `apod-<decisionId>`');
  }
  if ((decision.nextStep === State.ESCALATED_HUMAN) !== (decision.actionRequired === 'ESCALATE_HUMAN')) {
    throw new ContractViolationError('ESCALATE_HUMAN and nextStep ESCALATED_HUMAN must occur together', {
      nextStep: decision.nextStep,
      actionRequired: decision.actionRequired,
    });
  }
  if (decision.nextStep === State.COMPLETED && decision.actionRequired !== 'NO_OP') {
    throw new ContractViolationError('COMPLETED must be reached with NO_OP (verified effects only)');
  }
  const forbidden = findForbiddenKey(decision, 'decision', 0);
  if (forbidden) {
    throw new ContractViolationError('Decision contains a forbidden key', { path: forbidden });
  }
  const bytes = Buffer.byteLength(JSON.stringify(decision), 'utf8');
  if (bytes > MAX_DECISION_JSON_BYTES) {
    throw new ContractViolationError('Decision exceeds the serialised size limit', { bytes, limit: MAX_DECISION_JSON_BYTES });
  }
  return decision as unknown as DecisionContract;
}

/** True when `value` is a valid contract (no throw). */
export function isDecisionContract(value: unknown): value is DecisionContract {
  try {
    assertDecisionContract(value);
    return true;
  } catch {
    return false;
  }
}
