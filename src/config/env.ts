import {resolve,dirname} from 'node:path';
import {z} from 'zod';
const selectedEnv=process.env.ENV_FILE;
const bool=z.enum(['true','false']).default('false').transform(v=>v==='true');
const optional=z.string().optional().transform(v=>v?.trim()||undefined);
const optionalPath=optional.transform(v=>v?resolve(selectedEnv?dirname(resolve(selectedEnv)):process.cwd(),v):undefined);
const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  SERVICE_MODE:z.enum(['setup','live']).default('setup'), DATA_MODE:z.enum(['real','mock']).default('real'),
  HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().int().min(0).max(65535).default(4720),
  DATABASE_URL:z.string().url(),REDIS_URL:z.string().url(),QUEUE_PREFIX:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).default('apod'),
  OPERATOR_TOKEN:z.string().min(32),LOG_LEVEL:z.enum(['debug','info','warn','error']).default('info'),
  STORAGE_DIR:z.string().default('./storage').transform(v=>resolve(selectedEnv?dirname(resolve(selectedEnv)):process.cwd(),v)),MAX_DOCUMENT_BYTES:z.coerce.number().int().min(1024).max(30000000).default(15000000),
  OUTBOUND_ENABLED:bool,WORKERS_ENABLED:z.enum(['true','false']).default('true').transform(v=>v==='true'),
  AIRAM_FULL_NAME:optional,REPRESENTATIVES_FILE:optionalPath,TUTORIAL_FILE:optionalPath,CONSENT_VERSION:optional,CONSENT_TEXT_FILE:optionalPath,
  REVOCATION_GUIDE_FILE:optionalPath,REVOCATION_SCREENSHOTS_FILE:optionalPath,WA_TEMPLATE_CONFIG_FILE:optionalPath,
  WHATSAPP_ENABLED:bool,WA_ACCESS_TOKEN:optional,WA_PHONE_NUMBER_ID:optional,WA_BUSINESS_ACCOUNT_ID:optional,WA_APP_SECRET:optional,WA_VERIFY_TOKEN:optional,
  WA_GRAPH_VERSION:z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  KMALEON_ENABLED:bool,KMALEON_CONFIG_FILE:optionalPath,KMALEON_BASE_URL:optional,KMALEON_CLIENT_ID:optional,KMALEON_CLIENT_SECRET:optional,KMALEON_AUTH_STATE:optional,KMALEON_REDIRECT_URI:optional,CARMEN_USER_ID:optional,
  APUDATA_ENABLED:bool,APUDATA_CONFIG_FILE:optionalPath,APUDATA_BASE_URL:optional,APUDATA_ACCESS_TOKEN:optional,APUDATA_ACCOUNT_ID:optional,APUDATA_PAYMENT_IBAN:optional,APUDATA_PAYMENT_EVIDENCE_REF:optional,
  APUDATA_CALLBACK_SECRET:optional,APUDATA_CALLBACK_PROTOCOL_REVIEWED:bool,
  SEDE_ENABLED:bool,SEDE_RECIPE_FILE:optionalPath,GEO_CATALOG_FILE:optionalPath,PUBLIC_BASE_URL:optional,
}).superRefine((e,ctx)=>{
  const reject=(message:string)=>ctx.addIssue({code:'custom',message});
  if(e.SERVICE_MODE==='setup'&&e.DATA_MODE!=='mock'&&(e.OUTBOUND_ENABLED||e.WHATSAPP_ENABLED||e.KMALEON_ENABLED||e.APUDATA_ENABLED||e.SEDE_ENABLED))reject('SETUP_MODE_REQUIRES_LIVE_CONNECTORS_DISABLED');
  if(e.DATA_MODE==='mock'){
    const database=new URL(e.DATABASE_URL);const redis=new URL(e.REDIS_URL);
    if(e.NODE_ENV!=='test'||e.SERVICE_MODE!=='setup'||!['127.0.0.1','localhost','::1','[::1]'].includes(e.HOST)||!['127.0.0.1','localhost'].includes(database.hostname)||!['127.0.0.1','localhost'].includes(redis.hostname)||!/^apod_setup_[a-z0-9_]+$/.test(database.searchParams.get('schema')??'')||!/^apod-setup-[a-z0-9-]+$/.test(e.QUEUE_PREFIX))reject('MOCK_DATA_REQUIRES_ISOLATED_LOCAL_TEST_RESOURCES');
    if(e.WHATSAPP_ENABLED||e.KMALEON_ENABLED||e.APUDATA_ENABLED||e.SEDE_ENABLED)reject('MOCK_DATA_CANNOT_ENABLE_LIVE_CONNECTORS');
  }
  if(e.PORT===0&&e.NODE_ENV!=='test')reject('EPHEMERAL_PORT_REQUIRES_TEST');
  const needs=(enabled:boolean,keys:(keyof typeof e)[])=>{if(enabled)for(const key of keys)if(!e[key])reject('MISSING_'+key);};
  needs(e.WHATSAPP_ENABLED,['WA_ACCESS_TOKEN','WA_PHONE_NUMBER_ID','WA_APP_SECRET','WA_VERIFY_TOKEN']);
  needs(e.KMALEON_ENABLED,['KMALEON_CONFIG_FILE','KMALEON_BASE_URL','KMALEON_CLIENT_ID','KMALEON_CLIENT_SECRET','KMALEON_AUTH_STATE','KMALEON_REDIRECT_URI']);
  needs(e.APUDATA_ENABLED,['APUDATA_CONFIG_FILE','APUDATA_BASE_URL','APUDATA_ACCESS_TOKEN','APUDATA_PAYMENT_IBAN','APUDATA_PAYMENT_EVIDENCE_REF']);
  needs(e.SEDE_ENABLED,['SEDE_RECIPE_FILE','CONSENT_VERSION','CONSENT_TEXT_FILE']);
  if(e.CARMEN_USER_ID&&!/^[1-9]\d*$/.test(e.CARMEN_USER_ID))reject('CARMEN_USER_ID_MUST_BE_NUMERIC');
});
export type Env=z.infer<typeof schema>;
/** Explicit overrides win, including isolated setup test values. Never logs values. */
export function loadEnv(values:Record<string,string|undefined>=process.env):Env{return Object.freeze(schema.parse(values));}
export function readinessConfig(e:Env){return {
  serviceMode:e.SERVICE_MODE,dataMode:e.DATA_MODE,simulationEnabled:e.DATA_MODE==='mock',
  outboundEnabled:e.DATA_MODE==='mock'?false:e.OUTBOUND_ENABLED,
  whatsapp:e.WHATSAPP_ENABLED&&Boolean(e.WA_ACCESS_TOKEN&&e.WA_PHONE_NUMBER_ID&&e.WA_APP_SECRET&&e.WA_VERIFY_TOKEN),
  kmaleon:e.KMALEON_ENABLED&&Boolean(e.KMALEON_CONFIG_FILE&&e.KMALEON_CLIENT_SECRET),
  apudata:e.APUDATA_ENABLED&&Boolean(e.APUDATA_CONFIG_FILE&&e.APUDATA_ACCESS_TOKEN),
  sede:e.SEDE_ENABLED&&Boolean(e.SEDE_RECIPE_FILE&&e.CONSENT_VERSION&&e.CONSENT_TEXT_FILE),
  representatives:Boolean(e.AIRAM_FULL_NAME&&e.REPRESENTATIVES_FILE),tutorial:Boolean(e.TUTORIAL_FILE),email:'DISABLED_HUMAN_TOKEN_REQUIRED',
};}
