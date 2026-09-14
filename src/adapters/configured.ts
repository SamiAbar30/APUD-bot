import type {AdapterPorts} from './ports.js';
import {readFile,stat} from 'node:fs/promises';
import {z} from 'zod';
import {KmaleonClient} from './kmaleon/kmaleon-client.js';
import {KmaleonGateway} from './kmaleon/kmaleon-gateway.js';
import {ApudataClient} from './apudata/apudata-client.js';
import {ApudataGateway} from './apudata/apudata-gateway.js';
import {SedePlaywright,type SedeDraftRecipe} from './sede-judicial/sede-playwright.js';
import {ApudataApprovalSchema,ApudataOrderSchema,type ApudataRequest} from '../contracts/apudata.contract.js';
import {AdapterError} from './common/http.js';
import {KmaleonProjectAddressSchema,KmaleonExpedienteCandidateSchema} from '../contracts/kmaleon.contract.js';
import {normalizeIdentityDocument,isValidSpanishIdentityDocument} from '../domain/identity/spanish-identity-document.js';
const Path=z.string().regex(/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/).refine(v=>!v.split('.').some(k=>['__proto__','constructor','prototype'].includes(k)));
const RootPath=Path.or(z.literal(''));
const EnvName=z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/);
const SearchFilter=z.object({filterId:z.string().trim().min(1).max(80),field:z.string().trim().min(1).max(80),condition:z.string().trim().min(1).max(30)}).strict();
const Review={reviewed:z.literal(true),reviewEvidenceRef:z.string().min(5),enabled:z.boolean().default(false)};
const KmaleonConfig=z.object({
  ...Review,baseUrl:z.string().url(),clientId:z.string().min(1),clientSecretEnv:EnvName,authState:z.string().min(1),redirectUri:z.string().min(1),recipientCode:z.number().int().positive().optional(),
  mapping:z.object({
    project:z.object({id:Path,dni:Path}).strict(),
    projects:z.object({
      items:RootPath,hasMore:Path.optional(),totalRows:Path.optional(),pageSize:z.number().int().positive().max(200).default(80),
      fields:z.object({id:Path,name:Path,dni:Path,phone:Path}).strict(),
      filters:z.object({dni:SearchFilter,nombre:SearchFilter}).strict(),
    }).strict().refine(v=>Boolean(v.hasMore)||Boolean(v.totalRows&&v.pageSize),'pagination proof required'),
    projectAddress:z.object({projectId:Path,dni:Path,direccion:Path,codigoPostal:Path,provincia:Path,localidad:Path,comunidadAutonoma:Path.optional()}).strict().optional(),
    annotations:z.object({items:RootPath,hasMore:Path.optional(),totalRows:Path.optional(),pageSize:z.number().int().positive().optional(),fields:z.object({id:Path,projectId:Path,text:Path,recipientCode:Path,documentId:Path,pending:Path}).strict(),pendingEncoding:z.enum(['boolean','opciones-P']).default('boolean')}).strict().refine(v=>Boolean(v.hasMore)||Boolean(v.totalRows&&v.pageSize),'pagination proof required'),
    document:z.object({base64:Path}).strict(),
  }).strict(),
}).strict();
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
export type ConfiguredAdapters=AdapterPorts;
/** Reads only named reviewed mapping files. Credential values are supplied by caller, never read from files. */
export async function loadConfiguredAdapters(values:Record<string,string|undefined>):Promise<ConfiguredAdapters>{
  const adapters:ConfiguredAdapters={};
  if((values.SERVICE_MODE??'setup')!=='live'||values.DATA_MODE==='mock'){if(['WHATSAPP_ENABLED','KMALEON_ENABLED','APUDATA_ENABLED','SEDE_ENABLED'].some(k=>values[k]==='true'))throw new AdapterError('SETUP_LIVE_CONNECTORS_FORBIDDEN');return adapters;}
  const outbound=values.OUTBOUND_ENABLED==='true';
  if(values.KMALEON_ENABLED==='true'){
    if(!values.KMALEON_CONFIG_FILE)throw new AdapterError('KMALEON_CONFIG_FILE_REQUIRED');
    const recipient=values.CARMEN_USER_ID?.trim();
    let recipientCode:number|undefined;
    if(recipient){const parsed=Number(recipient);if(!Number.isSafeInteger(parsed)||parsed<1)throw new AdapterError('KMALEON_RECIPIENT_CODE_INVALID');recipientCode=parsed;}
    const c=await config(values.KMALEON_CONFIG_FILE,KmaleonConfig,{baseUrl:secret(values,'KMALEON_BASE_URL'),clientId:secret(values,'KMALEON_CLIENT_ID'),clientSecretEnv:'KMALEON_CLIENT_SECRET',authState:secret(values,'KMALEON_AUTH_STATE'),redirectUri:secret(values,'KMALEON_REDIRECT_URI'),...(recipientCode!==undefined?{recipientCode}:{}),enabled:true});const m=c.mapping;
    const client=new KmaleonClient({baseUrl:c.baseUrl,clientId:c.clientId,clientSecret:secret(values,c.clientSecretEnv),authState:c.authState,redirectUri:c.redirectUri,writesEnabled:outbound&&c.enabled});
    const normalizePhone=(value:unknown)=>typeof value==='string'?value.trim().replace(/^\+/,'').replace(/[\s().-]/g,''):'';
    const projectCandidate=(raw:unknown)=>{
      const fields=responseFields(raw,m.projects.fields);const dni=normalizeIdentityDocument(String(fields.dni??''));
      const candidate={projectId:stringId(fields.id),dni,nombre:String(fields.name??'').trim(),telefono:normalizePhone(fields.phone)};
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
