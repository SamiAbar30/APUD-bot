import { z } from 'zod';
export const KmaleonIdentitySchema=z.object({projectId:z.string().min(1),dni:z.string().min(1)});
export const KmaleonExpedienteCandidateSchema=z.object({
  projectId:z.string().min(1).max(160),
  /** Human-facing expediente number from Kmaleon's project record. */
  numeroExpediente:z.string().trim().min(1).max(160),
  /** Company/lender linked to the selected Kmaleon expediente. */
  empresa:z.string().trim().min(1).max(160),
  dni:z.string().regex(/^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/),
  nombre:z.string().trim().min(1).max(160),
  telefono:z.string().regex(/^[1-9]\d{7,14}$/),
}).strict();
export type KmaleonExpedienteCandidate=z.infer<typeof KmaleonExpedienteCandidateSchema>;
export const KmaleonAnnotationSchema=z.object({
  id:z.string().min(1),projectId:z.string().min(1),text:z.string(),recipientCode:z.number().int().positive(),
  documentId:z.string().min(1).optional(),pending:z.boolean(),
  typeCode:z.string().optional(),classCode:z.string().optional(),classDescription:z.string().optional(),comment:z.string().optional(),internal:z.boolean().optional(),priority:z.boolean().optional(),
});
export type KmaleonAnnotation=z.infer<typeof KmaleonAnnotationSchema>;
export interface KmaleonPendingApudActa {
  externalId:string;projectId:string;macroCode:27;pending:true;open:true;evidenceRef:string;
  candidate?:KmaleonExpedienteCandidate;
}
export interface KmaleonPendingApudActaPage {items:KmaleonPendingApudActa[];page:number;hasMore:boolean}
/** Fresh catalogue evidence. Descriptions are compared whole, never by substring. */
export interface KmaleonMacro {code:10|27;id:string;description:string;classCode:string;classDescription:string;evidenceRef:string}
const addressText=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
export const KmaleonProjectAddressSchema=z.object({
  projectId:addressText(160),dni:addressText(30),direccion:addressText(250),
  // Preserve leading zeroes; missing digits are never fabricated from numeric postal data.
  codigoPostal:z.string().trim().regex(/^\d{5}$/),provincia:addressText(100),localidad:addressText(100),
  comunidadAutonoma:addressText(100).optional(),
}).strict();
export type KmaleonProjectAddress=z.infer<typeof KmaleonProjectAddressSchema>;
export interface KmaleonVerifiedAddress extends KmaleonProjectAddress {evidenceRef:string}

export interface KmaleonResponseMapping {
  /** Reference to the human review of actual vendor responses. */
  reviewEvidenceRef:string;
  projectIdentity(raw:unknown):{projectId:string;dni:string};
  /** Reviewed mapping for the operator's read-only expediente search. */
  projectSearchFilter(field:'dni'|'nombre',query:string):unknown;
  projectSearchPage(raw:unknown,pageNum:number):{items:KmaleonExpedienteCandidate[];hasMore:boolean};
  /** Read a selected project again before linking it to the local APOD case. */
  projectCandidate(raw:unknown):KmaleonExpedienteCandidate;
  /** Actual address owner identity and address fields from the same projects/getProject response. */
  projectAddress?(raw:unknown):KmaleonProjectAddress;
  annotationsPage(raw:unknown,pageNum:number):{items:KmaleonAnnotation[];hasMore:boolean};
  /** Decode only the actual document bytes; never a guessed response shape or untrusted URL. */
  documentBytes(raw:unknown):Buffer;
}
export interface DocumentProof {verified:true;projectId:string;annotationId:string;documentId:string;sha256:string;idempotencyKey:string;macroCode?:10;macroEvidenceRef?:string}
export interface NoticeProof {verified:true;projectId:string;annotationId:string;recipientCode:number;idempotencyKey:string}
