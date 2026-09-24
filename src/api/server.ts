import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Redis } from 'ioredis';
import type { WorkflowService } from '../core/workflow-service.js';
import type { ActionExecutor } from '../queue/action-executor.js';
import type { Queues } from '../queue/queues.js';
import { AppError,constantEqual,errorCode,requireOutbound } from '../infrastructure/security.js';
import { readinessConfig } from '../config/env.js';
import { DebounceBuffer } from '../core/debounce-buffer.js';
import { conversationActivity } from '../core/conversation-activity.js';
import { json } from '../core/workflow-service.js';
import { E } from '../core/workflow-events.js';
import { EventType } from '../domain/fsm/states.js';
import { isValidSpanishIdentityDocument,normalizeIdentityDocument } from '../domain/identity/spanish-identity-document.js';
import type { KmaleonExpedienteCandidate } from '../contracts/kmaleon.contract.js';
import { normalizeWebhook,verifyWebhookSignature,verifyWebhookChallenge } from '../adapters/whatsapp/webhook-router.js';
import { verifyApudataCallback } from '../adapters/apudata/apudata-gateway.js';
import { ApudataCallbackSchema } from '../contracts/apudata.contract.js';
import { automationRoutes } from './automation.routes.js';
import { boundedConversationHistory, redactConversationPii } from '../core/conversation-policy.js';
import { assistedRoutes } from './assisted.routes.js';
import { phaseOneRoutes } from './phase-one.routes.js';
import { addressRoutes } from './address.routes.js';
import { REPLY_BUTTON_TEXT, type ReplyButtonId } from '../contracts/whatsapp.contract.js';
import { StrictConversationAgent } from '../core/conversation-agent.js';
import { brainFromEnv } from '../config/brain.js';
import { AttachmentIntake, passwordCandidates } from '../core/attachment-intake.js';
import { CredentialVault } from '../infrastructure/credential-vault.js';
import { OpenAIVisionReader } from '../adapters/ai/openai-vision.js';
import { sha256 } from '../adapters/common/http.js';
import { OpenAICompatibleConversationModel } from '../adapters/ai/openai-compatible-conversation.js';
import { conversationAiFromEnv } from '../config/conversation-ai.js';
import { loadReferenceAgentPackage } from '../config/reference-agent.js';
import { requireAgentEvaluations } from '../config/agent-release.js';

const uuid=z.string().uuid();const idParam=z.object({id:uuid});
const version=z.number().int().nonnegative();
const caseCreate=z.object({nombre:z.string().trim().min(3).max(160),dni:z.string().transform(normalizeIdentityDocument).refine(isValidSpanishIdentityDocument,'INVALID_DNI_NIE'),telefono:z.string().regex(/^[1-9]\d{7,14}$/),kmaleonExpedienteId:z.string().min(1).max(80),empresa:z.string().trim().min(1).max(160).optional(),numeroExpediente:z.string().trim().min(1).max(160).optional(),identityVerified:z.literal(true)}).strict();
const kmaleonSearch=z.object({q:z.string().trim().min(2).max(160),field:z.enum(['dni','nombre']).default('nombre'),page:z.coerce.number().int().min(1).max(100).default(1)}).strict();
const kmaleonSelection=z.object({projectId:z.string().trim().min(1).max(160)}).strict();
const operatorEvents=[
  {type:E.start,label:'Iniciar triaje'},
  {type:E.certYes,label:'Cliente: tiene certificado digital'},
  {type:E.certNo,label:'Cliente: no tiene certificado'},
  {type:E.devicePc,label:'Cliente: certificado en ordenador'},
  {type:E.deviceMobile,label:'Cliente: certificado en móvil'},
  {type:E.hasPc,label:'Cliente: dispone de ordenador'},
  {type:E.noPc,label:'Cliente: no dispone de ordenador'},
  {type:E.assistance,label:'Cliente: solicita asistencia'},
  {type:E.court,label:'Cliente: solicita vía presencial'},
  {type:E.partner,label:'Cliente: solicita proveedor de pago'},
  {type:E.revoked,label:'Cliente: informa de revocación'},
  {type:E.consentNo,label:'Cliente: retira el consentimiento de asistencia'},
  {type:EventType.CLIENT_OPT_OUT,label:'Cliente: solicita detener el contacto'},
  {type:EventType.OPERATOR_ESCALATE,label:'Escalar a revisión humana'},
];
const buttonEvents:Record<ReplyButtonId,string>={HAS_CERT_YES:E.certYes,HAS_CERT_NO:E.certNo,DEVICE_PC:E.devicePc,DEVICE_MOBILE:E.deviceMobile,HAS_PC:E.hasPc,NO_PC:E.noPc,NEEDS_ASSISTANCE:E.assistance,CONSENT_YES:E.consentYes,CONSENT_NO:E.consentNo,DRAFT_APPROVED:E.review,DRAFT_REJECTED:EventType.CLIENT_DRAFT_REJECTED,REVOKED:E.revoked,REISSUED:EventType.CLIENT_ACKNOWLEDGED,COURT_APPOINTMENT:E.court,APUDATA_REQUEST:E.partner,HUMAN_HELP:EventType.CLIENT_REQUESTS_HUMAN};
const rolloutReplyIds=new Set(['PHASE1_GREETING','PHASE1_HELP','PHASE2_ACK','PHASE2_DEFER','PHASE3_GREETING','PHASE3_WORKFLOW','CONVERSATION_REPLY','SECURITY_ANSWER']);
export async function createServer(flow:WorkflowService,executor:ActionExecutor,queues:Queues,redis:Redis){
  const env=flow.env;
  const conversationAi=conversationAiFromEnv({
    AI_MODE:env.AI_MODE,LOCAL_AI_BASE_URL:env.LOCAL_AI_BASE_URL,LOCAL_AI_MODEL:env.LOCAL_AI_MODEL,LOCAL_AI_API_KEY:env.LOCAL_AI_API_KEY,
    AI_BASE_URL:env.AI_BASE_URL,
    AI_API_KEY:env.AI_API_KEY,
    AI_MODEL:env.AI_MODEL,
    AI_TIMEOUT_MS:String(env.AI_TIMEOUT_MS),
    AI_REDACT_PII:String(env.AI_REDACT_PII),
    AI_STREAM:String(env.AI_STREAM),
    AI_SIN_TEMPERATURE:String(env.AI_SIN_TEMPERATURE),
  });
  const referenceAgent=await loadReferenceAgentPackage(env.APOD_AGENT_PACKAGE_DIR,env.APOD_MASTER_PROMPT_FILE);
  if(env.APOD_AGENT_PACKAGE_DIR&&referenceAgent.status!=='LOADED')throw new AppError('AGENT_TRAINING_PACKAGE_NOT_LOADED',503);
  // The model is opt-in. A complete AI_* configuration by itself must never
  // activate a provider while CONVERSATION_AI_PROVIDER remains `none`.
  const conversationAiEnabled=env.CONVERSATION_AI_PROVIDER!=='none';
  const effectiveConversationAiStatus=conversationAiEnabled?conversationAi.status:'DISABLED';
  const conversationModel=conversationAiEnabled&&conversationAi.status==='CONFIGURED'
    ? new OpenAICompatibleConversationModel(conversationAi.config, referenceAgent.status==='LOADED'?referenceAgent.context:undefined)
    : undefined;
  const conversationBrain=conversationAiEnabled&&conversationAi.status==='CONFIGURED'?await brainFromEnv(conversationAi.config):undefined;
  const conversationAgent=new StrictConversationAgent(conversationModel,env.CONVERSATION_PHASE,conversationBrain);
  if(env.WHATSAPP_TRANSPORT==='meta'&&env.WHATSAPP_ENABLED&&env.OUTBOUND_ENABLED&&referenceAgent.context?.packageHash&&conversationAi.config)await requireAgentEvaluations(env.APOD_AGENT_EVAL_REPORT,referenceAgent.context.packageHash,conversationAi.config.model);
  flow.conversationAgent=conversationAgent;
  // Files clients send are read by content (PDF, certificate, screenshot…). Downloads take any type
  // the phone may label a file with; what it really is comes from its bytes.
  if(executor.wa&&(process.env.ATTACHMENT_INTAKE??'on')!=='off'){
    const wa=executor.wa;
    const accepted=['application/pdf','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','application/x-pkcs12','application/pkcs12','application/x-pkcs12-certificates','application/octet-stream','application/zip','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','text/html','text/plain'];
    flow.attachmentIntake=new AttachmentIntake({
      media:{download:mediaId=>wa.downloadMedia(mediaId,{allowedMimeTypes:accepted})},
      vault:env.APUD_CREDENTIAL_KEY?new CredentialVault(flow.storage.root,env.APUD_CREDENTIAL_KEY):null,
      vision:conversationAiEnabled&&conversationAi.status==='CONFIGURED'?new OpenAIVisionReader(conversationAi.config,process.env.VISION_MODEL?.trim()||conversationAi.config.model):null,
    });
  }
  const server=Fastify({logger:{level:env.LOG_LEVEL,redact:['req.headers.authorization','req.headers.cookie','body','password','pfx','certificate']},disableRequestLogging:true,bodyLimit:256*1024,requestTimeout:300000,connectionTimeout:30000,trustProxy:false});
  server.setErrorHandler((error,_request,reply)=>{
    const detail=error && typeof error==='object'?error as {code?:string;statusCode?:number}:{};
    const status=error instanceof ZodError?400:error instanceof AppError?error.statusCode:detail.code==='P2002'?409:(detail.statusCode&&detail.statusCode<500)?detail.statusCode:500;
    const code=error instanceof ZodError?'INVALID_REQUEST':errorCode(error);
    reply.code(status).send({error:code});
  });
  server.addHook('onSend',async(_request,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");return payload;});
  for(const [url,file,type]of [['/','index.html','text/html; charset=utf-8'],['/app.js','app.js','application/javascript; charset=utf-8'],['/automation.js','automation.js','application/javascript; charset=utf-8'],['/case-tools.js','case-tools.js','application/javascript; charset=utf-8'],['/inbox-tools.js','inbox-tools.js','application/javascript; charset=utf-8'],['/app.css','app.css','text/css; charset=utf-8']])server.get(url!,async(_request,reply)=>reply.type(type!).send(await readFile(resolve('public',file!))));
  server.get('/health/live',async()=>({status:'alive'}));
  server.get('/health/ready',async(_request,reply)=>{try{await Promise.all([flow.db.$queryRaw`SELECT 1`,redis.ping()]);return {status:'ready',service:'apoderamiento-bot'};}catch{return reply.code(503).send({status:'unavailable'});}});
  await server.register(async api=>{
    await api.register(multipart,{limits:{files:1,fileSize:env.MAX_DOCUMENT_BYTES,fields:12,fieldSize:8192,parts:15},attachFieldsToBody:false});
    api.addHook('onRequest',async(request)=>{
      const auth=request.headers.authorization;
      const rateKey=`${queues.inbound.opts.prefix}:operator-rate:${request.ip}:${Math.floor(Date.now()/60000)}`;const count=await redis.incr(rateKey);if(count===1)await redis.expire(rateKey,90);if(count>300)throw new AppError('RATE_LIMIT',429);
      if(!auth?.startsWith('Bearer ')||!constantEqual(auth.slice(7),env.OPERATOR_TOKEN))throw new AppError('UNAUTHORIZED',401);
    });
    await automationRoutes(api,flow,effectiveConversationAiStatus);
    await assistedRoutes(api,flow,executor);
    await phaseOneRoutes(api,flow);
    await addressRoutes(api,flow,executor);
    api.get('/setup',async()=>({...readinessConfig(env),runtime:'Node.js 22',validation:env.DATA_MODE==='mock'?'SETUP_WITH_MOCK_DATA':'REAL_EXTERNAL_E2E_PENDING'}));
    api.get('/emulator/activity',async()=>{
      if(env.WHATSAPP_TRANSPORT!=='emulator')throw new AppError('NOT_FOUND',404);
      return conversationActivity(flow.db,env.DEMO_WHATSAPP_RECIPIENTS[0]??'',env.CONVERSATION_QUIET_MS);
    });
    api.get('/agent/status',async()=>({name:'APUD_agent',provider:env.CONVERSATION_AI_PROVIDER,model:conversationAi.config?.model,mode:env.AI_MODE,trainingMethod:'SYSTEM_PROMPT_AND_RETRIEVED_FEW_SHOT',retrieval:conversationModel?await conversationModel.retrievalStatus():'NO_MODEL',fineTuned:false,referenceStatus:referenceAgent.status,packageHash:referenceAgent.context?.packageHash,corpus:referenceAgent.context?.training,usableStyleExamples:referenceAgent.context?.dataset?.examples.length,pendingPlaceholders:referenceAgent.context?.todoPlaceholders,masterWorkflow:'AVISO27_MACRO10_DAYANA',conversationPhase:env.CONVERSATION_PHASE}));
    api.get('/capabilities',async()=>({operatorEvents,consentVersion:env.CONSENT_VERSION,consentConfigured:!!env.CONSENT_TEXT_FILE,documentRejection:true,initialContact:'CASE_OPENED -> approved WhatsApp question',documentsRequiredAtStart:false,conversationPolicy:'REVIEWED_SUPPORT_PLUS_STRICT_WORKFLOW',conversationPhase:env.CONVERSATION_PHASE,conversationProvider:env.CONVERSATION_AI_PROVIDER,conversationModel:conversationAiEnabled&&conversationAi.status==='CONFIGURED'?conversationAi.config.model:'LOCAL_POLICY_ONLY',aiMode:env.AI_MODE,conversationAiStatus:effectiveConversationAiStatus,referenceAgentStatus:referenceAgent.status,referenceAgentPackage:referenceAgent.context?.packageName??null,referenceAgentTraining:referenceAgent.context?.training??null,kmaleonSearch:!!executor.adapters.kmaleon,kmaleonAddressLookup:executor.adapters.kmaleon?.addressLookupConfigured===true,apudVersion:env.APUD_VERSION,phaseOneCredentialIntakeEnabled:Boolean(env.APUD_CREDENTIAL_KEY),assistedDraftEnabled:env.APUD_VERSION===2&&env.OUTBOUND_ENABLED&&!!executor.adapters.sede,assistedCertificate:env.APUD_VERSION===2&&executor.adapters.sede?'POST /api/cases/:id/assisted-draft':'NOT_CONFIGURED',productionVerified:false}));
    api.get('/kmaleon/search',async request=>{
      const adapter=executor.adapters.kmaleon;if(!adapter)throw new AppError('KMALEON_NOT_CONFIGURED',503);
      const query=kmaleonSearch.parse(request.query);return adapter.searchExpedientes({field:query.field,query:query.q,page:query.page});
    });
    api.post('/cases/from-kmaleon',async(request,reply)=>{
      const adapter=executor.adapters.kmaleon;if(!adapter)throw new AppError('KMALEON_NOT_CONFIGURED',503);
      const selection=kmaleonSelection.parse(request.body);const candidate:KmaleonExpedienteCandidate=await adapter.getExpediente(selection.projectId);
      const result=await flow.linkKmaleon(candidate,{source:'OPERATOR'});
      return reply.code(result.alreadyLinked?200:201).send(result);
    });
    api.get('/cases',async()=>flow.db.botApodExpediente.findMany({orderBy:{updatedAt:'desc'},take:500}));
    api.post('/cases',async(request,reply)=>{const data=caseCreate.parse(request.body);const c=await flow.db.$transaction(async tx=>{const row=await tx.botApodExpediente.create({data});await tx.botApodAuditLog.create({data:{expedienteId:row.id,event:'OPERATOR_CASE_CREATED',operator:'OPERATOR',metadata:{identityVerified:true,source:'OPERATOR_VERIFIED'}}});return row;});return reply.code(201).send(c);});
    api.get('/cases/:id',async request=>{const {id}=idParam.parse(request.params);const c=await flow.db.botApodExpediente.findUnique({where:{id},include:{messages:{orderBy:{createdAt:'asc'},take:300},humanTasks:{orderBy:{createdAt:'desc'},take:100},documents:{orderBy:{createdAt:'desc'}},auditLogs:{orderBy:{createdAt:'desc'},take:100},actions:{orderBy:{createdAt:'desc'},take:100}}});if(!c)throw new AppError('CASE_NOT_FOUND',404);return c;});
    api.post('/cases/:id/events',async(request,reply)=>{
      const {id}=idParam.parse(request.params);const body=z.object({type:z.string(),version}).strict().parse(request.body);
      if(!operatorEvents.some(e=>e.type===body.type))throw new AppError('EVENT_REQUIRES_SPECIFIC_EVIDENCE_ENDPOINT',400);
      if([E.consentNo,EventType.CLIENT_OPT_OUT].includes(body.type as typeof E.consentNo)){const c=await flow.load(id);await flow.db.botApodInbox.create({data:{externalId:'operator-withdrawal-'+randomUUID(),expedienteId:id,telefono:c.telefono,source:'OPERATOR',eventType:body.type,payload:{operatorId:'OPERATOR',source:'OPERATOR_OBSERVED'},status:'PENDING',notBefore:new Date()}});return reply.code(202).send({status:'WITHDRAWAL_REQUESTED'});}
      return flow.event(id,body.version,body.type,{operatorId:'OPERATOR',source:'OPERATOR_OBSERVED'});
    });
    api.post('/cases/:id/recover',async request=>{const {id}=idParam.parse(request.params);const b=z.object({version,reason:z.string().min(10).max(300)}).strict().parse(request.body);return flow.recoverCase(id,b.version,b.reason);});
    api.post('/cases/:id/documents',async(request,reply)=>{
      const {id}=idParam.parse(request.params);let bytes:Buffer|undefined;let observedVersion:number|undefined;
      try{for await(const part of request.parts()){
        if(part.type==='file'){if(part.mimetype!=='application/pdf'||!part.filename.toLowerCase().endsWith('.pdf'))throw new AppError('PDF_REQUIRED',400);bytes=await part.toBuffer();if(part.file.truncated)throw new AppError('FILE_TOO_LARGE',413);}
        else if(part.fieldname==='version')observedVersion=z.coerce.number().int().nonnegative().parse(part.value);
        else throw new AppError('UNEXPECTED_UPLOAD_FIELD',400);
      }
      if(!bytes||observedVersion===undefined)throw new AppError('DOCUMENT_AND_VERSION_REQUIRED',400);
      const doc=await flow.intakeDocument(id,observedVersion,bytes);const audit=doc.rawAuditJson as Record<string,unknown>|null;
      if(audit?.status==='PENDING')await queues.audit.add('audit',{documentId:doc.id,requestId:audit.requestId},{jobId:`audit-${doc.id}-${typeof audit.requestId==='string'?audit.requestId:'legacy'}`});
      return reply.code(202).send({documentId:doc.id,status:audit?.status??'UNKNOWN'});
      }finally{bytes?.fill(0);}
    });
    api.get('/documents/:id',async(request,reply)=>{const {id}=idParam.parse(request.params);const d=await flow.db.botApodDocumento.findUnique({where:{id}});if(!d)throw new AppError('DOCUMENT_NOT_FOUND',404);return reply.type('application/pdf').header('Content-Disposition','inline; filename="apoderamiento.pdf"').send(await flow.storage.read(d.s3OrLocalPath,d.sha256Hash));});
    api.post('/cases/:id/documents/:documentId/approve',async request=>{
      const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(request.params);
      const b=z.object({version,sha256:z.string().regex(/^[a-f0-9]{64}$/),reviewer:z.string().trim().min(3).max(100),evidenceRef:z.string().min(4).max(200),identityConfirmed:z.literal(true),representativesConfirmed:z.literal(true),powersReviewed:z.literal(true),clientReviewed:z.boolean(),clientEvidenceRef:z.string().min(4).max(200).optional()}).strict().parse(request.body);
      return flow.approve(id,documentId,b);
    });
    api.post('/cases/:id/payment-confirmation',async request=>{
      const {id}=idParam.parse(request.params);
      const b=z.object({version,operatorId:z.string().min(3).max(100),approvalId:z.string().min(1).max(200),paymentEvidenceRef:z.string().min(5).max(200),amountCents:z.literal(3500),currency:z.literal('EUR'),paymentVerified:z.literal(true)}).strict().parse(request.body);
      const c=await flow.load(id);const approval=c.apudataApprovalEvidence as Record<string,unknown>|null;
      if(c.currentState!=='APUDATA_WAITING_PAYMENT'||!c.apudataPreApproved||approval?.id!==b.approvalId||!c.apudataApprovalExpiresAt||c.apudataApprovalExpiresAt.getTime()<=Date.now())throw new AppError('VALID_PREAPPROVAL_REQUIRED');
      return flow.event(id,b.version,E.paid,{operatorId:b.operatorId,paymentEvidenceRef:b.paymentEvidenceRef,approvalId:b.approvalId,amountCents:b.amountCents,currency:b.currency,paymentVerified:true},{},b.operatorId);
    });
    api.post('/cases/:id/documents/:documentId/reject',async request=>{
      const {id,documentId}=z.object({id:uuid,documentId:uuid}).parse(request.params);
      const b=z.object({version,sha256:z.string().regex(/^[a-f0-9]{64}$/),operatorId:z.string().min(3).max(100),reason:z.string().min(10).max(300),disposition:z.enum(['RESEND','REVOKE_AND_REISSUE'])}).strict().parse(request.body);
      return flow.locked(id,async signal=>{const c=await flow.load(id);const d=await flow.db.botApodDocumento.findUniqueOrThrow({where:{id:documentId}});
        if(signal.aborted||c.version!==b.version||c.documentId!==d.id||d.expedienteId!==id||d.sha256Hash!==b.sha256)throw new AppError('CASE_CHANGED_RELOAD');
        if(c.currentState!=='AUDITING_DOCUMENT'||d.uploadedKmaleon)throw new AppError('DOCUMENT_NOT_REJECTABLE');
        return flow.db.$transaction(async tx=>{await tx.botApodDocumento.update({where:{id:documentId},data:{approvedAt:null,approvedBy:null,clientReviewedAt:null}});return flow.transition(tx,c,EventType.OPERATOR_REJECTED_DOCUMENT,{...b,documentId},{documentApproved:false,clientReviewed:false},b.operatorId);});
      });
    });
    api.get('/actions',async()=>flow.db.botApodAccion.findMany({where:{status:{notIn:['EXECUTED','CANCELLED']}},orderBy:{createdAt:'desc'},take:300}));
    api.get('/inbox',async()=>flow.db.botApodInbox.findMany({where:{status:{notIn:['PROCESSED','HUMAN_REVIEWED']}},orderBy:{createdAt:'desc'},take:300}));
    api.post('/actions/:id/retry',async request=>{
      const {id}=idParam.parse(request.params);const action=await flow.db.botApodAccion.findUniqueOrThrow({where:{id}});
      if(!['BLOCKED','FAILED','UNCERTAIN'].includes(action.status))throw new AppError('ACTION_NOT_RETRYABLE');
      await flow.locked(action.expedienteId,async()=>{const fresh=await flow.db.botApodAccion.findUniqueOrThrow({where:{id}});if(!['BLOCKED','FAILED','UNCERTAIN'].includes(fresh.status))throw new AppError('ACTION_NOT_RETRYABLE');const c=await flow.load(fresh.expedienteId);if(c.version!==fresh.expectedVersion&&fresh.status!=='UNCERTAIN')throw new AppError('STALE_ACTION_CANNOT_RETRY');
        if(fresh.status==='UNCERTAIN'&&fresh.actionType.startsWith('SEND_WHATSAPP')&&!(fresh.receipt as Record<string,unknown>|null)?.effectResult)throw new AppError('WHATSAPP_EXTERNAL_DELIVERY_EVIDENCE_REQUIRED');
        const changed=await flow.db.botApodAccion.updateMany({where:{id,status:fresh.status},data:{status:fresh.status==='UNCERTAIN'?'UNCERTAIN':'PENDING'}});if(changed.count!==1)throw new AppError('ACTION_CHANGED_RELOAD');
      });
      await queues.notifications.add('effect',{actionId:id},{jobId:`operator-retry-${id}-${randomUUID()}`});return {message:'Acción programada; los resultados inciertos se reconcilian antes de cualquier reenvío.'};
    });
    api.post('/inbox/:id/review',async request=>{
      const {id}=idParam.parse(request.params);const b=z.object({operatorId:z.string().min(3).max(100),evidenceRef:z.string().min(5).max(200),handledInPerson:z.literal(true)}).strict().parse(request.body);
      return flow.db.$transaction(async tx=>{const row=await tx.botApodInbox.findUniqueOrThrow({where:{id}});if(row.status!=='HUMAN_REQUIRED')throw new AppError('INBOX_NOT_AWAITING_HUMAN');
        const changed=await tx.botApodInbox.updateMany({where:{id,status:'HUMAN_REQUIRED'},data:{status:'HUMAN_REVIEWED',processedAt:new Date(),payload:json({...row.payload as Record<string,unknown>,humanReview:{operatorId:b.operatorId,evidenceRef:b.evidenceRef,at:new Date().toISOString()}})}});if(changed.count!==1)throw new AppError('INBOX_CHANGED_RELOAD');
        if(row.expedienteId)await tx.botApodAuditLog.create({data:{expedienteId:row.expedienteId,event:'INBOX_ATTENDED_BY_OPERATOR',operator:b.operatorId,metadata:json({inboxId:id,evidenceRef:b.evidenceRef})}});return {status:'HUMAN_REVIEWED'};
      });
    });
    api.post('/inbox/:id/link',async request=>{
      const {id}=idParam.parse(request.params);const b=z.object({expedienteId:uuid,identityVerified:z.literal(true)}).strict().parse(request.body);
      const c=await flow.load(b.expedienteId);const incoming=await flow.db.botApodInbox.findUniqueOrThrow({where:{id}});
      if(!c.identityVerified||incoming.telefono!==c.telefono||incoming.status!=='UNMATCHED')throw new AppError('INBOX_IDENTITY_MISMATCH');
      await flow.db.botApodInbox.update({where:{id},data:{expedienteId:c.id,status:'PENDING',notBefore:new Date()}});return {status:'PENDING'};
    });
  },{prefix:'/api'});
  const debounce=new DebounceBuffer(flow.db,queues.inbound,env.CONVERSATION_QUIET_MS);
  const webhookEnabled=(enabled:boolean)=>(env.DATA_MODE==='mock'&&env.NODE_ENV==='test'&&env.SERVICE_MODE==='setup')||(env.DATA_MODE==='real'&&env.SERVICE_MODE==='live'&&enabled);
  await server.register(async webhooks=>{
    webhooks.removeContentTypeParser('application/json');webhooks.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:2*1024*1024},(_req,body,done)=>done(null,body));
    webhooks.get('/whatsapp',async(request,reply)=>{if(!webhookEnabled(env.WHATSAPP_ENABLED)||!env.WA_VERIFY_TOKEN)throw new AppError('WHATSAPP_NOT_CONFIGURED',503);const challenge=verifyWebhookChallenge(request.query as Record<string,unknown>,env.WA_VERIFY_TOKEN);if(challenge===null)throw new AppError('INVALID_VERIFY_TOKEN',403);return reply.type('text/plain').send(challenge);});
    webhooks.post('/whatsapp',async(request)=>{
      const raw=request.body;if(!Buffer.isBuffer(raw))throw new AppError('RAW_BODY_REQUIRED',400);
      try{
        if(!webhookEnabled(env.WHATSAPP_ENABLED)||!env.WA_APP_SECRET||!env.WA_PHONE_NUMBER_ID)throw new AppError('WHATSAPP_NOT_CONFIGURED',503);
        const signature=typeof request.headers['x-hub-signature-256']==='string'?request.headers['x-hub-signature-256']:undefined;
        if(!verifyWebhookSignature(raw,signature,env.WA_APP_SECRET))throw new AppError('INVALID_WEBHOOK_SIGNATURE',401);
        const envelope=normalizeWebhook(JSON.parse(raw.toString('utf8')),env.WA_PHONE_NUMBER_ID);
        for(const inbound of envelope.messages){
          let m=inbound;
          const duplicate=await flow.db.botApodInbox.findUnique({where:{externalId:m.id}});if(duplicate)continue;
          const c=await flow.db.botApodExpediente.findUnique({where:{telefono:m.from}});
          // A button answers the message that carried it. Tapped under an older message it no longer
          // answers the current question (live test 23 Sep: two old taps flipped a client with no
          // certificate to "has one on mobile"), so it is read as what the client typed instead.
          // Consent and draft buttons keep their own stricter check below.
          if(c&&m.buttonId&&!['CONSENT_YES','CONSENT_NO','DRAFT_APPROVED','DRAFT_REJECTED'].includes(m.buttonId)){
            const lastSent=await flow.db.botApodAccion.findFirst({where:{expedienteId:c.id,actionType:{in:['SEND_WHATSAPP_MESSAGE','SEND_WHATSAPP_BUTTONS','SEND_WHATSAPP_MEDIA']},status:{in:['EXECUTED','AWAITING_DELIVERY']}},orderBy:{createdAt:'desc'},select:{receipt:true}});
            const lastId=(lastSent?.receipt as {messageId?:unknown}|null)?.messageId;
            // "Necesito asistencia" / "Ayuda paso a paso" is a request the brain answers with the
            // conversation in view; as a workflow event it fired fixed help texts (training round 10).
            const brainAnswers=m.buttonId==='NEEDS_ASSISTANCE'&&conversationAgent.readsWholeBursts;
            if(brainAnswers||!m.contextId||m.contextId!==lastId){const {buttonId,buttonTitle:_t,...rest}=m;m={...rest,type:'text',textPresent:true,text:m.buttonTitle??REPLY_BUTTON_TEXT[buttonId]};}
          }
          const buttonText=m.buttonId?(m.buttonTitle??REPLY_BUTTON_TEXT[m.buttonId]):undefined;
          const textBytes=m.text?Buffer.from(m.text,'utf8'):undefined;
          const textHash=textBytes?sha256(textBytes):undefined;
          textBytes?.fill(0);
          // Files are identified and read by the attachment intake in the worker, by their content;
          // the brain gets a line describing what arrived instead of a generic "adjunto".
          if(env.CONVERSATION_PHASE===3&&!m.buttonId&&flow.attachmentIntake&&(m.media||m.unreadableMedia)){
            if(c&&(c.optOutAt||c.automationPaused)&&c.currentState!=='ESCALATED_HUMAN')
              await flow.db.botApodExpediente.updateMany({where:{id:c.id},data:{optOutAt:null,automationPaused:false}});
            await debounce.ingestMessage({externalId:m.id,expedienteId:c?.id??null,telefono:m.from,eventType:'MEDIA_RECEIVED',payload:{messageId:m.id,timestamp:m.timestamp,...(m.media?{mediaId:m.media.id,mediaType:m.media.mimeType,...(m.media.filename?{filename:m.media.filename.slice(0,120)}:{})}:{unreadable:m.unreadableMedia??'media'}),...(m.caption?{caption:m.caption.slice(0,1000)}:{})},source:'WHATSAPP'});
            continue;
          }
          // A password is hidden from the chat as before, but kept encrypted so the certificate it
          // opens can be checked (never shown to any model).
          if(c&&m.text&&flow.attachmentIntake&&/CONTENIDO_SENSIBLE|REDACTADA/.test(redactConversationPii(m.text)))
            await flow.attachmentIntake.storePassword(c,passwordCandidates(m.text)).catch(()=>undefined);
          if(env.CONVERSATION_PHASE===3&&!m.buttonId&&(m.text||m.media?.mimeType!=='application/pdf')){
            const text=m.text?redactConversationPii(m.text):/pkcs12/i.test(m.media?.mimeType??'')||/\.(?:p12|pfx)$/i.test(m.media?.filename??'')?'[CONTENIDO_SENSIBLE_OMITIDO]':'El cliente ha enviado un adjunto que requiere revisión de una persona.';
            const stop=/^(?:stop|baja|no me escribas(?: más| mas)?|no quiero seguir|dejad de escribirme|cancelar contacto)[.! ]*$/i.test(text.trim());
            // A client who comes back with a question or a document has re-engaged. Filler keeps
            // the pause; a real question lifts it, so they are not left talking to a silent number.
            const asksSomething=/\?|donde|cuando|como|que hago|contrase|certificad|password|enviar|mandar/
              .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
            // A case a person already holds stays with that person: lifting the pause there made the state
            // machine reject every later message, and the client was left with no reply at all.
            if(c&&(c.optOutAt||c.automationPaused)&&c.currentState!=='ESCALATED_HUMAN'&&!stop&&(asksSomething||Boolean(m.media)))
              await flow.db.botApodExpediente.updateMany({where:{id:c.id},data:{optOutAt:null,automationPaused:false}});
            // Secret chat text is never retained in the ordinary inbox or sent to the model.
            await debounce.ingestMessage({externalId:m.id,expedienteId:c?.id??null,telefono:m.from,eventType:stop?EventType.CLIENT_OPT_OUT:'CONVERSATION_TEXT',payload:{messageId:m.id,timestamp:m.timestamp,text,...(textHash?{messageSha256:textHash}:{}),...(m.media?{mediaId:m.media.id,mediaType:m.media.mimeType}:{})},source:'WHATSAPP',conversationText:text});
            continue;
          }
          const history=c?boundedConversationHistory((await flow.db.botApodMessage.findMany({where:{expedienteId:c.id},orderBy:[{createdAt:'desc'},{id:'desc'}],take:12})).reverse().map(x=>({role:x.role==='user'?'user' as const:'assistant' as const,content:x.content}))):[];
          const normalizedText=(m.text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
          const stop=/^(?:stop|baja|no me escribas(?: mas)?|no quiero seguir|dejad de escribirme|cancelar contacto)[.! ]*$/.test(normalizedText);
          const cannotContinue=/^(?:no puedo|no consigo|no quiero compartir(?: mi certificado)?|no quiero enviarlo|no puedo obtenerlo|no puedo instalarlo)[.! ]*$/.test(normalizedText);
          const suppressed=Boolean(c?.optOutAt||c?.automationPaused);
          const rollout=!stop&&!cannotContinue&&!suppressed&&!m.buttonId&&m.text&&c?conversationAgent.classifyRollout(m.text):undefined;
          const rolloutReplyId=rollout&&rolloutReplyIds.has(rollout.responseId)&&(env.CONVERSATION_PHASE<3||rollout.responseId==='SECURITY_ANSWER'||rollout.kind==='GREETING')?rollout.responseId:undefined;
          // Phase 1/2 never run workflow classification. They emit a fixed
          // rollout reply or a bounded support reply instead.
          const classification=!stop&&!cannotContinue&&!suppressed&&env.CONVERSATION_PHASE===3&&!rolloutReplyId&&!m.buttonId&&m.text&&c?await conversationAgent.classify(c,m.text,history):undefined;
          const conversationReply=!stop&&!cannotContinue&&!suppressed&&!m.buttonId&&m.text&&c&&!rolloutReplyId&&(!classification||classification.kind==='HUMAN_REVIEW')
            ?await conversationAgent.respond(c,m.text,history)
            :undefined;
          const replyId=conversationReply?'CONVERSATION_REPLY':rolloutReplyId;
          let event=stop?EventType.CLIENT_OPT_OUT:cannotContinue?EventType.CLIENT_EXPORT_FAILED:replyId?E.smallTalk:m.buttonId?buttonEvents[m.buttonId]:m.media?.mimeType==='application/pdf'?'PDF_MEDIA':classification?.kind==='OPTION'?classification.eventType:E.help;
          let payload:Record<string,string|boolean|number>={messageId:m.id,timestamp:m.timestamp,...(textHash?{messageSha256:textHash}:{})};
          // CLIENT_SMALL_TALK has a strict event payload contract. Keep the
          // approved rollout identifiers in the names consumed by the FSM;
          // the old `conversation*` aliases were only audit labels and made
          // every greeting fail validation before it could produce a reply.
          if(conversationReply)payload={...payload,responseId:'CONVERSATION_REPLY',rolloutPhase:env.CONVERSATION_PHASE,rolloutKind:rollout?.kind??'UNSUPPORTED',responseText:conversationReply.text,requiresHumanReview:conversationReply.requiresHumanReview};
          else if(rollout&&rolloutReplyId)payload={...payload,responseId:rolloutReplyId,rolloutPhase:rollout.phase,rolloutKind:rollout.kind};
          if(classification)payload={...payload,conversationClassification:classification.kind,...(classification.kind==='OPTION'?{conversationOption:classification.optionId,conversationConfidence:classification.confidence}:{conversationReviewReason:classification.reason})};
          if(m.media?.mimeType==='application/pdf')payload={...payload,mediaId:m.media.id,...(m.media.sha256?{mediaSha256:m.media.sha256}:{})};
          // No consent version configured (live CONSENT_VERSION="") means none to record, not an
          // invalid tap: sending '' made the rules reject "Sí, te los mando" (live test 24 Sep 15:13).
          if(m.buttonId==='CONSENT_YES'||m.buttonId==='DRAFT_APPROVED'){
            const previous=m.contextId?await flow.db.botApodAccion.findFirst({where:{expedienteId:c?.id??'UNMATCHED',receipt:{path:['messageId'],equals:m.contextId},status:{in:['EXECUTED','AWAITING_DELIVERY']}}}):null;
            const receipt=previous?.receipt as Record<string,unknown>|null;
            const requestedTemplate=m.buttonId==='CONSENT_YES'?'ASSIST_CONSENT_REQUEST':'DRAFT_REVIEW_REQUEST';
            if(!c||!previous||previous.expectedVersion!==c.version||receipt?.template!==requestedTemplate)event=E.help;
            else payload={...payload,...(typeof receipt.consentVersion==='string'&&receipt.consentVersion?{consentVersion:receipt.consentVersion}:{}),evidenceRef:m.id,contextId:m.contextId!,requestActionId:previous.id,requestVersion:previous.expectedVersion,documentId:typeof receipt.documentId==='string'?receipt.documentId:'',sha256:typeof receipt.documentSha256==='string'?receipt.documentSha256:''};
          }
          // A tapped button is the client's answer too: keep it in the conversation the brain reads.
          await debounce.ingestMessage({externalId:m.id,expedienteId:c?.id??null,telefono:m.from,eventType:event,payload,source:'WHATSAPP',...(m.text?{conversationText:m.text}:buttonText?{conversationText:buttonText}:{})});
        }
        // Delivery callbacks must be durable even if received before send response is committed.
        for(const s of envelope.statuses){await flow.db.botApodInbox.upsert({where:{externalId:`wa-status-${s.id}-${s.status}`},create:{externalId:`wa-status-${s.id}-${s.status}`,source:'WHATSAPP_STATUS',eventType:'DELIVERY_STATUS',payload:json(s),status:'PENDING'},update:{}});}
        return {received:true};
      }finally{raw.fill(0);}
    });
    webhooks.post('/apudata',async request=>{
      const raw=request.body;if(!Buffer.isBuffer(raw))throw new AppError('RAW_BODY_REQUIRED',400);
      try{const secret=env.APUDATA_CALLBACK_SECRET;const reviewed=env.APUDATA_CALLBACK_PROTOCOL_REVIEWED;if(!webhookEnabled(env.APUDATA_ENABLED)||!secret||!reviewed)throw new AppError('APUDATA_CALLBACK_NOT_CONFIGURED',503);
        if(!verifyApudataCallback(raw,request.headers['x-apod-timestamp'] as string|undefined,request.headers['x-apod-signature'] as string|undefined,secret))throw new AppError('INVALID_WEBHOOK_SIGNATURE',401);
        const b=ApudataCallbackSchema.parse(JSON.parse(raw.toString('utf8')));const c=await flow.db.botApodExpediente.findUnique({where:{apudataOrderId:b.orderId}});if(!c||c.id!==b.clientId)throw new AppError('PARTNER_ORDER_IDENTITY_MISMATCH');
        await flow.db.botApodInbox.upsert({where:{externalId:`apudata-${b.eventId}`},create:{externalId:`apudata-${b.eventId}`,expedienteId:c.id,source:'APUDATA',eventType:'PARTNER_STATUS',payload:json(b),status:'HUMAN_REQUIRED'},update:{}});
        return {received:true};
      }finally{raw.fill(0);}
    });
  },{prefix:'/webhooks'});
  return server;
}
