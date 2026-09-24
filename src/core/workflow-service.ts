import { Prisma, type PrismaClient, ApodState, type BotApodExpediente } from '@prisma/client';
import type Redlock from 'redlock';
import { randomUUID } from 'node:crypto';
import { evaluateNextStep } from './decision-engine.js';
import { caseMemory, historicalCaseMemory } from './case-memory.js';
import type { Expediente } from '../domain/models/expediente.js';
import { EventType, type WorkflowEvent } from '../domain/fsm/states.js';
import { PdfAuditor } from './pdf-auditor.js';
import { AppError } from '../infrastructure/security.js';
import type { DocumentStorage } from '../infrastructure/storage.js';
import type { Env } from '../config/env.js';
import { E } from './workflow-events.js';
import type { KmaleonExpedienteCandidate } from '../contracts/kmaleon.contract.js';
import { FOLLOW_UP_STATES, stepFor, nextFollowUp } from './follow-up.js';
import { closePhaseOne, phaseOneExpired } from './phase-one.js';
import { phaseOneReportedOutcome } from './phase-one-intent.js';
import type { StrictConversationAgent } from './conversation-agent.js';
import { certificateMarker, CERTIFICATE_CHECK_WORDS, type AttachmentIntake } from './attachment-intake.js';
import { requiresDeterministicHandoff } from './conversation-policy.js';
import { relatedConversationText } from './conversation-batching.js';

export const json = (value:unknown):Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export type WorkflowPatch = Prisma.BotApodExpedienteUpdateManyMutationInput;
export class WorkflowService {
  conversationAgent?:StrictConversationAgent;
  attachmentIntake?:AttachmentIntake;
  constructor(readonly db:PrismaClient,readonly redlock:Redlock,readonly storage:DocumentStorage,readonly env:Env) {}
  async locked<T>(id:string,fn:(signal:{aborted:boolean})=>Promise<T>):Promise<T>{return this.redlock.using([`lock:apod:${id}`],180000,fn);}
  async load(id:string):Promise<BotApodExpediente>{const c=await this.db.botApodExpediente.findUnique({where:{id}});if(!c)throw new AppError('CASE_NOT_FOUND',404);return c;}
  async linkKmaleon(candidate:KmaleonExpedienteCandidate,input:{source:'OPERATOR'|'AVISO_27'|'AVISO_24';triggerId?:string}){
    return this.locked(`identity:${candidate.dni}`,async signal=>{
      if(signal.aborted)throw new AppError('LOCK_LOST');
      return this.db.$transaction(async tx=>{
        let row=await tx.botApodExpediente.findFirst({where:{kmaleonExpedienteId:candidate.projectId}});
        const created=!row;
        if(row){
          if(row.dni!==candidate.dni||row.telefono!==candidate.telefono)throw new AppError('KMALEON_LOCAL_IDENTITY_MISMATCH',409);
          row=await tx.botApodExpediente.update({where:{id:row.id},data:{empresa:candidate.empresa,numeroExpediente:candidate.numeroExpediente}});
        }else{
          if(await tx.botApodExpediente.findFirst({where:{OR:[{dni:candidate.dni},{telefono:candidate.telefono}]}}))throw new AppError('KMALEON_IDENTITY_ALREADY_LINKED',409);
          row=await tx.botApodExpediente.create({data:{nombre:candidate.nombre,dni:candidate.dni,telefono:candidate.telefono,kmaleonExpedienteId:candidate.projectId,empresa:candidate.empresa,numeroExpediente:candidate.numeroExpediente,identityVerified:true,source:input.source}});
        }
        let initialContactQueued=false;
        if(row.currentState==='INITIAL_TRIAGE'&&!row.automationPaused&&!row.optOutAt&&!await tx.botApodAuditLog.findFirst({where:{expedienteId:row.id,event:E.start}})){
          await this.transition(tx,row,E.start,{source:input.source,projectId:candidate.projectId});initialContactQueued=true;
        }
        await tx.botApodAuditLog.create({data:{expedienteId:row.id,event:input.source.startsWith('AVISO_')?`${input.source}_OBSERVED`:'KMALEON_EXPEDIENTE_SELECTED',operator:input.source,metadata:json({projectId:candidate.projectId,triggerId:input.triggerId,created})}});
        if(input.triggerId)await tx.botApodTrigger.update({where:{id:input.triggerId},data:{expedienteId:row.id,status:'PROCESSED',processedAt:new Date(),lastError:null}});
        return {...await tx.botApodExpediente.findUniqueOrThrow({where:{id:row.id}}),alreadyLinked:!created,initialContactQueued};
      });
    });
  }
  async transition(tx:Prisma.TransactionClient,c:BotApodExpediente,type:string,payload:Record<string,unknown>={},patch:WorkflowPatch={},operator='SYSTEM_BOT') {
    if(c.phaseOneClosedAt)throw new AppError('PHASE_ONE_CLOSED',409);
    if(!Object.values(EventType).includes(type as EventType))throw new AppError('UNSUPPORTED_DOMAIN_EVENT',400);
    const document=c.documentId?await tx.botApodDocumento.findUnique({where:{id:c.documentId}}):null;
    if(type===E.delivered){
      if(!document||document.documentType!=='APODERAMIENTO_FINAL'||!document.uploadedKmaleon)throw new AppError('VERIFIED_FINAL_DOCUMENT_REQUIRED');
      const notice=await tx.botApodAccion.findFirst({where:{expedienteId:c.id,actionType:'NOTIFY_DAYANA',status:'EXECUTED',receipt:{path:['documentSha256'],equals:document.sha256Hash}},orderBy:{createdAt:'desc'}});
      if(!notice||(notice.receipt as Record<string,unknown>|null)?.verified!==true||payload.template!=='COMPLETION_NOTICE')throw new AppError('VERIFIED_DAYANA_NOTICE_REQUIRED');
    }
    const snapshot={...c,...patch,documentSha256:document?.sha256Hash??null,documentType:document?.documentType??null,kmaleonDocumentId:document?.kmaleonDocumentId??null} as unknown as Expediente;
    const decision=evaluateNextStep(snapshot,{type:type as EventType,payload} as WorkflowEvent);
    const lead=typeof payload.brainLead==='string'?payload.brainLead.trim():'';
    const leadTarget=decision.actionPayload as {template?:unknown;variables?:Record<string,unknown>};
    if(lead&&typeof leadTarget.template==='string'&&leadTarget.template!=='CONVERSATION_REPLY')leadTarget.variables={...(leadTarget.variables??{}),leadText:lead.slice(0,600)};
    const enginePatch=decision.actionPayload.expedientePatch;
    const persisted:Record<string,unknown>={};
    const allowed=new Set(['hasDigitalCert','certDevice','digitalHelpAttempts','certificateHelpAttempts','consentGranted','consentVersion','consentGrantedAt','auditStatus','pageCount','isProvisionalFiled','apudataOrderId','apudataPreApproved','apudataApprovalExpiresAt','apudataApprovalEvidence','documentId','documentApproved','clientReviewed','partidoJudicial']);
    if(enginePatch&&typeof enginePatch==='object'&&!Array.isArray(enginePatch))for(const [key,value]of Object.entries(enginePatch)){if(allowed.has(key))persisted[key]=value;}
    if(persisted.apudataApprovalEvidence===null)persisted.apudataApprovalEvidence=Prisma.DbNull;
    const combined:WorkflowPatch={...patch,...persisted};
    if(decision.nextStep!==c.currentState||(decision.nextStep!==ApodState.ESCALATED_HUMAN&&stepFor({...c,...persisted,currentState:decision.nextStep as ApodState})!==c.stepReached)){
      if(decision.nextStep===ApodState.ESCALATED_HUMAN){combined.previousState=c.currentState;combined.automationPaused=true;combined.nextReminderAt=null;}
      else {
        combined.stepReached=stepFor({...c,...persisted,currentState:decision.nextStep as ApodState});combined.stepEnteredAt=new Date();
        combined.reminderCycle={increment:1};
        if(c.phaseOneStartedAt){combined.reminderAnchorAt=c.phaseOneStartedAt;combined.nextReminderAt=nextFollowUp(c.phaseOneStartedAt,c.lastReminderDay);}
        else{combined.reminderAnchorAt=null;combined.lastReminderDay=0;combined.reminderCount=0;combined.nextReminderAt=null;}
      }
    }
    if(type===EventType.CLIENT_CERT_FILE_RECEIVED){combined.stepReached='ASISTENCIA_SEGURA';combined.nextReminderAt=null;combined.reminderCycle={increment:1};}
    if(type===EventType.CLIENT_OPT_OUT){combined.optOutAt=new Date();combined.automationPaused=true;combined.nextReminderAt=null;}
    const changed=decision.nextStep!==c.currentState||decision.actionRequired!=='NO_OP'||Object.entries(combined).some(([key,value])=>JSON.stringify(value)!==JSON.stringify(c[key as keyof BotApodExpediente]));
    const nextVersion=c.version+(changed?1:0);
    const updated=await tx.botApodExpediente.updateMany({where:{id:c.id,version:c.version},data:{...combined,currentState:decision.nextStep as ApodState,version:nextVersion}});
    if(updated.count!==1)throw new AppError('CASE_CHANGED_RELOAD',409);
      await tx.botApodAuditLog.create({data:{expedienteId:c.id,event:type,fromState:c.currentState,toState:decision.nextStep as ApodState,operator,metadata:json({decision,version:nextVersion,evidence:Object.fromEntries(Object.entries(payload).filter(([key])=>['evidenceRef','clientEvidenceRef','paymentEvidenceRef','operatorId','requestActionId','contextId','messageId','messageSha256','conversationOption','conversationConfidence','conversationClassification','conversationReviewReason','conversationResponseId','conversationRolloutPhase','conversationRolloutKind','responseId','rolloutPhase','rolloutKind','sha256','documentId','reviewedDraftId','reviewedDraftSha256','brainUnderstanding','brainProgress','brainNote','brainLead','brainFactCert','brainFactDevice','silent'].includes(key)))})}});
    if(decision.actionRequired!=='NO_OP')await tx.botApodAccion.create({data:{expedienteId:c.id,decisionId:decision.decisionId,expectedVersion:nextVersion,actionType:decision.actionRequired,payload:json({...decision.actionPayload,contextStep:combined.stepReached??c.stepReached,...(payload.requiresHumanReview===true?{humanHandoff:true,handoffReason:payload.handoffReason??'HUMANO'}:{})}),idempotencyKey:`apod-${decision.decisionId}`,status:decision.actionRequired==='ESCALATE_HUMAN'?'HUMAN_REQUIRED':'PENDING'}});
    if(decision.actionPayload.kind==='ESCALATE_HUMAN'&&type!==EventType.CLIENT_OPT_OUT&&!c.optOutAt&&decision.actionPayload.clientNoticeTemplate)await tx.botApodAccion.create({data:{expedienteId:c.id,decisionId:randomUUID(),expectedVersion:nextVersion,actionType:'SEND_WHATSAPP_MESSAGE',payload:json({template:payload.requiresHumanReview===true?'CONVERSATION_REPLY':'HUMAN_HANDOFF_NOTICE',...(payload.requiresHumanReview===true?{variables:{replyText:payload.responseText},contextStep:c.stepReached}:{}),parentDecisionId:decision.decisionId,humanHandoff:true,handoffReason:payload.handoffReason??'HUMANO'}),idempotencyKey:`handoff-${decision.decisionId}`}});
    if(type===EventType.OPERATOR_SUBMISSION_CONFIRMED)await tx.botApodHumanTask.updateMany({where:{expedienteId:c.id,kind:'ASSISTED_PROCESSING',status:'OPEN'},data:{status:'RESOLVED',resolvedAt:new Date(),resolvedBy:operator,resolutionRef:String(payload.evidenceRef)}});
    if(decision.actionRequired==='ESCALATE_HUMAN'||type===E.pdf||type===EventType.CLIENT_CERT_FILE_RECEIVED||payload.requiresHumanReview===true){
      const kind=type===E.pdf?'DOCUMENT_REVIEW':type===EventType.CLIENT_CERT_FILE_RECEIVED?'ASSISTED_PROCESSING':'CONVERSATION_REVIEW';
      const ref=String(payload.documentId??payload.certRef??payload.messageId??decision.decisionId);
      await tx.botApodHumanTask.upsert({where:{dedupeKey:`${kind}:${c.id}:${ref}`},create:{expedienteId:c.id,dedupeKey:`${kind}:${c.id}:${ref}`,kind,assignedTo:'DAYANA',reason:kind==='DOCUMENT_REVIEW'?'Revisar identidad, profesionales, facultades y validez del PDF.':kind==='ASSISTED_PROCESSING'?'Certificado recibido en sesión segura. El apoderamiento sigue pendiente.':String(payload.handoffReason??'El cliente necesita atención profesional.'),evidence:json({stepReached:c.stepReached,event:type,ref,...(payload.handoffMarker?{handoffMarker:payload.handoffMarker}:{})})},update:{}});
    }
    // Once the certificate and its password are in, the bot's part is over: a person prepares the
    // apoderamiento. Stop the automation so no tutorial, reminder or next step follows the client's
    // handover, which would read as if nobody had picked it up.
    if(type===EventType.CLIENT_CERT_FILE_RECEIVED&&!c.optOutAt)
      await tx.botApodExpediente.updateMany({where:{id:c.id,automationPaused:false},data:{automationPaused:true,nextReminderAt:null}});
    return {decision,version:nextVersion};
  }
  async event(id:string,version:number,type:string,payload:Record<string,unknown>={},patch:WorkflowPatch={},operator='OPERATOR') {
    return this.locked(id,async signal=>{if(signal.aborted)throw new AppError('LOCK_LOST');const c=await this.load(id);if(c.version!==version)throw new AppError('CASE_CHANGED_RELOAD');return this.db.$transaction(tx=>this.transition(tx,c,type,payload,patch,operator));});
  }
  async intakeDocument(id:string,version:number,buffer:Buffer,sourceId?:string) {
    return this.locked(id,async signal=>{
      const c=await this.load(id);if(c.version!==version)throw new AppError('CASE_CHANGED_RELOAD');if(!c.identityVerified)throw new AppError('IDENTITY_NOT_VERIFIED');
      if(c.phaseOneClosedAt)throw new AppError('PHASE_ONE_CLOSED',409);
      const stored=await this.storage.save(buffer);if(signal.aborted)throw new AppError('LOCK_LOST');
      const existing=await this.db.botApodDocumento.findUnique({where:{expedienteId_sha256Hash:{expedienteId:id,sha256Hash:stored.sha256}}});
      const canReselectSameDocument=([ApodState.INITIAL_TRIAGE,ApodState.WAITING_PDF_SUBMISSION,ApodState.WAITING_REVOCATION_REISSUE] as ApodState[]).includes(c.currentState);
      if(existing&&c.documentId===existing.id&&!canReselectSameDocument)return existing;
      // A new workflow action has a new provider idempotency key. Previously filed
      // bytes need reconciliation, never another automatic upload after recovery.
      if(existing?.uploadedKmaleon)throw new AppError('DOCUMENT_ALREADY_FILED_REQUIRES_RECONCILIATION');
      return this.db.$transaction(async tx=>{
        const pendingAudit=json({status:'PENDING',sourceId,requestId:randomUUID()});
        const doc=existing?await tx.botApodDocumento.update({where:{id:existing.id},data:{rawAuditJson:pendingAudit,pageCount:0,hasAiram:false,hasPowersArt25:false,identityMatches:false,documentType:'PENDING_REVIEW',approvedAt:null,approvedBy:null,clientReviewedAt:null}}):await tx.botApodDocumento.create({data:{expedienteId:id,s3OrLocalPath:stored.path,sha256Hash:stored.sha256,rawAuditJson:pendingAudit}});
        if(existing)await tx.botApodAuditLog.create({data:{expedienteId:id,event:'DOCUMENT_RESELECTED_FOR_REVIEW',metadata:json({documentId:doc.id,sha256:stored.sha256,previousAuditStatus:(existing.rawAuditJson as Record<string,unknown>|null)?.status,sourceId})}});
        const result=await this.transition(tx,c,E.pdf,{documentId:doc.id,sha256:stored.sha256},{documentId:doc.id,documentApproved:false,clientReviewed:false,auditStatus:null,pageCount:null});
        if(result.decision.nextStep!==ApodState.AUDITING_DOCUMENT)return tx.botApodDocumento.update({where:{id:doc.id},data:{rawAuditJson:json({status:'HUMAN_REQUIRED',reason:'DOCUMENT_AWAITS_CASE_RECOVERY',sourceId})}});
        return doc;
      });
    });
  }
  async auditDocument(documentId:string,requestId?:string) {
    const initial=await this.db.botApodDocumento.findUniqueOrThrow({where:{id:documentId}});
    return this.locked(initial.expedienteId,async signal=>{
      const doc=await this.db.botApodDocumento.findUniqueOrThrow({where:{id:documentId}});
      const pendingAudit=doc.rawAuditJson as Record<string,unknown>|null;
      if(pendingAudit?.status!=='PENDING'||pendingAudit.requestId!==requestId)return;
      const c=await this.load(doc.expedienteId);if(signal.aborted)throw new AppError('LOCK_LOST');
      if(c.documentId!==doc.id||c.currentState!==ApodState.AUDITING_DOCUMENT){
        const status=c.documentId!==doc.id?'SUPERSEDED':'HUMAN_REQUIRED';
        await this.db.botApodDocumento.updateMany({where:{id:doc.id,rawAuditJson:{path:['status'],equals:'PENDING'}},data:{rawAuditJson:json({...pendingAudit,status,reason:status==='SUPERSEDED'?'ANOTHER_DOCUMENT_SELECTED':'DOCUMENT_AWAITS_CASE_RECOVERY'})}});
        return;
      }
      const buffer=await this.storage.read(doc.s3OrLocalPath,doc.sha256Hash);
      let report:Awaited<ReturnType<typeof PdfAuditor.audit>>;
      try{report=await PdfAuditor.audit(buffer,{expectedDni:c.dni,airamFullName:this.env.AIRAM_FULL_NAME});}finally{buffer.fill(0);}
      if(signal.aborted)throw new AppError('LOCK_LOST');
      // Never persist extracted document text. The private PDF remains the evidence.
      const {extractedText: _text,...safeReport}=report;
      return this.db.$transaction(async tx=>{
        await tx.botApodDocumento.update({where:{id:doc.id},data:{pageCount:report.pageCount,hasAiram:report.hasAiram,hasPowersArt25:report.missingPowers.length===0,identityMatches:report.identityMatches,rawAuditJson:json({...safeReport,requestId})}});
        if(c.phaseOneClosedAt){
          await tx.botApodExpediente.update({where:{id:c.id},data:{auditStatus:report.status,pageCount:report.pageCount,version:{increment:1}}});
          await tx.botApodHumanTask.upsert({where:{dedupeKey:`late-audit:${doc.id}`},create:{expedienteId:c.id,dedupeKey:`late-audit:${doc.id}`,kind:'DOCUMENT_REVIEW',assignedTo:'DAYANA',reason:'Auditoría terminada tras el cierre de fase 1; revisar el documento sin reactivar mensajes.',evidence:json({documentId:doc.id,status:report.status})},update:{}});
        }else await this.transition(tx,c,E.audit,{...safeReport,documentId:doc.id,sha256:doc.sha256Hash},{auditStatus:report.status,pageCount:report.pageCount});
      });
    });
  }
  async approve(id:string,documentId:string,input:{version:number;sha256:string;reviewer:string;evidenceRef:string;clientReviewed:boolean;clientEvidenceRef?:string}) {
    return this.locked(id,async signal=>{
      const c=await this.load(id);if(c.version!==input.version||c.documentId!==documentId)throw new AppError('CASE_CHANGED_RELOAD');
      const doc=await this.db.botApodDocumento.findUniqueOrThrow({where:{id:documentId}});
      if(doc.expedienteId!==id||doc.sha256Hash!==input.sha256)throw new AppError('DOCUMENT_MISMATCH');
      if(c.currentState!==ApodState.AUDITING_DOCUMENT||doc.uploadedKmaleon)throw new AppError('DOCUMENT_NOT_AWAITING_REVIEW');
      if(!doc.identityMatches||!doc.hasAiram||!doc.pageCount)throw new AppError('AUDIT_REQUIRES_CORRECTION');
      const report=doc.rawAuditJson as Record<string,unknown>;
      if(report.isValid!==true&&report.canViabilize!==true)throw new AppError('DOCUMENT_NOT_ELIGIBLE');
      if(!input.clientReviewed||!input.clientEvidenceRef)throw new AppError('CLIENT_REVIEW_EVIDENCE_REQUIRED');
      const verifiedBytes=await this.storage.read(doc.s3OrLocalPath,doc.sha256Hash);verifiedBytes.fill(0);if(signal.aborted)throw new AppError('LOCK_LOST');
      return this.db.$transaction(async tx=>{
        await tx.botApodDocumento.update({where:{id:documentId},data:{approvedAt:new Date(),approvedBy:input.reviewer,clientReviewedAt:input.clientReviewed?new Date():null,documentType:report.isValid?'APODERAMIENTO_FINAL':'APODERAMIENTO_PROVISIONAL'}});
        await tx.botApodHumanTask.updateMany({where:{expedienteId:id,dedupeKey:{in:[`DOCUMENT_REVIEW:${id}:${documentId}`,`late-audit:${documentId}`]},status:'OPEN'},data:{status:'RESOLVED',resolvedAt:new Date(),resolvedBy:input.reviewer,resolutionRef:input.evidenceRef}});
        if(this.env.APUD_VERSION===1&&c.phaseOneClosedAt){
          const evidence={documentId,sha256:input.sha256,evidenceRef:input.evidenceRef,clientEvidenceRef:input.clientEvidenceRef,documentReviewed:true,priorOutcome:c.phaseOneOutcome,priorEvidence:c.phaseOneEvidence,legalFilingVerified:false};
          await tx.botApodExpediente.update({where:{id},data:{documentApproved:true,clientReviewed:true,version:{increment:1},...(report.isValid?{phaseOneOutcome:'PDF_RECEIVED',phaseOneEvidence:json(evidence)}:{})}});
          await tx.botApodHumanTask.upsert({where:{dedupeKey:`phase-one-document:${documentId}`},create:{expedienteId:id,dedupeKey:`phase-one-document:${documentId}`,kind:'PHASE_ONE_DOCUMENT_REVIEW',assignedTo:'DAYANA',reason:report.isValid?'Documento revisado tras finalizar la fase 1; el bot permanece en silencio.':'Documento provisional revisado tras finalizar la fase 1; continuar su corrección manualmente.',evidence:json(evidence)},update:{}});
          return {status:'PHASE_ONE_CLOSED',version:c.version+1};
        }
        if(this.env.APUD_VERSION===1&&report.isValid){
          await tx.botApodExpediente.update({where:{id},data:{documentApproved:true,clientReviewed:true}});
          await closePhaseOne(tx,c,'PDF_RECEIVED',{documentId,sha256:input.sha256,evidenceRef:input.evidenceRef,clientEvidenceRef:input.clientEvidenceRef??null,documentReviewed:true},input.reviewer);
          return {status:'PHASE_ONE_CLOSED',version:c.version+1};
        }
        return this.transition(tx,c,E.approve,{documentId,sha256:input.sha256,reviewer:input.reviewer,evidenceRef:input.evidenceRef,clientEvidenceRef:input.clientEvidenceRef},{documentApproved:true,clientReviewed:input.clientReviewed},input.reviewer);
      });
    });
  }
  async recoverCase(id:string,version:number,reason:string){
    return this.locked(id,async signal=>{const c=await this.load(id);if(c.version!==version||signal.aborted)throw new AppError('CASE_CHANGED_RELOAD');
      if(c.phaseOneClosedAt||this.env.APUD_VERSION===1&&phaseOneExpired(c))throw new AppError('PHASE_ONE_CLOSED',409);
      if(c.currentState!==ApodState.ESCALATED_HUMAN)throw new AppError('CASE_NOT_ESCALATED');
      if(c.optOutAt)throw new AppError('CLIENT_OPT_OUT_REQUIRES_NEW_CONSENT');
      const target=c.previousState;
      if(!target||target===ApodState.INITIAL_TRIAGE||!Object.values(ApodState).includes(target as ApodState))throw new AppError('SAVED_STEP_REQUIRES_OPERATOR_REVIEW');
      return this.db.$transaction(async tx=>{
        const result=await this.transition(tx,c,E.resume,{operatorId:'OPERATOR',targetState:target,reason},{automationPaused:false},'OPERATOR');
        if(result.decision.nextStep===ApodState.ESCALATED_HUMAN)throw new AppError('SAVED_STEP_REQUIRES_OPERATOR_REVIEW');
        await tx.botApodAccion.updateMany({where:{expedienteId:id,status:{in:['PENDING','BLOCKED','HUMAN_REQUIRED']}},data:{status:'CANCELLED',lastError:'OPERATOR_RESUMED_SAVED_STEP'}});
        const anchor=c.phaseOneStartedAt??new Date();
        await tx.botApodExpediente.update({where:{id},data:{stepReached:c.stepReached,reminderAnchorAt:anchor,nextReminderAt:FOLLOW_UP_STATES.has(target as ApodState)?nextFollowUp(anchor,c.phaseOneStartedAt?c.lastReminderDay:0):null}});
        return {id,version:result.version,resumedState:result.decision.nextStep};
      });});
  }

  async processInbox(id:string,handleMedia:(caseId:string,mediaId:string,externalId:string)=>Promise<void>) {
    return this.redlock.using([`lock:apod-inbox:${id}`],180000,async inboxSignal=>{

    // Media processing takes its own lock. Durable per-message statuses make recovery explicit.
    // Files first: each is identified by its content and becomes a line of the conversation (or, for
    // the apud acta justificante, goes on to the PDF audit) before the turn is read.
    if(this.attachmentIntake){
      const media=await this.db.botApodInbox.findMany({where:{expedienteId:id,status:'PENDING',eventType:'MEDIA_RECEIVED',notBefore:{lte:new Date()}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:10});
      if(media.length){
        const c=await this.load(id);
        for(const row of media){
          const payload=row.payload as Record<string,unknown>;
          const result=await this.attachmentIntake.read({id:c.id,dni:c.dni},payload);
          await this.db.$transaction(async tx=>{
            // The conversation keeps a readable line; the certificate code stays in the turn text only.
            const said=result.route==='CERTIFICATE'?`[Adjunto del cliente: el archivo de su certificado digital. Comprobación del sistema: ${CERTIFICATE_CHECK_WORDS[result.check]}.]`:result.marker;
            await tx.botApodMessage.upsert({where:{externalId:row.externalId},create:{expedienteId:id,externalId:row.externalId,role:'user',content:said.slice(0,2000),source:'WHATSAPP',createdAt:row.createdAt},update:{}});
            await tx.botApodInbox.update({where:{id:row.id},data:result.route==='APUD_PDF'?{eventType:'PDF_MEDIA'}:{eventType:'CONVERSATION_TEXT',payload:json({...payload,text:result.marker})}});
            await tx.botApodAuditLog.create({data:{expedienteId:id,event:'ATTACHMENT_READ',operator:'WHATSAPP_CLIENT',metadata:json({inboxId:row.id,route:result.route,...(result.route==='CERTIFICATE'?{check:result.check}:{})})}});
          });
        }
      }
    }
    const pending=await this.db.botApodInbox.findMany({where:{expedienteId:id,status:'PENDING'},orderBy:[{createdAt:'asc'},{id:'asc'}],take:50});
    // Anything already waiting is backlog, not a new arrival: with more than one page of pending
    // texts the old "outside this page" test discarded every draft and stalled the case for good.
    const snapshotAt=new Date();
    if(!pending.length||pending.some(x=>x.notBefore.getTime()>Date.now()))return;
    for(const candidate of pending){
      if(inboxSignal.aborted)throw new AppError('INBOX_LOCK_LOST');
      const row=await this.db.botApodInbox.findUniqueOrThrow({where:{id:candidate.id}});
      if(row.status!=='PENDING')continue;
      if(row.notBefore.getTime()>Date.now())return;
      const stopped=await this.locked(id,async signal=>{
        if(signal.aborted)throw new AppError('LOCK_LOST');
        const c=await this.load(id);
        if(!c.phaseOneClosedAt&&!(this.env.APUD_VERSION===1&&phaseOneExpired(c)))return false;
        await this.db.$transaction(async tx=>{
          if(!c.phaseOneClosedAt)await closePhaseOne(tx,c,'DEADLINE_REACHED',{source:'INBOUND_DEADLINE_CHECK'});
          await tx.botApodInbox.updateMany({where:{id:row.id,status:'PENDING'},data:{status:'HUMAN_REQUIRED',lastError:'PHASE_ONE_CLOSED',processedAt:new Date()}});
          await tx.botApodHumanTask.upsert({where:{dedupeKey:`phase-one-late:${row.id}`},create:{expedienteId:id,dedupeKey:`phase-one-late:${row.id}`,kind:'CONVERSATION_REVIEW',assignedTo:'DAYANA',reason:'Nuevo mensaje tras finalizar la fase 1; el bot permanece en silencio.',evidence:json({inboxId:row.id})},update:{}});
        });
        return true;
      });
      if(stopped)continue;
      if(row.eventType==='PDF_MEDIA'){
        try{await handleMedia(id,(row.payload as Record<string,string>).mediaId!,row.externalId);await this.db.botApodInbox.updateMany({where:{id:row.id,status:'PENDING'},data:{status:'PROCESSED',processedAt:new Date()}});}catch{await this.db.botApodInbox.updateMany({where:{id:row.id,status:'PENDING'},data:{status:'HUMAN_REQUIRED',lastError:'PDF_PROCESSING_FAILED'}});}continue;
      }
      await this.locked(id,async signal=>{const fresh=await this.db.botApodInbox.findUniqueOrThrow({where:{id:row.id}});if(fresh.status!=='PENDING'||fresh.notBefore.getTime()>Date.now()||signal.aborted)return;const c=await this.load(id);
        if(c.phaseOneClosedAt){await this.db.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'PHASE_ONE_CLOSED',processedAt:new Date()}});return;}
        // One quiet-period burst is one conversation turn. Keep each durable inbox
        // row and user message; commit all consumed statuses with the one decision.
        const turnRows=[fresh];
        // With the brain, a burst is read whole: a stop word or an odd request is judged with the rest of
        // what the client wrote (training round 9: "ya no quiero seguir" answered as a stop while its
        // question arrived as a separate turn). Only a message carrying a secret stays on its own.
        const carriesSecret=(value:string)=>/CONTENIDO_SENSIBLE|REDACTADA|^\[CERTIFICADO:/.test(value);
        // With the brain the whole burst is one turn, secrets included: a turn that carries a password
        // or a certificate becomes the certificate check (below), so the words around it ("perdón, la
        // escribí mal") do not get a separate, contradictory reply.
        const burstable=(value:string)=>this.conversationAgent?.readsWholeBursts?true:!requiresDeterministicHandoff(value)&&!carriesSecret(value);
        if(fresh.eventType==='CONVERSATION_TEXT'&&burstable(String((fresh.payload as Record<string,unknown>).text??''))){
          let size=String((fresh.payload as Record<string,unknown>).text??'').length;
          const following=pending.slice(pending.findIndex(x=>x.id===row.id)+1);
          for(const next of following){
            const value=String((next.payload as Record<string,unknown>).text??'');
            if(next.eventType!=='CONVERSATION_TEXT'||next.notBefore.getTime()!==fresh.notBefore.getTime()||size+1+value.length>4000||(!burstable(value)||!(this.conversationAgent?.readsWholeBursts||relatedConversationText(turnRows.map(x=>String((x.payload as Record<string,unknown>).text??'')),value))))break;
            const current=await this.db.botApodInbox.findUniqueOrThrow({where:{id:next.id}});
            if(current.status!=='PENDING'||current.notBefore.getTime()>Date.now())break;
            turnRows.push(current);size+=1+value.length;
          }
        }
        const turnIds=turnRows.map(x=>x.id);
        let eventType=row.eventType;let eventPayload=row.payload as Record<string,unknown>;
        if(eventType==='CONVERSATION_TEXT'){
          if(!c.identityVerified){await this.db.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'IDENTITY_NOT_VERIFIED'}});return;}
          const reportedText=turnRows.map(x=>String((x.payload as Record<string,unknown>).text??'')).join('\n');
          const previousAssistant=await this.db.botApodMessage.findFirst({where:{expedienteId:id,role:'assistant',createdAt:{lt:row.createdAt}},orderBy:[{createdAt:'desc'},{id:'desc'}],select:{content:true}});
          const reported=this.env.APUD_VERSION===1&&!c.optOutAt?phaseOneReportedOutcome(reportedText,{currentState:c.currentState,pendingQuestion:c.pendingQuestion,lastAssistantText:previousAssistant?.content}):null;
          if(reported){
            await this.db.$transaction(async tx=>{
              await closePhaseOne(tx,c,reported,{inboxIds:turnIds,messageId:row.externalId},'WHATSAPP_CLIENT');
              await tx.botApodInbox.updateMany({where:{id:{in:turnIds},status:'PENDING'},data:{status:'PROCESSED',processedAt:new Date()}});
            });return;
          }
          // Completion reports take precedence over unsent guidance. Ordinary turns still wait.
          if(await this.db.botApodAccion.count({where:{expedienteId:id,actionType:{in:['SEND_WHATSAPP_MESSAGE','SEND_WHATSAPP_BUTTONS','SEND_WHATSAPP_MEDIA']},status:{in:['PENDING','RUNNING','UNCERTAIN']}}}))return;
          const declinesSharing=!c.optOutAt&&c.currentState===ApodState.ESCALATED_HUMAN
            &&/no (?:te |os )?(?:lo |la )?(?:quiero|voy a|pienso) (?:enviar|mandar|pasar|compartir)|no (?:lo|la) (?:envio|mando|comparto)|prefiero no (?:enviar|mandar|compartir)|no quiero compartir (?:mi|el) certificado|no pienso enviarlo/
              .test(String((row.payload as Record<string,unknown>).text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
          // A case a person holds cannot take workflow events (the decision contract rejects them), so
          // every message goes to that person. Unpausing it here used to leave the message pending for
          // good with no reply. A refusal to share still gets the two routes that need nothing sent.
          if(c.automationPaused||c.optOutAt||c.currentState===ApodState.ESCALATED_HUMAN){
            await this.db.$transaction(async tx=>{
              await tx.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'AUTOMATION_PAUSED',processedAt:new Date()}});
              if(!c.optOutAt)await tx.botApodHumanTask.upsert({where:{dedupeKey:`inbox:${row.id}`},create:{expedienteId:id,dedupeKey:`inbox:${row.id}`,kind:'CONVERSATION_REVIEW',reason:'Nuevo mensaje durante el traspaso al equipo.',evidence:json({inboxId:row.id,stepReached:c.stepReached})},update:{}});
              // Silence reads as abandonment: acknowledge once per hold while a person takes over.
              if(!c.optOutAt&&c.currentState===ApodState.ESCALATED_HUMAN){
                const key=declinesSharing?`held-decline-${id}-${c.version}`:`held-ack-${id}-${c.version}`;
                const ackText=declinesSharing
                  ?'Entendido, no hace falta que nos mandes nada. Puedes hacerlo gratis en el juzgado, con cita en el decanato, o con la empresa colaboradora por 35 €. Una compañera del equipo te escribe por aquí para ayudarte con la opción que prefieras.'
                  :'Gracias, lo tengo apuntado. Una compañera del equipo lo está viendo y te escribe por aquí para seguir desde donde lo dejamos.';
                await tx.botApodAccion.upsert({where:{idempotencyKey:key},create:{expedienteId:id,decisionId:randomUUID(),expectedVersion:c.version,actionType:'SEND_WHATSAPP_MESSAGE',payload:json({kind:'SEND_WHATSAPP_MESSAGE',template:'CONVERSATION_REPLY',variables:{replyText:ackText},contextStep:c.stepReached,humanHandoff:true,handoffReason:'HUMANO'}),idempotencyKey:key},update:{}});
              }
            });
            return;
          }
          if(!this.conversationAgent)throw new AppError('CONVERSATION_AGENT_NOT_CONFIGURED');
          const sourceMessage=await this.db.botApodMessage.findUnique({where:{externalId:row.externalId}});
          const history=await this.db.botApodMessage.findMany({where:{expedienteId:id,externalId:{notIn:turnRows.map(x=>x.externalId)},OR:[{role:'assistant'},{createdAt:{lt:sourceMessage?.createdAt??row.createdAt}}]},orderBy:[{createdAt:'desc'},{id:'desc'}],take:40});
          // Approved Meta templates store a marker instead of their body in history.
          // An accepted opening receipt works for both transports, across all history.
          const sentOpening=await this.db.botApodAccion.findFirst({where:{expedienteId:id,status:{in:['AWAITING_DELIVERY','EXECUTED']},receipt:{path:['template'],equals:'ASK_HAS_CERT'}},select:{id:true}});
          const introduction=sentOpening??await this.db.botApodMessage.findFirst({where:{expedienteId:id,role:'assistant',OR:[{content:'Plantilla aprobada: ASK_HAS_CERT'},{AND:[{content:{contains:'LITIGIOS'}},{content:{contains:'apoderamiento apud acta'}}]}]},select:{id:true}});
          const parts=turnRows.map(x=>String((x.payload as Record<string,unknown>).text??'').trim());
          let text=parts.join('\n');
          if(parts.some(p=>p==='[CONTENIDO_SENSIBLE_OMITIDO]'))text='[CONTENIDO_SENSIBLE_OMITIDO]';
          else{const certificate=parts.find(p=>/^\[CERTIFICADO:[A-Z_]+/.test(p));if(certificate)text=certificate;}
          // A password that just arrived is checked against the certificate waiting for it.
          if(this.attachmentIntake&&text.trim()==='[CONTENIDO_SENSIBLE_OMITIDO]'){
            const checked=await this.attachmentIntake.checkPair({id:c.id,dni:c.dni});
            text=certificateMarker(checked.check,checked.validTo);
            await this.db.botApodAuditLog.create({data:{expedienteId:id,event:'CERTIFICATE_CHECKED',operator:'WHATSAPP_CLIENT',metadata:json({check:checked.check})}});
          }
          // Durable memory beyond the recent window: the client may be answering days later.
          const older=await this.db.botApodMessage.findMany({where:{expedienteId:id,id:{notIn:history.map(m=>m.id)},externalId:{notIn:turnRows.map(x=>x.externalId)},createdAt:{lt:sourceMessage?.createdAt??row.createdAt}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:200});
          const memory=historicalCaseMemory(older.reverse(),text);
          const previousInboundAt=history.find(m=>m.role==='user')?.createdAt??c.lastInboundAt;
          const turn=await this.conversationAgent.turn(c,text,history.reverse().map(m=>({role:m.role==='user'?'user':'assistant',content:m.content})),Boolean(introduction),[caseMemory({...c,lastInboundAt:previousInboundAt,conversationSummary:null}),memory].filter(Boolean).join('\n'));
          if(signal.aborted)throw new AppError('LOCK_LOST');
          const latest=await this.load(id);if(latest.optOutAt||latest.automationPaused)return;
          if(memory)await this.db.botApodExpediente.update({where:{id},data:{conversationSummary:memory,conversationSummaryAt:new Date(),conversationSummaryTurns:older.length}});
          eventType=turn.type;eventPayload={...eventPayload,...turn.payload};delete eventPayload.text;
        }
        if(eventType===E.help){
          const evidence=row.payload as Record<string,unknown>;
          await this.db.$transaction(async tx=>{
            await tx.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'CLIENT_MESSAGE_REQUIRES_OPERATOR_REVIEW'}});
            await tx.botApodHumanTask.upsert({where:{dedupeKey:`inbox:${row.id}`},create:{expedienteId:id,dedupeKey:`inbox:${row.id}`,kind:'CONVERSATION_REVIEW',reason:'Mensaje pendiente de atención profesional.',evidence:json({inboxId:row.id,stepReached:c.stepReached})},update:{}});
            await tx.botApodAuditLog.create({data:{expedienteId:id,event:'CLIENT_MESSAGE_REQUIRES_OPERATOR_REVIEW',operator:'WHATSAPP_CLIENT',metadata:json({inboxId:row.id,externalId:row.externalId,messageId:typeof evidence.messageId==='string'?evidence.messageId:undefined,messageSha256:typeof evidence.messageSha256==='string'?evidence.messageSha256:undefined,conversationClassification:typeof evidence.conversationClassification==='string'?evidence.conversationClassification:undefined,conversationReviewReason:typeof evidence.conversationReviewReason==='string'?evidence.conversationReviewReason:undefined,source:row.source})}});
          });
          return;
        }
        if([E.consentYes,E.review].includes(row.eventType as typeof E.consentYes)){
          const evidence=row.payload as Record<string,unknown>;
          const requestAction=typeof evidence.requestActionId==='string'?await this.db.botApodAccion.findUnique({where:{id:evidence.requestActionId}}):null;
          if(!requestAction||requestAction.expedienteId!==c.id||requestAction.expectedVersion!==c.version||requestAction.createdAt.getTime()<Date.now()-3600000){await this.db.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'STALE_CLIENT_CONSENT_OR_REVIEW'}});return;}
        }
        if(!c.identityVerified){await this.db.botApodInbox.update({where:{id:row.id},data:{status:'HUMAN_REQUIRED',lastError:'IDENTITY_NOT_VERIFIED'}});return;}
        await this.db.$transaction(async tx=>{
          if(row.eventType==='CONVERSATION_TEXT'){
            // An arrival while the model was thinking invalidates this draft. The
            // shared row lock closes the race between this check and committing.
            await tx.$queryRaw`SELECT id FROM bot_apod_expedientes WHERE id = ${id} FOR UPDATE`;
            const newer=await tx.botApodInbox.count({where:{expedienteId:id,status:'PENDING',id:{notIn:turnIds},OR:[{notBefore:{gt:new Date()}},{createdAt:{gt:snapshotAt}}]}});
            if(newer)return;
          }
          // Facts the client stated in a turn the brain answered in words: keep the case in step
          // with the conversation, so later steps (such as the office route) are offered.
          const stated:WorkflowPatch={};
          if(eventType===E.smallTalk){
            if(eventPayload.brainFactCert==='si')stated.hasDigitalCert=true;
            if(eventPayload.brainFactCert==='no'){stated.hasDigitalCert=false;stated.certDevice='NONE';}
            if(eventPayload.brainFactDevice==='movil'){stated.hasDigitalCert=true;stated.certDevice='MOBILE';}
            if(eventPayload.brainFactDevice==='ordenador'){stated.hasDigitalCert=true;stated.certDevice='PC';}
          }
          await this.transition(tx,c,eventType,eventPayload,stated,'WHATSAPP_CLIENT');
          const payload=eventPayload;
          const needsHumanReview=payload.requiresHumanReview===true;
          await tx.botApodInbox.updateMany({where:{id:{in:turnIds},status:'PENDING'},data:{status:needsHumanReview?'HUMAN_REQUIRED':'PROCESSED',lastError:needsHumanReview?'CLIENT_MESSAGE_REQUIRES_OPERATOR_REVIEW':null,processedAt:new Date()}});
        });
      });
    }
    });
  }
  factPatch(type:string):WorkflowPatch {
    if(type===E.certYes)return {hasDigitalCert:true};if(type===E.certNo)return {hasDigitalCert:false,certDevice:'NONE'};
    if(type===E.deviceMobile)return {certDevice:'MOBILE',hasDigitalCert:true};if(type===E.devicePc)return {certDevice:'PC',hasDigitalCert:true};
    if(type===E.consentNo)return {consentGranted:false,consentGrantedAt:null};
    return {};
  }
}
