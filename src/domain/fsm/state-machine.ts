/**
 * Deterministic transition table for the apoderamiento workflow.
 *
 * `transition()` is a pure function of (expediente snapshot, event, clock). It never performs
 * I/O, never consults an LLM and never renders text: it selects the next state, one action with
 * a typed payload, the blocking conditions and the evidence the orchestrator must collect before
 * treating the effect as done. `src/core/decision-engine.ts` wraps it into the 11-field contract.
 *
 * Design rules
 *   - Every state handles every event: specific handlers first, then the global fallback.
 *   - Unexpected CLIENT events hold (NO_OP + UNEXPECTED_EVENT) so a stray button press never
 *     derails a filing. Unexpected SYSTEM/OPERATOR events and unknown vocabulary escalate.
 *   - Kmaleon uploads require operator approval, client review, identity-consistent audit and a
 *     Kmaleon expediente id. Completion requires verified filing + Dayana notice + delivered
 *     client notice, evaluated only from HANDOFF_DAYANA on a final (non-provisional) document.
 *   - Bank details (APUDATA_PAYMENT_DETAILS) are never emitted without an unexpired partner
 *     pre-approval bound to this expediente.
 *   - Certificate material is only used with explicit consent; every exit from the assisted path
 *     sets `discardCertificateMaterial`.
 */

import { EventType, EventOrigin, EVENT_ORIGIN, State, isEventType, isState, type WorkflowEvent } from './states.js';
import {
  ApudataOperation,
  AwaitingParty,
  BlockingCondition,
  EscalationReason,
  InternalJob,
  MediaAssetId,
  ReplyButton,
  SedePhase,
  TemplateId,
  type ActionPayload,
  type FinancialGateEvidence,
  type TemplateVariables,
} from './actions.js';
import { AuditStatus, CertDevice, DocumentType, isAuditStatus, isDocumentType, type Expediente, type ExpedientePatch } from '../models/expediente.js';
import {
  operatorIdOf,
  validateEventPayload,
  type ApudataApprovalPayload,
  type AuditCompletedPayload,
  type CertInspectionPayload,
  type ClientNotificationDeliveredPayload,
  type KmaleonNoticeVerifiedPayload,
  type KmaleonUploadVerifiedPayload,
} from './event-payloads.js';
import { IdentityDocumentType, parseSpanishIdentityDocument } from '../identity/spanish-identity-document.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Action payload without the fields the engine fills in (`expectedVersion`, `idempotencyKey`). */
export type ActionSpec = DistributiveOmit<ActionPayload, 'expectedVersion' | 'idempotencyKey'>;

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TransitionInput {
  expediente: Expediente;
  event: WorkflowEvent;
  /** Injected clock (expiry checks, consent timestamps). */
  now: Date;
}

export interface TransitionResult {
  nextStep: State;
  action: ActionSpec;
  blockingConditions: BlockingCondition[];
  isViabilizable: boolean;
  requiresClientRevocation: boolean;
  evidenceRequired: string;
  summary: string;
}

interface Ctx {
  exp: Expediente;
  type: EventType;
  payload: Record<string, unknown>;
  now: Date;
}

interface DecideOptions {
  blocking?: BlockingCondition[];
  patch?: ExpedientePatch;
  discard?: boolean;
  isViabilizable?: boolean;
  requiresClientRevocation?: boolean;
  evidence?: string;
  note: string;
}

type Handler = (ctx: Ctx) => TransitionResult | undefined;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const NO_VARS: TemplateVariables = Object.freeze({});

/** States whose progress depends on a system effect or an operator, not on the client. */
export const SYSTEM_DRIVEN_STATES: ReadonlySet<State> = new Set([
  State.AUDITING_DOCUMENT,
  State.KMALEON_FILING,
  State.HANDOFF_DAYANA,
  State.PROVISIONAL_VIABILIZED,
  State.APUDATA_PENDING_PREAPPROVAL,
  State.APUDATA_VIDEO_IN_PROGRESS,
  State.MOBILE_ASSIST_PROCESSING,
]);

/** States where a verified external effect is pending; a new PDF here is an inconsistency. */
const FILING_STATES: ReadonlySet<State> = new Set([State.KMALEON_FILING, State.HANDOFF_DAYANA]);

/** Resume targets that would fake a verified effect. */
export const FORBIDDEN_RESUME_TARGETS: ReadonlySet<State> = new Set([
  State.COMPLETED,
  State.ESCALATED_HUMAN,
  State.KMALEON_FILING,
  State.HANDOFF_DAYANA,
  State.PROVISIONAL_VIABILIZED,
]);

function sha256Prefix(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length >= 12 ? value.slice(0, 12) : null;
}

function evidenceFor(action: ActionSpec, exp: Expediente): string {
  switch (action.kind) {
    case 'SEND_WHATSAPP_MESSAGE':
    case 'SEND_WHATSAPP_BUTTONS':
    case 'SEND_WHATSAPP_MEDIA':
      return 'WhatsApp status webhook (delivered/read) for the outbox message id; API acceptance is not delivery.';
    case 'UPLOAD_KMALEON_DOCUMENT':
      return `Kmaleon read-back: project ${action.kmaleonExpedienteId} identity matches expediente DNI and retrieved bytes sha256 == ${action.documentSha256}.`;
    case 'CREATE_KMALEON_AVISO':
      return `Kmaleon annotation re-read on project ${action.kmaleonExpedienteId} referencing document ${action.kmaleonDocumentId} with the exact recipient and text.`;
    case 'NOTIFY_DAYANA':
      return `Kmaleon annotation re-read on project ${action.kmaleonExpedienteId} addressed to the Dayana recipient code referencing document ${action.kmaleonDocumentId}.`;
    case 'TRIGGER_SEDE_AUTOMATION':
      return action.phase === SedePhase.AWAIT_OPERATOR_SUBMISSION
        ? 'OPERATOR_SUBMISSION_CONFIRMED with operatorId and evidenceRef after the human performed the legally effective submission.'
        : action.phase === SedePhase.PREPARE_DRAFT
          ? 'SEDE_DRAFT_READY with stored draft documentId + sha256 produced by the reviewed recipe (no submission).'
          : 'CERT_INSPECTION_COMPLETED produced by CertInspector on RAM-held material (never persisted).';
    case 'CALL_APUDATA_PREAPPROVAL':
      return action.operation === ApudataOperation.CREATE_ORDER
        ? 'APUDATA_ORDER_CREATED with the partner order id bound to the approval id and payment evidence.'
        : `APUDATA_PREAPPROVAL_CONFIRMED with approval.clientId == ${exp.id}, preApproved=true, evidenceRef and unexpired expiresAt.`;
    case 'ESCALATE_HUMAN':
      return 'Operator resolution recorded in the audit log, then OPERATOR_RESUME with operatorId and targetState.';
    case 'NO_OP':
      return action.internalJob === InternalJob.PDF_AUDIT
        ? `PDF_AUDIT_COMPLETED for documentId ${action.documentId ?? 'n/a'} carrying the same sha256.`
        : `NONE (holding; awaiting ${action.awaiting}).`;
    default:
      return 'NONE';
  }
}

function decide(ctx: Ctx, nextStep: State, action: ActionSpec, opts: DecideOptions): TransitionResult {
  const patch = opts.patch ?? action.expedientePatch;
  const withPatch: ActionSpec = {
    ...action,
    ...(patch && Object.keys(patch).length > 0 ? { expedientePatch: patch } : {}),
    ...(opts.discard ? { discardCertificateMaterial: true } : {}),
  };
  const auditStatus = patch?.auditStatus !== undefined ? patch.auditStatus : ctx.exp.auditStatus;
  const provisionalFiled = patch?.isProvisionalFiled ?? ctx.exp.isProvisionalFiled;
  const isViabilizable = opts.isViabilizable ?? (auditStatus === AuditStatus.DEFECTIVE_WITH_AIRAM || provisionalFiled);
  const requiresClientRevocation =
    opts.requiresClientRevocation ??
    ((provisionalFiled && nextStep !== State.COMPLETED) ||
      nextStep === State.REVOCATION_GUIDE_SENT ||
      nextStep === State.WAITING_REVOCATION_REISSUE);
  return {
    nextStep,
    action: withPatch,
    blockingConditions: [...new Set(opts.blocking ?? [])],
    isViabilizable,
    requiresClientRevocation,
    evidenceRequired: opts.evidence ?? evidenceFor(withPatch, ctx.exp),
    summary: `${ctx.exp.currentState} + ${ctx.type} -> ${nextStep} [${withPatch.kind}]: ${opts.note}`,
  };
}

function hold(
  ctx: Ctx,
  awaiting: AwaitingParty,
  note: string,
  opts: Partial<DecideOptions> & { internalJob?: InternalJob; nextStep?: State } = {},
): TransitionResult {
  const nextStep = opts.nextStep ?? ctx.exp.currentState;
  const documentId = opts.patch?.documentId !== undefined ? opts.patch.documentId : ctx.exp.documentId;
  const documentSha256 = opts.patch?.documentSha256 !== undefined ? opts.patch.documentSha256 : ctx.exp.documentSha256;
  const documentType = opts.patch?.documentType !== undefined ? opts.patch.documentType : ctx.exp.documentType;
  const action: ActionSpec = {
    kind: 'NO_OP',
    awaiting,
    note,
    ...(opts.internalJob ? { internalJob: opts.internalJob } : {}),
    ...(documentId ? { documentId } : {}),
    ...(documentSha256 ? { documentSha256 } : {}),
    ...(isDocumentType(documentType) ? { documentType } : {}),
  };
  return decide(ctx, nextStep, action, { ...opts, note });
}

function escalate(
  ctx: Ctx,
  reason: EscalationReason,
  severity: Severity,
  note: string,
  opts: Partial<DecideOptions> & { clientNotice?: TemplateId; extra?: Record<string, string | number | boolean | null> } = {},
): TransitionResult {
  const action: ActionSpec = {
    kind: 'ESCALATE_HUMAN',
    reason,
    severity,
    context: {
      fromState: ctx.exp.currentState,
      eventType: ctx.type,
      version: ctx.exp.version,
      documentId: ctx.exp.documentId,
      documentSha256Prefix: sha256Prefix(ctx.exp.documentSha256),
      kmaleonExpedienteId: ctx.exp.kmaleonExpedienteId,
      ...(opts.extra ?? {}),
    },
    ...(opts.clientNotice ? { clientNoticeTemplate: opts.clientNotice } : {}),
  };
  return decide(ctx, State.ESCALATED_HUMAN, action, { ...opts, discard: true, note });
}

function buttons(template: TemplateId, ids: readonly ReplyButton[], variables: TemplateVariables = NO_VARS): ActionSpec {
  return { kind: 'SEND_WHATSAPP_BUTTONS', template, variables, buttons: ids };
}

function message(template: TemplateId, variables: TemplateVariables = NO_VARS): ActionSpec {
  return { kind: 'SEND_WHATSAPP_MESSAGE', template, variables };
}

const ROLLOUT_REPLY_TEMPLATES: Readonly<Record<string, TemplateId>> = Object.freeze({
  PHASE1_GREETING: TemplateId.PHASE1_GREETING,
  PHASE1_HELP: TemplateId.PHASE1_HELP,
  PHASE2_ACK: TemplateId.PHASE2_ACK,
  PHASE2_DEFER: TemplateId.PHASE2_DEFER,
  PHASE3_GREETING: TemplateId.PHASE3_GREETING,
  PHASE3_WORKFLOW: TemplateId.PHASE3_GREETING,
  CONVERSATION_REPLY: TemplateId.CONVERSATION_REPLY,
  SECURITY_ANSWER: TemplateId.SECURITY_ANSWER,
});

function media(template: TemplateId, assets: readonly MediaAssetId[], extra: Partial<Extract<ActionSpec, { kind: 'SEND_WHATSAPP_MEDIA' }>> = {}): ActionSpec {
  return { kind: 'SEND_WHATSAPP_MEDIA', template, variables: NO_VARS, media: assets, ...extra };
}

function evidenceRefOf(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>).evidenceRef;
    if (typeof ref === 'string' && ref.trim().length > 0) return ref.trim();
  }
  return null;
}

/** Evidence that the 35 EUR financial gate is open for this expediente right now. */
export function financialGate(exp: Expediente, now: Date): FinancialGateEvidence | null {
  const expires = exp.apudataApprovalExpiresAt;
  const evidenceRef = evidenceRefOf(exp.apudataApprovalEvidence);
  if (!exp.apudataPreApproved || !(expires instanceof Date) || Number.isNaN(expires.getTime()) || !evidenceRef) return null;
  if (expires.getTime() <= now.getTime()) return null;
  return { preApproved: true, approvalExpiresAt: expires.toISOString(), evidenceRef };
}

function documentMatches(exp: Expediente, documentId: string, sha256?: string): boolean {
  if (!exp.documentId || exp.documentId !== documentId) return false;
  if (sha256 && exp.documentSha256 && exp.documentSha256 !== sha256) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Shared transitions
// ---------------------------------------------------------------------------------------------

function toAskHasCert(ctx: Ctx, note = 'Ask whether the client has a digital certificate'): TransitionResult {
  return decide(ctx, State.WAITING_CERT_RESPONSE, buttons(TemplateId.ASK_HAS_CERT, [ReplyButton.HAS_CERT_YES, ReplyButton.HAS_CERT_NO]), { note });
}

const DEVICE_BUTTONS: readonly ReplyButton[] = [ReplyButton.DEVICE_PC, ReplyButton.DEVICE_MOBILE, ReplyButton.NEEDS_ASSISTANCE];
const HAS_PC_BUTTONS: readonly ReplyButton[] = [ReplyButton.HAS_PC, ReplyButton.NO_PC, ReplyButton.NEEDS_ASSISTANCE];

/** Client has a certificate: ask on which device (stays in WAITING_CERT_RESPONSE). */
function toAskDevice(ctx: Ctx, note = 'Client has a certificate; ask on which device it is installed'): TransitionResult {
  return decide(ctx, State.WAITING_CERT_RESPONSE, buttons(TemplateId.ASK_CERT_DEVICE, DEVICE_BUTTONS), { note, patch: { hasDigitalCert: true } });
}

/** Certificate on mobile: ask whether the client owns a PC (MOBILE_TRIAGE_PC_CHECK). */
function toAskHasPc(ctx: Ctx, note = 'Certificate on mobile: ask whether the client has a PC'): TransitionResult {
  return decide(ctx, State.MOBILE_TRIAGE_PC_CHECK, buttons(TemplateId.ASK_HAS_PC, HAS_PC_BUTTONS), {
    note,
    patch: { hasDigitalCert: true, certDevice: CertDevice.MOBILE },
  });
}

function toPcTutorial(ctx: Ctx): TransitionResult {
  return decide(ctx, State.PC_TUTORIAL_SENT, media(TemplateId.PC_TUTORIAL, [MediaAssetId.TUTORIAL_PC_PDF, MediaAssetId.REPRESENTATIVES_LIST_PDF]), {
    note: 'Certificate on PC: send Sede tutorial and approved representatives list',
    patch: { hasDigitalCert: true, certDevice: CertDevice.PC, digitalHelpAttempts:0, certificateHelpAttempts:0 },
  });
}

function toExportGuide(ctx: Ctx, note = 'Certificate on mobile: send export-to-PC guide'): TransitionResult {
  return decide(ctx, State.MOBILE_EXPORT_GUIDE_SENT, buttons(TemplateId.MOBILE_EXPORT_GUIDE, [ReplyButton.DEVICE_PC, ReplyButton.NEEDS_ASSISTANCE]), {
    note,
    patch: { hasDigitalCert: true, certDevice: CertDevice.MOBILE },
  });
}

function toConsentRequest(ctx: Ctx, note: string): TransitionResult {
  return decide(ctx, State.MOBILE_ASSIST_CONSENT_REQUESTED, buttons(TemplateId.ASSIST_CONSENT_REQUEST, [ReplyButton.CONSENT_YES, ReplyButton.CONSENT_NO]), {
    note,
    blocking: [BlockingCondition.CONSENT_REQUIRED_BEFORE_CERT_USE],
    patch: { consentGranted: false, consentGrantedAt: null },
  });
}

function acquisitionTemplate(exp: Expediente, declared?:unknown): TemplateId {
  const type = declared==='NIE'||declared==='DNI'?declared:parseSpanishIdentityDocument(exp.dni).type;
  if (type === IdentityDocumentType.DNI) return TemplateId.CERT_ACQUISITION_LINKS_DNI;
  if (type === IdentityDocumentType.NIE) return TemplateId.CERT_ACQUISITION_LINKS_NIE;
  return TemplateId.CERT_ACQUISITION_LINKS_UNKNOWN_ID;
}

function toAcquisitionLinks(ctx: Ctx): TransitionResult {
  const type = parseSpanishIdentityDocument(ctx.exp.dni).type;
  return decide(
    ctx,
    State.CERT_ACQUISITION_LINKS_SENT,
    buttons(acquisitionTemplate(ctx.exp,ctx.payload.guidanceDocumentType), [ReplyButton.NEEDS_ASSISTANCE], { identityDocumentType: type }),
    { note: 'No certificate: send official acquisition links for the identity document type', patch: { hasDigitalCert: false, certDevice: CertDevice.NONE, digitalHelpAttempts:0, certificateHelpAttempts:0 } },
  );
}

function toCourtFallback(ctx: Ctx, template: TemplateId, note: string): TransitionResult {
  return decide(ctx, State.COURT_FALLBACK_GUIDE_SENT, media(template, [MediaAssetId.COURT_POWER_CHECKLIST_GENERATED]), { note });
}

/** Help first, certificate-copy assistance second, alternatives only after failures. */
function guidedHelp(ctx: Ctx): TransitionResult {
  const attempts = (ctx.exp.digitalHelpAttempts ?? 0) + 1;
  const copyAttempts = ctx.exp.certificateHelpAttempts ?? 0;
  const failed = ctx.type === EventType.CLIENT_EXPORT_FAILED;
  const hasCert = ctx.exp.hasDigitalCert === true;
  const fallback = () => decide(ctx, State.FALLBACK_OPTIONS, buttons(TemplateId.FALLBACK_OPTIONS, [ReplyButton.COURT_APPOINTMENT, ReplyButton.APUDATA_REQUEST, ReplyButton.HUMAN_HELP]), {
    note:'Repeated guided attempts exhausted; offer court or partner alternatives',
    patch:{digitalHelpAttempts:attempts,certificateHelpAttempts:copyAttempts},
  });
  if (hasCert && ctx.payload.copyLocated === true) return toConsentRequest(ctx, 'Client located the certificate copy: ask for consent to prepare it for them');
  // Protocol 2.2: certificate on the phone and no computer means the office does it. Staying in the
  // "do you have a computer?" step made the bot ask the same question again (live test 23 Sep).
  if (hasCert && ctx.type === EventType.CLIENT_HAS_NO_PC) return toConsentRequest(ctx, 'No computer: the office prepares it with the client\'s certificate (protocol 2.2)');
  if (!hasCert && ctx.exp.hasDigitalCert === false && attempts >= 3 && failed) return fallback();
  if (hasCert && ctx.type === EventType.CLIENT_REQUESTS_ASSISTANCE && ctx.payload.takeoverRequested === true && copyAttempts > 0)
    return toConsentRequest(ctx, 'Client asked the office to take it over after the copy help: move to assisted processing');
  if (hasCert && (copyAttempts > 0 || attempts >= 3 || ctx.type === EventType.CLIENT_HAS_NO_PC)) {
    if (copyAttempts >= 3 && failed) return fallback();
    return decide(ctx, ctx.exp.currentState, message(TemplateId.CERTIFICATE_COPY_HELP, { helpTopic:String(ctx.payload.helpTopic??'') }), {
      note:'Help locate and prepare the certificate copy before offering alternatives',
      patch:{digitalHelpAttempts:attempts,certificateHelpAttempts:copyAttempts+1},
    });
  }
  return decide(ctx, ctx.exp.currentState, message(TemplateId.DIGITAL_STEP_HELP, { helpTopic:String(ctx.payload.helpTopic??''),guidanceDocumentType:String(ctx.payload.guidanceDocumentType??'') }), {
    note:'Continue the current digital step with practical guidance; no handoff',
    patch:{digitalHelpAttempts:attempts},
  });
}

function toApudataPreapproval(ctx: Ctx): TransitionResult {
  // The bot never contacts the partner company itself unless that integration is switched on
  // (APUD_VERSION=2): otherwise a person from the team takes the paid route straight away.
  if (ctx.payload.partnerIntegration !== true)
    return escalate(ctx, EscalationReason.CLIENT_NEEDS_HUMAN, 'MEDIUM', 'Client chose the paid partner route: a person from the team takes it', { clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE });
  const action: ActionSpec = {
    kind: 'CALL_APUDATA_PREAPPROVAL',
    operation: ApudataOperation.PREAPPROVAL_CHECK,
    dni: ctx.exp.dni,
    nombre: ctx.exp.nombre,
    telefono: ctx.exp.telefono,
  };
  return decide(ctx, State.APUDATA_PENDING_PREAPPROVAL, action, {
    note: 'Client requested the paid partner path: ask the partner for eligibility before any bank details',
    blocking: [BlockingCondition.FINANCIAL_GATE_CLOSED],
    patch: { apudataPreApproved: false, apudataApprovalExpiresAt: null, apudataApprovalEvidence: null },
  });
}

function toAudit(ctx: Ctx, documentId: string, sha256: string, typeHint: DocumentType, note: string, extraPatch: ExpedientePatch = {}): TransitionResult {
  const patch: ExpedientePatch = {
    documentId,
    documentSha256: sha256,
    documentType: typeHint,
    documentApproved: false,
    auditStatus: null,
    pageCount: null,
    ...extraPatch,
  };
  return hold(ctx, AwaitingParty.NONE, note, {
    nextStep: State.AUDITING_DOCUMENT,
    internalJob: InternalJob.PDF_AUDIT,
    patch,
    blocking: [BlockingCondition.HUMAN_APPROVAL_REQUIRED],
    isViabilizable: false,
  });
}

function reminder(ctx: Ctx, action: ActionSpec, nextStep = ctx.exp.currentState): TransitionResult {
  return decide(ctx, nextStep, action, { note: 'Reminder: re-send the pending step' });
}

const REMINDER_VARS = (exp: Expediente): TemplateVariables => ({ pendingState: exp.currentState });

// ---------------------------------------------------------------------------------------------
// Per-state handlers
// ---------------------------------------------------------------------------------------------

function triageAnswer(ctx: Ctx): TransitionResult | undefined {
  switch (ctx.type) {
    case EventType.CLIENT_HAS_CERT:
      return toAskDevice(ctx);
    case EventType.CLIENT_HAS_CERT_PC:
    case EventType.CLIENT_EXPORT_SUCCEEDED:
      return toPcTutorial(ctx);
    case EventType.CLIENT_HAS_CERT_MOBILE:
      return toAskHasPc(ctx);
    case EventType.CLIENT_HAS_PC:
      return toExportGuide(ctx, 'Client owns a PC: guide the export of the mobile certificate');
    case EventType.CLIENT_HAS_NO_PC:
    case EventType.CLIENT_EXPORT_FAILED:
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
      return toConsentRequest(ctx, 'No PC or export impossible: request explicit consent for assisted processing');
    case EventType.CLIENT_HAS_NO_CERT:
      return toAcquisitionLinks(ctx);
    case EventType.CLIENT_CANNOT_GET_CERT:
      return toCourtFallback(ctx, TemplateId.COURT_POWER_CHECKLIST, 'Client cannot obtain a certificate: send the personalised court checklist');
    case EventType.CLIENT_REQUESTS_URGENT_PAID:
      return toApudataPreapproval(ctx);
    case EventType.CLIENT_CONSENT_DENIED:
      // Refusing to hand over the certificate is not a dead end: the court and partner routes
      // remain open, so triage and the mobile states offer them instead of stalling.
      return decide(ctx, State.FALLBACK_OPTIONS, buttons(TemplateId.FALLBACK_OPTIONS, [ReplyButton.COURT_APPOINTMENT, ReplyButton.APUDATA_REQUEST, ReplyButton.HUMAN_HELP]), {
        discard: true,
        note: 'Client will not share the certificate: offer the court and partner routes',
        patch: { consentGranted: false, consentGrantedAt: null },
      });
    default:
      return undefined;
  }
}

const initialTriage: Handler = (ctx) => {
  if (ctx.type === EventType.CASE_OPENED || ctx.type === EventType.REMINDER_DUE) return toAskHasCert(ctx, 'Case opened: start triage');
  return triageAnswer(ctx);
};

const waitingCertResponse: Handler = (ctx) => {
  if (ctx.type === EventType.REMINDER_DUE) {
    return ctx.exp.hasDigitalCert === true
      ? reminder(ctx, buttons(TemplateId.ASK_CERT_DEVICE, DEVICE_BUTTONS))
      : reminder(ctx, buttons(TemplateId.ASK_HAS_CERT, [ReplyButton.HAS_CERT_YES, ReplyButton.HAS_CERT_NO]));
  }
  return triageAnswer(ctx);
};

const mobileTriagePcCheck: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_HAS_CERT_MOBILE:
      return toAskHasPc(ctx, 'Device confirmed again as mobile: re-ask whether the client has a PC');
    case EventType.CLIENT_HAS_CERT:
      return toAskHasPc(ctx, 'Certificate confirmed: re-ask whether the client has a PC');
    case EventType.REMINDER_DUE:
      return reminder(ctx, buttons(TemplateId.ASK_HAS_PC, HAS_PC_BUTTONS));
    default:
      return triageAnswer(ctx);
  }
};

const mobileExportGuideSent: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_HAS_CERT_MOBILE:
    case EventType.CLIENT_HAS_PC:
      return toExportGuide(ctx, 'Client still on mobile with a PC: re-send the export guide');
    case EventType.REMINDER_DUE:
      return reminder(ctx, buttons(TemplateId.MOBILE_EXPORT_GUIDE, [ReplyButton.DEVICE_PC, ReplyButton.NEEDS_ASSISTANCE]));
    default:
      return triageAnswer(ctx);
  }
};

const mobileAssistConsentRequested: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_CONSENT_GRANTED: {
      const consentVersion = typeof ctx.payload.consentVersion === 'string' ? ctx.payload.consentVersion : undefined;
      return decide(ctx, State.MOBILE_ASSIST_PROCESSING, buttons(TemplateId.ASSIST_SEND_CERT_INSTRUCTIONS, [ReplyButton.HUMAN_HELP]), {
        note: 'Consent granted: tell the client the operator will indicate the secure channel for the certificate',
        patch: { consentGranted: true, consentGrantedAt: ctx.now, ...(consentVersion ? { consentVersion } : {}) },
        blocking: [BlockingCondition.CLIENT_REVIEW_REQUIRED],
      });
    }
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
      return decide(ctx, State.MOBILE_ASSIST_CONSENT_REQUESTED, buttons(TemplateId.ASSIST_CONSENT_REQUEST, [ReplyButton.CONSENT_YES, ReplyButton.CONSENT_NO]), {
        note: 'Consent answer could not be tied to its request: ask again rather than leaving the client without a reply',
      });
    case EventType.CLIENT_CONSENT_DENIED:
      return decide(ctx, State.FALLBACK_OPTIONS, buttons(TemplateId.FALLBACK_OPTIONS,[ReplyButton.COURT_APPOINTMENT,ReplyButton.APUDATA_REQUEST,ReplyButton.HUMAN_HELP]),{discard:true,note:'Assistance declined: offer both alternatives',patch:{consentGranted:false,consentGrantedAt:null}});
    case EventType.CLIENT_HAS_CERT_PC:
    case EventType.CLIENT_EXPORT_SUCCEEDED:
      return toPcTutorial(ctx);
    case EventType.CLIENT_CANNOT_GET_CERT:
      return toCourtFallback(ctx, TemplateId.COURT_POWER_CHECKLIST, 'Client prefers the court: send the personalised checklist');
    case EventType.CLIENT_REQUESTS_URGENT_PAID:
      return toApudataPreapproval(ctx);
    case EventType.REMINDER_DUE:
      return reminder(ctx, buttons(TemplateId.ASSIST_CONSENT_REQUEST, [ReplyButton.CONSENT_YES, ReplyButton.CONSENT_NO]));
    default:
      return undefined;
  }
};

const mobileAssistProcessing: Handler = (ctx) => {
  const exp = ctx.exp;
  if (!exp.consentGranted && ctx.type !== EventType.CLIENT_PDF_RECEIVED && ctx.type !== EventType.CLIENT_CONSENT_DENIED) {
    return hold(ctx, AwaitingParty.CLIENT, 'Consent flag is not set: certificate material must not be used', {
      blocking: [BlockingCondition.CONSENT_REQUIRED_BEFORE_CERT_USE],
      discard: true,
    });
  }
  switch (ctx.type) {
    case EventType.CLIENT_CERT_FILE_RECEIVED: {
      const action: ActionSpec = { kind: 'TRIGGER_SEDE_AUTOMATION', phase: SedePhase.INSPECT_CERTIFICATE, certRef: String(ctx.payload.certRef) };
      return decide(ctx, State.MOBILE_ASSIST_PROCESSING, action, { note: 'Certificate material received in RAM: inspect before any use' });
    }
    case EventType.CERT_INSPECTION_COMPLETED: {
      const p = ctx.payload as CertInspectionPayload;
      if (!p.identityMatches) {
        return escalate(ctx, EscalationReason.IDENTITY_MISMATCH_CERTIFICATE, 'HIGH', 'Certificate subject does not match the expediente identity', {
          blocking: [BlockingCondition.IDENTITY_MISMATCH],
          extra: { fingerprintSha256: p.fingerprintSha256 ?? null },
        });
      }
      if (!p.passwordValid) {
        return escalate(ctx, EscalationReason.CERTIFICATE_UNUSABLE, 'MEDIUM', 'Certificate password invalid', {
          blocking: [BlockingCondition.CERTIFICATE_UNUSABLE],
          clientNotice: TemplateId.ASSIST_CERT_PASSWORD_INVALID,
        });
      }
      if (p.expired) {
        return escalate(ctx, EscalationReason.CERTIFICATE_UNUSABLE, 'MEDIUM', 'Certificate expired or not yet valid', {
          blocking: [BlockingCondition.CERTIFICATE_UNUSABLE],
          clientNotice: TemplateId.ASSIST_CERT_EXPIRED,
        });
      }
      if (!p.usable || !p.keyMatchesCertificate) {
        return escalate(ctx, EscalationReason.CERTIFICATE_UNUSABLE, 'MEDIUM', 'Certificate unusable (key mismatch or unsupported)', {
          blocking: [BlockingCondition.CERTIFICATE_UNUSABLE],
          clientNotice: TemplateId.ASSIST_CERT_UNUSABLE,
          extra: { reasons: (p.reasons ?? []).join(',') || null },
        });
      }
      const action: ActionSpec = {
        kind: 'TRIGGER_SEDE_AUTOMATION',
        phase: SedePhase.PREPARE_DRAFT,
        certRef: p.certRef,
        requires: ['KMALEON_ADDRESS', 'GEO_CATALOG_RESOLUTION', 'CLIENT_REVIEW'],
      };
      return decide(ctx, State.MOBILE_ASSIST_PROCESSING, action, {
        note: 'Certificate usable and identity-bound: prepare the Sede draft with catalog-resolved geography',
        blocking: [BlockingCondition.CLIENT_REVIEW_REQUIRED],
      });
    }
    case EventType.GEO_UNRESOLVED:
      return escalate(ctx, EscalationReason.GEO_UNRESOLVED, 'MEDIUM', 'Judicial district could not be resolved from the reviewed catalog', {
        blocking: [BlockingCondition.GEO_UNRESOLVED],
      });
    case EventType.SEDE_DRAFT_READY: {
      const documentId = String(ctx.payload.documentId);
      const sha256 = String(ctx.payload.sha256);
      const action: ActionSpec = media(TemplateId.DRAFT_REVIEW_REQUEST, [MediaAssetId.STORED_DOCUMENT], {
        documentId,
        documentSha256: sha256,
        buttons: [ReplyButton.DRAFT_APPROVED, ReplyButton.DRAFT_REJECTED],
      });
      return decide(ctx, State.MOBILE_ASSIST_PROCESSING, action, {
        note: 'Sede draft stored: send it to the client for review before any submission',
        blocking: [BlockingCondition.CLIENT_REVIEW_REQUIRED],
        patch: { documentId, documentSha256: sha256, documentType: DocumentType.BORRADOR_SEDE, documentApproved: false, clientReviewed: false, auditStatus: null, pageCount: null },
        isViabilizable: false,
      });
    }
    case EventType.SEDE_AUTOMATION_FAILED:
      return escalate(ctx, EscalationReason.SEDE_AUTOMATION_FAILED, 'HIGH', `Sede automation failed: ${String(ctx.payload.errorCode)}`);
    case EventType.CLIENT_DRAFT_APPROVED: {
      const documentId = typeof ctx.payload.documentId === 'string' ? ctx.payload.documentId : exp.documentId;
      const sha256 = typeof ctx.payload.sha256 === 'string' ? ctx.payload.sha256 : exp.documentSha256 ?? undefined;
      if (!documentId || !documentMatches(exp, documentId, sha256) || exp.documentType !== DocumentType.BORRADOR_SEDE) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Draft approval does not reference the stored Sede draft', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
        });
      }
      const action: ActionSpec = {
        kind: 'TRIGGER_SEDE_AUTOMATION',
        phase: SedePhase.AWAIT_OPERATOR_SUBMISSION,
        draftDocumentId: documentId,
        ...(exp.documentSha256 ? { draftSha256: exp.documentSha256 } : {}),
      };
      return decide(ctx, State.MOBILE_ASSIST_PROCESSING, action, {
        note: 'Client approved the draft: a human operator must perform and evidence the submission',
        blocking: [BlockingCondition.OPERATOR_SUBMISSION_EVIDENCE_REQUIRED],
        patch: { clientReviewed: true },
      });
    }
    case EventType.CLIENT_DRAFT_REJECTED:
      return escalate(ctx, EscalationReason.DRAFT_REJECTED_BY_CLIENT, 'MEDIUM', 'Client rejected the draft: human review of the draft data required', {
        patch: { clientReviewed: false },
        clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE,
      });
    case EventType.OPERATOR_SUBMISSION_CONFIRMED: {
      if (!exp.clientReviewed) {
        return hold(ctx, AwaitingParty.CLIENT, 'Submission confirmed without client review of the draft: refusing to proceed', {
          blocking: [BlockingCondition.CLIENT_REVIEW_REQUIRED],
        });
      }
      const reviewedDraftId = typeof ctx.payload.reviewedDraftId === 'string' ? ctx.payload.reviewedDraftId : undefined;
      const reviewedDraftSha256 = typeof ctx.payload.reviewedDraftSha256 === 'string' ? ctx.payload.reviewedDraftSha256 : undefined;
      if ((reviewedDraftId && reviewedDraftId !== exp.documentId) || (reviewedDraftSha256 && exp.documentSha256 && reviewedDraftSha256 !== exp.documentSha256)) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Submission evidence references a different draft than the reviewed one', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
          extra: { reviewedDraftId: reviewedDraftId ?? null },
        });
      }
      const documentId = typeof ctx.payload.documentId === 'string' ? ctx.payload.documentId : undefined;
      const sha256 = typeof ctx.payload.sha256 === 'string' ? ctx.payload.sha256 : undefined;
      if (documentId && sha256) {
        return toAudit(ctx, documentId, sha256, DocumentType.PENDING_REVIEW, 'Operator submitted at Sede and uploaded the justificante: audit it', { clientReviewed: true });
      }
      return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_UPLOAD, 'Submission evidenced: operator must upload the Sede justificante PDF for audit', {
        nextStep: State.WAITING_PDF_SUBMISSION,
        discard: true,
        blocking: [BlockingCondition.HUMAN_APPROVAL_REQUIRED],
      });
    }
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'PDF received during assisted processing: audit it', {});
    case EventType.CLIENT_CONSENT_DENIED:
      return escalate(ctx, EscalationReason.CONSENT_DENIED, 'MEDIUM', 'Consent withdrawn during assisted processing: wipe material and hand over', {
        patch: { consentGranted: false, consentGrantedAt: null },
        clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE,
      });
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.NONE, 'Assisted processing in progress: no client reminder');
    default:
      return undefined;
  }
};

function pdfExpectedHandler(reminderAction: (ctx: Ctx) => TransitionResult): Handler {
  return (ctx) => {
    switch (ctx.type) {
      case EventType.CLIENT_PDF_RECEIVED:
        return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'PDF received: audit it', {});
      case EventType.CLIENT_REQUESTS_ASSISTANCE:
        return toConsentRequest(ctx, 'Client cannot complete the self-service path: offer assisted processing under consent');
      case EventType.CLIENT_HAS_NO_CERT:
        return toAcquisitionLinks(ctx);
      case EventType.CLIENT_CANNOT_GET_CERT:
        return toCourtFallback(ctx, TemplateId.COURT_POWER_CHECKLIST, 'Client prefers the court: send the personalised checklist');
      case EventType.CLIENT_REQUESTS_URGENT_PAID:
        return toApudataPreapproval(ctx);
      case EventType.REMINDER_DUE:
        return reminderAction(ctx);
      default:
        return undefined;
    }
  };
}

const pcTutorialSent = pdfExpectedHandler((ctx) => reminder(ctx, message(TemplateId.REMINDER_PENDING_STEP, REMINDER_VARS(ctx.exp))));
const waitingPdfSubmission = pdfExpectedHandler((ctx) => reminder(ctx, message(TemplateId.REMINDER_PENDING_STEP, REMINDER_VARS(ctx.exp))));

const auditingDocument: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.PDF_AUDIT_COMPLETED: {
      const p = ctx.payload as AuditCompletedPayload;
      if (!documentMatches(exp, p.documentId, p.sha256)) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Audit result references a different document than the expediente', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
          extra: { auditedDocumentId: p.documentId, auditedSha256Prefix: sha256Prefix(p.sha256) },
        });
      }
      const patch: ExpedientePatch = { auditStatus: p.status, pageCount: p.pageCount, documentApproved: false };
      if (p.status !== AuditStatus.UNREADABLE_OR_CORRUPT && !p.identityMatches) {
        return escalate(ctx, EscalationReason.IDENTITY_MISMATCH_DOCUMENT, 'HIGH', 'Audited document does not carry the expediente identity document', {
          blocking: [BlockingCondition.IDENTITY_MISMATCH],
          patch,
        });
      }
      const blocking: BlockingCondition[] = [BlockingCondition.HUMAN_APPROVAL_REQUIRED];
      if (p.requiresHumanReview || p.status !== AuditStatus.VALID_FULL_5_PAGES) blocking.push(BlockingCondition.AUDIT_REQUIRES_HUMAN_REVIEW);
      const note =
        p.status === AuditStatus.VALID_FULL_5_PAGES
          ? 'Structural audit passed: mandatory operator approval before any filing'
          : p.status === AuditStatus.DEFECTIVE_WITH_AIRAM
            ? `Defective document (Airam present, ${p.missingPowers.length} power(s) missing, ${p.pageCount} page(s)): operator decides approval as provisional or rejection`
            : p.status === AuditStatus.DEFECTIVE_NO_AIRAM
              ? 'Airam not detected: operator must verify manually or reject (never viabilizable automatically)'
              : 'Document unreadable or corrupt: operator must inspect and reject to request a new PDF';
      return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, note, {
        blocking,
        patch,
        isViabilizable: p.canViabilize && p.identityMatches && p.hasAiram,
      });
    }
    case EventType.PDF_AUDIT_FAILED:
      return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, `Audit engine failed (${String(ctx.payload.errorCode)}): operator must inspect the document manually`, {
        blocking: [BlockingCondition.AUDIT_REQUIRES_HUMAN_REVIEW, BlockingCondition.HUMAN_APPROVAL_REQUIRED],
        patch: { auditStatus: null, documentApproved: false },
        isViabilizable: false,
      });
    case EventType.OPERATOR_APPROVED_DOCUMENT: {
      const documentId = String(ctx.payload.documentId);
      const sha256 = String(ctx.payload.sha256);
      const reviewer = operatorIdOf(ctx.payload) ?? 'OPERATOR';
      if (!documentMatches(exp, documentId, sha256)) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Approval references a different document than the expediente', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
          extra: { approvedDocumentId: documentId, approvedSha256Prefix: sha256Prefix(sha256), reviewer },
        });
      }
      if (!isAuditStatus(exp.auditStatus) || (exp.auditStatus !== AuditStatus.VALID_FULL_5_PAGES && exp.auditStatus !== AuditStatus.DEFECTIVE_WITH_AIRAM)) {
        return escalate(ctx, EscalationReason.APPROVAL_INCONSISTENT_WITH_AUDIT, 'HIGH', `Approval received with audit status ${exp.auditStatus ?? 'null'}: refusing to file`, {
          blocking: [BlockingCondition.AUDIT_NOT_COMPLETED],
          extra: { reviewer },
        });
      }
      const isProvisional = exp.auditStatus === AuditStatus.DEFECTIVE_WITH_AIRAM;
      const documentType = isProvisional ? DocumentType.APODERAMIENTO_PROVISIONAL : DocumentType.APODERAMIENTO_FINAL;
      const clientReviewed = ctx.payload.clientReviewed === true || (ctx.payload.clientReviewed === undefined && exp.clientReviewed);
      const patch: ExpedientePatch = { documentApproved: true, clientReviewed, documentType };
      if (!clientReviewed) {
        return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, 'Approved without client review evidence: approve again with clientReviewed=true and clientEvidenceRef', {
          blocking: [BlockingCondition.CLIENT_REVIEW_REQUIRED],
          patch,
          isViabilizable: isProvisional,
        });
      }
      if (!exp.kmaleonExpedienteId) {
        return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, 'Approved but no Kmaleon expediente is linked: link it and approve again', {
          blocking: [BlockingCondition.KMALEON_EXPEDIENTE_MISSING],
          patch,
          isViabilizable: isProvisional,
        });
      }
      const action: ActionSpec = {
        kind: 'UPLOAD_KMALEON_DOCUMENT',
        kmaleonExpedienteId: exp.kmaleonExpedienteId,
        documentId,
        documentSha256: sha256,
        documentType,
        isProvisional,
        approvedBy: reviewer,
        titleTemplate: isProvisional ? 'APODERAMIENTO_PROVISIONAL_TITLE' : 'APODERAMIENTO_FINAL_TITLE',
      };
      return decide(ctx, State.KMALEON_FILING, action, {
        note: isProvisional ? 'Operator approved a defective-but-usable document: file it provisionally (verified write-read)' : 'Operator approved the complete document: file it (verified write-read)',
        patch,
        isViabilizable: isProvisional,
      });
    }
    case EventType.OPERATOR_REJECTED_DOCUMENT: {
      const documentId = String(ctx.payload.documentId);
      if (!documentMatches(exp, documentId)) {
        return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, 'Rejection references a different document: ignored', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
        });
      }
      const patch: ExpedientePatch = { documentApproved: false, clientReviewed: false };
      if (ctx.payload.disposition === 'REVOKE_AND_REISSUE') {
        return decide(ctx, State.REVOCATION_GUIDE_SENT, media(TemplateId.REVOCATION_GUIDE, [MediaAssetId.REVOCATION_GUIDE_PDF, MediaAssetId.REVOCATION_SCREENSHOTS], { buttons: [ReplyButton.REVOKED, ReplyButton.HUMAN_HELP] }), {
          note: 'Operator rejected the document and asks the client to revoke and re-issue it',
          patch,
          requiresClientRevocation: true,
        });
      }
      const template =
        exp.auditStatus === AuditStatus.UNREADABLE_OR_CORRUPT
          ? TemplateId.PDF_UNREADABLE_RESEND
          : exp.auditStatus === AuditStatus.DEFECTIVE_NO_AIRAM
            ? TemplateId.PDF_NO_AIRAM_REDO
            : TemplateId.PDF_REJECTED_RESEND;
      return decide(ctx, State.WAITING_PDF_SUBMISSION, message(template), { note: 'Operator rejected the document: ask the client for a new PDF', patch });
    }
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'Another PDF received while auditing: audit the new one', {});
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.OPERATOR_DOCUMENT_APPROVAL, 'Awaiting operator decision: no client reminder', { blocking: [BlockingCondition.HUMAN_APPROVAL_REQUIRED] });
    default:
      return undefined;
  }
};

function kmaleonNoticeAction(exp: Expediente, kind: 'CREATE_KMALEON_AVISO' | 'NOTIFY_DAYANA', isProvisional: boolean, kmaleonDocumentId: string): ActionSpec {
  const kmaleonExpedienteId = exp.kmaleonExpedienteId ?? '';
  return kind === 'CREATE_KMALEON_AVISO'
    ? { kind, kmaleonExpedienteId, kmaleonDocumentId, isProvisional, avisoTemplate: isProvisional ? 'AVISO_APODERAMIENTO_PROVISIONAL' : 'AVISO_APODERAMIENTO_FINAL' }
    : { kind, kmaleonExpedienteId, kmaleonDocumentId, isProvisional, noticeTemplate: isProvisional ? 'DAYANA_APODERAMIENTO_PROVISIONAL' : 'DAYANA_APODERAMIENTO_FINAL' };
}

const kmaleonFiling: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.KMALEON_UPLOAD_VERIFIED: {
      const p = ctx.payload as KmaleonUploadVerifiedPayload;
      if (!exp.documentApproved || !exp.documentId) {
        return escalate(ctx, EscalationReason.KMALEON_UPLOAD_UNAPPROVED, 'CRITICAL', 'Upload verified for a document that is not operator-approved', {
          blocking: [BlockingCondition.DOCUMENT_NOT_APPROVED],
        });
      }
      if (!exp.kmaleonExpedienteId || p.projectId !== exp.kmaleonExpedienteId || (exp.documentSha256 && p.sha256 !== exp.documentSha256)) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'CRITICAL', 'Verified upload does not match the expediente project or document hash', {
          blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
          extra: { uploadedProjectId: p.projectId, uploadedSha256Prefix: sha256Prefix(p.sha256) },
        });
      }
      const isProvisional = p.isProvisional;
      const patch: ExpedientePatch = {
        kmaleonDocumentId: p.documentId,
        isProvisionalFiled: isProvisional,
        documentType: isProvisional ? DocumentType.APODERAMIENTO_PROVISIONAL : DocumentType.APODERAMIENTO_FINAL,
      };
      // The Kmaleon notice addressed to Dayana (Reclamaciones) is the "aviso" of the source process.
      const action = kmaleonNoticeAction(exp, 'NOTIFY_DAYANA', isProvisional, p.documentId);
      return decide(ctx, isProvisional ? State.PROVISIONAL_VIABILIZED : State.HANDOFF_DAYANA, action, {
        note: isProvisional ? 'Provisional filing verified: notify Dayana (Reclamaciones) in Kmaleon' : 'Final filing verified: notify Dayana (Reclamaciones) in Kmaleon',
        patch,
        isViabilizable: isProvisional,
        requiresClientRevocation: isProvisional,
      });
    }
    case EventType.KMALEON_UPLOAD_FAILED:
      return escalate(ctx, EscalationReason.KMALEON_UPLOAD_FAILED, 'HIGH', `Kmaleon upload failed (${String(ctx.payload.errorCode)}): reconcile before any retry`);
    case EventType.CLIENT_PDF_RECEIVED:
      return escalate(ctx, EscalationReason.UNEXPECTED_EVENT_IN_STATE, 'HIGH', 'New PDF arrived while a verified upload is pending: document pointer changed');
    case EventType.OPERATOR_APPROVED_DOCUMENT:
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.NONE, 'Upload in progress: waiting for the verified read-back');
    default:
      return undefined;
  }
};

function verifiedNoticeGuard(ctx: Ctx, expectProvisional: boolean): TransitionResult | undefined {
  const exp = ctx.exp;
  const p = ctx.payload as KmaleonNoticeVerifiedPayload;
  const noticeSha = typeof p.documentSha256 === 'string' ? p.documentSha256 : undefined;
  if (
    !exp.kmaleonExpedienteId ||
    p.projectId !== exp.kmaleonExpedienteId ||
    !exp.kmaleonDocumentId ||
    !exp.documentApproved ||
    (noticeSha && exp.documentSha256 && noticeSha !== exp.documentSha256)
  ) {
    return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Verified notice does not match a verified filing on this expediente', {
      blocking: [BlockingCondition.DOCUMENT_REFERENCE_MISMATCH],
      extra: { noticeProjectId: p.projectId, annotationId: p.annotationId, noticeSha256Prefix: sha256Prefix(noticeSha) },
    });
  }
  if (exp.isProvisionalFiled !== expectProvisional) {
    return escalate(ctx, EscalationReason.INVALID_EXPEDIENTE_STATE, 'HIGH', 'Provisional flag inconsistent with the notice chain', {
      extra: { isProvisionalFiled: exp.isProvisionalFiled },
    });
  }
  return undefined;
}

const provisionalViabilized: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.KMALEON_AVISO_VERIFIED:
      return verifiedNoticeGuard(ctx, true) ?? decide(ctx, State.PROVISIONAL_VIABILIZED, kmaleonNoticeAction(exp, 'NOTIFY_DAYANA', true, exp.kmaleonDocumentId ?? ''), {
        note: 'Provisional notice verified: notify Dayana (Reclamaciones)',
        requiresClientRevocation: true,
      });
    case EventType.DAYANA_NOTIFIED:
      return verifiedNoticeGuard(ctx, true) ?? decide(
        ctx,
        State.REVOCATION_GUIDE_SENT,
        media(TemplateId.PROVISIONAL_FILED_REVOKE_AND_REISSUE, [MediaAssetId.REVOCATION_GUIDE_PDF, MediaAssetId.REVOCATION_SCREENSHOTS], { buttons: [ReplyButton.REVOKED, ReplyButton.HUMAN_HELP] }),
        { note: 'Dayana notified of the provisional filing: tell the client to revoke and re-issue', requiresClientRevocation: true },
      );
    case EventType.KMALEON_AVISO_FAILED:
      return escalate(ctx, EscalationReason.KMALEON_AVISO_FAILED, 'HIGH', `Kmaleon notice failed (${String(ctx.payload.errorCode)})`);
    case EventType.DAYANA_NOTIFICATION_FAILED:
      return escalate(ctx, EscalationReason.DAYANA_NOTIFICATION_FAILED, 'HIGH', `Dayana notification failed (${String(ctx.payload.errorCode)})`);
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'Re-issued PDF received early: audit it (final supersedes provisional)', {});
    case EventType.CLIENT_REVOCATION_DONE:
      return decide(ctx, State.WAITING_REVOCATION_REISSUE, message(TemplateId.REISSUE_INSTRUCTIONS), { note: 'Client revoked early: ask for the re-issued PDF', requiresClientRevocation: true });
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.NONE, 'Provisional notices in progress: no client reminder');
    default:
      return undefined;
  }
};

const revocationGuideSent: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_REVOCATION_DONE:
      return decide(ctx, State.WAITING_REVOCATION_REISSUE, message(TemplateId.REISSUE_INSTRUCTIONS), { note: 'Client reported the revocation: ask for the re-issued PDF', requiresClientRevocation: true });
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'Re-issued PDF received: audit it', {});
    case EventType.CLIENT_REVOCATION_HELP:
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
      return escalate(ctx, EscalationReason.CLIENT_NEEDS_HUMAN, 'LOW', 'Client needs help revoking: human walkthrough with screenshots', { clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE });
    case EventType.REMINDER_DUE:
      return reminder(ctx, media(TemplateId.REVOCATION_GUIDE, [MediaAssetId.REVOCATION_GUIDE_PDF], { buttons: [ReplyButton.REVOKED, ReplyButton.HUMAN_HELP] }));
    default:
      return undefined;
  }
};

const waitingRevocationReissue: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'Re-issued PDF received: audit it', {});
    case EventType.CLIENT_REVOCATION_DONE:
      return hold(ctx, AwaitingParty.CLIENT, 'Revocation already recorded: waiting for the re-issued PDF');
    case EventType.CLIENT_REVOCATION_HELP:
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
      return escalate(ctx, EscalationReason.CLIENT_NEEDS_HUMAN, 'LOW', 'Client needs help re-issuing the power', { clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE });
    case EventType.REMINDER_DUE:
      return reminder(ctx, message(TemplateId.REMINDER_PENDING_STEP, REMINDER_VARS(ctx.exp)));
    default:
      return undefined;
  }
};

const certAcquisitionLinksSent: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_CERT_ACQUIRED:
    case EventType.CLIENT_HAS_CERT:
      return toAskDevice(ctx, 'Client obtained a certificate: ask on which device it is installed');
    case EventType.CLIENT_HAS_CERT_PC:
      return toPcTutorial(ctx);
    case EventType.CLIENT_HAS_CERT_MOBILE:
      return toAskHasPc(ctx);
    case EventType.CLIENT_CANNOT_GET_CERT:
      return toCourtFallback(ctx, TemplateId.COURT_POWER_CHECKLIST, 'Client cannot obtain a certificate: send the personalised court checklist');
    case EventType.CLIENT_REQUESTS_URGENT_PAID:
      return toApudataPreapproval(ctx);
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'PDF received: audit it', {});
    case EventType.REMINDER_DUE:
      return reminder(ctx, buttons(acquisitionTemplate(ctx.exp), [ReplyButton.DEVICE_PC, ReplyButton.DEVICE_MOBILE, ReplyButton.NEEDS_ASSISTANCE]));
    default:
      return undefined;
  }
};

const courtFallbackGuideSent: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
      if(ctx.payload.resumeDigital===true)return ctx.exp.certDevice===CertDevice.PC?toPcTutorial(ctx):toAskDevice(ctx,'Client wants guidance to complete the digital power');
      return undefined;
    case EventType.CLIENT_HAS_NO_CERT:
      return toAcquisitionLinks(ctx);
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.ACTA_JUZGADO, 'Court power received: audit it', {});
    case EventType.CLIENT_REQUESTS_URGENT_PAID:
      return toApudataPreapproval(ctx);
    case EventType.CLIENT_CERT_ACQUIRED:
    case EventType.CLIENT_HAS_CERT:
      return toAskDevice(ctx, 'Client obtained a certificate after all: ask on which device it is installed');
    case EventType.CLIENT_HAS_CERT_PC:
      return toPcTutorial(ctx);
    case EventType.CLIENT_HAS_CERT_MOBILE:
      return toAskHasPc(ctx);
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.CLIENT, 'Court appointment pending: no automatic reminder (operator follows up)');
    default:
      return undefined;
  }
};

const apudataPendingPreapproval: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.APUDATA_PREAPPROVAL_CONFIRMED: {
      const p = ctx.payload as ApudataApprovalPayload;
      const expiresAt = new Date(p.approval.expiresAt);
      if (p.approval.clientId !== exp.id) {
        return escalate(ctx, EscalationReason.FINANCIAL_GATE_CLOSED, 'CRITICAL', 'Partner approval is bound to a different client id', {
          blocking: [BlockingCondition.FINANCIAL_GATE_CLOSED],
          extra: { approvalClientId: p.approval.clientId },
        });
      }
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= ctx.now.getTime()) {
        return escalate(ctx, EscalationReason.FINANCIAL_GATE_CLOSED, 'HIGH', 'Partner approval already expired on receipt', {
          blocking: [BlockingCondition.FINANCIAL_APPROVAL_EXPIRED],
        });
      }
      const gate: FinancialGateEvidence = { preApproved: true, approvalExpiresAt: expiresAt.toISOString(), evidenceRef: p.approval.evidenceRef };
      const action: ActionSpec = { kind: 'SEND_WHATSAPP_MESSAGE', template: TemplateId.APUDATA_PAYMENT_DETAILS, variables: { approvalExpiresAt: gate.approvalExpiresAt }, financialGate: gate };
      return decide(ctx, State.APUDATA_WAITING_PAYMENT, action, {
        note: 'Partner pre-approved the client: send payment instructions (adapter re-validates the gate)',
        patch: { apudataPreApproved: true, apudataApprovalExpiresAt: expiresAt, apudataApprovalEvidence: { ...p.approval } },
      });
    }
    case EventType.APUDATA_PREAPPROVAL_DENIED:
      return decide(ctx, State.COURT_FALLBACK_GUIDE_SENT, media(TemplateId.APUDATA_NOT_ELIGIBLE_COURT_FALLBACK, [MediaAssetId.COURT_POWER_CHECKLIST_GENERATED]), {
        note: 'Partner declined: offer the court checklist instead',
        patch: { apudataPreApproved: false, apudataApprovalExpiresAt: null, apudataApprovalEvidence: null },
      });
    case EventType.APUDATA_PREAPPROVAL_FAILED:
    case EventType.APUDATA_FAILED:
      // The client just chose the paid route and is waiting: always tell them a person continues.
      return escalate(ctx, EscalationReason.APUDATA_FAILED, 'MEDIUM', `Partner call failed (${String(ctx.payload.errorCode)})`, { clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE });
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.NONE, 'Partner eligibility check in progress: no client reminder', { blocking: [BlockingCondition.FINANCIAL_GATE_CLOSED] });
    default:
      return undefined;
  }
};

const apudataWaitingPayment: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.OPERATOR_PAYMENT_CONFIRMED: {
      const gate = financialGate(exp, ctx.now);
      if (!gate) {
        return escalate(ctx, EscalationReason.FINANCIAL_GATE_CLOSED, 'HIGH', 'Payment confirmed but the partner approval is missing or expired: human reconciliation', {
          blocking: [BlockingCondition.FINANCIAL_APPROVAL_EXPIRED],
        });
      }
      const action: ActionSpec = {
        kind: 'CALL_APUDATA_PREAPPROVAL',
        operation: ApudataOperation.CREATE_ORDER,
        dni: exp.dni,
        nombre: exp.nombre,
        telefono: exp.telefono,
        paymentEvidenceRef: String(ctx.payload.paymentEvidenceRef),
        financialGate: gate,
      };
      return decide(ctx, State.APUDATA_WAITING_PAYMENT, action, { note: 'Operator evidenced the payment: create the partner order (reconcile before write)' });
    }
    case EventType.APUDATA_ORDER_CREATED: {
      const orderId = String(ctx.payload.orderId);
      if (ctx.payload.status === 'failed') {
        return escalate(ctx, EscalationReason.APUDATA_FAILED, 'HIGH', 'Partner reported the order as failed after payment: human reconciliation', {
          patch: { apudataOrderId: orderId },
          extra: { orderId },
        });
      }
      return decide(ctx, State.APUDATA_VIDEO_IN_PROGRESS, message(TemplateId.APUDATA_VIDEO_INSTRUCTIONS, { orderId }), {
        note: 'Partner order registered: send the verified video-identification instructions',
        patch: { apudataOrderId: orderId },
      });
    }
    case EventType.APUDATA_PREAPPROVAL_CONFIRMED: {
      const p = ctx.payload as ApudataApprovalPayload;
      const expiresAt = new Date(p.approval.expiresAt);
      if (p.approval.clientId !== exp.id || Number.isNaN(expiresAt.getTime())) {
        return escalate(ctx, EscalationReason.FINANCIAL_GATE_CLOSED, 'HIGH', 'Refreshed partner approval is not bound to this client');
      }
      return hold(ctx, AwaitingParty.CLIENT, 'Partner approval refreshed while waiting for payment', {
        patch: { apudataPreApproved: true, apudataApprovalExpiresAt: expiresAt, apudataApprovalEvidence: { ...p.approval } },
      });
    }
    case EventType.APUDATA_PREAPPROVAL_DENIED:
      return escalate(ctx, EscalationReason.FINANCIAL_GATE_CLOSED, 'HIGH', 'Partner withdrew the approval while waiting for payment', {
        patch: { apudataPreApproved: false, apudataApprovalExpiresAt: null, apudataApprovalEvidence: null },
      });
    case EventType.APUDATA_FAILED:
    case EventType.APUDATA_PREAPPROVAL_FAILED:
      return escalate(ctx, EscalationReason.APUDATA_FAILED, 'MEDIUM', `Partner call failed (${String(ctx.payload.errorCode)})`);
    case EventType.REMINDER_DUE: {
      const gate = financialGate(exp, ctx.now);
      if (!gate) {
        return hold(ctx, AwaitingParty.OPERATOR_RESUME, 'Approval expired: payment instructions must not be re-sent', {
          blocking: [BlockingCondition.FINANCIAL_APPROVAL_EXPIRED],
        });
      }
      return reminder(ctx, { kind: 'SEND_WHATSAPP_MESSAGE', template: TemplateId.APUDATA_PAYMENT_DETAILS, variables: { approvalExpiresAt: gate.approvalExpiresAt }, financialGate: gate });
    }
    default:
      return undefined;
  }
};

const apudataVideoInProgress: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.APUDATA_DOCUMENT_RECEIVED: {
      if (ctx.exp.apudataOrderId && ctx.payload.orderId !== ctx.exp.apudataOrderId) {
        return escalate(ctx, EscalationReason.DOCUMENT_REFERENCE_MISMATCH, 'HIGH', 'Partner document belongs to a different order', {
          extra: { receivedOrderId: String(ctx.payload.orderId) },
        });
      }
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.APODERAMIENTO_APUDATA, 'Partner delivered the power: audit it', {});
    }
    case EventType.CLIENT_PDF_RECEIVED:
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.APODERAMIENTO_APUDATA, 'Client forwarded the partner power: audit it', {});
    case EventType.APUDATA_FAILED:
      return escalate(ctx, EscalationReason.APUDATA_FAILED, 'MEDIUM', `Partner reported a failure (${String(ctx.payload.errorCode)})`);
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.CLIENT, 'Video identification handled by the partner: no bot reminder');
    default:
      return undefined;
  }
};

const handoffDayana: Handler = (ctx) => {
  const exp = ctx.exp;
  switch (ctx.type) {
    case EventType.KMALEON_AVISO_VERIFIED:
      return verifiedNoticeGuard(ctx, false) ?? decide(ctx, State.HANDOFF_DAYANA, kmaleonNoticeAction(exp, 'NOTIFY_DAYANA', false, exp.kmaleonDocumentId ?? ''), {
        note: 'Final notice verified: notify Dayana (Reclamaciones)',
        isViabilizable: false,
        requiresClientRevocation: false,
      });
    case EventType.DAYANA_NOTIFIED:
      return verifiedNoticeGuard(ctx, false) ?? decide(ctx, State.HANDOFF_DAYANA, message(TemplateId.COMPLETION_NOTICE), {
        note: 'Dayana notified of the final filing: send the completion notice to the client',
        isViabilizable: false,
        requiresClientRevocation: false,
      });
    case EventType.CLIENT_NOTIFICATION_DELIVERED: {
      const p = ctx.payload as ClientNotificationDeliveredPayload;
      const finalChain =
        !!exp.kmaleonExpedienteId &&
        !!exp.kmaleonDocumentId &&
        exp.documentApproved &&
        !exp.isProvisionalFiled &&
        (exp.documentType === undefined || exp.documentType === null || exp.documentType === DocumentType.APODERAMIENTO_FINAL) &&
        (exp.auditStatus === null || exp.auditStatus === AuditStatus.VALID_FULL_5_PAGES) &&
        (p.template === undefined || p.template === TemplateId.COMPLETION_NOTICE);
      if (!finalChain) {
        return escalate(ctx, EscalationReason.INVALID_EXPEDIENTE_STATE, 'HIGH', 'Delivery receipt without a verified final chain (filing + approval + final document)', {
          blocking: [BlockingCondition.DOCUMENT_NOT_APPROVED],
          extra: { messageId: p.messageId, template: p.template ?? null, isProvisionalFiled: exp.isProvisionalFiled },
        });
      }
      return hold(ctx, AwaitingParty.NONE, 'Completion notice delivered after verified filing and Dayana notice: case completed', {
        nextStep: State.COMPLETED,
        isViabilizable: false,
        requiresClientRevocation: false,
        discard: true,
        evidence: `NONE further: verified Kmaleon document ${exp.kmaleonDocumentId}, Dayana annotation and WhatsApp message ${p.messageId} delivered.`,
      });
    }
    case EventType.KMALEON_AVISO_FAILED:
      return escalate(ctx, EscalationReason.KMALEON_AVISO_FAILED, 'HIGH', `Kmaleon notice failed (${String(ctx.payload.errorCode)})`);
    case EventType.DAYANA_NOTIFICATION_FAILED:
      return escalate(ctx, EscalationReason.DAYANA_NOTIFICATION_FAILED, 'HIGH', `Dayana notification failed (${String(ctx.payload.errorCode)})`);
    case EventType.CLIENT_NOTIFICATION_FAILED:
      return escalate(ctx, EscalationReason.CLIENT_NOTIFICATION_FAILED, 'MEDIUM', `Client completion notice failed (${String(ctx.payload.errorCode)})`);
    case EventType.CLIENT_PDF_RECEIVED:
      return escalate(ctx, EscalationReason.UNEXPECTED_EVENT_IN_STATE, 'HIGH', 'New PDF arrived during hand-off: document pointer changed after a verified filing');
    case EventType.REMINDER_DUE:
      return hold(ctx, AwaitingParty.NONE, 'Hand-off notices in progress: no client reminder');
    default:
      return undefined;
  }
};

const completed: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.CLIENT_PDF_RECEIVED:
      return escalate(ctx, EscalationReason.UNEXPECTED_DOCUMENT_AFTER_COMPLETION, 'MEDIUM', 'A document arrived after completion: human decides whether to reopen');
    case EventType.OPERATOR_ESCALATE:
      return undefined; // global handler reopens through escalation
    default:
      return hold(ctx, AwaitingParty.NONE, 'Case completed: no further automatic processing', { blocking: [BlockingCondition.TERMINAL_STATE] });
  }
};

const escalatedHuman: Handler = (ctx) => {
  switch (ctx.type) {
    case EventType.OPERATOR_RESUME: {
      const target = ctx.payload.targetState;
      if (!isState(target) || FORBIDDEN_RESUME_TARGETS.has(target)) {
        return hold(ctx, AwaitingParty.OPERATOR_RESUME, `Resume target ${String(target)} is forbidden (verified-effect or terminal state)`, {
          blocking: [BlockingCondition.OPERATOR_RESUME_REQUIRED],
        });
      }
      if (target === State.AUDITING_DOCUMENT && !ctx.exp.documentId) {
        return hold(ctx, AwaitingParty.OPERATOR_RESUME, 'Cannot resume into AUDITING_DOCUMENT without a stored document', {
          blocking: [BlockingCondition.OPERATOR_RESUME_REQUIRED],
        });
      }
      const awaiting = SYSTEM_DRIVEN_STATES.has(target) ? AwaitingParty.NONE : AwaitingParty.CLIENT;
      return hold(ctx, awaiting, `Operator resumed the case into ${target}; no automatic outbound message`, {
        nextStep: target,
        patch: target === State.INITIAL_TRIAGE ? { documentApproved: false, clientReviewed: false } : {},
      });
    }
    case EventType.OPERATOR_ESCALATE:
      return hold(ctx, AwaitingParty.OPERATOR_RESUME, 'Already escalated', { blocking: [BlockingCondition.OPERATOR_RESUME_REQUIRED] });
    default:
      return hold(ctx, AwaitingParty.OPERATOR_RESUME, `Event ${ctx.type} recorded while escalated; operator must resume explicitly`, {
        blocking: [BlockingCondition.OPERATOR_RESUME_REQUIRED],
      });
  }
};

const STATE_HANDLERS: Readonly<Record<State, Handler>> = Object.freeze({
  [State.INITIAL_TRIAGE]: initialTriage,
  [State.WAITING_CERT_RESPONSE]: waitingCertResponse,
  [State.MOBILE_TRIAGE_PC_CHECK]: mobileTriagePcCheck,
  [State.MOBILE_EXPORT_GUIDE_SENT]: mobileExportGuideSent,
  [State.MOBILE_ASSIST_CONSENT_REQUESTED]: mobileAssistConsentRequested,
  [State.MOBILE_ASSIST_PROCESSING]: mobileAssistProcessing,
  [State.PC_TUTORIAL_SENT]: pcTutorialSent,
  [State.WAITING_PDF_SUBMISSION]: waitingPdfSubmission,
  [State.AUDITING_DOCUMENT]: auditingDocument,
  [State.PROVISIONAL_VIABILIZED]: provisionalViabilized,
  [State.REVOCATION_GUIDE_SENT]: revocationGuideSent,
  [State.WAITING_REVOCATION_REISSUE]: waitingRevocationReissue,
  [State.CERT_ACQUISITION_LINKS_SENT]: certAcquisitionLinksSent,
  [State.FALLBACK_OPTIONS]: ctx => ctx.type===EventType.CLIENT_CANNOT_GET_CERT ? toCourtFallback(ctx, TemplateId.COURT_POWER_CHECKLIST, 'Client selected the court route') : ctx.type===EventType.CLIENT_REQUESTS_URGENT_PAID ? toApudataPreapproval(ctx) : ctx.type===EventType.CLIENT_HAS_NO_CERT ? toAcquisitionLinks(ctx) : ctx.type===EventType.CLIENT_HAS_CERT||ctx.type===EventType.CLIENT_REQUESTS_ASSISTANCE&&ctx.payload.resumeDigital===true ? toAskDevice(ctx, 'Client wants to continue digitally') : undefined,
  [State.COURT_FALLBACK_GUIDE_SENT]: courtFallbackGuideSent,
  [State.APUDATA_PENDING_PREAPPROVAL]: apudataPendingPreapproval,
  [State.APUDATA_WAITING_PAYMENT]: apudataWaitingPayment,
  [State.APUDATA_VIDEO_IN_PROGRESS]: apudataVideoInProgress,
  [State.KMALEON_FILING]: kmaleonFiling,
  [State.HANDOFF_DAYANA]: handoffDayana,
  [State.COMPLETED]: completed,
  [State.ESCALATED_HUMAN]: escalatedHuman,
});

// ---------------------------------------------------------------------------------------------
// Global fallback (events every state must answer)
// ---------------------------------------------------------------------------------------------

function globalHandler(ctx: Ctx): TransitionResult {
  const state = ctx.exp.currentState;
  switch (ctx.type) {
    case EventType.OPERATOR_ESCALATE: {
      const severity = (ctx.payload.severity as Severity | undefined) ?? 'MEDIUM';
      return escalate(ctx, EscalationReason.OPERATOR_REQUESTED, severity, 'Operator requested a human hold', {
        extra: { operatorId: operatorIdOf(ctx.payload) ?? null },
      });
    }
    case EventType.OPERATOR_RESUME:
      return hold(ctx, AwaitingParty.NONE, 'Resume received while not escalated: ignored', { blocking: [BlockingCondition.UNEXPECTED_EVENT] });
    case EventType.CLIENT_OPT_OUT:
      return escalate(ctx, EscalationReason.CLIENT_OPT_OUT, 'MEDIUM', 'Client opted out: stop automated contact, human decides', {
        blocking: [BlockingCondition.CLIENT_OPT_OUT],
      });
    case EventType.CLIENT_PDF_RECEIVED:
      if (FILING_STATES.has(state)) {
        return escalate(ctx, EscalationReason.UNEXPECTED_EVENT_IN_STATE, 'HIGH', 'PDF arrived while a verified effect is pending');
      }
      return toAudit(ctx, String(ctx.payload.documentId), String(ctx.payload.sha256), DocumentType.PENDING_REVIEW, 'PDF received ahead of the expected step: audit it', {});
    case EventType.CLIENT_REQUESTS_ASSISTANCE:
    case EventType.CLIENT_REVOCATION_HELP:
    case EventType.CLIENT_REQUESTS_HUMAN:
      return escalate(ctx, EscalationReason.CLIENT_NEEDS_HUMAN, 'LOW', 'Client asked for a human', { clientNotice: TemplateId.HUMAN_HANDOFF_NOTICE });
    case EventType.CLIENT_UNCLEAR_RESPONSE:
      return hold(ctx, SYSTEM_DRIVEN_STATES.has(state) ? AwaitingParty.NONE : AwaitingParty.CLIENT, 'Free text cannot be read by the bot: operator reads it through the authorized channel', {
        blocking: [],
      });
    case EventType.CLIENT_SMALL_TALK: {
      // The client acknowledged an answer they already had. Saying nothing is the correct reply:
      // a second "aquí estoy cuando me necesites" is what made the bot feel like it was nagging.
      if (ctx.payload.silent === true) return hold(ctx, AwaitingParty.CLIENT, 'Client acknowledged: leave them to it until they write again');
      const responseId = typeof ctx.payload.responseId === 'string' ? ctx.payload.responseId : '';
      const template = ROLLOUT_REPLY_TEMPLATES[responseId];
      if (!template) return hold(ctx, AwaitingParty.CLIENT, 'Conversation rollout response is not approved');
      const variables = responseId === 'CONVERSATION_REPLY' && typeof ctx.payload.responseText === 'string'
        ? { replyText: ctx.payload.responseText }
        : undefined;
      if(ctx.payload.requiresHumanReview===true)return escalate(ctx,EscalationReason.CLIENT_NEEDS_HUMAN,'LOW','Conversation handed to the team; stop automatic replies',{clientNotice:TemplateId.CONVERSATION_REPLY});
      return decide(ctx,state,message(template,variables),{note:`Conversation rollout ${responseId}: acknowledge without workflow transition`});
    }
    case EventType.CLIENT_ACKNOWLEDGED:
      return hold(ctx, SYSTEM_DRIVEN_STATES.has(state) ? AwaitingParty.NONE : AwaitingParty.CLIENT, 'Outbound delivery acknowledged: no transition');
    case EventType.REMINDER_DUE:
      return hold(ctx, SYSTEM_DRIVEN_STATES.has(state) ? AwaitingParty.NONE : AwaitingParty.CLIENT, 'No reminder defined for this state');
    case EventType.CASE_OPENED:
      return hold(ctx, AwaitingParty.NONE, 'Case already opened: duplicate CASE_OPENED ignored', { blocking: [BlockingCondition.UNEXPECTED_EVENT] });
    default: {
      const origin = EVENT_ORIGIN[ctx.type];
      if (origin === EventOrigin.CLIENT) {
        return hold(ctx, SYSTEM_DRIVEN_STATES.has(state) ? AwaitingParty.NONE : AwaitingParty.CLIENT, `Client event ${ctx.type} is not expected in ${state}: recorded, no transition`, {
          blocking: [BlockingCondition.UNEXPECTED_EVENT],
        });
      }
      return escalate(ctx, EscalationReason.UNEXPECTED_EVENT_IN_STATE, 'MEDIUM', `${origin} event ${ctx.type} is not expected in ${state}`, {
        blocking: [BlockingCondition.UNEXPECTED_EVENT],
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Computes the transition for one event. Pure and deterministic for a fixed `now`.
 * Precondition: `expediente.currentState` is a valid `State` (the engine checks this).
 */
export function transition(input: TransitionInput): TransitionResult {
  const { expediente, event, now } = input;
  const rawType: unknown = event.type;
  const rawPayload = event.payload ?? {};

  if (!isEventType(rawType)) {
    const ctx: Ctx = { exp: expediente, type: EventType.OPERATOR_ESCALATE, payload: {}, now };
    const result = escalate(ctx, EscalationReason.UNEXPECTED_EVENT_IN_STATE, 'HIGH', `Unknown event type ${String(rawType)}`, {
      blocking: [BlockingCondition.UNEXPECTED_EVENT],
      extra: { unknownEventType: String(rawType) },
    });
    return { ...result, summary: `${expediente.currentState} + ${String(rawType)} -> ${State.ESCALATED_HUMAN} [ESCALATE_HUMAN]: unknown event type` };
  }

  const type: EventType = rawType;
  const origin = EVENT_ORIGIN[type];

  if (origin === EventOrigin.OPERATOR && !operatorIdOf(rawPayload as Record<string, unknown>)) {
    const ctx: Ctx = { exp: expediente, type, payload: {}, now };
    return hold(ctx, AwaitingParty.NONE, 'Operator event without operatorId rejected', {
      blocking: [BlockingCondition.OPERATOR_IDENTITY_MISSING],
    });
  }

  const check = validateEventPayload(type, rawPayload);
  if (!check.ok) {
    const ctx: Ctx = { exp: expediente, type, payload: {}, now };
    if (origin === EventOrigin.OPERATOR) {
      return hold(ctx, AwaitingParty.NONE, `Operator payload invalid: ${check.reason}`, { blocking: [BlockingCondition.INVALID_EVENT_PAYLOAD] });
    }
    return escalate(ctx, EscalationReason.INVALID_EVENT_PAYLOAD, 'HIGH', `Payload invalid for ${type}: ${check.reason}`, {
      blocking: [BlockingCondition.INVALID_EVENT_PAYLOAD],
      extra: { payloadIssue: check.reason, secretKey: check.secretKey ?? null },
    });
  }

  const ctx: Ctx = { exp: expediente, type, payload: check.value, now };
  const guidedStates = [State.INITIAL_TRIAGE,State.WAITING_CERT_RESPONSE,State.CERT_ACQUISITION_LINKS_SENT,State.PC_TUTORIAL_SENT,State.WAITING_PDF_SUBMISSION,State.MOBILE_TRIAGE_PC_CHECK,State.MOBILE_EXPORT_GUIDE_SENT];
  if ([EventType.CLIENT_EXPORT_FAILED,EventType.CLIENT_REQUESTS_ASSISTANCE,EventType.CLIENT_HAS_NO_PC].includes(type) && guidedStates.includes(expediente.currentState)) return guidedHelp(ctx);
  const handler = STATE_HANDLERS[expediente.currentState];
  return handler(ctx) ?? globalHandler(ctx);
}

/** True when the action produces an external side effect (message, CRM write, partner call). */
export function isOutboundAction(action: ActionSpec | ActionPayload): boolean {
  return action.kind !== 'NO_OP' && action.kind !== 'ESCALATE_HUMAN';
}
