import { KmaleonIdentitySchema,KmaleonAnnotationSchema,KmaleonProjectAddressSchema,KmaleonExpedienteCandidateSchema,type KmaleonVerifiedAddress,type KmaleonResponseMapping,type KmaleonAnnotation,type KmaleonExpedienteCandidate,type DocumentProof,type NoticeProof,type KmaleonMacro,type KmaleonPendingApudActaPage,type KmaleonTriggerReference } from '../../contracts/kmaleon.contract.js';
import { AdapterError,requireId,requireValue,sha256 } from '../common/http.js';
import { KmaleonClient } from './kmaleon-client.js';
import {canonicalKmaleonText,type ReviewedKmaleonOperations} from './kmaleon-reviewed.js';
export interface KmaleonSearchImplementation {
  search(input:{field:'dni'|'nombre';query:string;page:number}):Promise<{items:KmaleonExpedienteCandidate[];page:number;hasMore:boolean}>;
  get(projectId:string):Promise<KmaleonExpedienteCandidate>;
}
export interface KmaleonGatewayOptions {recipientCode?:number;mapping:KmaleonResponseMapping;searchImplementation?:KmaleonSearchImplementation;maxPages?:number;readbackDelayMs?:number;operations?:ReviewedKmaleonOperations;annotationPageStart?:0|1}
interface DocumentInput {projectId:string;expectedDni:string;buffer:Buffer;fileName:string;idempotencyKey:string;isProvisional:boolean;reconcileOnly?:boolean}
const normalizeDni=(dni:string)=>dni.toUpperCase().replace(/[\s.-]/g,'');
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class KmaleonGateway {
  readonly addressLookupConfigured:boolean;
  constructor(private readonly client:KmaleonClient,private readonly options:KmaleonGatewayOptions){
    requireValue(options.mapping.reviewEvidenceRef,'KMALEON_MAPPING_REVIEW');
    this.addressLookupConfigured=Boolean(options.mapping.projectAddress);
  }
  private requiredRecipientCode():number{
    const code=this.options.recipientCode;
    if(typeof code!=='number'||!Number.isSafeInteger(code)||code<1)throw new AdapterError('KMALEON_DAYANA_RECIPIENT_NOT_CONFIGURED');
    return code;
  }
  private async checkIdentity(projectId:string,expectedDni:string):Promise<void>{
    requireId(projectId,'PROJECT_ID');
    if(!/^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/.test(normalizeDni(expectedDni)))throw new AdapterError('INVALID_EXPECTED_DNI');
    const identity=this.options.operations?await this.options.operations.identity(projectId):this.options.mapping.projectIdentity(await this.client.invokeRead('projects/getProject',{projectId:Number(projectId)||projectId}));
    const parsed=KmaleonIdentitySchema.safeParse(identity);
    if(!parsed.success||parsed.data.projectId!==projectId||normalizeDni(parsed.data.dni)!==normalizeDni(expectedDni))throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
  }
  async listPendingApudActa(input:{page?:number}={}):Promise<KmaleonPendingApudActaPage>{
    if(!this.options.operations)throw new AdapterError('KMALEON_TRIGGER_MAPPING_NOT_REVIEWED');
    return this.options.operations.listPendingApudActa(input);
  }
  async resolveTriggerExpediente(projectId:string,trigger:KmaleonTriggerReference):Promise<KmaleonExpedienteCandidate>{
    if(!this.options.operations)throw new AdapterError('KMALEON_TRIGGER_MAPPING_NOT_REVIEWED');
    return this.options.operations.resolveTriggerExpediente(projectId,trigger);
  }
  /** Read-only search used to select an existing Kmaleon expediente before local linking. */
  async searchExpedientes(input:{field:'dni'|'nombre';query:string;page?:number}):Promise<{items:KmaleonExpedienteCandidate[];page:number;hasMore:boolean}> {
    const query=input.query.trim();if(query.length<2||query.length>160)throw new AdapterError('KMALEON_SEARCH_QUERY_INVALID');
    const page=input.page??1;if(!Number.isInteger(page)||page<1||page>100)throw new AdapterError('KMALEON_SEARCH_PAGE_INVALID');
    if(this.options.searchImplementation)return this.options.searchImplementation.search({field:input.field,query,page});
    const raw=await this.client.invokeRead('projects/getProjects',{pageNum:page,filter:this.options.mapping.projectSearchFilter(input.field,query)});
    const result=this.options.mapping.projectSearchPage(raw,page);
    if(!result||!Array.isArray(result.items)||typeof result.hasMore!=='boolean')throw new AdapterError('KMALEON_PROJECT_SEARCH_MAPPING_INVALID');
    return {items:result.items,page,hasMore:result.hasMore};
  }
  /** Re-reads and validates the selected project; the browser result is never trusted as identity. */
  async getExpediente(projectId:string):Promise<KmaleonExpedienteCandidate>{
    requireId(projectId,'PROJECT_ID');
    if(this.options.searchImplementation)return this.options.searchImplementation.get(projectId);
    const raw=await this.client.invokeRead('projects/getProject',{projectId:Number(projectId)||projectId});
    const candidate=this.options.mapping.projectCandidate(raw);
    if(candidate.projectId!==projectId)throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
    return candidate;
  }
  /** Read-only, identity-bound retrieval. Judicial district selection remains outside this adapter. */
  async getVerifiedAddress(input:{projectId:string;expectedDni:string}):Promise<KmaleonVerifiedAddress>{
    const mapper=this.options.mapping.projectAddress;
    if(!mapper)throw new AdapterError('KMALEON_ADDRESS_MAPPING_NOT_REVIEWED');
    requireId(input.projectId,'PROJECT_ID');
    const expectedDni=normalizeDni(input.expectedDni);
    if(!/^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/.test(expectedDni))throw new AdapterError('INVALID_EXPECTED_DNI');
    const digits=expectedDni.slice(0,-1).replace(/^[XYZ]/,letter=>String('XYZ'.indexOf(letter)));
    if('TRWAGMYFPDXBNJZSQVHLCKE'[Number(digits)%23]!==expectedDni.at(-1))throw new AdapterError('INVALID_EXPECTED_DNI');
    const raw=await this.client.invokeRead('projects/getProject',{projectId:Number(input.projectId)||input.projectId});
    let responseSha256:string;
    try{const serialized=JSON.stringify(raw);if(!serialized)throw new Error('EMPTY_RESPONSE');responseSha256=sha256(serialized);}catch{throw new AdapterError('KMALEON_PROJECT_RESPONSE_INVALID');}
    let identity:ReturnType<typeof KmaleonIdentitySchema.safeParse>;
    let address:ReturnType<typeof KmaleonProjectAddressSchema.safeParse>;
    try{
      identity=KmaleonIdentitySchema.safeParse(this.options.mapping.projectIdentity(raw));
      address=KmaleonProjectAddressSchema.safeParse(mapper(raw));
    }catch{throw new AdapterError('KMALEON_ADDRESS_FIELDS_UNAVAILABLE');}
    if(!identity.success||identity.data.projectId!==input.projectId||normalizeDni(identity.data.dni)!==expectedDni)throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
    if(!address.success)throw new AdapterError('KMALEON_ADDRESS_FIELDS_INVALID');
    if(address.data.projectId!==input.projectId||normalizeDni(address.data.dni)!==expectedDni)throw new AdapterError('KMALEON_ADDRESS_IDENTITY_MISMATCH');
    const verified={...address.data,dni:expectedDni};
    const fingerprint=sha256(JSON.stringify({source:'projects/getProject',responseSha256,mappingReviewSha256:sha256(this.options.mapping.reviewEvidenceRef),address:verified}));
    return {...verified,evidenceRef:'kmaleon-address:sha256:'+fingerprint};
  }
  private async annotations(projectId:string):Promise<KmaleonAnnotation[]>{
    if(this.options.operations)return this.options.operations.projectAnnotations(projectId);
    const rows:KmaleonAnnotation[]=[];const seen=new Set<string>();
    for(let page=0;page<(this.options.maxPages??100);page++){
      const raw=await this.client.invokeRead('calendar/annotations/getAnnotations',{project_id:Number(projectId)||projectId,pageNum:page+(this.options.annotationPageStart??0),filter:''});
      const result=this.options.mapping.annotationsPage(raw,page);
      if(!result||!Array.isArray(result.items)||typeof result.hasMore!=='boolean')throw new AdapterError('KMALEON_ANNOTATION_MAPPING_INVALID');
      for(const item of result.items){const parsed=KmaleonAnnotationSchema.safeParse(item);
        if(!parsed.success||parsed.data.projectId!==projectId)throw new AdapterError('KMALEON_ANNOTATION_IDENTITY_MISMATCH');
        if(seen.has(item.id))throw new AdapterError('KMALEON_PAGINATION_AMBIGUOUS');seen.add(item.id);rows.push(parsed.data);
      }
      if(!result.hasMore)return rows;
      if(result.items.length===0)throw new AdapterError('KMALEON_PAGINATION_INCOMPLETE');
    }
    throw new AdapterError('KMALEON_PAGINATION_LIMIT');
  }
  private exact(rows:KmaleonAnnotation[],text:string):KmaleonAnnotation|undefined{
    const recipientCode=this.requiredRecipientCode();
    const matches=rows.filter(a=>a.text===text&&a.recipientCode===recipientCode);
    if(matches.length>1)throw new AdapterError('KMALEON_DUPLICATE_REFERENCE','uncertain');return matches[0];
  }
  private documentRow(rows:KmaleonAnnotation[],text:string,isProvisional:boolean,macro?:KmaleonMacro):KmaleonAnnotation|undefined{
    const expected=canonicalKmaleonText(isProvisional?text:macro!.description+' '+text);
    const matches=rows.filter(row=>canonicalKmaleonText(row.text)===expected&&(isProvisional?row.recipientCode===this.requiredRecipientCode():true));
    if(matches.length>1)throw new AdapterError('KMALEON_DUPLICATE_REFERENCE','uncertain');return matches[0];
  }
  private async proveDocument(row:KmaleonAnnotation,projectId:string,hash:string,key:string,macro?:KmaleonMacro):Promise<DocumentProof>{
    if(row.projectId!==projectId||!row.documentId)throw new AdapterError('KMALEON_DOCUMENT_REFERENCE_MISSING','uncertain');
    if(macro&&(row.classCode!==macro.classCode||row.classDescription!==macro.classDescription||Boolean(row.comment?.trim())))throw new AdapterError('KMALEON_MACRO_10_NOT_VERIFIED','uncertain');
    const raw=await this.client.invokeRead('documents/viewDocument',{document:row.documentId});
    const bytes=this.options.mapping.documentBytes(raw);
    if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>25*1024*1024||sha256(bytes)!==hash)throw new AdapterError('KMALEON_DOCUMENT_HASH_MISMATCH','uncertain');
    return {verified:true,projectId,annotationId:row.id,documentId:row.documentId,sha256:hash,idempotencyKey:key,...(macro?{macroCode:10 as const,macroEvidenceRef:macro.evidenceRef}:{})};
  }
  private annotation(text:string,pending:boolean):Record<string,unknown>{
    const recipientCode=this.requiredRecipientCode();
    const now=new Date();const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const part=(type:string)=>parts.find(p=>p.type===type)!.value;
    return {fecha:`${part('day')}/${part('month')}/${part('year')}`,hora:`${part('hour')}:${part('minute')}`,duracion:'00:00',tipo:{codigo:pending?'R':'H',descripcion:pending?'Aviso':'Historial'},opciones:pending?'PIT':'E',destinatario:{codigo:recipientCode},eshilopadre:0,eshilohijo:0,eshiloactivo:0,codigopadre:0,texto:text,comentario:''};
  }
  async uploadAndVerifyDocument(input:DocumentInput):Promise<DocumentProof>{
    const dayana=this.requiredRecipientCode();
    if(this.options.operations)await this.options.operations.verifyDayana(dayana);
    requireId(input.idempotencyKey,'IDEMPOTENCY_KEY');
    if(input.buffer.length===0||input.buffer.length>25*1024*1024||input.buffer.subarray(0,5).toString()!=='%PDF-'||!/^[-\p{L}\p{N} _().]{1,180}\.pdf$/iu.test(input.fileName))throw new AdapterError('INVALID_KMALEON_DOCUMENT');
    if(!input.isProvisional&&!this.options.operations)throw new AdapterError('KMALEON_MACRO_10_MAPPING_NOT_REVIEWED');
    const macro=input.isProvisional?undefined:await this.options.operations!.macro(10);
    const hash=sha256(input.buffer);const text=`APOD ${input.isProvisional?'PROVISIONAL':'VALIDADO'} [APOD:${input.idempotencyKey}:${hash}]`;
    await this.checkIdentity(input.projectId,input.expectedDni);
    const prior=await this.annotations(input.projectId);
    const recipientCode=this.requiredRecipientCode();
    const expectedText=canonicalKmaleonText(input.isProvisional?text:macro!.description+' '+text);
    if(prior.some(row=>row.text.includes(`[APOD:${input.idempotencyKey}:`)&&(canonicalKmaleonText(row.text)!==expectedText||(input.isProvisional&&row.recipientCode!==recipientCode))))throw new AdapterError('KMALEON_IDEMPOTENCY_REFERENCE_CONFLICT','uncertain');
    const existing=this.documentRow(prior,text,input.isProvisional,macro);
    if(existing)return this.proveDocument(existing,input.projectId,hash,input.idempotencyKey,macro);
    if(input.reconcileOnly)throw new AdapterError('KMALEON_WRITE_OUTCOME_UNRESOLVED','uncertain');
    // Caller must hold a lock and durably mark the operation started before entering this branch.
    try { await this.client.invokeWrite('calendar/annotations/newAnnotation',{project_id:Number(input.projectId)||input.projectId,annotation:{...this.annotation(text,false),...(macro?{macro_codigo:10}:{}),documento:{file:input.fileName,content:input.buffer.toString('base64')}}}); }
    catch(error){if(error instanceof AdapterError&&error.outcome==='not_applied')throw error;}
    for(let attempt=0;attempt<3;attempt++){
      try{await this.checkIdentity(input.projectId,input.expectedDni);const row=this.documentRow(await this.annotations(input.projectId),text,input.isProvisional,macro);if(row)return await this.proveDocument(row,input.projectId,hash,input.idempotencyKey,macro);}catch(error){if(error instanceof AdapterError&&['KMALEON_DOCUMENT_HASH_MISMATCH','KMALEON_DUPLICATE_REFERENCE','KMALEON_PROJECT_IDENTITY_MISMATCH'].includes(error.code))throw error;}
      if(attempt<2)await delay(Math.min(this.options.readbackDelayMs??1000,10_000));
    }
    throw new AdapterError('KMALEON_DOCUMENT_NOT_VERIFIED','uncertain');
  }
  /** Compatibility alias for persisted legacy effects; recipient is always the configured Dayana. */
  async notifyCarmen(input:Parameters<KmaleonGateway['notifyDayana']>[0]):Promise<NoticeProof>{return this.notifyDayana(input);}
  async notifyDayana(input:{projectId:string;expectedDni:string;idempotencyKey:string;documentProof:DocumentProof;isProvisional:boolean;reconcileOnly?:boolean}):Promise<NoticeProof>{
    const recipientCode=this.requiredRecipientCode();
    if(!this.options.operations)throw new AdapterError('KMALEON_DAYANA_MAPPING_NOT_REVIEWED');
    await this.options.operations.verifyDayana(recipientCode);
    requireId(input.idempotencyKey,'IDEMPOTENCY_KEY');const proof=input.documentProof;
    if(!proof.verified||proof.projectId!==input.projectId||!/^[a-f0-9]{64}$/.test(proof.sha256)||(!input.isProvisional&&(proof.macroCode!==10||!proof.macroEvidenceRef)))throw new AdapterError('INVALID_DOCUMENT_PROOF');
    await this.checkIdentity(input.projectId,input.expectedDni);
    const before=await this.annotations(input.projectId);
    if(!input.isProvisional&&!this.options.operations)throw new AdapterError('KMALEON_MACRO_10_MAPPING_NOT_REVIEWED');
    const macro=input.isProvisional?undefined:await this.options.operations!.macro(10);
    const documentRow=before.find(r=>r.id===proof.annotationId&&r.documentId===proof.documentId);
    const documentText=`APOD ${input.isProvisional?'PROVISIONAL':'VALIDADO'} [APOD:${proof.idempotencyKey}:${proof.sha256}]`;
    if(!documentRow||this.documentRow(before,documentText,input.isProvisional,macro)?.id!==documentRow.id)throw new AdapterError('KMALEON_DOCUMENT_PROOF_STALE');
    await this.proveDocument(documentRow,input.projectId,proof.sha256,proof.idempotencyKey,macro);
    const text=`DAYANA: REVISION PRIORITARIA DE APODERAMIENTO ${input.isProvisional?'PROVISIONAL; PENDIENTE SUBSANACION':'VALIDADO'}. DOCUMENTO ${proof.documentId} [APOD-NOTICE:${input.idempotencyKey}:${proof.sha256}]`;
    const result=(row:KmaleonAnnotation):NoticeProof=>({verified:true,projectId:input.projectId,annotationId:row.id,recipientCode:row.recipientCode,idempotencyKey:input.idempotencyKey});
    if(before.some(row=>row.text.includes(`[APOD-NOTICE:${input.idempotencyKey}:`)&&(row.text!==text||row.recipientCode!==recipientCode)))throw new AdapterError('KMALEON_IDEMPOTENCY_REFERENCE_CONFLICT','uncertain');
    const verifiedNotice=(row:KmaleonAnnotation)=>row.pending&&row.internal===true&&row.priority===true&&row.typeCode==='R';
    const existing=this.exact(before,text);if(existing){if(!verifiedNotice(existing))throw new AdapterError('KMALEON_NOTICE_PENDING_PRIORITY_NOT_VERIFIED','uncertain');return result(existing);}
    if(input.reconcileOnly)throw new AdapterError('KMALEON_NOTICE_OUTCOME_UNRESOLVED','uncertain');
    try{await this.client.invokeWrite('calendar/annotations/newAnnotation',{project_id:Number(input.projectId)||input.projectId,annotation:this.annotation(text,true)});}catch(error){if(error instanceof AdapterError&&error.outcome==='not_applied')throw error;}
    for(let attempt=0;attempt<3;attempt++){
      try{await this.checkIdentity(input.projectId,input.expectedDni);const row=this.exact(await this.annotations(input.projectId),text);if(row&&verifiedNotice(row))return result(row);}catch(error){if(error instanceof AdapterError&&['KMALEON_DUPLICATE_REFERENCE','KMALEON_PROJECT_IDENTITY_MISMATCH'].includes(error.code))throw error;}
      if(attempt<2)await delay(Math.min(this.options.readbackDelayMs??1000,10_000));
    }
    throw new AdapterError('KMALEON_NOTICE_NOT_VERIFIED','uncertain');
  }
}
