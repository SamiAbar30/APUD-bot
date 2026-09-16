import {KmaleonClient} from './kmaleon-client.js';
import {AdapterError,sha256,requireId} from '../common/http.js';
import {KmaleonExpedienteCandidateSchema,type KmaleonAnnotation,type KmaleonExpedienteCandidate,type KmaleonMacro,type KmaleonPendingApudActaPage,type KmaleonResponseMapping} from '../../contracts/kmaleon.contract.js';
import {isValidSpanishIdentityDocument,normalizeIdentityDocument} from '../../domain/identity/spanish-identity-document.js';

type Row=Record<string,unknown>;
const object=(value:unknown):Row=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new AdapterError('KMALEON_RESPONSE_OBJECT_INVALID');return value as Row;};
const text=(value:unknown):string=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
const id=(value:unknown):string=>{const result=text(value);if(!/^[1-9]\d*$/.test(result))throw new AdapterError('KMALEON_RESPONSE_ID_INVALID');return result;};
const array=(value:unknown):unknown[]=>{if(!Array.isArray(value))throw new AdapterError('KMALEON_RESPONSE_ARRAY_INVALID');return value;};
export const canonicalKmaleonText=(value:string):string=>value.replace(/<br\s*\/?\s*>/gi,' ').replace(/&nbsp;/gi,' ').replace(/\s+/g,' ').trim();
/** Vendor response paths verified read-only on 2026-09-16; no error envelope is an empty success. */
function envelope(raw:unknown):{result:unknown;info:Row}{const root=object(raw);if(root.status!=='ok')throw new AdapterError('KMALEON_PROVIDER_RESPONSE_NOT_OK');const data=object(root.data);return {result:data.result,info:object(data.info)};}
function list(raw:unknown):{rows:Row[];total:number}{const e=envelope(raw);const rows=array(e.result).map(object);const total=e.info.totalRows;const count=e.info.numRows;if(typeof total!=='number'||!Number.isSafeInteger(total)||total<0||count!==rows.length||rows.length>total)throw new AdapterError('KMALEON_PAGINATION_PROOF_INVALID');return {rows,total};}
function singleProject(raw:unknown,projectId:string):Row{const {rows,total}=list(raw);if(rows.length!==1||total!==1||id(rows[0]!.project_id)!==projectId)throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');return rows[0]!;}
const filter=(filterId:string,field:string,value:string,cond='eq')=>[{group:'and',filters:[{group:'and',filters:[{filterId,fields:{[field]:[{value,cond}]}}]}]}];
function annotation(row:Row):KmaleonAnnotation{
  if(typeof row.texto!=='string'||typeof row.opciones!=='string'||typeof row.comentario!=='string')throw new AdapterError('KMALEON_ANNOTATION_FIELDS_INVALID');
  const recipient=object(row.destinatario);const tipo=object(row.tipo);const clase=object(row.clase);
  return {id:id(row.codigo),projectId:id(row.expedienteinterno),text:row.texto,recipientCode:Number(id(recipient.codigo)),pending:row.opciones.includes('P'),internal:row.opciones.includes('I'),priority:row.opciones.includes('T'),typeCode:text(tipo.codigo),classCode:text(clase.codigo),classDescription:text(clase.descripcion),comment:row.comentario,...(row.documento?{documentId:id(object(row.documento).codigo)}:{})};
}
export function reviewedKmaleonMapping(reviewEvidenceRef:string):KmaleonResponseMapping{
  const blocked=():never=>{throw new AdapterError('KMALEON_IDENTITY_REQUIRES_LINKED_CLIENT_CARD');};
  return {reviewEvidenceRef,projectIdentity:blocked,projectCandidate:blocked,projectSearchFilter:blocked,projectSearchPage:blocked,
    annotationsPage(raw,pageNum){const {rows,total}=list(raw);const hasMore=(pageNum+1)*80<total;if(hasMore&&rows.length!==80||rows.length===0&&total>pageNum*80)throw new AdapterError('KMALEON_PAGINATION_INCOMPLETE');return {items:rows.map(annotation),hasMore};},
    documentBytes(raw){const root=object(raw);
      // Live documents/viewDocument returns the document object at the root; older vendor builds wrap it.
      const document=Object.hasOwn(root,'document')?root:root.status==='ok'?object(object(root.data).result):null;if(!document)throw new AdapterError('KMALEON_PROVIDER_RESPONSE_NOT_OK');const encoded=document.document;if(document.mime!=='application/pdf'||typeof encoded!=='string'||encoded.length>36*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new AdapterError('KMALEON_DOCUMENT_ENCODING_INVALID');const bytes=Buffer.from(encoded,'base64');if(bytes.length!==Number(document.size)||bytes.toString('base64')!==encoded||bytes.subarray(0,5).toString()!=='%PDF-')throw new AdapterError('KMALEON_DOCUMENT_ENCODING_INVALID');return bytes;},
  };
}
/** Uses only vendor-documented reads plus the existing, live-verified macro catalogue. */
export class ReviewedKmaleonOperations {
  constructor(private readonly client:KmaleonClient,private readonly reviewEvidenceRef:string){}
  async verifyDayana(recipientCode:number):Promise<void>{
    const {rows,total}=list(await this.client.invokeRead('cards/getCards',{pageNum:0,filter:filter('cardid','cardid',String(recipientCode))}));
    if(total!==1||rows.length!==1)throw new AdapterError('KMALEON_DAYANA_RECIPIENT_AMBIGUOUS');const card=rows[0]!;
    if(id(card.interno)!==String(recipientCode)||text(card.desactivada)!=='0'||text(card.nombrecompleto).toUpperCase()!=='MORERA DE LA NUEZ, DAYANA'||!array(card.categories).map(object).some(row=>text(row.codigo)==='1'))throw new AdapterError('KMALEON_DAYANA_RECIPIENT_IDENTITY_MISMATCH');
  }
  async macro(code:10|27):Promise<KmaleonMacro>{
    const raw=await this.client.invokeRead('macros/getMacros',{pageNum:1,filter:''});const {rows,total}=list(raw);
    if(total!==rows.length)throw new AdapterError('KMALEON_MACRO_CATALOGUE_INCOMPLETE');
    const matches=rows.filter(row=>text(row.codigo)===String(code));if(matches.length!==1)throw new AdapterError('KMALEON_MACRO_CATALOGUE_AMBIGUOUS');const row=matches[0]!;
    const description=text(row.descripcion);const expected=code===10?'DOCUMENTO 1 APUD ACTA':'-- A LA ESPERA DE APUD ACTA AVISADME CUANDO ESTE PORFA';
    if(canonicalKmaleonText(description)!==expected||(code===10&&(text(row.clase_id)!=='453'||text(row.clase)!=='APUD')))throw new AdapterError('KMALEON_MACRO_CATALOGUE_CHANGED');
    if(rows.some(other=>other!==row&&canonicalKmaleonText(text(other.descripcion))===canonicalKmaleonText(description)))throw new AdapterError('KMALEON_MACRO_CATALOGUE_AMBIGUOUS');
    return {code,id:id(row.macro_id),description,classCode:text(row.clase_id),classDescription:text(row.clase),evidenceRef:'kmaleon-macro:sha256:'+sha256(JSON.stringify({row,review:this.reviewEvidenceRef}))};
  }
  private async project(projectId:string):Promise<Row>{requireId(projectId,'PROJECT_ID');return singleProject(await this.client.invokeRead('projects/getProject',{projectId:Number(projectId)||projectId}),projectId);}
  private isOpen(project:Row):boolean{
    const archive=object(project.archivo);if(typeof archive.fecha!=='string'||typeof archive.numero!=='string')throw new AdapterError('KMALEON_PROJECT_OPEN_STATUS_UNVERIFIED');
    const situation=object(project.situacion);if(typeof situation.descripcion!=='string')throw new AdapterError('KMALEON_PROJECT_OPEN_STATUS_UNVERIFIED');
    return archive.fecha.trim()===''&&archive.numero.trim()===''&&!/\b(?:ARCHIVADO|CERRADO|FINALIZADO|DESESTIMADO|DESISTIDO)\b/i.test(situation.descripcion);
  }
  private async clientCard(project:Row):Promise<Row>{
    const clients=array(project.intervinientes).map(object).filter(row=>text(object(row.categoria).codigo)==='3'&&text(row.desactivada)==='0');
    if(clients.length!==1)throw new AdapterError('KMALEON_CLIENT_PARTICIPANT_AMBIGUOUS');const client=clients[0]!;const cardId=id(object(client.referencia).codigo);
    const {rows,total}=list(await this.client.invokeRead('cards/getCards',{pageNum:0,filter:filter('cardid','cardid',cardId)}));
    if(total!==1||rows.length!==1)throw new AdapterError('KMALEON_CLIENT_CARD_AMBIGUOUS');const card=rows[0]!;
    if(id(card.interno)!==cardId||text(card.desactivada)!=='0')throw new AdapterError('KMALEON_CLIENT_CARD_IDENTITY_MISMATCH');
    if(!array(card.categories).map(object).some(row=>text(row.codigo)==='3'&&id(row.participant_id)===id(client.participant_id)))throw new AdapterError('KMALEON_CLIENT_PARTICIPANT_MISMATCH');return card;
  }
  async identity(projectId:string):Promise<{projectId:string;dni:string}>{const project=await this.project(projectId);const card=await this.clientCard(project);const dni=normalizeIdentityDocument(text(card.nifnormalizado));if(!isValidSpanishIdentityDocument(dni))throw new AdapterError('KMALEON_PROJECT_DNI_INVALID');return {projectId,dni};}
  async candidate(projectId:string):Promise<KmaleonExpedienteCandidate>{
    const project=await this.project(projectId);if(!this.isOpen(project))throw new AdapterError('KMALEON_TRIGGER_PROJECT_NOT_OPEN');const card=await this.clientCard(project);
    const companies=array(project.intervinientes).map(object).filter(row=>text(object(row.categoria).codigo)==='4'&&text(row.desactivada)==='0').map(row=>text(object(row.referencia).nombrecompleto));
    if(companies.length!==1||!companies[0])throw new AdapterError('KMALEON_PROJECT_COMPANY_AMBIGUOUS');
    const phones=new Set<string>();for(const address of array(card.address).map(object)){for(const raw of Object.values(object(address.telefonos))){const phone=object(raw);if(text(phone.teldesactivado)!=='0')continue;for(const field of ['telnorma','telefono']){let value=text(phone[field]).replace(/[\s().-]/g,'').replace(/^\+/,'').replace(/^00/,'');if(!value)continue;
      // A nine-digit Spanish mobile is expanded only when this card's address explicitly says Spain.
      const country=canonicalKmaleonText(text(address.pais)).toUpperCase();if(/^[67]\d{8}$/.test(value)&&['ESPAÑA','ESPANA','ESPA\u00d1A','SPAIN','ES'].includes(country))value='34'+value;
      if(/^[1-9]\d{7,14}$/.test(value))phones.add(value);
    }}}
    if(phones.size!==1)throw new AdapterError('KMALEON_CLIENT_PHONE_AMBIGUOUS');
    if([...phones][0]!.length<10)throw new AdapterError('KMALEON_CLIENT_PHONE_COUNTRY_UNVERIFIED');
    const dni=normalizeIdentityDocument(text(card.nifnormalizado));if(!isValidSpanishIdentityDocument(dni))throw new AdapterError('KMALEON_PROJECT_DNI_INVALID');
    const candidate=KmaleonExpedienteCandidateSchema.safeParse({projectId,numeroExpediente:text(project.codigo),empresa:companies[0],dni,nombre:text(card.nombrecompleto),telefono:[...phones][0]});if(!candidate.success)throw new AdapterError('KMALEON_PROJECT_CONTACT_FIELDS_INVALID');return candidate.data;
  }
  private async allAnnotations(payload:Record<string,unknown>):Promise<KmaleonAnnotation[]>{
    const rows:KmaleonAnnotation[]=[];const seen=new Set<string>();let expectedTotal:number|undefined;
    for(let page=1;page<=100;page++){
      const result=list(await this.client.invokeRead('calendar/annotations/getAnnotations',{...payload,pageNum:page}));
      if(expectedTotal!==undefined&&expectedTotal!==result.total)throw new AdapterError('KMALEON_PAGINATION_CHANGED');expectedTotal=result.total;
      for(const raw of result.rows){const row=annotation(raw);if(seen.has(row.id))throw new AdapterError('KMALEON_PAGINATION_AMBIGUOUS');seen.add(row.id);rows.push(row);}
      if(rows.length===expectedTotal)return rows;if(rows.length>expectedTotal||result.rows.length!==80)throw new AdapterError('KMALEON_PAGINATION_INCOMPLETE');
    }throw new AdapterError('KMALEON_PAGINATION_LIMIT');
  }
  async projectAnnotations(projectId:string):Promise<KmaleonAnnotation[]>{
    requireId(projectId,'PROJECT_ID');const rows=await this.allAnnotations({project_id:Number(projectId)||projectId,filter:''});
    if(rows.some(row=>row.projectId!==projectId))throw new AdapterError('KMALEON_ANNOTATION_IDENTITY_MISMATCH');return rows;
  }
  async resolveTriggerExpediente(projectId:string):Promise<KmaleonExpedienteCandidate>{
    const macro=await this.macro(27);const rows=await this.projectAnnotations(projectId);
    if(!rows.some(row=>row.pending&&row.typeCode==='R'&&canonicalKmaleonText(row.text)===canonicalKmaleonText(macro.description)&&!row.comment?.trim()))throw new AdapterError('KMALEON_TRIGGER_NO_LONGER_PENDING');
    return this.candidate(projectId);
  }
  async listPendingApudActa(input:{page?:number}={}):Promise<KmaleonPendingApudActaPage>{
    const page=input.page??1;if(page!==1)throw new AdapterError('KMALEON_TRIGGER_PAGE_INVALID');
    const macro=await this.macro(27);const rows=await this.allAnnotations({filter:filter('PorTexto','@texto','-- A LA ESPERA DE APUD ACTA','like')});
    // Expose one complete result set only. A bounded failure never looks like a smaller successful batch.
    const pending=rows.filter(row=>row.pending&&row.typeCode==='R'&&canonicalKmaleonText(row.text)===canonicalKmaleonText(macro.description)&&!row.comment?.trim());
    if(pending.length>250)throw new AdapterError('KMALEON_TRIGGER_CASE_LIMIT');
    const items:KmaleonPendingApudActaPage['items']=[];
    for(const row of pending){const project=await this.project(row.projectId);if(!this.isOpen(project))continue;items.push({externalId:row.id,projectId:row.projectId,macroCode:27,pending:true,open:true,evidenceRef:'kmaleon-trigger:sha256:'+sha256(JSON.stringify({annotation:row,archive:project.archivo,macro:macro.evidenceRef}))});}
    return {items,page,hasMore:false};
  }
}
