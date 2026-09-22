import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidSpanishIdentityDocument, normalizeIdentityDocument } from '../domain/identity/spanish-identity-document.js';

export const v2Hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().trim().min(5).max(300);
const identity = z.string().transform(normalizeIdentityDocument).refine(isValidSpanishIdentityDocument);
const name = z.string().trim().min(5).max(160);
const faculty = z.object({ code:z.string().min(1).max(100), label:z.string().trim().min(5).max(300) }).strict();
export const RegistrationIntentSchema = z.object({
  caseId:z.string().uuid(), grantor:z.object({ dni:identity, name }).strict(),
  // The representative route requires a separate authority model; it is not inferred from a PFX.
  appearingAs:z.literal('PODERDANTE'),
  professionals:z.array(z.object({ dni:identity, name, role:z.enum(['PROCURADOR','ABOGADO']), college:z.string().min(2).max(160), registrationNumber:z.string().min(1).max(40) }).strict()).min(1).max(10),
  scope:z.object({ kind:z.enum(['GENERAL','SPECIFIC_PROCEEDING','PROCEEDING_CLASSES']), description:z.string().trim().min(5).max(500) }).strict(),
  faculties:z.array(faculty).max(20), exclusions:z.array(faculty).max(20),
  validFrom:z.string().date(), validUntil:z.string().date(),
  selectionEvidenceRef:evidence,
  consent:z.object({ granted:z.literal(true), scope:z.literal('APUD_V2_PREPARE_AND_REVIEW'), grantedAt:z.string().datetime({offset:true}), expiresAt:z.string().datetime({offset:true}), evidenceRef:evidence }).strict(),
}).strict().superRefine((value,ctx)=>{
  const reject=(message:string)=>ctx.addIssue({code:'custom',message});
  const start=new Date(value.validFrom), end=new Date(value.validUntil), max=new Date(start);max.setUTCFullYear(max.getUTCFullYear()+5);
  if(end<=start||end>max)reject('V2_VALIDITY_EXCEEDS_FIVE_YEARS');
  if(new Set(value.professionals.map(p=>p.dni)).size!==value.professionals.length||value.professionals.some(p=>p.dni===value.grantor.dni))reject('V2_PROFESSIONAL_IDENTITY_CONFLICT');
  for(const list of [value.faculties,value.exclusions])if(new Set(list.map(p=>p.code)).size!==list.length)reject('V2_DUPLICATE_FACULTY');
  if(value.faculties.some(p=>value.exclusions.some(e=>e.code===p.code)))reject('V2_FACULTY_INCLUDED_AND_EXCLUDED');
  if(value.faculties.length+value.exclusions.length>20)reject('V2_FACULTY_SELECTION_LIMIT');
  if(value.scope.kind==='GENERAL'&&value.faculties.length>0)reject('V2_GENERAL_SCOPE_CANNOT_SELECT_SPECIAL_FACULTIES');
  const granted=Date.parse(value.consent.grantedAt),expires=Date.parse(value.consent.expiresAt);
  if(expires<=granted||expires-granted>3600000)reject('V2_CONSENT_MAXIMUM_ONE_HOUR');
});
export type RegistrationIntent = z.infer<typeof RegistrationIntentSchema>;
/** Stable canonical serialization: hashes survive PostgreSQL JSONB key ordering. */
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
export function registrationIntentHash(intent:RegistrationIntent):string { return createHash('sha256').update(canonical(intent)).digest('hex'); }
export const SigningApprovalSchema=z.object({
  intentHash:v2Hash,draftSha256:v2Hash,certificateFingerprint:v2Hash,
  operatorId:z.string().trim().min(3).max(100),evidenceRef:evidence,
  clientApprovedExactDraft:z.literal(true),identityAndPowersReviewed:z.literal(true),
  signerWillAppearPersonally:z.literal(true),certificateTrustAndRevocationChecked:z.literal(true),
  certificateValidationEvidenceRef:evidence,expiresAt:z.string().datetime({offset:true}),
}).strict();
export type SigningApproval=z.infer<typeof SigningApprovalSchema>;
export const ReceiptEvidenceSchema=z.object({
  operatorId:z.string().min(3).max(100),evidenceRef:evidence,registrationReference:z.string().trim().min(4).max(160),
  receiptSha256:v2Hash,intentHash:v2Hash,draftSha256:v2Hash,
  sourceUrl:z.string().url().refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='sedejudicial.justicia.es'&&!u.username&&!u.password&&!u.hash;}catch{return false;}}),
  observedAt:z.string().datetime({offset:true}),officialLookupVerified:z.literal(true),
  grantorRoleVerified:z.literal(true),professionalIdentitiesVerified:z.literal(true),
  facultiesExclusionsAndValidityVerified:z.literal(true),signatureAndRegistrationVerified:z.literal(true),
}).strict();
export type ReceiptEvidence=z.infer<typeof ReceiptEvidenceSchema>;
