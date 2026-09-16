import type {AdapterPorts} from './ports.js';
import {readFile,stat} from 'node:fs/promises';
import {z} from 'zod';
import {KmaleonClient} from './kmaleon/kmaleon-client.js';
import {ReviewedKmaleonOperations,reviewedKmaleonMapping} from './kmaleon/kmaleon-reviewed.js';
import {KmaleonGateway,type KmaleonSearchImplementation} from './kmaleon/kmaleon-gateway.js';
import {ApudataClient} from './apudata/apudata-client.js';
import {ApudataGateway} from './apudata/apudata-gateway.js';
import {SedePlaywright,type SedeDraftRecipe} from './sede-judicial/sede-playwright.js';
import {ApudataApprovalSchema,ApudataOrderSchema,type ApudataRequest} from '../contracts/apudata.contract.js';
import {AdapterError} from './common/http.js';
import {KmaleonProjectAddressSchema,KmaleonExpedienteCandidateSchema,type KmaleonResponseMapping,type KmaleonExpedienteCandidate} from '../contracts/kmaleon.contract.js';
import {normalizeIdentityDocument,isValidSpanishIdentityDocument} from '../domain/identity/spanish-identity-document.js';
const Path=z.string().regex(/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/).refine(v=>!v.split('.').some(k=>['__proto__','constructor','prototype'].includes(k)));
const RootPath=Path.or(z.literal(''));
const EnvName=z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/);
const SearchFilter=z.object({filterId:z.string().trim().min(1).max(80),field:z.string().trim().min(1).max(80),condition:z.string().trim().min(1).max(30)}).strict();
const Review={reviewed:z.literal(true),reviewEvidenceRef:z.string().min(5),enabled:z.boolean().default(false)};
const KmaleonConfig=z.object({
  ...Review,legacySearch:z.boolean().default(false),baseUrl:z.string().url(),clientId:z.string().min(1),clientSecretEnv:EnvName,authState:z.string().min(1),redirectUri:z.string().min(1),recipientCode:z.number().int().positive().optional(),
  mapping:z.object({
    project:z.object({id:Path,dni:Path}).strict(),
    projects:z.object({
      items:RootPath,hasMore:Path.optional(),totalRows:Path.optional(),pageSize:z.number().int().positive().max(200).default(80),
      fields:z.object({id:Path,name:Path,dni:Path,phone:Path,company:Path.optional(),expedienteNumber:Path.optional()}).strict(),
      filters:z.object({dni:SearchFilter,nombre:SearchFilter}).strict(),
    }).strict().refine(v=>Boolean(v.hasMore)||Boolean(v.totalRows&&v.pageSize),'pagination proof required'),
    projectAddress:z.object({projectId:Path,dni:Path,direccion:Path,codigoPostal:Path,provincia:Path,localidad:Path,comunidadAutonoma:Path.optional()}).strict().optional(),
    annotations:z.object({items:RootPath,hasMore:Path.optional(),totalRows:Path.optional(),pageSize:z.number().int().positive().optional(),fields:z.object({id:Path,projectId:Path,text:Path,recipientCode:Path,documentId:Path,pending:Path}).strict(),pendingEncoding:z.enum(['boolean','opciones-P']).default('boolean')}).strict().refine(v=>Boolean(v.hasMore)||Boolean(v.totalRows&&v.pageSize),'pagination proof required'),
    document:z.object({base64:Path}).strict(),
  }).strict().optional(),
}).strict().superRefine((value,ctx)=>{if(!value.legacySearch&&!value.mapping)ctx.addIssue({code:'custom',message:'KMALEON_MAPPING_REQUIRED'});});
const Source=z.enum(['clientId','dni','nombre','idempotencyKey','approvalId','approvalEvidenceRef','approvalExpiresAt','paymentEvidenceRef','amountCents','currency']);
const Binding=z.union([z.object({env:EnvName}).strict(),z.object({source:Source}).strict(),z.object({literal:z.union([z.string(),z.number(),z.boolean(),z.null()])}).strict()]);
const RequestMap=z.object({path:z.string().min(1),method:z.enum(['GET','POST']),body:z.record(Path,Binding).optional()}).strict();
const OrderFields=z.object({id:Path,clientId:Path,idempotencyKey:Path,approvalId:Path,amountCents:Path,currency:Path,status:Path,videoUrl:Path.optional(),documentSha256:Path.optional()}).strict();
const ApudataConfig=z.object({
  ...Review,baseUrl:z.string().url(),accessTokenEnv:EnvName,
  payment:z.object({iban:z.string(),amountCents:z.literal(3500),currency:z.literal('EUR'),evidenceRef:z.string().min(5)}).strict(),
  mapping:z.object({
    preapprove:RequestMap,findOrder:RequestMap,createOrder:RequestMap,
    approvalFields:z.object({id:Path,clientId:Path,preApproved:Path,expiresAt:Path,evidenceRef:Path}).strict(),
    foundOrderRoot:RootPath,createdOrderRoot:RootPath,orderFields:OrderFields,
  }).strict(),
}).strict();
const Step=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('fill'),selector:z.string().min(1),field:z.string().min(1)}).strict(),
  z.object({kind:z.literal('select'),selector:z.string().min(1),field:z.string().min(1)}).strict(),
  z.object({kind:z.literal('check'),selector:z.string().min(1)}).strict(),
  z.object({kind:z.literal('click'),selector:z.string().min(1)}).strict(),
  z.object({kind:z.literal('wait'),selector:z.string().min(1)}).strict(),
]);
const SedeConfig=z.object({
  ...Review,recipe:z.object({id:z.string().min(1),reviewEvidenceRef:z.string().min(5),reviewedDraftOnly:z.literal(true),officialOrigins:z.array(z.string().url()).min(1),startUrl:z.string().url(),allowedRequests:z.array(z.object({origin:z.string().url(),pathname:z.string().min(1),method:z.enum(['GET','POST']),purpose:z.enum(['authentication','read','draft'])}).strict()).min(1),steps:z.array(Step).max(100),identitySelector:z.string().min(1),draftReadySelector:z.string().min(1),draftPdfLinkSelector:z.string().min(1)}).strict(),
}).strict();
function at(raw:unknown,path:string):unknown{
  if(path==='')return raw;
  const validated=Path.safeParse(path);if(!validated.success)throw new AdapterError('CONFIG_MAPPING_PATH_INVALID');
  let current:unknown=raw;
  for(const key of path.split('.')){if(current===null||typeof current!=='object'||!Object.hasOwn(current,key))throw new AdapterError('PROVIDER_RESPONSE_FIELD_MISSING');current=(current as Record<string,unknown>)[key];}
  return current;
}
function stringId(v:unknown):string{if(typeof v==='string'&&v.length>0)return v;if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)return String(v);throw new AdapterError('PROVIDER_ID_INVALID');}
function responseFields(raw:unknown,fields:Record<string,string|undefined>):Record<string,unknown>{const out:Record<string,unknown>={};for(const [key,path]of Object.entries(fields))if(path)out[key]=at(raw,path);return out;}
function setPath(output:Record<string,unknown>,path:string,value:unknown):void{
  const parts=path.split('.');let current=output;
  for(const key of parts.slice(0,-1)){const existing=current[key];if(existing===undefined)current[key]={};else if(existing===null||typeof existing!=='object'||Array.isArray(existing))throw new AdapterError('CONFIG_BODY_FIELD_COLLISION');current=current[key]as Record<string,unknown>;}
  current[parts.at(-1)!]=value;
}
function mappedRequest(map:z.infer<typeof RequestMap>,inputs:Record<string,unknown>,environment:Record<string,string|undefined>):ApudataRequest{
  const path=map.path.replace(/\{([A-Za-z]+)\}/g,(_,key:string)=>{const value=inputs[key];if(value===undefined||!Source.safeParse(key).success)throw new AdapterError('CONFIG_REQUEST_PARAMETER_MISSING');return encodeURIComponent(String(value));});
  if(/[{}]/.test(path))throw new AdapterError('CONFIG_REQUEST_PATH_INVALID');
  const body:Record<string,unknown>={};
  for(const [key,binding]of Object.entries(map.body??{})){const value='env'in binding?secret(environment,binding.env):'literal'in binding?binding.literal:inputs[binding.source];if(value===undefined)throw new AdapterError('CONFIG_REQUEST_BODY_VALUE_MISSING');setPath(body,key,value);}
  return {path,method:map.method,...(map.body?{body}:{})};
}
async function config<T>(path:string,schema:z.ZodType<T,z.ZodTypeDef,unknown>,overrides:Record<string,unknown>={}):Promise<T>{
  const info=await stat(path);if(!info.isFile()||info.size>128*1024)throw new AdapterError('ADAPTER_CONFIG_FILE_INVALID');
  let raw:unknown;try{raw=JSON.parse(await readFile(path,'utf8'))as unknown;}catch{throw new AdapterError('ADAPTER_CONFIG_JSON_INVALID');}
  const parsed=schema.safeParse({...raw as Record<string,unknown>,...overrides});if(!parsed.success)throw new AdapterError('ADAPTER_CONFIG_NOT_REVIEWED_OR_INVALID');return parsed.data;
}
function secret(values:Record<string,string|undefined>,name:string):string{const value=values[name];if(!value?.trim())throw new AdapterError('ADAPTER_REFERENCED_SECRET_MISSING');return value;}
function positiveSetting(values:Record<string,string|undefined>,name:string,fallback:number):number{const value=Number(values[name]??fallback);if(!Number.isSafeInteger(value)||value<1)throw new AdapterError('KMALEON_TIMEOUT_INVALID');return value;}
export type ConfiguredAdapters=AdapterPorts;
function resultArray(raw:unknown):unknown[]{
  if(!raw||typeof raw!=='object')return [];
  const root=raw as {data?:{result?:unknown};result?:unknown};
  const value=root.data?.result??root.result??raw;
  return Array.isArray(value)?value:[];
}
function totalRows(raw:unknown):number{
  if(!raw||typeof raw!=='object')return 0;
  const info=(raw as {data?:{info?:{totalRows?:unknown}}}).data?.info;
  const value=Number(info?.totalRows??0);
  return Number.isSafeInteger(value)&&value>=0?value:0;
}
function filterPayload(filterId:string,field:string,value:string,condition:'eq'|'ls'):unknown[]{
  return [{group:'and',filters:[{group:'and',filters:[{filterId,fields:{[field]:[{value,cond:condition}]}}]}]}];
}
function legacyPhone(card:unknown):string{
  if(!card||typeof card!=='object')return '';
  const addressValue=(card as {address?:unknown}).address;
  const address:Record<string,unknown>=Array.isArray(addressValue)&&addressValue[0]&&typeof addressValue[0]==='object'?addressValue[0] as Record<string,unknown>:{};
  const telephoneObject=address.telefonos&&typeof address.telefonos==='object'?Object.values(address.telefonos as Record<string,unknown>):[];
  const values=[...telephoneObject,address.telefonosadicionales].flatMap(value=>{
    if(value&&typeof value==='object'){
      const row=value as Record<string,unknown>;
      return [row.telefono,row.telnorma];
    }
    return [value];
  }).map(value=>String(value??'').trim());
  for(const value of values){const normalized=value.replace(/^\+/,'').replace(/[\s().-]/g,'');if(/^[1-9]\d{7,14}$/.test(normalized))return normalized;}
  return '';
}
function legacyParticipantIds(card:unknown):string[]{
  if(!card||typeof card!=='object'||!Array.isArray((card as {categories?:unknown}).categories))return [];
  const categories=(card as {categories:unknown[]}).categories;
  const ids=(preferClient:boolean)=>categories.filter(category=>category&&typeof category==='object'&&(!preferClient||String((category as {codigo?:unknown}).codigo)==='3')).map(category=>String((category as {participant_id?:unknown}).participant_id??'').trim()).filter(Boolean);
  const client=ids(true);return [...new Set(client.length?client:ids(false))];
}
function legacyText(value:unknown):string{
  if(typeof value==='string')return value.trim();
  if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
  return '';
}
function legacyReferenceName(value:unknown):string{
  if(!value||typeof value!=='object')return '';
  const row=value as Record<string,unknown>;
  return legacyText(row.nombrecompleto??row.nombre??row.name??row.razonsocial??row.descripcion);
}
function legacyCompany(project:unknown):string{
  if(!project||typeof project!=='object')return '';
  const participants=(project as {intervinientes?:unknown}).intervinientes;
  if(!Array.isArray(participants))return '';
  for(const participant of participants){
    if(!participant||typeof participant!=='object')continue;
    const row=participant as Record<string,unknown>;
    // Kmaleon's live response uses category 4 for the lender/contrario.
    if(String((row.categoria as Record<string,unknown>|undefined)?.codigo??row.codigo??'')!=='4')continue;
    const name=legacyReferenceName(row.referencia??row.participante??row);
    if(name)return name;
  }
  return '';
}
function legacyExpedienteNumber(project:unknown):string{
  if(!project||typeof project!=='object')return '';
  const row=project as Record<string,unknown>;
  // Prefer the business-facing number; fall back to the stable Kmaleon id.
  return legacyText(row.codigo??row.codigointerno??row.project_id);
}
function legacyCardIdentity(card:unknown):{dni:string;nombre:string;telefono:string;participantIds:string[]}|null{
  if(!card||typeof card!=='object')return null;
  const row=card as {nifnormalizado?:unknown;nif?:unknown;nombrecompleto?:unknown};
  const dni=normalizeIdentityDocument(String(row.nifnormalizado??row.nif??''));
  const nombre=String(row.nombrecompleto??'').trim();
  const telefono=legacyPhone(card);
  const participantIds=legacyParticipantIds(card);
  if(!isValidSpanishIdentityDocument(dni)||!nombre||!telefono||participantIds.length===0)return null;
  return {dni,nombre,telefono,participantIds};
}
function legacySearch(client:KmaleonClient):KmaleonSearchImplementation{
  const selected=new Map<string,{candidate:KmaleonExpedienteCandidate;participantIds:string[]}>();
  const search=async(input:{field:'dni'|'nombre';query:string;page:number})=>{
    const cardPage=input.page-1;
    const value=input.field==='dni'?normalizeIdentityDocument(input.query):input.query;
    let raw=await client.invokeRead('cards/getCards',{pageNum:cardPage,filter:filterPayload(input.field==='dni'?'nif':'nombre',input.field==='dni'?'nif':'nombre',value,input.field==='dni'?'eq':'ls')});
    let cards=resultArray(raw);
    if(input.field==='dni'&&cards.length===0){
      raw=await client.invokeRead('cards/getCards',{pageNum:cardPage,filter:filterPayload('searchall','searchall',value,'ls')});
      cards=resultArray(raw);
    }
    const items:KmaleonExpedienteCandidate[]=[];const seen=new Set<string>();let providerHasMore=totalRows(raw)>((input.page-1)*60+cards.length);
    for(const card of cards){
      const identity=legacyCardIdentity(card);if(!identity)continue;
      for(const participantId of identity.participantIds){
        const projectsRaw=await client.invokeRead('projects/getProjects',{pageNum:input.page,filter:filterPayload('interviniente','interviniente',participantId,'eq')});
        const projects=resultArray(projectsRaw);if(totalRows(projectsRaw)>projects.length)providerHasMore=true;
        for(const project of projects){
          if(!project||typeof project!=='object')continue;
          const projectId=String((project as {project_id?:unknown}).project_id??'').trim();if(!projectId||seen.has(projectId))continue;
          const empresa=legacyCompany(project);const numeroExpediente=legacyExpedienteNumber(project);
          // A result without a linked company is not safe to present as a
          // selectable expediente. It remains searchable after Kmaleon data is
          // corrected, but cannot be silently labelled or guessed here.
          if(!empresa||!numeroExpediente)continue;
          const candidate={projectId,numeroExpediente,empresa,dni:identity.dni,nombre:identity.nombre,telefono:identity.telefono};
          const parsed=KmaleonExpedienteCandidateSchema.safeParse(candidate);if(!parsed.success)continue;
          seen.add(projectId);selected.set(projectId,{candidate:parsed.data,participantIds:identity.participantIds});items.push(parsed.data);
        }
      }
    }
    return {items,page:input.page,hasMore:providerHasMore};
  };
  const get=async(projectId:string)=>{
    const stored=selected.get(projectId);if(!stored)throw new AdapterError('KMALEON_SELECTION_REQUIRES_FRESH_SEARCH');
    const raw=await client.invokeRead('projects/getProject',{projectId:Number(projectId)||projectId});
    const project=resultArray(raw)[0];
    if(!project||typeof project!=='object'||String((project as {project_id?:unknown}).project_id??'')!==projectId)throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
    const participantIds=Array.isArray((project as {intervinientes?:unknown}).intervinientes)?(project as {intervinientes:unknown[]}).intervinientes.map(item=>String((item as {participant_id?:unknown})?.participant_id??'')).filter(Boolean):[];
    if(!stored.participantIds.some(id=>participantIds.includes(id)))throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
    const freshCompany=legacyCompany(project);const freshNumber=legacyExpedienteNumber(project);
    if(freshCompany!==stored.candidate.empresa||freshNumber!==stored.candidate.numeroExpediente)throw new AdapterError('KMALEON_PROJECT_IDENTITY_MISMATCH');
    return stored.candidate;
  };
  return {search,get};
}
/** Reads only named reviewed mapping files. Credential values are supplied by caller, never read from files. */
export async function loadConfiguredAdapters(values:Record<string,string|undefined>):Promise<ConfiguredAdapters>{
  const adapters:ConfiguredAdapters={};
  if((values.SERVICE_MODE??'setup')!=='live'||values.DATA_MODE==='mock'){if(['WHATSAPP_ENABLED','KMALEON_ENABLED','APUDATA_ENABLED','SEDE_ENABLED'].some(k=>values[k]==='true'))throw new AdapterError('SETUP_LIVE_CONNECTORS_FORBIDDEN');return adapters;}
  const outbound=values.OUTBOUND_ENABLED==='true';
  if(values.KMALEON_ENABLED==='true'){
    if(!values.KMALEON_CONFIG_FILE)throw new AdapterError('KMALEON_CONFIG_FILE_REQUIRED');
    const recipient=values.DAYANA_USER_ID?.trim();
    let recipientCode:number|undefined;
    if(recipient){const parsed=Number(recipient);if(!Number.isSafeInteger(parsed)||parsed<1)throw new AdapterError('KMALEON_RECIPIENT_CODE_INVALID');recipientCode=parsed;}
    const c=await config(values.KMALEON_CONFIG_FILE,KmaleonConfig,{baseUrl:secret(values,'KMALEON_BASE_URL'),clientId:secret(values,'KMALEON_CLIENT_ID'),clientSecretEnv:'KMALEON_CLIENT_SECRET',authState:secret(values,'KMALEON_AUTH_STATE'),redirectUri:secret(values,'KMALEON_REDIRECT_URI'),recipientCode,enabled:true});
    const client=new KmaleonClient({baseUrl:c.baseUrl,clientId:c.clientId,clientSecret:secret(values,c.clientSecretEnv),authState:c.authState,redirectUri:c.redirectUri,writesEnabled:outbound&&c.enabled,timeoutMs:positiveSetting(values,'KMALEON_TIMEOUT_MS',120000),authTimeoutMs:positiveSetting(values,'KMALEON_AUTH_TIMEOUT_MS',120000),rejectUnauthorized:values.KMALEON_REJECT_UNAUTHORIZED!=='false'});
    if(c.legacySearch){
      adapters.kmaleon=new KmaleonGateway(client,{recipientCode:c.recipientCode,mapping:reviewedKmaleonMapping(c.reviewEvidenceRef),searchImplementation:legacySearch(client),operations:new ReviewedKmaleonOperations(client,c.reviewEvidenceRef),annotationPageStart:1});
    } else {
    const m=c.mapping;if(!m)throw new AdapterError('KMALEON_MAPPING_REQUIRED');
    const normalizePhone=(value:unknown)=>typeof value==='string'?value.trim().replace(/^\+/,'').replace(/[\s().-]/g,''):'';
    const projectCandidate=(raw:unknown)=>{
      const fields=responseFields(raw,m.projects.fields);const dni=normalizeIdentityDocument(String(fields.dni??''));
      const projectId=stringId(fields.id);
      const candidate={projectId,numeroExpediente:String(fields.expedienteNumber??projectId).trim(),empresa:String(fields.company??'Empresa no indicada').trim(),dni,nombre:String(fields.name??'').trim(),telefono:normalizePhone(fields.phone)};
      if(!isValidSpanishIdentityDocument(candidate.dni))throw new AdapterError('KMALEON_PROJECT_DNI_INVALID');
      const parsed=KmaleonExpedienteCandidateSchema.safeParse(candidate);if(!parsed.success)throw new AdapterError('KMALEON_PROJECT_CONTACT_FIELDS_INVALID');return parsed.data;
    };
    adapters.kmaleon=new KmaleonGateway(client,{recipientCode:c.recipientCode,mapping:{reviewEvidenceRef:c.reviewEvidenceRef,
      projectSearchFilter(field,query){const f=m.projects.filters[field];return [{group:'and',filters:[{group:'and',filters:[{filterId:f.filterId,fields:{[f.field]:[{value:query,cond:f.condition}]}}]}]}];},
      projectSearchPage(raw,pageNum){const items=at(raw,m.projects.items);if(!Array.isArray(items))throw new AdapterError('KMALEON_PROJECT_LIST_INVALID');let hasMore:boolean;if(m.projects.hasMore){const value=at(raw,m.projects.hasMore);if(typeof value!=='boolean')throw new AdapterError('KMALEON_PROJECT_PAGINATION_INVALID');hasMore=value;}else{const total=at(raw,m.projects.totalRows!);if(typeof total!=='number'||!Number.isSafeInteger(total)||total<0)throw new AdapterError('KMALEON_PROJECT_TOTAL_ROWS_INVALID');hasMore=pageNum*m.projects.pageSize<total;if(hasMore&&items.length!==m.projects.pageSize)throw new AdapterError('KMALEON_PROJECT_PAGE_SIZE_MISMATCH');}return {items:items.map(projectCandidate),hasMore};},
      projectCandidate,
      projectIdentity(raw){return {projectId:stringId(at(raw,m.project.id)),dni:stringId(at(raw,m.project.dni))};},
      ...(m.projectAddress?{projectAddress(raw:unknown){
        const fields=responseFields(raw,m.projectAddress!);
        // Only an actual numeric project identifier may be stringified; address data has no defaults or coercions.
        const parsed=KmaleonProjectAddressSchema.safeParse({...fields,projectId:stringId(fields.projectId)});
        if(!parsed.success)throw new AdapterError('KMALEON_ADDRESS_MAPPING_INVALID');return parsed.data;
      }}:{}),
      annotationsPage(raw,pageNum){
        const items=at(raw,m.annotations.items);if(!Array.isArray(items))throw new AdapterError('KMALEON_ANNOTATION_LIST_INVALID');
        let hasMore:boolean;
        if(m.annotations.hasMore){const value=at(raw,m.annotations.hasMore);if(typeof value!=='boolean')throw new AdapterError('KMALEON_PAGINATION_PROOF_INVALID');hasMore=value;}
        else{const total=at(raw,m.annotations.totalRows!);if(typeof total!=='number'||!Number.isSafeInteger(total)||total<0)throw new AdapterError('KMALEON_TOTAL_ROWS_INVALID');hasMore=(pageNum+1)*m.annotations.pageSize!<total;if(hasMore&&items.length!==m.annotations.pageSize)throw new AdapterError('KMALEON_PAGINATION_SIZE_MISMATCH');}
        return {hasMore,items:items.map(row=>{const f=responseFields(row,m.annotations.fields);const pending=m.annotations.pendingEncoding==='opciones-P'?typeof f.pending==='string'&&f.pending.includes('P'):f.pending;
          if((m.annotations.pendingEncoding==='opciones-P'&&typeof f.pending!=='string')||typeof pending!=='boolean'||typeof f.text!=='string')throw new AdapterError('KMALEON_ANNOTATION_FIELDS_INVALID');const recipient=Number(f.recipientCode);if(!Number.isInteger(recipient)||recipient<1)throw new AdapterError('KMALEON_ANNOTATION_RECIPIENT_INVALID');
          return {id:stringId(f.id),projectId:stringId(f.projectId),text:f.text,recipientCode:recipient,pending,...(f.documentId!==null&&f.documentId!==undefined&&f.documentId!==''?{documentId:stringId(f.documentId)}:{})};})};
      },
      documentBytes(raw){const encoded=at(raw,m.document.base64);if(typeof encoded!=='string'||encoded.length>36*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new AdapterError('KMALEON_DOCUMENT_ENCODING_INVALID');return Buffer.from(encoded,'base64');},
    }});
    }
  }
  if(values.APUDATA_ENABLED==='true'){
    if(!values.APUDATA_CONFIG_FILE)throw new AdapterError('APUDATA_CONFIG_FILE_REQUIRED');
    const c=await config(values.APUDATA_CONFIG_FILE,ApudataConfig,{baseUrl:secret(values,'APUDATA_BASE_URL'),accessTokenEnv:'APUDATA_ACCESS_TOKEN',enabled:true,payment:{iban:secret(values,'APUDATA_PAYMENT_IBAN'),amountCents:3500,currency:'EUR',evidenceRef:secret(values,'APUDATA_PAYMENT_EVIDENCE_REF')}});const m=c.mapping;
    // Creation must carry a stable provider-side idempotency reference; do not invent a header guarantee.
    const carriesKey=(request:z.infer<typeof RequestMap>)=>request.path.includes('{idempotencyKey}')||Object.values(request.body??{}).some(binding=>'source'in binding&&binding.source==='idempotencyKey');
    if(!carriesKey(m.createOrder)||!carriesKey(m.findOrder)||!carriesKey(m.preapprove))throw new AdapterError('APUDATA_IDEMPOTENCY_MAPPING_REQUIRED');
    const order=(raw:unknown)=>{const parsed=ApudataOrderSchema.safeParse(responseFields(raw,m.orderFields));if(!parsed.success)throw new AdapterError('APUDATA_ORDER_MAPPING_INVALID');return parsed.data;};
    const client=new ApudataClient({baseUrl:c.baseUrl,accessToken:secret(values,c.accessTokenEnv),writesEnabled:outbound&&c.enabled,reviewedMapping:{reviewEvidenceRef:c.reviewEvidenceRef,
      preapproveRequest(input){return mappedRequest(m.preapprove,input,values);},
      parseApproval(raw){const parsed=ApudataApprovalSchema.safeParse(responseFields(raw,m.approvalFields));if(!parsed.success)throw new AdapterError('APUDATA_APPROVAL_MAPPING_INVALID');return parsed.data;},
      findOrderRequest(key){return mappedRequest(m.findOrder,{idempotencyKey:key},values);},
      parseFoundOrder(raw){const root=at(raw,m.foundOrderRoot);if(root===null)return null;if(Array.isArray(root)){if(root.length===0)return null;if(root.length!==1)throw new AdapterError('APUDATA_ORDER_LOOKUP_AMBIGUOUS');return order(root[0]);}return order(root);},
      createOrderRequest(input){return mappedRequest(m.createOrder,{clientId:input.clientId,idempotencyKey:input.idempotencyKey,approvalId:input.approval.id,approvalEvidenceRef:input.approval.evidenceRef,approvalExpiresAt:input.approval.expiresAt,paymentEvidenceRef:input.paymentEvidenceRef,amountCents:input.amountCents,currency:input.currency},values);},
      parseCreatedOrder(raw){return order(at(raw,m.createdOrderRoot));},
    }});
    adapters.apudata=new ApudataGateway(client,c.payment);
  }
  if(values.SEDE_ENABLED==='true'){if(!values.SEDE_RECIPE_FILE)throw new AdapterError('SEDE_RECIPE_FILE_REQUIRED');const c=await config(values.SEDE_RECIPE_FILE,SedeConfig,{enabled:true});adapters.sede=new SedePlaywright({recipe:c.recipe as SedeDraftRecipe,writesEnabled:outbound&&c.enabled});}
  return adapters;
}
