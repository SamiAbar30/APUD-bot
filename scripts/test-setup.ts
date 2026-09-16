/** User-authorized setup exercise: real application/infrastructure, artificial data and offline provider ports. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {parse} from 'dotenv';
import {PrismaClient,type BotApodExpediente} from '@prisma/client';
import {Redis} from 'ioredis';
import Redlock from 'redlock';
import {loadEnv} from '../src/config/env.js';
import {WorkflowService} from '../src/core/workflow-service.js';
import {DocumentStorage} from '../src/infrastructure/storage.js';
import {ActionExecutor} from '../src/queue/action-executor.js';
import {createQueues} from '../src/queue/queues.js';
import {startWorkers} from '../src/queue/workers.js';
import {createServer} from '../src/api/server.js';
import {PdfAuditor} from '../src/core/pdf-auditor.js';
import {MockProviders,sha} from './testing/mock-providers.js';
import {makeMockPdf,mockDni,MOCK_AIRAM} from './testing/mock-pdf.js';

const runId=randomUUID();const schema='apod_setup_'+runId.replaceAll('-','');
const queuePrefix='apod-setup-'+runId;const runDir=resolve('.runtime/setup-tests',runId);
const assertions:Array<{name:string;passed:true}>=[];
const report:Record<string,unknown>={runId,startedAt:new Date().toISOString(),validation:'SETUP_WITH_MOCK_DATA',productionVerified:false,externalProviderCalls:0,emailInteraction:'NONE',schema,queuePrefix,storage:runDir,assertions};
function check(name:string,condition:unknown):void{assert.ok(condition,name);assertions.push({name,passed:true});console.log('PASS '+name);}
function localUrl(value:string|undefined,kind:'postgres'|'redis'):URL{
  assert.ok(value,`${kind.toUpperCase()}_LOCAL_URL_REQUIRED`);const url=new URL(value);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),`${kind.toUpperCase()}_MUST_BE_LOOPBACK`);
  assert.ok(kind==='postgres'?['postgresql:','postgres:'].includes(url.protocol):url.protocol==='redis:',`${kind.toUpperCase()}_PROTOCOL_INVALID`);
  if(kind==='postgres')assert.ok(['/apoderamientos','/apoderamientos_setup'].includes(url.pathname),'SETUP_DATABASE_NOT_APPROVED');
  assert.equal(url.hash,'','URL_FRAGMENT_NOT_ALLOWED');return url;
}
async function migrate(databaseUrl:string){
  const status=await new Promise<number|null>((resolveExit,reject)=>{
    const child=spawn(process.execPath,[resolve('node_modules/prisma/build/index.js'),'migrate','deploy'],{
      cwd:process.cwd(),env:{PATH:process.env.PATH??'',DATABASE_URL:databaseUrl,PRISMA_HIDE_UPDATE_MESSAGE:'true',CHECKPOINT_DISABLE:'1'},stdio:['ignore','pipe','pipe'],
    });
    // Prisma may echo connection details. Never send its raw output to logs/reports.
    child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('exit',resolveExit);
  });
  assert.equal(status,0,'ISOLATED_SCHEMA_MIGRATION_FAILED');
}
let db:PrismaClient|undefined;let redis:Redis|undefined;
let queues:ReturnType<typeof createQueues>|undefined;
let server:Awaited<ReturnType<typeof createServer>>|undefined;
let workers:ReturnType<typeof startWorkers>|undefined;
const providers=new MockProviders();
try{
  assert.ok(/^apod_setup_[a-f0-9]{32}$/.test(schema));
  await mkdir(runDir,{recursive:true,mode:0o700});await mkdir(resolve('evidence'),{recursive:true,mode:0o700});
  const selectedEnvFile=resolve(process.env.ENV_FILE??'.env');
  const fileBytes=await readFile(selectedEnvFile);
  const infrastructure=(()=>{
    // The selected dotenv file is parsed in full. Retain only these two allowed values.
    // Never spread process.env (or the parsed file) into the isolated mock configuration.
    try{const parsed=parse(fileBytes);return {DATABASE_URL:parsed.DATABASE_URL,REDIS_URL:parsed.REDIS_URL};}
    finally{fileBytes.fill(0);}
  })();
  const pg=localUrl(process.env.SETUP_DATABASE_URL??infrastructure.DATABASE_URL,'postgres');
  const redisUrl=localUrl(process.env.SETUP_REDIS_URL??infrastructure.REDIS_URL,'redis');
  pg.searchParams.set('schema',schema);
  await migrate(pg.toString());
  db=new PrismaClient({datasources:{db:{url:pg.toString()}},log:[]});await db.$connect();
  redis=new Redis(redisUrl.toString(),{maxRetriesPerRequest:null,lazyConnect:true});await redis.connect();
  check('Real PostgreSQL responds inside this run schema',(await db.$queryRaw<Array<{schema:string}>>`SELECT current_schema() AS schema`)[0]?.schema===schema);
  check('Real Redis responds',await redis.ping()==='PONG');
  const guide=await makeMockPdf(mockDni(10000000),{pages:1,label:'MOCK GUIDE ONLY'});
  const guidePath=resolve(runDir,'mock-guide.pdf');await writeFile(guidePath,guide,{mode:0o600});guide.fill(0);
  const rosterPath=resolve(runDir,'mock-representatives.json');
  await writeFile(rosterPath,JSON.stringify({approvedBy:'MOCK OPERATOR',approvedAt:new Date().toISOString(),representatives:[{fullName:MOCK_AIRAM,role:'PROCURADOR',college:'MOCK COLLEGE',registration:'MOCK-ONLY'}]}),{mode:0o600});
  const operatorToken=randomBytes(32).toString('hex');const appSecret=randomBytes(32).toString('hex');
  const mockValues:Record<string,string|undefined>={NODE_ENV:'test',SERVICE_MODE:'setup',DATA_MODE:'mock',HOST:'127.0.0.1',PORT:'4721',DATABASE_URL:pg.toString(),REDIS_URL:redisUrl.toString(),QUEUE_PREFIX:queuePrefix,OPERATOR_TOKEN:operatorToken,LOG_LEVEL:'error',STORAGE_DIR:resolve(runDir,'pdf'),OUTBOUND_ENABLED:'true',WORKERS_ENABLED:'true',WHATSAPP_ENABLED:'false',KMALEON_ENABLED:'false',APUDATA_ENABLED:'false',SEDE_ENABLED:'false',AIRAM_FULL_NAME:MOCK_AIRAM,REPRESENTATIVES_FILE:rosterPath,TUTORIAL_FILE:guidePath,REVOCATION_GUIDE_FILE:guidePath,REVOCATION_SCREENSHOTS_FILE:guidePath,WA_PHONE_NUMBER_ID:'999000000000',WA_APP_SECRET:appSecret,WA_VERIFY_TOKEN:randomBytes(24).toString('hex')};
  const env=loadEnv(mockValues);
  check('Mock configuration does not inherit provider keys, accounts or connector enablement',
    !env.WHATSAPP_ENABLED&&!env.KMALEON_ENABLED&&!env.APUDATA_ENABLED&&!env.SEDE_ENABLED&&
    [env.WA_ACCESS_TOKEN,env.WA_BUSINESS_ACCOUNT_ID,env.KMALEON_CLIENT_SECRET,env.KMALEON_CLIENT_ID,env.KMALEON_BASE_URL,env.KMALEON_CONFIG_FILE,env.CARMEN_USER_ID,env.APUDATA_ACCESS_TOKEN,env.APUDATA_ACCOUNT_ID,env.APUDATA_BASE_URL,env.APUDATA_CONFIG_FILE,env.APUDATA_CALLBACK_SECRET,env.APUDATA_PAYMENT_IBAN,env.SEDE_RECIPE_FILE].every(value=>value===undefined));
  queues=createQueues(redis,queuePrefix);
  const flow=new WorkflowService(db,new Redlock([redis],{retryCount:10,retryDelay:100,retryJitter:30}),new DocumentStorage(env.STORAGE_DIR,env.MAX_DOCUMENT_BYTES),env);
  const executor=new ActionExecutor(flow,providers.adapters,providers.wa,queues);
  server=await createServer(flow,executor,queues,redis);await server.listen({host:'127.0.0.1',port:0});
  const address=server.server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  workers=startWorkers(flow,executor,queues,redis,server.log);
  async function http(path:string,body?:unknown,expected=200,authorized=true){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(authorized?{authorization:'Bearer '+operatorToken}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json() as Record<string,any>;
    assert.equal(response.status,expected,`HTTP ${path}: expected ${expected}, got ${response.status}, ${data.error??''}`);return data;
  }
  async function until(name:string,predicate:()=>Promise<boolean>,ms=25000){
    const deadline=Date.now()+ms;while(Date.now()<deadline){await workers!.dispatch();if(await predicate())return;await delay(150);}
    const states=await db!.botApodExpediente.findMany({select:{id:true,currentState:true,auditStatus:true}});
    const actions=await db!.botApodAccion.findMany({where:{status:{notIn:['EXECUTED','AWAITING_DELIVERY']}},select:{actionType:true,status:true,lastError:true}});
    report.failureState={states,actions};throw new Error('TIMEOUT_'+name);
  }
  const cget=(id:string)=>db!.botApodExpediente.findUniqueOrThrow({where:{id}});
  const envelope=(value:Record<string,unknown>)=>({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:env.WA_PHONE_NUMBER_ID},...value}}]}]});
  async function webhook(value:Record<string,unknown>,valid=true,expected=200){
    const raw=JSON.stringify(envelope(value));const signature='sha256='+createHmac('sha256',valid?appSecret:'wrong-secret').update(raw).digest('hex');
    const response=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature},body:raw});
    const data=await response.json();assert.equal(response.status,expected,'Signed webhook HTTP status');return data;
  }
  async function createCase(index:number,fromKmaleon=false){
    const candidate={projectId:'mock-project-'+index,numeroExpediente:'MOCK-EXP-'+index,empresa:'MOCK EMPRESA',dni:mockDni(10000000+index),nombre:`MOCK SETUP PERSON ${index}`,telefono:'999000'+String(index).padStart(6,'0')};
    providers.projects.set(candidate.projectId,candidate);
    const result=fromKmaleon
      ? await (async()=>{const found=await http(`/api/kmaleon/search?field=dni&q=${encodeURIComponent(candidate.dni)}`);check('Kmaleon search returns the selected expediente',found.items?.length===1&&found.items[0].projectId===candidate.projectId);return http('/api/cases/from-kmaleon',{projectId:candidate.projectId},201);})()
      : await http('/api/cases',{nombre:candidate.nombre,dni:candidate.dni,telefono:candidate.telefono,kmaleonExpedienteId:candidate.projectId,identityVerified:true},201);
    providers.identities.set(String(result.kmaleonExpedienteId),String(result.dni));return result as BotApodExpediente;
  }
  async function uploadInbound(c:BotApodExpediente,bytes:Buffer,duplicate=false){
    const mediaId=String(800000+providers.documents.size);providers.documents.set(mediaId,Buffer.from(bytes));
    const externalId='mock-inbound-'+randomUUID();const message={id:externalId,from:c.telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'document',document:{id:mediaId,mime_type:'application/pdf',sha256:sha(bytes)}};
    await webhook({messages:[message]});
    const first=await db!.botApodInbox.findUniqueOrThrow({where:{externalId}});
    if(duplicate){await webhook({messages:[message]});const second=await db!.botApodInbox.findUniqueOrThrow({where:{externalId}});check('Duplicate signed webhook retains the same inbox row and debounce deadline',first.id===second.id&&first.notBefore.getTime()===second.notBefore.getTime());}
    await until('PDF_AUDIT',async()=>{const latest=await cget(c.id);if(!latest.documentId||!latest.auditStatus)return false;const selected=await db!.botApodDocumento.findUnique({where:{id:latest.documentId}});return selected?.sha256Hash===sha(bytes)&&(selected.rawAuditJson as Record<string,unknown>)?.status!=='PENDING';});
    const current=await cget(c.id);assert.ok(current.documentId);const doc=await db!.botApodDocumento.findUniqueOrThrow({where:{id:current.documentId}});
    check('Actual worker audited the stored PDF bytes',doc.sha256Hash===sha(bytes)&&doc.pageCount>0&&!(doc.rawAuditJson as Record<string,unknown>).extractedText);
    return doc;
  }
  async function approve(c:BotApodExpediente,documentId:string,digest:string,options:{clientReviewed?:boolean;clientEvidenceRef?:string}={}){
    const fresh=await cget(c.id);
    return http(`/api/cases/${c.id}/documents/${documentId}/approve`,{version:fresh.version,sha256:digest,reviewer:'MOCK HUMAN REVIEWER',evidenceRef:'mock-operator-review-'+runId,identityConfirmed:true,representativesConfirmed:true,powersReviewed:true,clientReviewed:options.clientReviewed??true,clientEvidenceRef:options.clientEvidenceRef??'mock-client-review-'+runId});
  }
  async function latestAccepted(c:BotApodExpediente,template:string){
    await until(template,async()=>Boolean(await db!.botApodAccion.findFirst({where:{expedienteId:c.id,status:'AWAITING_DELIVERY',payload:{path:['template'],equals:template}}})));
    return db!.botApodAccion.findFirstOrThrow({where:{expedienteId:c.id,status:'AWAITING_DELIVERY',payload:{path:['template'],equals:template}},orderBy:{createdAt:'desc'}});
  }
  async function delivered(c:BotApodExpediente,messageId:string,duplicate=false){
    const status={id:messageId,recipient_id:c.telefono,timestamp:String(Math.floor(Date.now()/1000)),status:'delivered'};
    await webhook({statuses:[status]});if(duplicate)await webhook({statuses:[status]});
    await until('DELIVERED_STATUS',async()=>(await db!.botApodInbox.findUnique({where:{externalId:`wa-status-${messageId}-delivered`}}))?.status==='PROCESSED');
  }

  const health=await http('/health/ready');check('Actual HTTP server is ready',health.status==='ready');
  // Populated artificial secrets must not turn the normal setup into a live webhook ingress.
  const closedEnv=loadEnv({...mockValues,DATA_MODE:'real',OUTBOUND_ENABLED:'false',WA_ACCESS_TOKEN:'mock-disabled-token',APUDATA_CALLBACK_SECRET:'mock-disabled-callback-secret',APUDATA_CALLBACK_PROTOCOL_REVIEWED:'true'});
  const closedFlow=new WorkflowService(db,flow.redlock,flow.storage,closedEnv);
  const closedServer=await createServer(closedFlow,new ActionExecutor(closedFlow,{},undefined,queues),queues,redis);
  try{
    await closedServer.listen({host:'127.0.0.1',port:0});const closedAddress=closedServer.server.address();assert.ok(closedAddress&&typeof closedAddress!=='string');
    const closedBase='http://127.0.0.1:'+closedAddress.port;const countBefore=await db.botApodInbox.count();
    const challenge=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':closedEnv.WA_VERIFY_TOKEN!,'hub.challenge':'mock-challenge'});
    const blockedRequests=[{url:'/webhooks/whatsapp?'+challenge.toString(),method:'GET'}, {url:'/webhooks/whatsapp',method:'POST'}, {url:'/webhooks/apudata',method:'POST'}];
    for(const request of blockedRequests){
      const raw=JSON.stringify(envelope({messages:[]}));const blocked=await fetch(closedBase+request.url,{method:request.method,...(request.method==='POST'?{headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',appSecret).update(raw).digest('hex')},body:raw}:{})});
      assert.equal(blocked.status,503,'Disabled setup connector must return 503: '+request.url.split('?')[0]);await blocked.body?.cancel();
    }
    check('Setup with populated keys still blocks both WhatsApp hooks and Apudata hook',await db.botApodInbox.count()===countBefore);
  }finally{await closedServer.close();}
  const beforeUnauthorized=await db.botApodExpediente.count();
  await http('/api/cases',{nombre:'MOCK UNAUTHORIZED'},401,false);await webhook({messages:[]},false,401);
  check('Unauthorized API and invalid signed webhook cannot mutate data',await db.botApodExpediente.count()===beforeUnauthorized&&await db.botApodInbox.count()===0);
  const finalCase=await createCase(1,true);const finalPdf=await makeMockPdf(finalCase.dni,{label:'FINAL FLOW'});
  const finalDoc=await uploadInbound(finalCase,finalPdf,true);
  check('Five-page fixture passes actual structural auditor',(finalDoc.rawAuditJson as Record<string,unknown>).isValid===true);
  await workers.dispatch();await delay(300);
  check('Missing human approval never uploads',providers.uploadCalls===0&&(await cget(finalCase.id)).currentState==='AUDITING_DOCUMENT');
  const beforeReview=await cget(finalCase.id);
  const denied=await fetch(base+`/api/cases/${finalCase.id}/documents/${finalDoc.id}/approve`,{method:'POST',headers:{authorization:'Bearer '+operatorToken,'content-type':'application/json'},body:JSON.stringify({version:beforeReview.version,sha256:finalDoc.sha256Hash,reviewer:'MOCK HUMAN REVIEWER',evidenceRef:'mock-review',identityConfirmed:true,representativesConfirmed:true,powersReviewed:true,clientReviewed:false})});
  check('Missing client review evidence is rejected',denied.status===409&&(await cget(finalCase.id)).version===beforeReview.version&&providers.uploadCalls===0);await denied.body?.cancel();
  await approve(finalCase,finalDoc.id,finalDoc.sha256Hash);
  const finalMessage=await latestAccepted(finalCase,'COMPLETION_NOTICE');
  check('Verified mock filing and Dayana aviso precede final delivery',providers.uploads.size===1&&providers.notices.size===1&&(await cget(finalCase.id)).currentState==='HANDOFF_DAYANA');
  const beforeDeliveryVersion=(await cget(finalCase.id)).version;
  await delivered(finalCase,String((finalMessage.receipt as Record<string,unknown>).messageId),true);
  check('Final state becomes COMPLETED only after signed delivery callback',(await cget(finalCase.id)).currentState==='COMPLETED');
  const completedVersion=(await cget(finalCase.id)).version;
  check('Duplicate delivery callback is idempotent',completedVersion===beforeDeliveryVersion+1&&await db.botApodInbox.count({where:{externalId:`wa-status-${String((finalMessage.receipt as Record<string,unknown>).messageId)}-delivered`}})===1);
  const uploadAction=await db.botApodAccion.findFirstOrThrow({where:{expedienteId:finalCase.id,actionType:'UPLOAD_KMALEON_DOCUMENT'}});const callsBeforeReplay=providers.uploadCalls;
  const replay=await queues.kmaleon.add('effect',{actionId:uploadAction.id},{jobId:'mock-replay-'+runId});
  await until('IDEMPOTENT_ACTION_REPLAY',async()=>await replay.getState()==='completed');
  check('Replaying completed queued action does not resend or reupload',providers.uploadCalls===callsBeforeReplay&&(await cget(finalCase.id)).version===completedVersion);
  finalPdf.fill(0);

  const provisional=await createCase(2);const provisionalPdf=await makeMockPdf(provisional.dni,{pages:3,label:'PROVISIONAL FLOW'});
  const provisionalDoc=await uploadInbound(provisional,provisionalPdf);
  check('Three-page fixture is eligible for human provisional review',(provisionalDoc.rawAuditJson as Record<string,unknown>).canViabilize===true);
  await approve(provisional,provisionalDoc.id,provisionalDoc.sha256Hash);
  const revokeMessage=await latestAccepted(provisional,'PROVISIONAL_FILED_REVOKE_AND_REISSUE');
  await delivered(provisional,String((revokeMessage.receipt as Record<string,unknown>).messageId));
  check('Provisional filing remains pending after delivery',(await cget(provisional.id)).currentState==='REVOCATION_GUIDE_SENT'&&(await cget(provisional.id)).isProvisionalFiled);
  await webhook({messages:[{id:'mock-revoked-'+randomUUID(),from:provisional.telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'interactive',interactive:{button_reply:{id:'REVOKED'}}}]});
  await until('WAITING_REISSUE',async()=>(await cget(provisional.id)).currentState==='WAITING_REVOCATION_REISSUE');
  const reissuedPdf=await makeMockPdf(provisional.dni,{label:'REISSUED FINAL FLOW'});const reissuedDoc=await uploadInbound(provisional,reissuedPdf);
  await approve(provisional,reissuedDoc.id,reissuedDoc.sha256Hash);const reissuedNotice=await latestAccepted(provisional,'COMPLETION_NOTICE');await delivered(provisional,String((reissuedNotice.receipt as Record<string,unknown>).messageId));
  check('Reissued final document closes the provisional loop',(await cget(provisional.id)).currentState==='COMPLETED'&&!(await cget(provisional.id)).isProvisionalFiled);
  provisionalPdf.fill(0);reissuedPdf.fill(0);

  for(const scenario of [{name:'No Airam',options:{airam:false},predicate:(r:Awaited<ReturnType<typeof PdfAuditor.audit>>)=>!r.hasAiram&&!r.isValid&&!r.canViabilize},{name:'Wrong identity',options:{},predicate:(r:Awaited<ReturnType<typeof PdfAuditor.audit>>)=>!r.identityMatches&&!r.isValid&&!r.canViabilize},{name:'Negated power',options:{negateAllanamiento:true},predicate:(r:Awaited<ReturnType<typeof PdfAuditor.audit>>)=>r.missingPowers.includes('ALLANAMIENTO')&&!r.isValid&&r.requiresHumanReview}]){
    const bytes=await makeMockPdf(mockDni(10000004),scenario.options);const audited=await PdfAuditor.audit(bytes,{expectedDni:scenario.name==='Wrong identity'?mockDni(10000005):mockDni(10000004),airamFullName:MOCK_AIRAM});bytes.fill(0);check('Actual PDF auditor rejects '+scenario.name,scenario.predicate(audited));
  }
  const paid=await createCase(3);
  const paymentBody={version:paid.version,operatorId:'MOCK OPERATOR',approvalId:'mock-none',paymentEvidenceRef:'mock-payment-'+runId,amountCents:3500,currency:'EUR',paymentVerified:true};
  await http(`/api/cases/${paid.id}/payment-confirmation`,paymentBody,409);
  check('Payment is blocked before partner preapproval',providers.orderCalls===0&&(await cget(paid.id)).version===paid.version);
  await webhook({messages:[{id:'mock-paid-path-'+randomUUID(),from:paid.telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'interactive',interactive:{button_reply:{id:'APUDATA_REQUEST'}}}]});
  await until('PARTNER_PREAPPROVAL',async()=>(await cget(paid.id)).currentState==='APUDATA_WAITING_PAYMENT');
  const paymentInstruction=await latestAccepted(paid,'APUDATA_PAYMENT_DETAILS');
  check('Payment instructions require a bound unexpired mock approval',providers.preapprovalCalls===1&&providers.orderCalls===0&&paymentInstruction.status==='AWAITING_DELIVERY');
  const waitingPayment=await cget(paid.id);const approval=waitingPayment.apudataApprovalEvidence as Record<string,unknown>;
  await http(`/api/cases/${paid.id}/payment-confirmation`,{...paymentBody,version:waitingPayment.version,approvalId:'mock-wrong'},409);
  await http(`/api/cases/${paid.id}/payment-confirmation`,{...paymentBody,version:waitingPayment.version,approvalId:approval.id,amountCents:1},400);
  check('Wrong approval and wrong amount never create an order',providers.orderCalls===0&&(await cget(paid.id)).version===waitingPayment.version);
  await http(`/api/cases/${paid.id}/payment-confirmation`,{...paymentBody,version:waitingPayment.version,approvalId:approval.id});
  await until('PAID_ORDER',async()=>(await cget(paid.id)).currentState==='APUDATA_VIDEO_IN_PROGRESS');
  await latestAccepted(paid,'APUDATA_VIDEO_INSTRUCTIONS');
  check('Valid evidence creates one mock order and leaves video pending',providers.orders.size===1&&(await cget(paid.id)).currentState==='APUDATA_VIDEO_IN_PROGRESS');
  const paidVersion=(await cget(paid.id)).version;
  await http(`/api/cases/${paid.id}/payment-confirmation`,{...paymentBody,version:paidVersion,approvalId:approval.id},409);
  check('Duplicate payment cannot create another order',providers.orders.size===1&&providers.orderCalls===1);

  const finalCases=await db.botApodExpediente.findMany({select:{id:true,nombre:true,currentState:true,version:true}});
  report.cases=finalCases;report.counts={cases:finalCases.length,documents:await db.botApodDocumento.count(),auditLogs:await db.botApodAuditLog.count(),inbox:await db.botApodInbox.count(),actions:await db.botApodAccion.count(),mockProviderUploads:providers.uploads.size,mockProviderNotices:providers.notices.size,mockProviderMessages:providers.messages.length,mockProviderOrders:providers.orders.size};
  report.result='PASS';report.retention='Isolated PostgreSQL schema and local generated PDFs retained for inspection. Redis queues removed only within this run prefix.';
}catch(error){if(db)report.failureState=await Promise.all([db.botApodExpediente.findMany({select:{id:true,currentState:true,auditStatus:true}}),db.botApodAccion.findMany({where:{status:{notIn:['EXECUTED','AWAITING_DELIVERY']}},select:{actionType:true,status:true,lastError:true}})]).then(([cases,actions])=>({cases,actions})).catch(()=>({unavailable:true}));report.result='FAIL';report.error=error instanceof Error?error.message.replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g,'[LOCAL_CONNECTION_REDACTED]'):'SETUP_TEST_ERROR';process.exitCode=1;}
finally{
  await workers?.close().catch(()=>undefined);await server?.close().catch(()=>undefined);
  if(queues){if(report.result==='PASS')await Promise.all(Object.values(queues).map(q=>q.obliterate({force:true})));await Promise.all(Object.values(queues).map(q=>q.close()));}
  await redis?.quit().catch(()=>undefined);await db?.$disconnect().catch(()=>undefined);providers.wipe();
  report.finishedAt=new Date().toISOString();
  await mkdir(resolve('evidence'),{recursive:true,mode:0o700});await writeFile(resolve('evidence/setup-test.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await mkdir(runDir,{recursive:true,mode:0o700});await writeFile(resolve(runDir,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({result:report.result,validation:report.validation,assertions:assertions.length,evidence:'evidence/setup-test.json',...(report.error?{error:report.error}:{})}));
}
