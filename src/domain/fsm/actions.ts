/**
 * Typed side-effect definitions produced by the state machine.
 *
 * The decision contract fixes `actionRequired` to ten values. Payloads are typed here so the
 * orchestrator and adapters can render messages and execute effects without the engine ever
 * producing rendered text, bank details, URLs or credentials. Templates and media are stable
 * identifiers resolved by the adapters from reviewed configuration.
 */

import type { DocumentType, ExpedientePatch } from '../models/expediente.js';

/** The ten allowed actions (exact contract values). */
export const ACTION_TYPES = [
  'SEND_WHATSAPP_MESSAGE',
  'SEND_WHATSAPP_BUTTONS',
  'SEND_WHATSAPP_MEDIA',
  'UPLOAD_KMALEON_DOCUMENT',
  'CREATE_KMALEON_AVISO',
  'TRIGGER_SEDE_AUTOMATION',
  'CALL_APUDATA_PREAPPROVAL',
  'NOTIFY_DAYANA',
  'ESCALATE_HUMAN',
  'NO_OP',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Convenience constants (`Action.NO_OP` etc.). */
export const Action = Object.freeze(
  Object.fromEntries(ACTION_TYPES.map((a) => [a, a])) as { readonly [K in ActionType]: K },
);

/**
 * Message/interaction templates. Adapters own the approved wording; the engine only selects
 * the template and supplies typed variables.
 */
export enum TemplateId {
  FALLBACK_OPTIONS = 'FALLBACK_OPTIONS',
  FOLLOWUP_DAY3 = 'FOLLOWUP_DAY3',
  FOLLOWUP_DAY7 = 'FOLLOWUP_DAY7',
  FOLLOWUP_DAY15 = 'FOLLOWUP_DAY15',
  ASK_HAS_CERT = 'ASK_HAS_CERT',
  ASK_CERT_DEVICE = 'ASK_CERT_DEVICE',
  ASK_HAS_PC = 'ASK_HAS_PC',
  MOBILE_EXPORT_GUIDE = 'MOBILE_EXPORT_GUIDE',
  ASSIST_CONSENT_REQUEST = 'ASSIST_CONSENT_REQUEST',
  ASSIST_SEND_CERT_INSTRUCTIONS = 'ASSIST_SEND_CERT_INSTRUCTIONS',
  ASSIST_CERT_PASSWORD_INVALID = 'ASSIST_CERT_PASSWORD_INVALID',
  ASSIST_CERT_UNUSABLE = 'ASSIST_CERT_UNUSABLE',
  ASSIST_CERT_EXPIRED = 'ASSIST_CERT_EXPIRED',
  DRAFT_REVIEW_REQUEST = 'DRAFT_REVIEW_REQUEST',
  PC_TUTORIAL = 'PC_TUTORIAL',
  CERT_ACQUISITION_LINKS_DNI = 'CERT_ACQUISITION_LINKS_DNI',
  CERT_ACQUISITION_LINKS_NIE = 'CERT_ACQUISITION_LINKS_NIE',
  CERT_ACQUISITION_LINKS_UNKNOWN_ID = 'CERT_ACQUISITION_LINKS_UNKNOWN_ID',
  COURT_POWER_CHECKLIST = 'COURT_POWER_CHECKLIST',
  APUDATA_NOT_ELIGIBLE_COURT_FALLBACK = 'APUDATA_NOT_ELIGIBLE_COURT_FALLBACK',
  APUDATA_PAYMENT_DETAILS = 'APUDATA_PAYMENT_DETAILS',
  APUDATA_VIDEO_INSTRUCTIONS = 'APUDATA_VIDEO_INSTRUCTIONS',
  PDF_UNREADABLE_RESEND = 'PDF_UNREADABLE_RESEND',
  PDF_REJECTED_RESEND = 'PDF_REJECTED_RESEND',
  PDF_NO_AIRAM_REDO = 'PDF_NO_AIRAM_REDO',
  PROVISIONAL_FILED_REVOKE_AND_REISSUE = 'PROVISIONAL_FILED_REVOKE_AND_REISSUE',
  REVOCATION_GUIDE = 'REVOCATION_GUIDE',
  REVOCATION_SCREENSHOTS = 'REVOCATION_SCREENSHOTS',
  REISSUE_INSTRUCTIONS = 'REISSUE_INSTRUCTIONS',
  COMPLETION_NOTICE = 'COMPLETION_NOTICE',
  REMINDER_PENDING_STEP = 'REMINDER_PENDING_STEP',
  HUMAN_HANDOFF_NOTICE = 'HUMAN_HANDOFF_NOTICE',
  PHASE1_GREETING = 'PHASE1_GREETING',
  PHASE1_HELP = 'PHASE1_HELP',
  PHASE2_ACK = 'PHASE2_ACK',
  PHASE2_DEFER = 'PHASE2_DEFER',
  PHASE3_GREETING = 'PHASE3_GREETING',
  /** Sanitised conversational answer produced by the reviewed support agent. */
  CONVERSATION_REPLY = 'CONVERSATION_REPLY',
  SECURITY_ANSWER = 'SECURITY_ANSWER',
}

/** Reply-button identifiers (aligned with the WhatsApp adapter contract). */
export enum ReplyButton {
  HAS_CERT_YES = 'HAS_CERT_YES',
  HAS_CERT_NO = 'HAS_CERT_NO',
  DEVICE_PC = 'DEVICE_PC',
  DEVICE_MOBILE = 'DEVICE_MOBILE',
  HAS_PC = 'HAS_PC',
  NO_PC = 'NO_PC',
  NEEDS_ASSISTANCE = 'NEEDS_ASSISTANCE',
  CONSENT_YES = 'CONSENT_YES',
  CONSENT_NO = 'CONSENT_NO',
  DRAFT_APPROVED = 'DRAFT_APPROVED',
  DRAFT_REJECTED = 'DRAFT_REJECTED',
  REVOKED = 'REVOKED',
  REISSUED = 'REISSUED',
  COURT_APPOINTMENT = 'COURT_APPOINTMENT',
  APUDATA_REQUEST = 'APUDATA_REQUEST',
  HUMAN_HELP = 'HUMAN_HELP',
}

/** Reviewed media assets referenced by identifier; adapters map them to files/URLs. */
export enum MediaAssetId {
  TUTORIAL_PC_PDF = 'TUTORIAL_PC_PDF',
  REPRESENTATIVES_LIST_PDF = 'REPRESENTATIVES_LIST_PDF',
  MOBILE_EXPORT_GUIDE_PDF = 'MOBILE_EXPORT_GUIDE_PDF',
  REVOCATION_GUIDE_PDF = 'REVOCATION_GUIDE_PDF',
  REVOCATION_SCREENSHOTS = 'REVOCATION_SCREENSHOTS',
  /** Generated per client by the orchestrator (see `courtChecklist`). */
  COURT_POWER_CHECKLIST_GENERATED = 'COURT_POWER_CHECKLIST_GENERATED',
  /** The stored document referenced by `documentId` (draft for client review). */
  STORED_DOCUMENT = 'STORED_DOCUMENT',
}

/** Phases of the Sede Judicial automation pipeline run by the orchestrator. */
export enum SedePhase {
  /** Run `CertInspector` on RAM-held material, emit `CERT_INSPECTION_COMPLETED`. */
  INSPECT_CERTIFICATE = 'INSPECT_CERTIFICATE',
  /** Pull address from Kmaleon, resolve geography deterministically, create the Sede draft. */
  PREPARE_DRAFT = 'PREPARE_DRAFT',
  /** Pause: a human operator must perform/confirm the legally effective submission. */
  AWAIT_OPERATOR_SUBMISSION = 'AWAIT_OPERATOR_SUBMISSION',
}

/** Operations multiplexed on `CALL_APUDATA_PREAPPROVAL`. */
export enum ApudataOperation {
  PREAPPROVAL_CHECK = 'PREAPPROVAL_CHECK',
  CREATE_ORDER = 'CREATE_ORDER',
}

/** Internal jobs the orchestrator runs when the engine returns `NO_OP` with `internalJob`. */
export enum InternalJob {
  PDF_AUDIT = 'PDF_AUDIT',
}

/** What the orchestrator is waiting for while holding with `NO_OP`. */
export enum AwaitingParty {
  OPERATOR_DOCUMENT_APPROVAL = 'OPERATOR_DOCUMENT_APPROVAL',
  /** Operator must upload the document produced outside WhatsApp (Sede justificante). */
  OPERATOR_DOCUMENT_UPLOAD = 'OPERATOR_DOCUMENT_UPLOAD',
  /** Operator must verify the client's identity before any outbound effect. */
  OPERATOR_IDENTITY_VERIFICATION = 'OPERATOR_IDENTITY_VERIFICATION',
  OPERATOR_RESUME = 'OPERATOR_RESUME',
  CLIENT = 'CLIENT',
  NONE = 'NONE',
}

/** Scalar template variables. Conversation replies are provider-validated before persistence. */
export type TemplateVariables = Readonly<Record<string, string | number | boolean | null>>;

/** Fields present in every payload. */
export interface ActionPayloadBase {
  /** Expediente version the decision was computed against (optimistic concurrency). */
  expectedVersion: number;
  /** Deterministic key for the outbox row (same event re-evaluated => same key). */
  idempotencyKey: string;
  /** Fields to persist atomically with the transition. */
  expedientePatch?: ExpedientePatch;
  /** Orchestrator must wipe RAM-held certificate material immediately. */
  discardCertificateMaterial?: boolean;
}

export interface SendWhatsappMessagePayload extends ActionPayloadBase {
  kind: 'SEND_WHATSAPP_MESSAGE';
  template: TemplateId;
  variables: TemplateVariables;
  /** Present only for `APUDATA_PAYMENT_DETAILS`; adapter must re-validate before sending. */
  financialGate?: FinancialGateEvidence;
}

export interface SendWhatsappButtonsPayload extends ActionPayloadBase {
  kind: 'SEND_WHATSAPP_BUTTONS';
  template: TemplateId;
  variables: TemplateVariables;
  buttons: readonly ReplyButton[];
}

export interface SendWhatsappMediaPayload extends ActionPayloadBase {
  kind: 'SEND_WHATSAPP_MEDIA';
  template: TemplateId;
  variables: TemplateVariables;
  media: readonly MediaAssetId[];
  /** Set when `media` includes `STORED_DOCUMENT`. */
  documentId?: string;
  documentSha256?: string;
  /** Optional reply buttons attached to the last media message. */
  buttons?: readonly ReplyButton[];
}

export interface UploadKmaleonDocumentPayload extends ActionPayloadBase {
  kind: 'UPLOAD_KMALEON_DOCUMENT';
  kmaleonExpedienteId: string;
  documentId: string;
  /** Adapter must upload exactly these bytes and verify by read-back hash. */
  documentSha256: string;
  documentType: DocumentType;
  isProvisional: boolean;
  approvedBy: string;
  /** Stable title key; adapter renders the approved title. */
  titleTemplate: 'APODERAMIENTO_FINAL_TITLE' | 'APODERAMIENTO_PROVISIONAL_TITLE';
}

export interface CreateKmaleonAvisoPayload extends ActionPayloadBase {
  kind: 'CREATE_KMALEON_AVISO';
  kmaleonExpedienteId: string;
  kmaleonDocumentId: string;
  isProvisional: boolean;
  avisoTemplate: 'AVISO_APODERAMIENTO_FINAL' | 'AVISO_APODERAMIENTO_PROVISIONAL';
}

export interface TriggerSedeAutomationPayload extends ActionPayloadBase {
  kind: 'TRIGGER_SEDE_AUTOMATION';
  phase: SedePhase;
  /** Opaque handle to RAM-held certificate material (never the bytes or password). */
  certRef?: string;
  /** Present for `PREPARE_DRAFT`: what the pipeline must produce/consume. */
  requires?: readonly ('KMALEON_ADDRESS' | 'GEO_CATALOG_RESOLUTION' | 'CLIENT_REVIEW')[];
  /** Present for `AWAIT_OPERATOR_SUBMISSION`. */
  draftDocumentId?: string;
  draftSha256?: string;
}

export interface CallApudataPreapprovalPayload extends ActionPayloadBase {
  kind: 'CALL_APUDATA_PREAPPROVAL';
  operation: ApudataOperation;
  dni: string;
  nombre: string;
  telefono: string;
  /** Present for `CREATE_ORDER`. */
  paymentEvidenceRef?: string;
  financialGate?: FinancialGateEvidence;
}

export interface NotifyDayanaPayload extends ActionPayloadBase {
  kind: 'NOTIFY_DAYANA';
  kmaleonExpedienteId: string;
  kmaleonDocumentId: string;
  isProvisional: boolean;
  noticeTemplate: 'DAYANA_APODERAMIENTO_FINAL' | 'DAYANA_APODERAMIENTO_PROVISIONAL';
}

export interface EscalateHumanPayload extends ActionPayloadBase {
  kind: 'ESCALATE_HUMAN';
  /** Stable machine-readable reason. */
  reason: EscalationReason;
  /** Severity hint for the operator queue. */
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Structured, log-safe context (no passwords, no PDF text, no free-form client text). */
  context: Readonly<Record<string, string | number | boolean | null>>;
  /** Courtesy notice the orchestrator may send to the client from the escalation handler. */
  clientNoticeTemplate?: TemplateId;
}

export interface NoOpPayload extends ActionPayloadBase {
  kind: 'NO_OP';
  awaiting: AwaitingParty;
  /** When set, the orchestrator runs this internal job (no external side effect). */
  internalJob?: InternalJob;
  documentId?: string;
  documentSha256?: string;
  documentType?: DocumentType;
  note: string;
}

export type ActionPayload =
  | SendWhatsappMessagePayload
  | SendWhatsappButtonsPayload
  | SendWhatsappMediaPayload
  | UploadKmaleonDocumentPayload
  | CreateKmaleonAvisoPayload
  | TriggerSedeAutomationPayload
  | CallApudataPreapprovalPayload
  | NotifyDayanaPayload
  | EscalateHumanPayload
  | NoOpPayload;

/** Evidence that the 35 EUR financial gate is open. Adapters MUST re-check independently. */
export interface FinancialGateEvidence {
  preApproved: true;
  approvalExpiresAt: string;
  evidenceRef: string;
}

/** Stable escalation reasons for operator queues and metrics. */
export enum EscalationReason {
  UNEXPECTED_EVENT_IN_STATE = 'UNEXPECTED_EVENT_IN_STATE',
  INVALID_EVENT_PAYLOAD = 'INVALID_EVENT_PAYLOAD',
  INVALID_EXPEDIENTE_STATE = 'INVALID_EXPEDIENTE_STATE',
  OPERATOR_IDENTITY_MISSING = 'OPERATOR_IDENTITY_MISSING',
  OPERATOR_REQUESTED = 'OPERATOR_REQUESTED',
  OPERATOR_REJECTED_DOCUMENT = 'OPERATOR_REJECTED_DOCUMENT',
  CLIENT_OPT_OUT = 'CLIENT_OPT_OUT',
  CLIENT_NEEDS_HUMAN = 'CLIENT_NEEDS_HUMAN',
  CONSENT_DENIED = 'CONSENT_DENIED',
  IDENTITY_MISMATCH_CERTIFICATE = 'IDENTITY_MISMATCH_CERTIFICATE',
  IDENTITY_MISMATCH_DOCUMENT = 'IDENTITY_MISMATCH_DOCUMENT',
  CERTIFICATE_UNUSABLE = 'CERTIFICATE_UNUSABLE',
  GEO_UNRESOLVED = 'GEO_UNRESOLVED',
  SEDE_AUTOMATION_FAILED = 'SEDE_AUTOMATION_FAILED',
  DRAFT_REJECTED_BY_CLIENT = 'DRAFT_REJECTED_BY_CLIENT',
  PDF_AUDIT_FAILED = 'PDF_AUDIT_FAILED',
  DOCUMENT_REFERENCE_MISMATCH = 'DOCUMENT_REFERENCE_MISMATCH',
  APPROVAL_INCONSISTENT_WITH_AUDIT = 'APPROVAL_INCONSISTENT_WITH_AUDIT',
  KMALEON_EXPEDIENTE_MISSING = 'KMALEON_EXPEDIENTE_MISSING',
  KMALEON_UPLOAD_FAILED = 'KMALEON_UPLOAD_FAILED',
  KMALEON_UPLOAD_UNAPPROVED = 'KMALEON_UPLOAD_UNAPPROVED',
  KMALEON_AVISO_FAILED = 'KMALEON_AVISO_FAILED',
  DAYANA_NOTIFICATION_FAILED = 'DAYANA_NOTIFICATION_FAILED',
  CLIENT_NOTIFICATION_FAILED = 'CLIENT_NOTIFICATION_FAILED',
  FINANCIAL_GATE_CLOSED = 'FINANCIAL_GATE_CLOSED',
  APUDATA_FAILED = 'APUDATA_FAILED',
  RESUME_TARGET_FORBIDDEN = 'RESUME_TARGET_FORBIDDEN',
  UNEXPECTED_DOCUMENT_AFTER_COMPLETION = 'UNEXPECTED_DOCUMENT_AFTER_COMPLETION',
}

/** Blocking condition identifiers surfaced in `DecisionContract.blockingConditions`. */
export enum BlockingCondition {
  HUMAN_APPROVAL_REQUIRED = 'HUMAN_APPROVAL_REQUIRED',
  AUDIT_REQUIRES_HUMAN_REVIEW = 'AUDIT_REQUIRES_HUMAN_REVIEW',
  OPERATOR_SUBMISSION_EVIDENCE_REQUIRED = 'OPERATOR_SUBMISSION_EVIDENCE_REQUIRED',
  OPERATOR_RESUME_REQUIRED = 'OPERATOR_RESUME_REQUIRED',
  CONSENT_REQUIRED_BEFORE_CERT_USE = 'CONSENT_REQUIRED_BEFORE_CERT_USE',
  CLIENT_REVIEW_REQUIRED = 'CLIENT_REVIEW_REQUIRED',
  IDENTITY_MISMATCH = 'IDENTITY_MISMATCH',
  IDENTITY_NOT_VERIFIED = 'IDENTITY_NOT_VERIFIED',
  AUDIT_NOT_COMPLETED = 'AUDIT_NOT_COMPLETED',
  DOCUMENT_REFERENCE_MISMATCH = 'DOCUMENT_REFERENCE_MISMATCH',
  DOCUMENT_NOT_APPROVED = 'DOCUMENT_NOT_APPROVED',
  KMALEON_EXPEDIENTE_MISSING = 'KMALEON_EXPEDIENTE_MISSING',
  FINANCIAL_GATE_CLOSED = 'FINANCIAL_GATE_CLOSED',
  FINANCIAL_APPROVAL_EXPIRED = 'FINANCIAL_APPROVAL_EXPIRED',
  OPERATOR_IDENTITY_MISSING = 'OPERATOR_IDENTITY_MISSING',
  INVALID_EVENT_PAYLOAD = 'INVALID_EVENT_PAYLOAD',
  UNEXPECTED_EVENT = 'UNEXPECTED_EVENT',
  TERMINAL_STATE = 'TERMINAL_STATE',
  GEO_UNRESOLVED = 'GEO_UNRESOLVED',
  CERTIFICATE_UNUSABLE = 'CERTIFICATE_UNUSABLE',
  CLIENT_OPT_OUT = 'CLIENT_OPT_OUT',
}
