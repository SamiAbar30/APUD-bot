/**
 * Canonical workflow vocabulary for the apoderamiento (apud acta) bot.
 *
 * This module is the single source of truth for:
 *   - the 21 workflow states (mirrors the Prisma `ApodState` enum by name, but is a
 *     plain string enum so the domain never depends on `@prisma/client`),
 *   - every event the deterministic state machine understands,
 *   - the origin classification of each event (client / operator / system), which the
 *     orchestrator MUST enforce before feeding an event to the engine.
 *
 * Nothing here performs I/O. The LLM is never allowed to produce a `State` value:
 * transitions are computed exclusively by `src/domain/fsm/state-machine.ts`.
 */

/** Workflow states. Names are identical to the Prisma `ApodState` enum. */
export enum State {
  /** Case created; first contact not yet triaged. */
  INITIAL_TRIAGE = 'INITIAL_TRIAGE',
  /** Bot asked whether the client has a digital certificate (and on which device). */
  WAITING_CERT_RESPONSE = 'WAITING_CERT_RESPONSE',
  /** Client has the certificate on a mobile phone; bot asked whether they own a PC. */
  MOBILE_TRIAGE_PC_CHECK = 'MOBILE_TRIAGE_PC_CHECK',
  /** Export-to-PC guide sent; waiting for the client to report success/failure. */
  MOBILE_EXPORT_GUIDE_SENT = 'MOBILE_EXPORT_GUIDE_SENT',
  /** Assisted path: explicit consent to use the client's certificate was requested. */
  MOBILE_ASSIST_CONSENT_REQUESTED = 'MOBILE_ASSIST_CONSENT_REQUESTED',
  /** Assisted path: certificate inspection, geography, Sede draft, client review, operator submission. */
  MOBILE_ASSIST_PROCESSING = 'MOBILE_ASSIST_PROCESSING',
  /** Self-service path: PC tutorial and representatives list sent. */
  PC_TUTORIAL_SENT = 'PC_TUTORIAL_SENT',
  /** Waiting for the client to send (or re-send) the resulting PDF. */
  WAITING_PDF_SUBMISSION = 'WAITING_PDF_SUBMISSION',
  /** A PDF is being audited and/or awaits mandatory operator approval. */
  AUDITING_DOCUMENT = 'AUDITING_DOCUMENT',
  /** Defective-but-usable document (Airam present) verified in Kmaleon; notices in progress. */
  PROVISIONAL_VIABILIZED = 'PROVISIONAL_VIABILIZED',
  /** Client was told to revoke the defective power and re-issue it. */
  REVOCATION_GUIDE_SENT = 'REVOCATION_GUIDE_SENT',
  /** Client reported the revocation; waiting for the re-issued PDF. */
  WAITING_REVOCATION_REISSUE = 'WAITING_REVOCATION_REISSUE',
  /** Client has no certificate; official acquisition links were sent. */
  CERT_ACQUISITION_LINKS_SENT = 'CERT_ACQUISITION_LINKS_SENT',
  /** Court (juzgado) fallback: personalised power checklist sent. */
  FALLBACK_OPTIONS = 'FALLBACK_OPTIONS',
  COURT_FALLBACK_GUIDE_SENT = 'COURT_FALLBACK_GUIDE_SENT',
  /** Paid Apudata path: eligibility pre-approval requested from the partner. */
  APUDATA_PENDING_PREAPPROVAL = 'APUDATA_PENDING_PREAPPROVAL',
  /** Paid Apudata path: pre-approved; payment details sent; waiting for payment evidence. */
  APUDATA_WAITING_PAYMENT = 'APUDATA_WAITING_PAYMENT',
  /** Paid Apudata path: order registered; client completing video identification. */
  APUDATA_VIDEO_IN_PROGRESS = 'APUDATA_VIDEO_IN_PROGRESS',
  /** Operator-approved document is being uploaded to Kmaleon (verified write-read loop). */
  KMALEON_FILING = 'KMALEON_FILING',
  /** Final document verified in Kmaleon; aviso, Dayana notice and client notice in progress. */
  HANDOFF_DAYANA = 'HANDOFF_DAYANA',
  /** Terminal: verified filing, verified Dayana notice and delivered client notice. */
  COMPLETED = 'COMPLETED',
  /** Human hold: an operator must resolve and explicitly resume. */
  ESCALATED_HUMAN = 'ESCALATED_HUMAN',
}

/** Alias kept for readers coming from the Prisma schema. */
export const ApodState = State;
export type ApodState = State;

/** Every state, in schema order. */
export const ALL_STATES: readonly State[] = Object.freeze(Object.values(State));

/** States that accept no further automatic progress. */
export const TERMINAL_STATES: ReadonlySet<State> = new Set([State.COMPLETED]);

/** States in which the bot waits for a human operator rather than the client. */
export const HUMAN_HOLD_STATES: ReadonlySet<State> = new Set([State.ESCALATED_HUMAN]);

/** States in which the client is expected to deliver a PDF. */
export const PDF_EXPECTED_STATES: ReadonlySet<State> = new Set([
  State.PC_TUTORIAL_SENT,
  State.WAITING_PDF_SUBMISSION,
  State.WAITING_REVOCATION_REISSUE,
  State.REVOCATION_GUIDE_SENT,
  State.COURT_FALLBACK_GUIDE_SENT,
  State.APUDATA_VIDEO_IN_PROGRESS,
  State.MOBILE_EXPORT_GUIDE_SENT,
]);

/** Human-readable descriptions for dashboards and audit logs. */
export const STATE_DESCRIPTIONS: Readonly<Record<State, string>> = Object.freeze({
  [State.INITIAL_TRIAGE]: 'Expediente abierto, pendiente de triaje inicial',
  [State.WAITING_CERT_RESPONSE]: 'Esperando respuesta sobre certificado digital y dispositivo',
  [State.MOBILE_TRIAGE_PC_CHECK]: 'Certificado en móvil; preguntando si dispone de ordenador',
  [State.MOBILE_EXPORT_GUIDE_SENT]: 'Guía de exportación a ordenador enviada',
  [State.MOBILE_ASSIST_CONSENT_REQUESTED]: 'Consentimiento explícito solicitado para uso asistido del certificado',
  [State.MOBILE_ASSIST_PROCESSING]: 'Tramitación asistida en curso (certificado, geografía, borrador, revisión, presentación)',
  [State.PC_TUTORIAL_SENT]: 'Tutorial de Sede Judicial y listado de profesionales enviados',
  [State.WAITING_PDF_SUBMISSION]: 'Esperando PDF del apoderamiento',
  [State.AUDITING_DOCUMENT]: 'Documento en auditoría y pendiente de aprobación humana',
  [State.PROVISIONAL_VIABILIZED]: 'Apoderamiento provisional verificado en Kmaleon; avisos en curso',
  [State.REVOCATION_GUIDE_SENT]: 'Instrucciones de revocación enviadas',
  [State.WAITING_REVOCATION_REISSUE]: 'Revocación comunicada; esperando nuevo apoderamiento',
  [State.CERT_ACQUISITION_LINKS_SENT]: 'Enlaces oficiales para obtener certificado enviados',
  [State.FALLBACK_OPTIONS]: 'Elegir vía presencial o proveedor',
  [State.COURT_FALLBACK_GUIDE_SENT]: 'Listado para apoderamiento presencial en juzgado enviado',
  [State.APUDATA_PENDING_PREAPPROVAL]: 'Consultando elegibilidad con el proveedor de pago',
  [State.APUDATA_WAITING_PAYMENT]: 'Preaprobado; esperando justificante de pago',
  [State.APUDATA_VIDEO_IN_PROGRESS]: 'Videoidentificación con proveedor en curso',
  [State.KMALEON_FILING]: 'Subida verificada a Kmaleon en curso',
  [State.HANDOFF_DAYANA]: 'Aviso Kmaleon, notificación a Dayana y aviso al cliente en curso',
  [State.COMPLETED]: 'Completado con efectos verificados',
  [State.ESCALATED_HUMAN]: 'Escalado a persona; requiere reanudación manual',
});

/**
 * Every event the state machine understands.
 *
 * Naming convention:
 *   CLIENT_*    – derived from a client WhatsApp interaction (button or classified text).
 *   OPERATOR_*  – issued by an authenticated operator through the panel. Payload MUST carry
 *                 `operatorId`; the engine rejects them otherwise.
 *   others      – produced by the orchestrator/adapters after a verified effect or failure.
 */
export enum EventType {
  // ---- lifecycle / system ------------------------------------------------------------
  /** Expediente created or first inbound contact; starts the triage. */
  CASE_OPENED = 'CASE_OPENED',
  /** Scheduler tick: the client has been silent longer than the configured window. */
  REMINDER_DUE = 'REMINDER_DUE',

  // ---- client answers (triage) --------------------------------------------------------
  CLIENT_HAS_CERT = 'CLIENT_HAS_CERT',
  CLIENT_HAS_CERT_MOBILE = 'CLIENT_HAS_CERT_MOBILE',
  CLIENT_HAS_CERT_PC = 'CLIENT_HAS_CERT_PC',
  CLIENT_HAS_NO_CERT = 'CLIENT_HAS_NO_CERT',
  CLIENT_HAS_PC = 'CLIENT_HAS_PC',
  CLIENT_HAS_NO_PC = 'CLIENT_HAS_NO_PC',
  CLIENT_EXPORT_SUCCEEDED = 'CLIENT_EXPORT_SUCCEEDED',
  CLIENT_EXPORT_FAILED = 'CLIENT_EXPORT_FAILED',

  // ---- client: assisted path ----------------------------------------------------------
  CLIENT_CONSENT_GRANTED = 'CLIENT_CONSENT_GRANTED',
  CLIENT_CONSENT_DENIED = 'CLIENT_CONSENT_DENIED',
  /** Certificate file (and password) arrived and is held ONLY in RAM by the orchestrator. */
  CLIENT_CERT_FILE_RECEIVED = 'CLIENT_CERT_FILE_RECEIVED',
  CLIENT_DRAFT_APPROVED = 'CLIENT_DRAFT_APPROVED',
  CLIENT_DRAFT_REJECTED = 'CLIENT_DRAFT_REJECTED',

  // ---- client: documents & misc -------------------------------------------------------
  /** A PDF arrived via WhatsApp (or operator upload on behalf of the client). */
  CLIENT_PDF_RECEIVED = 'CLIENT_PDF_RECEIVED',
  CLIENT_ACKNOWLEDGED = 'CLIENT_ACKNOWLEDGED',
  CLIENT_REQUESTS_ASSISTANCE = 'CLIENT_REQUESTS_ASSISTANCE',
  CLIENT_REQUESTS_HUMAN = 'CLIENT_REQUESTS_HUMAN',
  CLIENT_CERT_ACQUIRED = 'CLIENT_CERT_ACQUIRED',
  CLIENT_CANNOT_GET_CERT = 'CLIENT_CANNOT_GET_CERT',
  CLIENT_REQUESTS_URGENT_PAID = 'CLIENT_REQUESTS_URGENT_PAID',
  CLIENT_REVOCATION_DONE = 'CLIENT_REVOCATION_DONE',
  CLIENT_REVOCATION_HELP = 'CLIENT_REVOCATION_HELP',
  CLIENT_UNCLEAR_RESPONSE = 'CLIENT_UNCLEAR_RESPONSE',
  /** Rollout or approved security reply; never changes the workflow state. */
  CLIENT_SMALL_TALK = 'CLIENT_SMALL_TALK',
  CLIENT_OPT_OUT = 'CLIENT_OPT_OUT',

  // ---- system: certificate / geography / Sede -----------------------------------------
  CERT_INSPECTION_COMPLETED = 'CERT_INSPECTION_COMPLETED',
  GEO_UNRESOLVED = 'GEO_UNRESOLVED',
  SEDE_DRAFT_READY = 'SEDE_DRAFT_READY',
  SEDE_AUTOMATION_FAILED = 'SEDE_AUTOMATION_FAILED',

  // ---- system: audit ------------------------------------------------------------------
  PDF_AUDIT_COMPLETED = 'PDF_AUDIT_COMPLETED',
  PDF_AUDIT_FAILED = 'PDF_AUDIT_FAILED',

  // ---- system: Kmaleon (verified effects only) ----------------------------------------
  KMALEON_UPLOAD_VERIFIED = 'KMALEON_UPLOAD_VERIFIED',
  KMALEON_UPLOAD_FAILED = 'KMALEON_UPLOAD_FAILED',
  KMALEON_AVISO_VERIFIED = 'KMALEON_AVISO_VERIFIED',
  KMALEON_AVISO_FAILED = 'KMALEON_AVISO_FAILED',

  // ---- system: notifications (verified effects only) ----------------------------------
  DAYANA_NOTIFIED = 'DAYANA_NOTIFIED',
  DAYANA_NOTIFICATION_FAILED = 'DAYANA_NOTIFICATION_FAILED',
  CLIENT_NOTIFICATION_DELIVERED = 'CLIENT_NOTIFICATION_DELIVERED',
  CLIENT_NOTIFICATION_FAILED = 'CLIENT_NOTIFICATION_FAILED',

  // ---- system: Apudata partner ---------------------------------------------------------
  APUDATA_PREAPPROVAL_CONFIRMED = 'APUDATA_PREAPPROVAL_CONFIRMED',
  APUDATA_PREAPPROVAL_DENIED = 'APUDATA_PREAPPROVAL_DENIED',
  APUDATA_PREAPPROVAL_FAILED = 'APUDATA_PREAPPROVAL_FAILED',
  APUDATA_ORDER_CREATED = 'APUDATA_ORDER_CREATED',
  APUDATA_DOCUMENT_RECEIVED = 'APUDATA_DOCUMENT_RECEIVED',
  APUDATA_FAILED = 'APUDATA_FAILED',

  // ---- operator (authenticated panel only) --------------------------------------------
  OPERATOR_APPROVED_DOCUMENT = 'OPERATOR_APPROVED_DOCUMENT',
  OPERATOR_REJECTED_DOCUMENT = 'OPERATOR_REJECTED_DOCUMENT',
  OPERATOR_SUBMISSION_CONFIRMED = 'OPERATOR_SUBMISSION_CONFIRMED',
  OPERATOR_PAYMENT_CONFIRMED = 'OPERATOR_PAYMENT_CONFIRMED',
  OPERATOR_ESCALATE = 'OPERATOR_ESCALATE',
  OPERATOR_RESUME = 'OPERATOR_RESUME',
}

/** Who is allowed to originate an event. Enforced by the orchestrator, checked by guards. */
export enum EventOrigin {
  CLIENT = 'CLIENT',
  OPERATOR = 'OPERATOR',
  SYSTEM = 'SYSTEM',
}

/** Event origin table. Operator events additionally require `payload.operatorId`. */
export const EVENT_ORIGIN: Readonly<Record<EventType, EventOrigin>> = Object.freeze({
  [EventType.CASE_OPENED]: EventOrigin.SYSTEM,
  [EventType.REMINDER_DUE]: EventOrigin.SYSTEM,
  [EventType.CLIENT_HAS_CERT]: EventOrigin.CLIENT,
  [EventType.CLIENT_HAS_CERT_MOBILE]: EventOrigin.CLIENT,
  [EventType.CLIENT_HAS_CERT_PC]: EventOrigin.CLIENT,
  [EventType.CLIENT_HAS_NO_CERT]: EventOrigin.CLIENT,
  [EventType.CLIENT_HAS_PC]: EventOrigin.CLIENT,
  [EventType.CLIENT_HAS_NO_PC]: EventOrigin.CLIENT,
  [EventType.CLIENT_EXPORT_SUCCEEDED]: EventOrigin.CLIENT,
  [EventType.CLIENT_EXPORT_FAILED]: EventOrigin.CLIENT,
  [EventType.CLIENT_CONSENT_GRANTED]: EventOrigin.CLIENT,
  [EventType.CLIENT_CONSENT_DENIED]: EventOrigin.CLIENT,
  [EventType.CLIENT_CERT_FILE_RECEIVED]: EventOrigin.CLIENT,
  [EventType.CLIENT_DRAFT_APPROVED]: EventOrigin.CLIENT,
  [EventType.CLIENT_DRAFT_REJECTED]: EventOrigin.CLIENT,
  [EventType.CLIENT_PDF_RECEIVED]: EventOrigin.CLIENT,
  [EventType.CLIENT_ACKNOWLEDGED]: EventOrigin.CLIENT,
  [EventType.CLIENT_REQUESTS_ASSISTANCE]: EventOrigin.CLIENT,
  [EventType.CLIENT_REQUESTS_HUMAN]: EventOrigin.CLIENT,
  [EventType.CLIENT_CERT_ACQUIRED]: EventOrigin.CLIENT,
  [EventType.CLIENT_CANNOT_GET_CERT]: EventOrigin.CLIENT,
  [EventType.CLIENT_REQUESTS_URGENT_PAID]: EventOrigin.CLIENT,
  [EventType.CLIENT_REVOCATION_DONE]: EventOrigin.CLIENT,
  [EventType.CLIENT_REVOCATION_HELP]: EventOrigin.CLIENT,
  [EventType.CLIENT_UNCLEAR_RESPONSE]: EventOrigin.CLIENT,
  [EventType.CLIENT_SMALL_TALK]: EventOrigin.CLIENT,
  [EventType.CLIENT_OPT_OUT]: EventOrigin.CLIENT,
  [EventType.CERT_INSPECTION_COMPLETED]: EventOrigin.SYSTEM,
  [EventType.GEO_UNRESOLVED]: EventOrigin.SYSTEM,
  [EventType.SEDE_DRAFT_READY]: EventOrigin.SYSTEM,
  [EventType.SEDE_AUTOMATION_FAILED]: EventOrigin.SYSTEM,
  [EventType.PDF_AUDIT_COMPLETED]: EventOrigin.SYSTEM,
  [EventType.PDF_AUDIT_FAILED]: EventOrigin.SYSTEM,
  [EventType.KMALEON_UPLOAD_VERIFIED]: EventOrigin.SYSTEM,
  [EventType.KMALEON_UPLOAD_FAILED]: EventOrigin.SYSTEM,
  [EventType.KMALEON_AVISO_VERIFIED]: EventOrigin.SYSTEM,
  [EventType.KMALEON_AVISO_FAILED]: EventOrigin.SYSTEM,
  [EventType.DAYANA_NOTIFIED]: EventOrigin.SYSTEM,
  [EventType.DAYANA_NOTIFICATION_FAILED]: EventOrigin.SYSTEM,
  [EventType.CLIENT_NOTIFICATION_DELIVERED]: EventOrigin.SYSTEM,
  [EventType.CLIENT_NOTIFICATION_FAILED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_PREAPPROVAL_CONFIRMED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_PREAPPROVAL_DENIED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_PREAPPROVAL_FAILED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_ORDER_CREATED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_DOCUMENT_RECEIVED]: EventOrigin.SYSTEM,
  [EventType.APUDATA_FAILED]: EventOrigin.SYSTEM,
  [EventType.OPERATOR_APPROVED_DOCUMENT]: EventOrigin.OPERATOR,
  [EventType.OPERATOR_REJECTED_DOCUMENT]: EventOrigin.OPERATOR,
  [EventType.OPERATOR_SUBMISSION_CONFIRMED]: EventOrigin.OPERATOR,
  [EventType.OPERATOR_PAYMENT_CONFIRMED]: EventOrigin.OPERATOR,
  [EventType.OPERATOR_ESCALATE]: EventOrigin.OPERATOR,
  [EventType.OPERATOR_RESUME]: EventOrigin.OPERATOR,
});

/** Every event type, for exhaustive checks. */
export const ALL_EVENT_TYPES: readonly EventType[] = Object.freeze(Object.values(EventType));

/**
 * Shared event shape (binding interface, see docs/ARCHITECTURE.md).
 * Payload schemas per event type live in `event-payloads.ts`. Payloads never carry
 * certificate passwords or free-form client text.
 */
export interface WorkflowEvent {
  type: EventType;
  payload?: Record<string, unknown>;
}

const STATE_SET: ReadonlySet<string> = new Set<string>(ALL_STATES);
const EVENT_SET: ReadonlySet<string> = new Set<string>(ALL_EVENT_TYPES);

/** Runtime type guard for `State`. */
export function isState(value: unknown): value is State {
  return typeof value === 'string' && STATE_SET.has(value);
}

/** Runtime type guard for `EventType`. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_SET.has(value);
}

/** Origin lookup that tolerates unknown strings (returns `undefined`). */
export function originOf(type: unknown): EventOrigin | undefined {
  return isEventType(type) ? EVENT_ORIGIN[type] : undefined;
}
