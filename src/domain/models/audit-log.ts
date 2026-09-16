import type { State } from '../fsm/states.js';

/** Append-only audit trail entry written by the orchestrator for every decision. */
export interface AuditLogEntry {
  id: string;
  expedienteId: string;
  /** Event type or synthetic marker (e.g. `DECISION`). */
  event: string;
  fromState: State | null;
  toState: State | null;
  /** Must never contain certificate passwords, extracted PDF text or free-form client text. */
  metadata: Record<string, unknown> | null;
  /** `SYSTEM_BOT` or an operator identifier. */
  operator: string;
  createdAt: Date;
}

/** Operator identifier used for autonomous decisions. */
export const SYSTEM_OPERATOR = 'SYSTEM_BOT';
