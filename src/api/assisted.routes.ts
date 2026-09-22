import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { WorkflowService } from '../core/workflow-service.js';
import type { ActionExecutor } from '../queue/action-executor.js';
import { AppError,requireOutbound } from '../infrastructure/security.js';
import { runAssistedDraft } from '../core/assisted-session.js';
import { EventType } from '../domain/fsm/states.js';
import { json } from '../core/workflow-service.js';
const params=z.object({id:z.string().uuid()});const version=z.number().int().nonnegative();

/** Watches durable withdrawal evidence without acquiring the case lock held by the session. */
function watchConsent(flow:WorkflowService,id:string,grantedAt:Date){
  const controller=new AbortController();let stopped=false;let checking=false;
  let withdrawalRef:string|undefined;
  const abort=(code:string)=>{if(!stopped&&!controller.signal.aborted)controller.abort(new AppError(code));};
  async function check(reader:Pick<WorkflowService['db'],'botApodInbox'>=flow.db):Promise<void>{
    if(stopped)throw new AppError('CONSENT_MONITOR_STOPPED');
    if(controller.signal.aborted)throw controller.signal.reason;
    if(Date.now()>=grantedAt.getTime()+3600000){abort('ASSISTED_CONSENT_EXPIRED');throw controller.signal.reason;}
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{
      const denial=await Promise.race([
        reader.botApodInbox.findFirst({where:{expedienteId:id,eventType:{in:[EventType.CLIENT_CONSENT_DENIED,EventType.CLIENT_OPT_OUT]},createdAt:{gte:grantedAt}},select:{id:true},orderBy:{createdAt:'desc'}}),
        new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>{abort('CONSENT_MONITOR_UNAVAILABLE');reject(new AppError('CONSENT_MONITOR_UNAVAILABLE'));},1000);deadline.unref();}),
      ]);
      if(denial){withdrawalRef=`inbox:${denial.id}`;abort('ASSISTED_CONSENT_WITHDRAWN');}
      if(controller.signal.aborted)throw controller.signal.reason;
    }catch(error){
      abort('CONSENT_MONITOR_UNAVAILABLE');
      throw controller.signal.reason??error;
    }finally{if(deadline)clearTimeout(deadline);}
  }
  const interval=setInterval(()=>{
    if(stopped||checking||controller.signal.aborted)return;
    checking=true;
    void check().catch(()=>undefined).finally(()=>{checking=false;});
  },500);interval.unref();
  return {signal:controller.signal,check,get withdrawalRef(){return withdrawalRef;},stop(){stopped=true;clearInterval(interval);}};
}

export async function assistedRoutes(api:FastifyInstance,flow:WorkflowService,executor:ActionExecutor){
  api.post('/cases/:id/consent',async request=>{
    const {id}=params.parse(request.params);const b=z.object({version,operatorId:z.string().min(3).max(100),consentVersion:z.string().min(1).max(100),evidenceRef:z.string().min(5).max(200),clientConsentGranted:z.literal(true)}).strict().parse(request.body);
    if(b.consentVersion!==flow.env.CONSENT_VERSION||!flow.env.CONSENT_TEXT_FILE)throw new AppError('APPROVED_CONSENT_VERSION_REQUIRED');
    const approvedText=await readFile(flow.env.CONSENT_TEXT_FILE,'utf8');if(!approvedText.includes(b.consentVersion)||approvedText.trim().length<40)throw new AppError('APPROVED_CONSENT_TEXT_REQUIRED');
    const c=await flow.load(id);if(c.currentState!=='MOBILE_ASSIST_CONSENT_REQUESTED')throw new AppError('CONSENT_NOT_REQUESTED');
    return flow.event(id,b.version,EventType.CLIENT_CONSENT_GRANTED,{consentVersion:b.consentVersion,evidenceRef:b.evidenceRef},{},b.operatorId);
  });
  api.post('/cases/:id/address-evidence',async request=>{
    const {id}=params.parse(request.params);const b=z.object({version,operatorId:z.string().min(3).max(100),evidenceRef:z.string().min(5).max(200),direccion:z.string().min(5).max(250),codigoPostal:z.string().regex(/^\d{5}$/),provincia:z.string().min(2).max(100),localidad:z.string().min(2).max(100),comunidadAutonoma:z.string().min(2).max(100),partidoJudicial:z.string().min(2).max(100)}).strict().parse(request.body);
    return flow.locked(id,async signal=>{const c=await flow.load(id);if(c.version!==b.version||signal.aborted)throw new AppError('CASE_CHANGED_RELOAD');return flow.db.$transaction(async tx=>{
      if(!['MOBILE_ASSIST_CONSENT_REQUESTED','MOBILE_ASSIST_PROCESSING'].includes(c.currentState))throw new AppError('ADDRESS_NOT_REQUESTED');
      if(c.documentId){const d=await tx.botApodDocumento.findUnique({where:{id:c.documentId}});if(d?.documentType==='BORRADOR_SEDE')throw new AppError('DRAFT_ALREADY_PREPARED');}
      const {version:_version,operatorId,evidenceRef,...address}=b;await tx.botApodExpediente.update({where:{id},data:{...address,version:{increment:1}}});await tx.botApodAuditLog.create({data:{expedienteId:id,event:'OPERATOR_VERIFIED_ADDRESS',operator:operatorId,metadata:json({evidenceRef,source:'OPERATOR_VERIFIED_KMALEON_ADDRESS'})}});return {id,version:c.version+1};
    });});
  });
  api.post('/cases/:id/draft-review',async request=>{
    if(flow.env.APUD_VERSION!==2)throw new AppError('APUD_V2_REQUIRED',409);
    const {id}=params.parse(request.params);const b=z.object({version,operatorId:z.string().min(3).max(100),evidenceRef:z.string().min(5).max(200),documentId:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),clientReviewed:z.literal(true)}).strict().parse(request.body);
    const c=await flow.load(id);const d=await flow.db.botApodDocumento.findUniqueOrThrow({where:{id:b.documentId}});if(c.documentId!==d.id||d.expedienteId!==id||d.sha256Hash!==b.sha256||d.documentType!=='BORRADOR_SEDE')throw new AppError('DRAFT_REFERENCE_MISMATCH');
    return flow.event(id,b.version,EventType.CLIENT_DRAFT_APPROVED,{documentId:d.id,sha256:d.sha256Hash,evidenceRef:b.evidenceRef},{},b.operatorId);
  });
  api.post('/cases/:id/submission-confirmation',async request=>{
    if(flow.env.APUD_VERSION!==2)throw new AppError('APUD_V2_REQUIRED',409);
    const {id}=params.parse(request.params);const b=z.object({version,operatorId:z.string().min(3).max(100),evidenceRef:z.string().min(5).max(200),documentId:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),submissionVerified:z.literal(true)}).strict().parse(request.body);
    const c=await flow.load(id);const d=await flow.db.botApodDocumento.findUniqueOrThrow({where:{id:b.documentId}});if(c.documentId!==d.id||d.expedienteId!==id||d.sha256Hash!==b.sha256||d.documentType!=='BORRADOR_SEDE'||!c.clientReviewed)throw new AppError('REVIEWED_DRAFT_REQUIRED');
    return flow.event(id,b.version,EventType.OPERATOR_SUBMISSION_CONFIRMED,{operatorId:b.operatorId,evidenceRef:b.evidenceRef,reviewedDraftId:d.id,reviewedDraftSha256:d.sha256Hash},{},b.operatorId);
  });
  api.post('/cases/:id/assisted-draft',async(request,reply)=>{
    if(flow.env.APUD_VERSION!==2)throw new AppError('APUD_V2_REQUIRED',409);
    const {id}=params.parse(request.params);let pfx:Buffer|undefined,password:Buffer|undefined;let observedVersion:number|undefined;
    const disconnected=new AbortController();const onAborted=()=>disconnected.abort();const onClosed=()=>{if(!reply.raw.writableEnded)disconnected.abort();};request.raw.once('aborted',onAborted);reply.raw.once('close',onClosed);
    try{
      requireOutbound(flow.env.OUTBOUND_ENABLED);if(!executor.adapters.sede)throw new AppError('SEDE_RECIPE_NOT_CONFIGURED');
      for await(const part of request.parts({limits:{files:2,fileSize:1024*1024,fields:1,parts:3}})){
        if(part.type==='file'){
          if(part.fieldname==='certificate'&&!pfx&&/\.(pfx|p12)$/i.test(part.filename))pfx=await part.toBuffer();
          else if(part.fieldname==='password'&&!password){password=await part.toBuffer();if(password.length>1024)throw new AppError('PASSWORD_TOO_LONG',400);}
          else throw new AppError('CERTIFICATE_AND_PASSWORD_PARTS_REQUIRED',400);
          if(part.file.truncated)throw new AppError('CERTIFICATE_TOO_LARGE',413);
        }else if(part.fieldname==='version')observedVersion=z.coerce.number().int().nonnegative().parse(part.value);else throw new AppError('UNEXPECTED_ASSISTED_FIELD',400);
      }
      if(!pfx||!password||observedVersion===undefined)throw new AppError('CERTIFICATE_PASSWORD_AND_VERSION_REQUIRED',400);
      const certificate=pfx;const pass=password;
      return await flow.locked(id,async signal=>{
        const c=await flow.load(id);if(c.version!==observedVersion||signal.aborted)throw new AppError('CASE_CHANGED_RELOAD');
        if(!c.identityVerified)throw new AppError('IDENTITY_NOT_VERIFIED');
        if(c.currentState!=='MOBILE_ASSIST_PROCESSING'||!c.consentGranted||!c.consentGrantedAt||c.consentGrantedAt.getTime()<Date.now()-3600000||c.consentVersion!==flow.env.CONSENT_VERSION)throw new AppError('FRESH_SCOPED_CONSENT_REQUIRED');
        if(!c.direccion||!c.codigoPostal||!c.localidad||!c.provincia||!c.comunidadAutonoma||!c.partidoJudicial)throw new AppError('VERIFIED_ADDRESS_REQUIRED');
        const addressEvidence=await flow.db.botApodAuditLog.findFirst({where:{expedienteId:id,event:'OPERATOR_VERIFIED_ADDRESS'},orderBy:{createdAt:'desc'}});if(!addressEvidence)throw new AppError('ADDRESS_PROVENANCE_REQUIRED');
        const consentLog=await flow.db.botApodAuditLog.findFirst({where:{expedienteId:id,event:EventType.CLIENT_CONSENT_GRANTED},orderBy:{createdAt:'desc'}});
        const consentEvidence=(consentLog?.metadata as {evidence?:{evidenceRef?:string}}|null)?.evidence?.evidenceRef;
        if(!consentEvidence)throw new AppError('CONSENT_PROVENANCE_REQUIRED');
        const consent=watchConsent(flow,id,c.consentGrantedAt);
        try{
        await consent.check();
        const certRef='sha256:'+createHash('sha256').update(certificate).digest('hex');const operationId=randomUUID();
        const requestDecision=await flow.db.$transaction(tx=>flow.transition(tx,c,EventType.CLIENT_CERT_FILE_RECEIVED,{certRef},{},'OPERATOR_SECURE_UPLOAD'));
        if(requestDecision.decision.nextStep==='ESCALATED_HUMAN')throw new AppError('ASSISTANCE_STATE_REQUIRES_REVIEW');
        try{
          const draft=await runAssistedDraft({pfx:certificate,password:pass,expectedDni:c.dni,clientId:id,consent:{granted:true,clientId:id,dni:c.dni,scope:'SEDE_DRAFT_ONLY',expiresAt:new Date(c.consentGrantedAt.getTime()+3600000).toISOString(),evidenceRef:consentEvidence},fields:{dni:c.dni,nombre:c.nombre,direccion:c.direccion,codigoPostal:c.codigoPostal,localidad:c.localidad,provincia:c.provincia,comunidadAutonoma:c.comunidadAutonoma,partidoJudicial:c.partidoJudicial}},180000,AbortSignal.any([signal as AbortSignal,disconnected.signal,consent.signal]));
          let saved:{path:string;sha256:string};try{if(signal.aborted)throw new AppError('LOCK_LOST_AFTER_DRAFT');await consent.check();saved=await flow.storage.save(draft.pdf);}finally{draft.pdf.fill(0);}
          const result=await flow.db.$transaction(async tx=>{
            await consent.check(tx);
            const fresh=await tx.botApodExpediente.findUniqueOrThrow({where:{id}});if(fresh.version!==requestDecision.version)throw new AppError('CASE_CHANGED_AFTER_DRAFT');
            const inspected=await flow.transition(tx,fresh,EventType.CERT_INSPECTION_COMPLETED,{...draft.inspection});
            if(inspected.decision.nextStep==='ESCALATED_HUMAN')throw new AppError('CERTIFICATE_REQUIRES_REVIEW');
            const doc=await tx.botApodDocumento.create({data:{expedienteId:id,documentType:'BORRADOR_SEDE',s3OrLocalPath:saved.path,sha256Hash:saved.sha256,rawAuditJson:json({status:'DRAFT_NOT_SUBMITTED',recipeId:draft.recipeId,operationId})}});
            const next=await tx.botApodExpediente.findUniqueOrThrow({where:{id}});
            await flow.transition(tx,next,EventType.SEDE_DRAFT_READY,{documentId:doc.id,sha256:doc.sha256Hash,recipeId:draft.recipeId},{documentId:doc.id,documentApproved:false,clientReviewed:false});
            await consent.check(tx);
            await tx.botApodAccion.updateMany({where:{expedienteId:id,decisionId:{in:[requestDecision.decision.decisionId,inspected.decision.decisionId]},actionType:'TRIGGER_SEDE_AUTOMATION'},data:{status:'EXECUTED',executedAt:new Date(),receipt:json({operationId,recipeId:draft.recipeId,draftSha256:saved.sha256,inspection:draft.inspection})}});
            return {documentId:doc.id,status:draft.status,sha256:saved.sha256};
          });
          return reply.code(201).send(result);
        }catch(error){
          if(!signal.aborted){const fresh=await flow.load(id);if(fresh.version===requestDecision.version)await flow.db.$transaction(async tx=>{if(signal.aborted)throw new AppError('LOCK_LOST');return flow.transition(tx,fresh,EventType.SEDE_AUTOMATION_FAILED,{errorCode:consent.withdrawalRef?'ASSISTED_CONSENT_WITHDRAWN':consent.signal.aborted?'ASSISTED_CONSENT_UNCONFIRMED':'ASSISTED_DRAFT_FAILED',outcome:'uncertain',...(consent.withdrawalRef?{evidenceRef:consent.withdrawalRef}:{})},consent.signal.aborted?{consentGranted:false,consentGrantedAt:null}:{});});}throw error;
        }
        }finally{consent.stop();}
      });
    }finally{pfx?.fill(0);password?.fill(0);request.raw.removeListener('aborted',onAborted);reply.raw.removeListener('close',onClosed);}
  });
}
