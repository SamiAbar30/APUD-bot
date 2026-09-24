import { ApodState, Prisma, type BotApodAccion, type BotApodExpediente } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ConfiguredAdapters } from '../adapters/configured.js';
import { AdapterError } from '../adapters/common/http.js';
import type { WhatsAppPort } from '../adapters/ports.js';
import type { WhatsAppStatus } from '../contracts/whatsapp.contract.js';
import { ApudataApprovalSchema } from '../contracts/apudata.contract.js';
import type { DocumentProof } from '../contracts/kmaleon.contract.js';
import { AppError, errorCode, requireOutbound } from '../infrastructure/security.js';
import { WorkflowService, json, type WorkflowPatch } from '../core/workflow-service.js';
import { messageForCase } from '../core/messages.js';
import type { TemplateVariables } from '../domain/fsm/actions.js';
import { courtChecklist, tutorialWithRoster } from '../core/guides.js';
import { approvedTemplate } from '../core/approved-template.js';
import { E } from '../core/workflow-events.js';
import type { Queues } from './queues.js';
import { canFollowUp, recentConversation, FOLLOW_UP_STATES, nextFollowUp } from '../core/follow-up.js';
import { randomUUID } from 'node:crypto';
import { redactConversationPii } from '../core/conversation-policy.js';
import { redactOutboundHistory } from '../core/outbound-history.js';
import { lastQuestionOf } from '../core/case-memory.js';
import { closePhaseOne, phaseOneExpired } from '../core/phase-one.js';
type Receipt = {receipt:Record<string,unknown>;event?:string;patch?:WorkflowPatch;awaitDelivery?:boolean};
const EffectContextSchema=z.object({
  id:z.string(),version:z.number().int(),dni:z.string(),nombre:z.string(),telefono:z.string(),
  currentState:z.nativeEnum(ApodState),identityVerified:z.boolean(),
  kmaleonExpedienteId:z.string().nullable(),documentId:z.string().nullable(),
  documentApproved:z.boolean(),clientReviewed:z.boolean(),
  apudataPreApproved:z.boolean(),apudataApprovalExpiresAt:z.string().datetime().nullable(),
  apudataApprovalEvidence:z.unknown(),
  reminderCycle:z.number().int().optional(),stepReached:z.string().optional(),reminderAnchorAt:z.string().datetime().nullable().optional(),
});
function effectContext(c:BotApodExpediente){return {
  id:c.id,version:c.version,dni:c.dni,nombre:c.nombre,telefono:c.telefono,
  currentState:c.currentState,identityVerified:c.identityVerified,
  kmaleonExpedienteId:c.kmaleonExpedienteId,documentId:c.documentId,
  documentApproved:c.documentApproved,clientReviewed:c.clientReviewed,
  apudataPreApproved:c.apudataPreApproved,apudataApprovalExpiresAt:c.apudataApprovalExpiresAt?.toISOString()??null,
  apudataApprovalEvidence:c.apudataApprovalEvidence,
  reminderCycle:c.reminderCycle,stepReached:c.stepReached,reminderAnchorAt:c.reminderAnchorAt?.toISOString()??null,
};}
function restoreEffectContext(c:BotApodExpediente,value:unknown):BotApodExpediente{
  const pinned=EffectContextSchema.parse(value);
  if(pinned.id!==c.id)throw new AppError('EFFECT_CONTEXT_IDENTITY_MISMATCH');
  return {...c,...pinned,reminderCycle:pinned.reminderCycle??-1,stepReached:pinned.stepReached??c.stepReached,reminderAnchorAt:pinned.reminderAnchorAt?new Date(pinned.reminderAnchorAt):null,apudataApprovalExpiresAt:pinned.apudataApprovalExpiresAt?new Date(pinned.apudataApprovalExpiresAt):null,apudataApprovalEvidence:(pinned.apudataApprovalEvidence??null) as Prisma.JsonValue};
}
const SavedEffectSchema=z.object({receipt:z.record(z.unknown()),event:z.string().optional(),patch:z.record(z.unknown()).optional(),awaitDelivery:z.boolean().optional()});
export class ActionExecutor {
  constructor(readonly flow:WorkflowService,readonly adapters:ConfiguredAdapters,readonly wa:WhatsAppPort|undefined,readonly queues:Queues){}
  async execute(id:string){
    const initial=await this.flow.db.botApodAccion.findUnique({where:{id}});if(!initial)return;
    await this.flow.locked(initial.expedienteId,async signal=>{
      const action=await this.flow.db.botApodAccion.findUniqueOrThrow({where:{id}});
      if(!['PENDING','UNCERTAIN'].includes(action.status))return;
      const currentCase=await this.flow.load(action.expedienteId);
      const reconcileOnly=action.status==='UNCERTAIN';
      if(!reconcileOnly&&this.flow.env.APUD_VERSION===1&&phaseOneExpired(currentCase)&&!currentCase.phaseOneClosedAt){
        await this.flow.db.$transaction(tx=>closePhaseOne(tx,currentCase,'DEADLINE_REACHED',{source:'OUTBOX_DEADLINE_CHECK'}));return;
      }
      if(!reconcileOnly&&(currentCase.phaseOneClosedAt||this.flow.env.APUD_VERSION===1&&['TRIGGER_SEDE_AUTOMATION','CALL_APUDATA_PREAPPROVAL','UPLOAD_KMALEON_DOCUMENT','CREATE_KMALEON_AVISO','NOTIFY_DAYANA'].includes(action.actionType))){
        await this.flow.db.botApodAccion.update({where:{id},data:{status:'CANCELLED',lastError:currentCase.phaseOneClosedAt?'PHASE_ONE_CLOSED':'APUD_V2_REQUIRED'}});return;
      }
      const actionPayload=action.payload as Record<string,unknown>;
      const isReminder=typeof actionPayload.reminderDay==='number';
      const humanHandoff=actionPayload.humanHandoff===true&&['HUMAN_HANDOFF_NOTICE','CONVERSATION_REPLY'].includes(String(actionPayload.template))&&currentCase.currentState==='ESCALATED_HUMAN';
      if(!reconcileOnly&&(currentCase.optOutAt||(currentCase.automationPaused&&!humanHandoff))){
        await this.flow.db.botApodAccion.update({where:{id},data:{status:'CANCELLED',lastError:'AUTOMATION_PAUSED_OR_CLIENT_OPT_OUT'}});return;
      }
      if(isReminder&&!reconcileOnly){
        const freshInput=await this.flow.db.botApodInbox.count({where:{expedienteId:currentCase.id,status:'PENDING'}});
        if(freshInput||recentConversation(currentCase)||actionPayload.reminderCycle!==currentCase.reminderCycle||actionPayload.stepReached!==currentCase.stepReached||actionPayload.anchor!==currentCase.reminderAnchorAt?.toISOString()||!canFollowUp(currentCase)){
          await this.flow.db.botApodAccion.update({where:{id},data:{status:'CANCELLED',lastError:'FOLLOW_UP_CONTEXT_CHANGED'}});return;
        }
      }
      const isConversationReply=action.actionType==='SEND_WHATSAPP_MESSAGE'&&actionPayload.template==='CONVERSATION_REPLY';
      // A support answer can outlive a version change only within the same saved step.
      if(isConversationReply&&!reconcileOnly&&actionPayload.contextStep!==currentCase.stepReached){await this.flow.db.botApodAccion.update({where:{id},data:{status:'STALE',lastError:'CONVERSATION_STEP_CHANGED'}});return;}
      if(currentCase.version!==action.expectedVersion&&!reconcileOnly&&!isConversationReply&&!isReminder){await this.flow.db.botApodAccion.update({where:{id},data:{status:'STALE',lastError:'CASE_CHANGED_BEFORE_EFFECT'}});return;}
      const priorReceipt=action.receipt&&typeof action.receipt==='object'&&!Array.isArray(action.receipt)?action.receipt as Record<string,unknown>:{};
      const saved=SavedEffectSchema.safeParse(priorReceipt.effectResult);
      if(action.retryCount>=action.maxRetries&&!saved.success){await this.flow.db.botApodAccion.update({where:{id},data:{status:'HUMAN_REQUIRED',lastError:reconcileOnly?'UNCERTAIN_RETRY_LIMIT_RECONCILE_MANUALLY':'RETRY_LIMIT_REQUIRES_REVIEW'}});return;}
      let c=currentCase;
      if(reconcileOnly){
        if(priorReceipt.executionContext){
          try{c=restoreEffectContext(currentCase,priorReceipt.executionContext);if(c.version!==action.expectedVersion)throw new AppError('EFFECT_CONTEXT_VERSION_MISMATCH');}
          catch{await this.flow.db.botApodAccion.update({where:{id},data:{status:'HUMAN_REQUIRED',lastError:'INVALID_EFFECT_CONTEXT_RECONCILE_MANUALLY'}});return;}
        }else if(currentCase.version!==action.expectedVersion){await this.flow.db.botApodAccion.update({where:{id},data:{status:'HUMAN_REQUIRED',lastError:'STALE_OUTCOME_RECONCILE_MANUALLY'}});return;}
      }
      if(signal.aborted)throw new AppError('LOCK_LOST');
      const context=effectContext(c);
      const startedAt=new Date();
      let attempted=false;
      let running=false;
      let result:Receipt|undefined;
      const beforeEffect=async()=>{
        if(signal.aborted)throw new AppError('LOCK_LOST');
        const fresh=await this.flow.load(action.expedienteId);
        if(!reconcileOnly&&(fresh.phaseOneClosedAt||this.flow.env.APUD_VERSION===1&&phaseOneExpired(fresh)))throw new AppError('PHASE_ONE_CLOSED');
        if(!reconcileOnly&&(fresh.optOutAt||(fresh.automationPaused&&!(humanHandoff&&fresh.currentState==='ESCALATED_HUMAN'))))throw new AppError('AUTOMATION_PAUSED_OR_CLIENT_OPT_OUT');
        if(isConversationReply&&!reconcileOnly&&actionPayload.contextStep!==fresh.stepReached)throw new AppError('CONVERSATION_STEP_CHANGED');
        if(isReminder&&!reconcileOnly&&(recentConversation(fresh)||actionPayload.reminderCycle!==fresh.reminderCycle||actionPayload.stepReached!==fresh.stepReached||actionPayload.anchor!==fresh.reminderAnchorAt?.toISOString()||!canFollowUp(fresh)||await this.flow.db.botApodInbox.count({where:{expedienteId:fresh.id,status:'PENDING'}})))throw new AppError('FOLLOW_UP_CONTEXT_CHANGED');
        if(signal.aborted)throw new AppError('LOCK_LOST');attempted=true;
      };
      try {
        if(!saved.success)requireOutbound(this.flow.env.OUTBOUND_ENABLED);
        if(!c.identityVerified)throw new AppError('IDENTITY_NOT_VERIFIED');
        const claimed=await this.flow.db.botApodAccion.updateMany({where:{id,status:action.status,retryCount:action.retryCount},data:{status:'RUNNING',startedAt,retryCount:{increment:1},lastError:null,receipt:json({...priorReceipt,executionContext:context})}});
        if(claimed.count!==1)return;
        running=true;
        if(signal.aborted)throw new AppError('LOCK_LOST');
        result=saved.success?saved.data as Receipt:await this.effect(action,c,reconcileOnly,beforeEffect);
        if(signal.aborted)throw new AdapterError('LOCK_LOST_AFTER_EFFECT','uncertain');
        const completed=result;
        await this.flow.db.$transaction(async tx=>{
          const current=await tx.botApodExpediente.findUniqueOrThrow({where:{id:c.id}});
          const updated=await tx.botApodAccion.updateMany({where:{id,status:'RUNNING',startedAt},data:{status:completed.awaitDelivery?'AWAITING_DELIVERY':'EXECUTED',receipt:json({...completed.receipt,executionContext:context,...(completed.event?{nextEvent:completed.event}:{})}),executedAt:completed.awaitDelivery?null:new Date()}});
          if(updated.count!==1)throw new AdapterError('ACTION_ATTEMPT_CHANGED','uncertain');
          if(completed.awaitDelivery){
            const at=new Date();
            if(this.flow.env.APUD_VERSION===1&&!current.phaseOneStartedAt&&!current.phaseOneClosedAt){
              await tx.botApodExpediente.updateMany({where:{id:c.id,phaseOneStartedAt:null},data:{phaseOneStartedAt:at,reminderAnchorAt:at}});
            }
            if(typeof completed.receipt.historyText==='string'){
              const historyText=redactOutboundHistory(completed.receipt.historyText);
              await tx.botApodMessage.upsert({where:{externalId:`outbox:${id}`},create:{expedienteId:c.id,externalId:`outbox:${id}`,role:'assistant',content:historyText.slice(0,2000),source:'OUTBOX_ACCEPTED'},update:{}});
              const question=lastQuestionOf(historyText);
              if(question)await tx.botApodExpediente.update({where:{id:c.id},data:{pendingQuestion:question,pendingQuestionAt:new Date()}});
            }
            if(current.reminderCycle===c.reminderCycle&&!current.automationPaused&&!current.optOutAt){
              const anchor=this.flow.env.APUD_VERSION===1?(current.phaseOneStartedAt??at):(current.reminderAnchorAt??at);
              const day=isReminder?Number(actionPayload.reminderDay):current.lastReminderDay;
              await tx.botApodExpediente.update({where:{id:c.id},data:{lastOutboundAt:at,...(this.flow.env.APUD_VERSION===1?{phaseOneStartedAt:anchor}:{}),reminderAnchorAt:anchor,...(isReminder?{reminderCount:{increment:1},lastReminderDay:day}:{}),nextReminderAt:canFollowUp(current)?nextFollowUp(anchor,day):null}});
            }
          }
          if(completed.patch?.isProvisionalFiled!==undefined && c.documentId)await tx.botApodDocumento.update({where:{id:c.documentId},data:{uploadedKmaleon:true,kmaleonDocumentId:String(completed.receipt.documentId)}});
          if(current.version!==action.expectedVersion){await tx.botApodAuditLog.create({data:{expedienteId:c.id,event:'EFFECT_CONFIRMED_AFTER_STATE_CHANGE',metadata:json({actionId:id,expectedVersion:action.expectedVersion,currentVersion:current.version})}});}
          else if(completed.event&&!completed.awaitDelivery&&!current.phaseOneClosedAt)await this.flow.transition(tx,current,completed.event,completed.receipt,completed.patch??{});
        });
      }catch(error){
        // A database failure after a verified effect never authorizes another send.
        // An explicit not_applied adapter result applies only to this attempt; an
        // earlier uncertain attempt remains unresolved until affirmative evidence.
        const uncertain=reconcileOnly||result!==undefined||(error instanceof AdapterError?error.outcome==='uncertain':attempted);
        const exhausted=running&&action.retryCount+1>=action.maxRetries;
        const status=isReminder&&!attempted&&!reconcileOnly&&errorCode(error)==='FOLLOW_UP_CONTEXT_CHANGED'?'CANCELLED':exhausted&&!result?'HUMAN_REQUIRED':uncertain?'UNCERTAIN':error instanceof AppError?'BLOCKED':'FAILED';
        const receipt={...priorReceipt,executionContext:context,...(result?{...result.receipt,...(result.event?{nextEvent:result.event}:{}),effectResult:result}:{})};
        const updated=await this.flow.db.botApodAccion.updateMany({where:{id,...(running?{status:'RUNNING',startedAt}:{status:action.status})},data:{status,receipt:json(receipt),lastError:errorCode(error)}});
        if(updated.count===1&&['FAILED','UNCERTAIN','HUMAN_REQUIRED'].includes(status))await this.queues.deadLetter.add('effect-needs-review',{actionId:id,expedienteId:c.id,code:errorCode(error)},{jobId:`dlq-${id}`,removeOnComplete:false});
        const isFallbackNotice=action.idempotencyKey.startsWith('blocked-notice-');
        if(updated.count===1&&status==='BLOCKED'&&!isFallbackNotice&&!isReminder&&['SEND_WHATSAPP_MESSAGE','SEND_WHATSAPP_BUTTONS','SEND_WHATSAPP_MEDIA'].includes(action.actionType)&&!c.optOutAt&&!c.phaseOneClosedAt&&!(this.flow.env.APUD_VERSION===1&&phaseOneExpired(c))){
          await this.flow.db.botApodHumanTask.upsert({where:{dedupeKey:`blocked:${id}`},create:{expedienteId:c.id,dedupeKey:`blocked:${id}`,kind:'CONVERSATION_REVIEW',reason:`Mensaje bloqueado: ${errorCode(error)}`,evidence:json({actionId:id,code:errorCode(error)})},update:{}});
          await this.flow.db.botApodAccion.upsert({where:{idempotencyKey:`blocked-notice-${id}`},create:{expedienteId:c.id,decisionId:randomUUID(),expectedVersion:c.version,actionType:'SEND_WHATSAPP_MESSAGE',payload:json({kind:'SEND_WHATSAPP_MESSAGE',template:'CONVERSATION_REPLY',variables:{replyText:'Para seguir con este paso necesito que lo revise una persona del despacho. Te escribimos por aquí en cuanto lo tenga.'},contextStep:c.stepReached,humanHandoff:true,handoffReason:'HUMANO'}),idempotencyKey:`blocked-notice-${id}`},update:{}});
        }
      }
    });
  }
  private async effect(a:BotApodAccion,c:BotApodExpediente,reconcileOnly:boolean,beforeEffect:()=>Promise<void>):Promise<Receipt>{
    switch(a.actionType){
      case 'SEND_WHATSAPP_MESSAGE':case 'SEND_WHATSAPP_BUTTONS':case 'SEND_WHATSAPP_MEDIA':{
        if(!this.wa)throw new AppError('WHATSAPP_NOT_CONFIGURED');
        if(reconcileOnly)throw new AdapterError('WHATSAPP_DELIVERY_REQUIRES_RECONCILIATION','uncertain');
        const templateId=String((a.payload as Record<string,unknown>).template??'');
        const emulatorTransport=this.flow.env.WHATSAPP_TRANSPORT==='emulator';
        if((!c.lastInboundAt||Date.now()-c.lastInboundAt.getTime()>24*60*60*1000)&&!emulatorTransport){
          const template=await approvedTemplate(this.flow.env.WA_TEMPLATE_CONFIG_FILE,templateId,c);
          await beforeEffect();const accepted=await this.wa.sendTemplate(c.telefono,template.name,template.language,template.parameters);
          return {receipt:{...accepted,to:c.telefono,template:templateId,templateName:template.name,reviewEvidenceRef:template.reviewEvidenceRef,historyText:`Plantilla aprobada: ${templateId}`},...(templateId==='COMPLETION_NOTICE'?{event:E.delivered}:{}),awaitDelivery:true};
        }
        const sentDocument=c.documentId?await this.flow.db.botApodDocumento.findUnique({where:{id:c.documentId}}):null;
        let result;let historyText='';
        if(templateId==='APUDATA_PAYMENT_DETAILS'){
          if(!this.adapters.apudata)throw new AppError('APUDATA_NOT_CONFIGURED');
          const approval=ApudataApprovalSchema.parse(c.apudataApprovalEvidence);
          if(!c.apudataPreApproved||!c.apudataApprovalExpiresAt||c.apudataApprovalExpiresAt.getTime()<=Date.now())throw new AppError('PREAPPROVAL_REQUIRED');
          const instruction=this.adapters.apudata.buildPaymentInstruction(approval,c.id);
          await beforeEffect();result=await this.wa.sendText(c.telefono,instruction);historyText='Instrucciones verificadas de pago enviadas.';
        }else{
          const actionPayload=a.payload as Record<string,unknown>;
          const rawVariables=actionPayload.variables;
          const variables=rawVariables&&typeof rawVariables==='object'&&!Array.isArray(rawVariables)?rawVariables as TemplateVariables:undefined;
          const guide=messageForCase(c,this.flow.env.CONSENT_VERSION,String(actionPayload.template??''),variables);
          historyText=guide.text;
          // With an approved consent text configured, that text is what goes out. Without one the
          // plain request is sent instead of blocking the case, which is what used to leave the
          // client reading certificate instructions they had already said they could not follow.
          if(templateId==='ASSIST_CONSENT_REQUEST'&&this.flow.env.CONSENT_TEXT_FILE){
            guide.text=await readFile(this.flow.env.CONSENT_TEXT_FILE,'utf8');
            if(!guide.text.includes(this.flow.env.CONSENT_VERSION??''))throw new AppError('CONSENT_VERSION_NOT_IN_APPROVED_TEXT');
          }
          if(guide.requiresVerifiedContent==='APUDATA_VIDEO_INSTRUCTIONS'){
            if(!c.apudataOrderId)throw new AppError('VERIFIED_PARTNER_ORDER_REQUIRED');
            const order=await this.flow.db.botApodAccion.findFirst({where:{expedienteId:c.id,status:'EXECUTED',actionType:'CALL_APUDATA_PREAPPROVAL',receipt:{path:['orderId'],equals:c.apudataOrderId}},orderBy:{createdAt:'desc'}});
            const videoUrl=(order?.receipt as Record<string,unknown>|null)?.videoUrl;
            if(typeof videoUrl!=='string'||!videoUrl.startsWith('https://'))throw new AppError('VERIFIED_VIDEO_URL_REQUIRED');
            guide.text='El proveedor ha registrado tu solicitud. Completa la identificación desde este enlace verificado: '+videoUrl;
          }
          historyText=guide.text;
          if(guide.attachment){
            let bytes:Buffer;let fileName:string;
            switch(guide.attachment){
              case 'COURT_CHECKLIST':bytes=await courtChecklist(c,this.flow.env.REPRESENTATIVES_FILE,this.flow.env.AIRAM_FULL_NAME);fileName='lista-juzgado.pdf';break;
              case 'TUTORIAL':bytes=await tutorialWithRoster(c,this.flow.env.TUTORIAL_FILE,this.flow.env.REPRESENTATIVES_FILE,this.flow.env.AIRAM_FULL_NAME);fileName='tutorial-apud-acta.pdf';break;
              case 'STORED_DOCUMENT':if(!sentDocument||sentDocument.documentType!=='BORRADOR_SEDE')throw new AppError('DRAFT_DOCUMENT_REQUIRED');bytes=await this.flow.storage.read(sentDocument.s3OrLocalPath,sentDocument.sha256Hash);fileName='borrador-apud-acta.pdf';break;
              case 'REVOCATION_GUIDE':case 'REVOCATION_SCREENSHOTS':{
                const path=guide.attachment==='REVOCATION_GUIDE'?this.flow.env.REVOCATION_GUIDE_FILE:this.flow.env.REVOCATION_SCREENSHOTS_FILE;
                if(!path)throw new AppError('REVOCATION_MATERIAL_NOT_APPROVED');bytes=await readFile(path);fileName='guia-revocacion.pdf';break;
              }
            }
            await beforeEffect();const mediaId=await this.wa.uploadMedia(bytes,'application/pdf',fileName);
            await beforeEffect();result=guide.buttons?await this.wa.sendDocumentButtons(c.telefono,mediaId,guide.text,guide.buttons):await this.wa.sendDocument(c.telefono,mediaId,fileName,guide.text);
          }else {await beforeEffect();result=guide.buttons?await this.wa.sendButtons(c.telefono,guide.text,guide.buttons):await this.wa.sendText(c.telefono,guide.text);}
        }
        return {receipt:{...result,to:c.telefono,template:(a.payload as Record<string,unknown>).template,historyText:redactOutboundHistory(historyText),documentId:c.documentId,documentSha256:sentDocument?.sha256Hash,consentVersion:c.currentState==='MOBILE_ASSIST_CONSENT_REQUESTED'?this.flow.env.CONSENT_VERSION:undefined},...(templateId==='COMPLETION_NOTICE'?{event:E.delivered}:{}),awaitDelivery:true};
      }
      case 'UPLOAD_KMALEON_DOCUMENT':{
        if(!this.adapters.kmaleon||!c.kmaleonExpedienteId)throw new AppError('KMALEON_NOT_CONFIGURED');
        if(!c.documentApproved||!c.clientReviewed||!c.documentId)throw new AppError('DOCUMENT_AND_CLIENT_REVIEW_REQUIRED');
        const d=await this.flow.db.botApodDocumento.findUniqueOrThrow({where:{id:c.documentId}});
        if(d.expedienteId!==c.id||!d.approvedAt||!d.identityMatches||!d.hasAiram)throw new AppError('DOCUMENT_APPROVAL_INVALID');
        const buffer=await this.flow.storage.read(d.s3OrLocalPath,d.sha256Hash);
        const provisional=d.documentType==='APODERAMIENTO_PROVISIONAL';
        await beforeEffect();
        const proof=await this.adapters.kmaleon.uploadAndVerifyDocument({projectId:c.kmaleonExpedienteId,expectedDni:c.dni,buffer,fileName:`apoderamiento-${d.sha256Hash.slice(0,16)}.pdf`,idempotencyKey:a.idempotencyKey,isProvisional:provisional,reconcileOnly});
        return {receipt:{...proof,isProvisional:provisional},event:E.filed,patch:{isProvisionalFiled:provisional}};
      }
      case 'CREATE_KMALEON_AVISO':case 'NOTIFY_DAYANA':{
        if(!this.adapters.kmaleon||!c.kmaleonExpedienteId||!c.documentId)throw new AppError('KMALEON_NOT_CONFIGURED');
        const d=await this.flow.db.botApodDocumento.findUniqueOrThrow({where:{id:c.documentId}});
        if(!d.uploadedKmaleon)throw new AppError('VERIFIED_DOCUMENT_REQUIRED');
        const prior=await this.flow.db.botApodAccion.findMany({where:{expedienteId:c.id,actionType:'UPLOAD_KMALEON_DOCUMENT',status:'EXECUTED'},orderBy:{createdAt:'desc'}});
        const upload=prior.find(p=>(p.receipt as Record<string,unknown>|null)?.sha256===d.sha256Hash);
        if(!upload?.receipt)throw new AppError('VERIFIED_DOCUMENT_PROOF_REQUIRED');
        await beforeEffect();
        const proof=await this.adapters.kmaleon.notifyDayana({projectId:c.kmaleonExpedienteId,expectedDni:c.dni,idempotencyKey:a.idempotencyKey,documentProof:upload.receipt as unknown as DocumentProof,isProvisional:d.documentType==='APODERAMIENTO_PROVISIONAL',reconcileOnly});
        return {receipt:{...proof,noticeId:proof.annotationId,documentSha256:d.sha256Hash,localDocumentId:d.id,verified:true},event:a.actionType==='CREATE_KMALEON_AVISO'?E.aviso:E.notice};
      }
      case 'CALL_APUDATA_PREAPPROVAL':{
        if(!this.adapters.apudata)throw new AppError('APUDATA_NOT_CONFIGURED');
        const payload=a.payload as Record<string,unknown>;
        if(payload.operation==='CREATE_ORDER'){
          const approval=ApudataApprovalSchema.parse(c.apudataApprovalEvidence);
          if(!c.apudataPreApproved||approval.clientId!==c.id)throw new AppError('PREAPPROVAL_REQUIRED');
          if(typeof payload.paymentEvidenceRef!=='string'||!payload.paymentEvidenceRef.trim())throw new AppError('APUDATA_PAYMENT_EVIDENCE_REQUIRED');
          await beforeEffect();
          const order=await this.adapters.apudata.createOrder({clientId:c.id,idempotencyKey:a.idempotencyKey,approval,paymentEvidenceRef:payload.paymentEvidenceRef,reconcileOnly});
          return {receipt:{...order,orderId:order.id},event:E.ordered,patch:{apudataOrderId:order.id}};
        }
        if(payload.operation!==undefined&&payload.operation!=='PREAPPROVAL_CHECK')throw new AppError('UNKNOWN_APUDATA_OPERATION');
        if(reconcileOnly)throw new AdapterError('APUDATA_PREAPPROVAL_REQUIRES_MANUAL_RECONCILIATION','uncertain');
        await beforeEffect();
        const approval=await this.adapters.apudata.preapprove({clientId:c.id,dni:c.dni,nombre:c.nombre,idempotencyKey:a.idempotencyKey});
        return {receipt:{approval},event:E.preapproved,patch:{apudataPreApproved:true,apudataApprovalExpiresAt:new Date(approval.expiresAt),apudataApprovalEvidence:json(approval)}};
      }
      case 'TRIGGER_SEDE_AUTOMATION':throw new AppError('SECURE_ASSISTANCE_SESSION_REQUIRED');
      default:throw new AppError('UNKNOWN_EFFECT_REQUIRES_OPERATOR');
    }
  }
  async delivery(status:WhatsAppStatus){
    const actions=await this.flow.db.botApodAccion.findMany({where:{receipt:{path:['messageId'],equals:status.id}},take:3});
    if(actions.length!==1)return false;
    const a=actions[0]!;
    return this.flow.locked(a.expedienteId,async signal=>{
      const action=await this.flow.db.botApodAccion.findUniqueOrThrow({where:{id:a.id}});const c=await this.flow.load(a.expedienteId);
      if(c.telefono!==status.recipientId||signal.aborted)return false;
      if(action.status==='EXECUTED')return true;
      if(!['AWAITING_DELIVERY','UNCERTAIN'].includes(action.status))return false;
      if(status.status==='sent')return true;
      if(status.status==='failed'){
        await this.flow.db.botApodAccion.update({where:{id:a.id},data:{status:'FAILED',lastError:`WHATSAPP_DELIVERY_FAILED_${status.errorCodes.join('_')}`}});
        // The client never saw it, so it is not part of the conversation: a refused opening left in
        // history made the bot skip its introduction (live test 23 Sep, Meta 131047).
        await this.flow.db.botApodMessage.deleteMany({where:{externalId:`outbox:${a.id}`}});
        return true;
      }
      const receipt=action.receipt as Record<string,unknown>;
      await this.flow.db.$transaction(async tx=>{
        await tx.botApodAccion.update({where:{id:a.id},data:{status:'EXECUTED',executedAt:new Date(),receipt:json({...receipt,deliveryStatus:status.status,deliveryTimestamp:status.timestamp})}});
        if(!c.phaseOneClosedAt&&c.version===a.expectedVersion&&typeof receipt.nextEvent==='string')await this.flow.transition(tx,c,receipt.nextEvent,{messageId:status.id,verified:true,template:receipt.template,deliveryStatus:status.status});
        else if(receipt.nextEvent) await tx.botApodAuditLog.create({data:{expedienteId:c.id,event:'DELIVERY_CONFIRMED_AFTER_STATE_CHANGE',metadata:json({actionId:a.id,messageId:status.id})}});
      });
      return true;
    });
  }
}
