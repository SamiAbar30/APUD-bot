/**
 * Typed domain errors. Every error carries a stable `code` suitable for logs, metrics and
 * dead-letter records, plus optional structured `details`. Messages are safe to log: callers
 * must never place passwords, extracted PDF text or free-form client text into `details`.
 */

export enum DomainErrorCode {
  INVALID_ARGUMENT = 'INVALID_ARGUMENT',
  INVALID_STATE = 'INVALID_STATE',
  INVALID_EVENT = 'INVALID_EVENT',
  INVALID_EVENT_PAYLOAD = 'INVALID_EVENT_PAYLOAD',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  GUARD_VIOLATION = 'GUARD_VIOLATION',
  FINANCIAL_SAFETY = 'FINANCIAL_SAFETY',
  IDENTITY_MISMATCH = 'IDENTITY_MISMATCH',
  HUMAN_APPROVAL_REQUIRED = 'HUMAN_APPROVAL_REQUIRED',
  CONTRACT_VIOLATION = 'CONTRACT_VIOLATION',
  PDF_AUDIT = 'PDF_AUDIT',
  CERTIFICATE_INSPECTION = 'CERTIFICATE_INSPECTION',
  CERTIFICATE_SESSION_CLOSED = 'CERTIFICATE_SESSION_CLOSED',
  GEO_CATALOG = 'GEO_CATALOG',
  GEO_RESOLUTION = 'GEO_RESOLUTION',
  REAL_INPUT_MISSING = 'REAL_INPUT_MISSING',
  TIMEOUT = 'TIMEOUT',
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  /** JSON-safe representation for audit logs and DLQ records. */
  toJSON(): { name: string; code: DomainErrorCode; message: string; details: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, details: { ...this.details } };
  }
}

export class InvalidArgumentError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.INVALID_ARGUMENT, message, details);
  }
}

export class InvalidStateError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.INVALID_STATE, message, details);
  }
}

export class InvalidEventError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.INVALID_EVENT, message, details);
  }
}

export class InvalidEventPayloadError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.INVALID_EVENT_PAYLOAD, message, details);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.INVALID_TRANSITION, message, details);
  }
}

export class GuardViolationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.GUARD_VIOLATION, message, details);
  }
}

/** Raised when bank/payment details would be revealed without a valid partner pre-approval. */
export class FinancialSafetyError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.FINANCIAL_SAFETY, message, details);
  }
}

export class IdentityMismatchError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.IDENTITY_MISMATCH, message, details);
  }
}

export class HumanApprovalRequiredError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.HUMAN_APPROVAL_REQUIRED, message, details);
  }
}

/** The engine produced (or was handed) an object violating the 11-field decision contract. */
export class ContractViolationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.CONTRACT_VIOLATION, message, details);
  }
}

export class PdfAuditError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(DomainErrorCode.PDF_AUDIT, message, details, options);
  }
}

export class CertificateInspectionError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}, options?: { cause?: unknown }) {
    super(DomainErrorCode.CERTIFICATE_INSPECTION, message, details, options);
  }
}

/** Access to certificate material after the bounded session was wiped. */
export class CertificateSessionClosedError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.CERTIFICATE_SESSION_CLOSED, message, details);
  }
}

export class GeoCatalogError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.GEO_CATALOG, message, details);
  }
}

export class GeoResolutionError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.GEO_RESOLUTION, message, details);
  }
}

/** Real-input verification cannot run because authorized real inputs are absent. */
export class RealInputMissingError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.REAL_INPUT_MISSING, message, details);
  }
}

export class TimeoutError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(DomainErrorCode.TIMEOUT, message, details);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Extracts a loggable message from unknown thrown values without leaking structured data. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
