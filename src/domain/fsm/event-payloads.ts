/**
 * Event payload guards (binding for the orchestrator, see docs/agents/claude-interfaces.md).
 *
 * The state machine only trusts what these schemas admit. Unknown extra keys are tolerated
 * (adapter receipts carry more fields) EXCEPT secret-like keys, which fail every event.
 * Operator events must carry `operatorId` (alias `reviewer` accepted for panel compatibility).
 *
 * Nothing here performs I/O.
 */

import { z } from 'zod';
import { EventType, State, isEventType } from './states.js';
import { AuditStatus } from '../models/expediente.js';
import { SHA256_HEX_REGEX } from '../models/documento.js';

const hex64 = z.string().regex(SHA256_HEX_REGEX, 'expected lower-case hex sha256');
const nonEmpty = z.string().trim().min(1).max(500);
const isoDate = z.string().datetime({ offset: true });
const errorCode = z.string().trim().min(1).max(200);

/** Keys that must never travel inside an event payload. */
export const SECRET_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passphrase',
  'pfx',
  'p12',
  'pin',
  'secret',
  'accessToken',
  'clientSecret',
  'extractedText',
]);

const operatorIdentity = z
  .object({ operatorId: nonEmpty.optional(), reviewer: nonEmpty.optional() })
  .passthrough()
  .transform((v) => ({ ...v, operatorId: v.operatorId ?? v.reviewer }))
  .refine((v) => typeof v.operatorId === 'string' && v.operatorId.length > 0, { message: 'operatorId required' });

const empty = z.object({}).passthrough();

const documentRef = z.object({ documentId: nonEmpty, sha256: hex64 }).passthrough();
const optionalDocumentRef = z.object({ documentId: nonEmpty.optional(), sha256: hex64.optional() }).passthrough();

export const AuditCompletedPayloadSchema = z
  .object({
    documentId: nonEmpty,
    sha256: hex64,
    status: z.nativeEnum(AuditStatus),
    isValid: z.boolean(),
    pageCount: z.number().int().min(0),
    hasAiram: z.boolean(),
    missingPowers: z.array(z.string().min(1)),
    canViabilize: z.boolean(),
    identityMatches: z.boolean(),
    requiresHumanReview: z.boolean(),
  })
  .passthrough();

export const KmaleonUploadVerifiedPayloadSchema = z
  .object({
    verified: z.literal(true),
    projectId: nonEmpty,
    annotationId: nonEmpty,
    /** Kmaleon document identifier returned by the verified read-back (NOT the local documentId). */
    documentId: nonEmpty,
    sha256: hex64,
    isProvisional: z.boolean(),
    idempotencyKey: nonEmpty.optional(),
  })
  .passthrough();

export const KmaleonNoticeVerifiedPayloadSchema = z
  .object({
    verified: z.literal(true),
    projectId: nonEmpty,
    annotationId: nonEmpty,
    recipientCode: z.number().int().positive().optional(),
    idempotencyKey: nonEmpty.optional(),
    /** Local document hash the notice refers to (executor receipt); checked against the snapshot. */
    documentSha256: hex64.optional(),
  })
  .passthrough();

export const ApudataApprovalPayloadSchema = z
  .object({
    approval: z
      .object({
        id: nonEmpty,
        clientId: nonEmpty,
        preApproved: z.literal(true),
        expiresAt: isoDate,
        evidenceRef: nonEmpty,
      })
      .passthrough(),
  })
  .passthrough();

export const CertInspectionPayloadSchema = z
  .object({
    certRef: nonEmpty,
    usable: z.boolean(),
    passwordValid: z.boolean(),
    keyMatchesCertificate: z.boolean(),
    identityMatches: z.boolean(),
    expired: z.boolean(),
    reasons: z.array(z.string().min(1)).optional(),
    fingerprintSha256: hex64.optional(),
  })
  .passthrough();

export const ClientNotificationDeliveredPayloadSchema = z
  .object({
    verified: z.literal(true),
    messageId: nonEmpty,
    template: z.string().min(1).optional(),
    deliveryStatus: z.enum(['delivered', 'read']).optional(),
  })
  .passthrough();

const failure = z.object({ errorCode, outcome: z.enum(['failed', 'uncertain']).optional() }).passthrough();

/** Payload schema per event type. */
export const EVENT_PAYLOAD_SCHEMAS: Readonly<Record<EventType, z.ZodTypeAny>> = Object.freeze({
  [EventType.CASE_OPENED]: empty,
  [EventType.REMINDER_DUE]: z.object({ reminderNumber: z.number().int().min(1).optional() }).passthrough(),
  [EventType.CLIENT_HAS_CERT]: empty,
  [EventType.CLIENT_HAS_CERT_MOBILE]: empty,
  [EventType.CLIENT_HAS_CERT_PC]: empty,
  [EventType.CLIENT_HAS_NO_CERT]: empty,
  [EventType.CLIENT_HAS_PC]: empty,
  [EventType.CLIENT_HAS_NO_PC]: empty,
  [EventType.CLIENT_EXPORT_SUCCEEDED]: empty,
  [EventType.CLIENT_EXPORT_FAILED]: empty,
  [EventType.CLIENT_CONSENT_GRANTED]: z.object({ consentVersion: nonEmpty.optional() }).passthrough(),
  [EventType.CLIENT_CONSENT_DENIED]: empty,
  [EventType.CLIENT_CERT_FILE_RECEIVED]: z.object({ certRef: nonEmpty }).passthrough(),
  [EventType.CLIENT_DRAFT_APPROVED]: optionalDocumentRef,
  [EventType.CLIENT_DRAFT_REJECTED]: optionalDocumentRef,
  [EventType.CLIENT_PDF_RECEIVED]: documentRef,
  [EventType.CLIENT_ACKNOWLEDGED]: empty,
  [EventType.CLIENT_REQUESTS_ASSISTANCE]: empty,
  [EventType.CLIENT_REQUESTS_HUMAN]: empty,
  [EventType.CLIENT_CERT_ACQUIRED]: empty,
  [EventType.CLIENT_CANNOT_GET_CERT]: empty,
  [EventType.CLIENT_REQUESTS_URGENT_PAID]: empty,
  [EventType.CLIENT_REVOCATION_DONE]: empty,
  [EventType.CLIENT_REVOCATION_HELP]: empty,
  [EventType.CLIENT_UNCLEAR_RESPONSE]: empty,
  [EventType.CLIENT_SMALL_TALK]: z.object({
    responseId: z.enum(['PHASE1_GREETING', 'PHASE1_HELP', 'PHASE2_ACK', 'PHASE2_DEFER', 'PHASE3_GREETING', 'PHASE3_WORKFLOW', 'CONVERSATION_REPLY', 'SECURITY_ANSWER']),
    rolloutPhase: z.number().int().min(1).max(3),
    rolloutKind: z.enum(['GREETING', 'PERSONAL_INFO', 'SECURITY_QUESTION', 'HELP_REQUEST', 'WORKFLOW_REQUEST', 'UNSUPPORTED']),
    responseText: z.string().trim().min(1).max(1600).optional(),
    requiresHumanReview: z.boolean().optional(),
    silent: z.boolean().optional(),
  }).passthrough().superRefine((value, ctx) => {
    if (value.responseId === 'CONVERSATION_REPLY' && !value.responseText && value.silent !== true) {
      ctx.addIssue({ code: 'custom', path: ['responseText'], message: 'responseText required for CONVERSATION_REPLY' });
    }
  }),
  [EventType.CLIENT_OPT_OUT]: empty,
  [EventType.CERT_INSPECTION_COMPLETED]: CertInspectionPayloadSchema,
  [EventType.GEO_UNRESOLVED]: z.object({ reasons: z.array(z.string()).optional() }).passthrough(),
  [EventType.SEDE_DRAFT_READY]: documentRef.and(z.object({ recipeId: nonEmpty.optional() }).passthrough()),
  [EventType.SEDE_AUTOMATION_FAILED]: failure,
  [EventType.PDF_AUDIT_COMPLETED]: AuditCompletedPayloadSchema,
  [EventType.PDF_AUDIT_FAILED]: z.object({ documentId: nonEmpty, sha256: hex64.optional(), errorCode }).passthrough(),
  [EventType.KMALEON_UPLOAD_VERIFIED]: KmaleonUploadVerifiedPayloadSchema,
  [EventType.KMALEON_UPLOAD_FAILED]: failure,
  [EventType.KMALEON_AVISO_VERIFIED]: KmaleonNoticeVerifiedPayloadSchema,
  [EventType.KMALEON_AVISO_FAILED]: failure,
  [EventType.DAYANA_NOTIFIED]: KmaleonNoticeVerifiedPayloadSchema,
  [EventType.DAYANA_NOTIFICATION_FAILED]: failure,
  [EventType.CLIENT_NOTIFICATION_DELIVERED]: ClientNotificationDeliveredPayloadSchema,
  [EventType.CLIENT_NOTIFICATION_FAILED]: z.object({ messageId: nonEmpty.optional(), errorCode }).passthrough(),
  [EventType.APUDATA_PREAPPROVAL_CONFIRMED]: ApudataApprovalPayloadSchema,
  [EventType.APUDATA_PREAPPROVAL_DENIED]: z.object({ reason: z.string().max(500).optional(), evidenceRef: nonEmpty.optional() }).passthrough(),
  [EventType.APUDATA_PREAPPROVAL_FAILED]: failure,
  [EventType.APUDATA_ORDER_CREATED]: z
    .object({ orderId: nonEmpty, status: z.enum(['created', 'video_pending', 'document_ready', 'failed']), approvalId: nonEmpty.optional() })
    .passthrough(),
  [EventType.APUDATA_DOCUMENT_RECEIVED]: documentRef.and(z.object({ orderId: nonEmpty }).passthrough()),
  [EventType.APUDATA_FAILED]: failure,
  [EventType.OPERATOR_APPROVED_DOCUMENT]: operatorIdentity.and(
    z
      .object({
        documentId: nonEmpty,
        sha256: hex64,
        evidenceRef: nonEmpty,
        clientReviewed: z.boolean().optional(),
        clientEvidenceRef: nonEmpty.optional(),
      })
      .passthrough(),
  ),
  [EventType.OPERATOR_REJECTED_DOCUMENT]: operatorIdentity.and(
    z
      .object({
        documentId: nonEmpty,
        reason: z.string().max(500).optional(),
        disposition: z.enum(['RESEND', 'REVOKE_AND_REISSUE']).optional(),
      })
      .passthrough(),
  ),
  [EventType.OPERATOR_SUBMISSION_CONFIRMED]: operatorIdentity.and(
    z
      .object({
        evidenceRef: nonEmpty,
        /** Reviewed draft the submission was based on (must match the snapshot document). */
        reviewedDraftId: nonEmpty.optional(),
        reviewedDraftSha256: hex64.optional(),
        /** Optional justificante already stored; otherwise the operator uploads it afterwards. */
        documentId: nonEmpty.optional(),
        sha256: hex64.optional(),
      })
      .passthrough(),
  ),
  [EventType.OPERATOR_PAYMENT_CONFIRMED]: operatorIdentity.and(z.object({ paymentEvidenceRef: nonEmpty }).passthrough()),
  [EventType.OPERATOR_ESCALATE]: operatorIdentity.and(
    z.object({ reason: z.string().max(500).optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional() }).passthrough(),
  ),
  [EventType.OPERATOR_RESUME]: operatorIdentity.and(
    z.object({ targetState: z.nativeEnum(State), reason: z.string().max(500).optional() }).passthrough(),
  ),
});

export type AuditCompletedPayload = z.infer<typeof AuditCompletedPayloadSchema>;
export type KmaleonUploadVerifiedPayload = z.infer<typeof KmaleonUploadVerifiedPayloadSchema>;
export type KmaleonNoticeVerifiedPayload = z.infer<typeof KmaleonNoticeVerifiedPayloadSchema>;
export type ApudataApprovalPayload = z.infer<typeof ApudataApprovalPayloadSchema>;
export type CertInspectionPayload = z.infer<typeof CertInspectionPayloadSchema>;
export type ClientNotificationDeliveredPayload = z.infer<typeof ClientNotificationDeliveredPayloadSchema>;

export type PayloadCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string; secretKey?: string };

function findSecretKey(value: unknown, depth: number): string | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) {
    if (!Array.isArray(value) && SECRET_PAYLOAD_KEYS.has(key)) return key;
    const nested = findSecretKey(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Validates an event payload for `type`. Never throws. Unknown event types fail.
 * Secret-like keys fail regardless of the event type (fail-closed).
 */
export function validateEventPayload(type: unknown, payload: unknown): PayloadCheck {
  if (!isEventType(type)) return { ok: false, reason: 'UNKNOWN_EVENT_TYPE' };
  const raw = payload === undefined || payload === null ? {} : payload;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'PAYLOAD_NOT_AN_OBJECT' };
  const secretKey = findSecretKey(raw, 0);
  if (secretKey) return { ok: false, reason: 'SECRET_KEY_IN_PAYLOAD', secretKey };
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: first ? `${first.path.join('.') || '$'}: ${first.message}` : 'INVALID_PAYLOAD' };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

/** Operator identity extracted from a validated operator payload. */
export function operatorIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.operatorId ?? payload.reviewer;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined;
}
