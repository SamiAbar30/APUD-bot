import {KmaleonClient} from './kmaleon-client.js';
import {AdapterError,sha256,requireId} from '../common/http.js';
import {KmaleonExpedienteCandidateSchema,type KmaleonAnnotation,type KmaleonExpedienteCandidate,type KmaleonMacro,type KmaleonPendingApudActaPage,type KmaleonResponseMapping,type KmaleonTriggerReference} from '../../contracts/kmaleon.contract.js';
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
  constructor(private readonly client:KmaleonClient,private readonly reviewEvidenceRef:string,private readonly options:{samiRecipientCode?:number}={}){}
  /** Read every page before returning anything; changed totals and repeats are incomplete scans. */
  private async allRows(method:string,payload:Record<string,unknown>,pageStart:0|1,rowId:(row:Row)=>string):Promise<Row[]>{
    const rows:Row[]=[];const seen=new Set<string>();let expectedTotal:number|undefined;let pageSize:number|undefined;
    for(let offset=0;offset<1000;offset++){
      const result=list(await this.client.invokeRead(method,{...payload,pageNum:pageStart+offset}));
      if(expectedTotal!==undefined&&expectedTotal!==result.total)throw new AdapterError('KMALEON_PAGINATION_CHANGED');expectedTotal=result.total;
      if(pageSize===undefined)pageSize=result.rows.length;
      for(const row of result.rows){const key=rowId(row);if(seen.has(key))throw new AdapterError('KMALEON_PAGINATION_AMBIGUOUS');seen.add(key);rows.push(row);}
      if(rows.length===expectedTotal)return rows;
      if(rows.length>expectedTotal||result.rows.length===0||result.rows.length!==pageSize)throw new AdapterError('KMALEON_PAGINATION_INCOMPLETE');
    }
    throw new AdapterError('KMALEON_PAGINATION_LIMIT');
  }
  /** Discover the exact staff card on every intake; never infer Sami from a client or another user. */
  async verifySami():Promise<{recipientCode:number;evidenceRef:string}>{
    const rows=await this.allRows('cards/getCards',{filter:filter('nombre','nombre','ABAR','ls')},0,row=>id(row.interno));
    const matches=rows.filter(row=>canonicalKmaleonText(text(row.nombrecompleto)).toUpperCase()==='ABAR, SAMI'&&array(row.categories).map(object).some(category=>text(category.codigo)==='1'));
    if(matches.length!==1)throw new AdapterError('KMALEON_SAMI_RECIPIENT_AMBIGUOUS');
    const card=matches[0]!;const recipientCode=Number(id(card.interno));
    if(text(card.desactivada)!=='0')throw new AdapterError('KMALEON_SAMI_RECIPIENT_INACTIVE');
    if(this.options.samiRecipientCode!==undefined&&this.options.samiRecipientCode!==recipientCode)throw new AdapterError('KMALEON_SAMI_RECIPIENT_IDENTITY_MISMATCH');
    return {recipientCode,evidenceRef:'kmaleon-recipient:sha256:'+sha256(JSON.stringify({recipientCode,name:card.nombrecompleto,inactive:card.desactivada,categories:card.categories,review:this.reviewEvidenceRef}))};
  }
  async verifyDayana(recipientCode:number):Promise<void>{
    const {rows,total}=list(await this.client.invokeRead('cards/getCards',{pageNum:0,filter:filter('cardid','cardid',String(recipientCode))}));
    if(total!==1||rows.length!==1)throw new AdapterError('KMALEON_DAYANA_RECIPIENT_AMBIGUOUS');const card=rows[0]!;
    if(id(card.interno)!==String(recipientCode)||text(card.desactivada)!=='0'||text(card.nombrecompleto).toUpperCase()!=='MORERA DE LA NUEZ, DAYANA'||!array(card.categories).map(object).some(row=>text(row.codigo)==='1'))throw new AdapterError('KMALEON_DAYANA_RECIPIENT_IDENTITY_MISMATCH');
  }
  async macro(code:10|24|27):Promise<KmaleonMacro>{
    const rows=await this.allRows('macros/getMacros',{filter:''},1,row=>id(row.macro_id));
    const matches=rows.filter(row=>text(row.codigo)===String(code));if(matches.length!==1)throw new AdapterError('KMALEON_MACRO_CATALOGUE_AMBIGUOUS');const row=matches[0]!;
    const description=text(row.descripcion);const expected=code===10?'DOCUMENTO 1 APUD ACTA':code===24?'-- PARA PEDIR APUD Y PAGO DE LOS 50€ AVISAME CUANDO ESTÉ PORFA':'-- A LA ESPERA DE APUD ACTA AVISADME CUANDO ESTE PORFA';
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
    return (await this.allRows('calendar/annotations/getAnnotations',payload,1,row=>id(row.codigo))).map(annotation);
  }
  async projectAnnotations(projectId:string):Promise<KmaleonAnnotation[]>{
    requireId(projectId,'PROJECT_ID');const rows=await this.allAnnotations({project_id:Number(projectId)||projectId,filter:''});
    if(rows.some(row=>row.projectId!==projectId))throw new AdapterError('KMALEON_ANNOTATION_IDENTITY_MISMATCH');return rows;
  }
  private matchesTrigger(row:KmaleonAnnotation,macro:KmaleonMacro,recipientCode:number):boolean{
    return row.recipientCode===recipientCode&&row.pending&&row.typeCode==='R'&&canonicalKmaleonText(row.text)===canonicalKmaleonText(macro.description)&&!row.comment?.trim();
  }
  async resolveTriggerExpediente(projectId:string,trigger:KmaleonTriggerReference):Promise<KmaleonExpedienteCandidate>{
    if(!trigger||![24,27].includes(trigger.macroCode)||!Number.isSafeInteger(trigger.recipientCode)||trigger.recipientCode<1)throw new AdapterError('KMALEON_TRIGGER_PROVENANCE_REQUIRED');
    requireId(trigger.externalId,'ANNOTATION_ID');
    const sami=await this.verifySami();if(sami.recipientCode!==trigger.recipientCode)throw new AdapterError('KMALEON_TRIGGER_RECIPIENT_CHANGED');
    const macro=await this.macro(trigger.macroCode);const candidate=await this.candidate(projectId);
    // Recheck the exact triggering aviso after identity/contact reads. Another aviso cannot replace it.
    const rows=await this.projectAnnotations(projectId);
    if(!rows.some(row=>row.id===trigger.externalId&&this.matchesTrigger(row,macro,sami.recipientCode)))throw new AdapterError('KMALEON_TRIGGER_NO_LONGER_PENDING');
    return candidate;
  }
  async listPendingApudActa(input:{page?:number}={}):Promise<KmaleonPendingApudActaPage>{
    const page=input.page??1;if(page!==1)throw new AdapterError('KMALEON_TRIGGER_PAGE_INVALID');
    // The active staff identity gate runs before any notice search.
    const sami=await this.verifySami();
    const items:KmaleonPendingApudActaPage['items']=[];
    const seen=new Set<string>();const projects=new Map<string,Row>();
    for(const code of [24,27] as const){
      const macro=await this.macro(code);
      // Vendor supports one annotation filter: fetch only this macro's first-line text,
      // then require the exact whole catalogue text and Sami recipient locally.
      const firstLine=macro.description.split(/\r?\n/)[0]!;
      const rows=await this.allAnnotations({filter:filter('PorTexto','@texto',firstLine,'like')});
      for(const row of rows){
        if(!this.matchesTrigger(row,macro,sami.recipientCode))continue;
        if(seen.has(row.id))throw new AdapterError('KMALEON_TRIGGER_MACRO_AMBIGUOUS');seen.add(row.id);
        let project=projects.get(row.projectId);if(!project){project=await this.project(row.projectId);projects.set(row.projectId,project);}
        if(!this.isOpen(project))continue;
        items.push({externalId:row.id,projectId:row.projectId,source:'KMALEON_AVISO',macroCode:code,recipientCode:sami.recipientCode,pending:true,open:true,macroEvidenceRef:macro.evidenceRef,recipientEvidenceRef:sami.evidenceRef,evidenceRef:'kmaleon-trigger:sha256:'+sha256(JSON.stringify({annotation:row,archive:project.archivo,macro:macro.evidenceRef,recipient:sami.evidenceRef}))});
      }
    }
    // Expose one complete result set only, with no arbitrary client-count cutoff.
    return {items,page,hasMore:false};
  }
}
