import type { State } from '../fsm/states.js';

/** Device on which the client holds the digital certificate. */
export enum CertDevice {
  MOBILE = 'MOBILE',
  PC = 'PC',
  NONE = 'NONE',
}

/** Deterministic audit outcome categories (mirror of the source `AuditResult` enum). */
export enum AuditStatus {
  /** Structural checks passed: expected page count, Airam present, no missing/negated powers. */
  VALID_FULL_5_PAGES = 'VALID_FULL_5_PAGES',
  /** Airam present but the document is incomplete; may be filed provisionally after approval. */
  DEFECTIVE_WITH_AIRAM = 'DEFECTIVE_WITH_AIRAM',
  /** Airam not reliably detected; the document must be re-issued. Never viabilizable. */
  DEFECTIVE_NO_AIRAM = 'DEFECTIVE_NO_AIRAM',
  /** No usable text layer, encrypted, truncated or not a PDF. */
  UNREADABLE_OR_CORRUPT = 'UNREADABLE_OR_CORRUPT',
}

/** Classification of a stored document. */
export enum DocumentType {
  /** Default classification for anything not yet approved by an operator. */
  PENDING_REVIEW = 'PENDING_REVIEW',
  /** Sede draft generated in the assisted path, awaiting client review. */
  BORRADOR_SEDE = 'BORRADOR_SEDE',
  /** Operator-approved complete apoderamiento. */
  APODERAMIENTO_FINAL = 'APODERAMIENTO_FINAL',
  /** Operator-approved defective apoderamiento filed to keep the case moving. */
  APODERAMIENTO_PROVISIONAL = 'APODERAMIENTO_PROVISIONAL',
  /** Power granted in person before a court clerk. */
  ACTA_JUZGADO = 'ACTA_JUZGADO',
  /** Power produced through the paid Apudata video-identification service. */
  APODERAMIENTO_APUDATA = 'APODERAMIENTO_APUDATA',
}

/**
 * Domain view of a case (binding interface, see docs/ARCHITECTURE.md).
 * Required fields are exactly those listed in the shared interface; the optional
 * fields mirror extra Prisma columns the engine reads when present.
 */
export interface Expediente {
  id: string;
  dni: string;
  nombre: string;
  telefono: string;
  currentState: State;
  /** Optimistic-concurrency version; echoed into every action payload as `expectedVersion`. */
  version: number;
  kmaleonExpedienteId: string | null;
  empresa?: string | null;
  numeroExpediente?: string | null;
  hasDigitalCert: boolean | null;
  certDevice: string | null;
  /** Guided support rounds, persisted independently of the history window. */
  digitalHelpAttempts?: number;
  certificateHelpAttempts?: number;
  consentGranted: boolean;
  auditStatus: string | null;
  pageCount: number | null;
  isProvisionalFiled: boolean;
  apudataOrderId: string | null;
  apudataPreApproved: boolean;
  apudataApprovalExpiresAt: Date | null;
  documentId: string | null;
  documentApproved: boolean;
  clientReviewed: boolean;

  // ---- optional extras (present in the Prisma model, read when available) --------------
  identityVerified?: boolean;
  consentVersion?: string | null;
  consentGrantedAt?: Date | null;
  apudataApprovalEvidence?: unknown;
  /** SHA-256 (hex) of the document referenced by `documentId`; pinned by the engine. */
  documentSha256?: string | null;
  /** Classification of the document referenced by `documentId`. */
  documentType?: string | null;
  kmaleonDocumentId?: string | null;
  lastInboundAt?: Date | null;
  direccion?: string | null;
  codigoPostal?: string | null;
  provincia?: string | null;
  localidad?: string | null;
  comunidadAutonoma?: string | null;
  partidoJudicial?: string | null;
}

/**
 * Fields the engine may ask the orchestrator to persist together with the transition.
 * Applied atomically with the state change (same transaction as the outbox row).
 */
export interface ExpedientePatch {
  digitalHelpAttempts?: number;
  certificateHelpAttempts?: number;
  hasDigitalCert?: boolean | null;
  certDevice?: CertDevice | null;
  consentGranted?: boolean;
  consentVersion?: string | null;
  consentGrantedAt?: Date | null;
  identityVerified?: boolean;
  auditStatus?: AuditStatus | null;
  pageCount?: number | null;
  isProvisionalFiled?: boolean;
  apudataOrderId?: string | null;
  apudataPreApproved?: boolean;
  apudataApprovalExpiresAt?: Date | null;
  apudataApprovalEvidence?: Record<string, unknown> | null;
  documentId?: string | null;
  documentSha256?: string | null;
  documentType?: DocumentType | null;
  documentApproved?: boolean;
  clientReviewed?: boolean;
  kmaleonDocumentId?: string | null;
  partidoJudicial?: string | null;
}

const AUDIT_STATUS_SET: ReadonlySet<string> = new Set<string>(Object.values(AuditStatus));
const DOCUMENT_TYPE_SET: ReadonlySet<string> = new Set<string>(Object.values(DocumentType));
const CERT_DEVICE_SET: ReadonlySet<string> = new Set<string>(Object.values(CertDevice));

export function isAuditStatus(value: unknown): value is AuditStatus {
  return typeof value === 'string' && AUDIT_STATUS_SET.has(value);
}

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && DOCUMENT_TYPE_SET.has(value);
}

export function isCertDevice(value: unknown): value is CertDevice {
  return typeof value === 'string' && CERT_DEVICE_SET.has(value);
}
