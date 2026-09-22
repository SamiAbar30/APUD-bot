import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { WorkflowService } from '../core/workflow-service.js';
import { json } from '../core/workflow-service.js';
import { AppError } from '../infrastructure/security.js';
import { redactConversationPii } from '../core/conversation-policy.js';
import { canFollowUp, FOLLOW_UP_STATES, nextFollowUp } from '../core/follow-up.js';
import { phaseOneExpired } from '../core/phase-one.js';

const params=z.object({id:z.string().uuid()});
export async function automationRoutes(api:FastifyInstance,flow:WorkflowService,aiStatus:string){
  api.get('/automation',async()=>({apudVersion:flow.env.APUD_VERSION,credentialIntakeEnabled:Boolean(flow.env.APUD_CREDENTIAL_KEY),pollerEnabled:flow.env.KMALEON_POLLER_ENABLED,remindersEnabled:flow.env.REMINDERS_ENABLED,aiMode:flow.env.AI_MODE,aiStatus,dayanaConfigured:true,notificationChannel:'PLATFORM',triggerMacros:[24,27],triggerRecipient:'ABAR, SAMI',pollIntervalMs:flow.env.KMALEON_POLL_INTERVAL_MS,reminderDays:[3,7,15],expiryDay:30,deadlineBasis:'FIRST_ACCEPTED_CONTACT',triggers:await flow.db.botApodTrigger.findMany({orderBy:{createdAt:'desc'},take:50})}));
  api.get('/human-tasks',async()=>flow.db.botApodHumanTask.findMany({where:{status:'OPEN'},orderBy:{createdAt:'asc'},take:300}));
  api.post('/human-tasks/:id/resolve',async request=>{
    const {id}=params.parse(request.params);const b=z.object({operatorId:z.string().trim().min(3).max(100),evidenceRef:z.string().trim().min(5).max(200)}).strict().parse(request.body);
    return flow.db.$transaction(async tx=>{
      const task=await tx.botApodHumanTask.findUniqueOrThrow({where:{id}});
      if(['DOCUMENT_REVIEW','ASSISTED_PROCESSING'].includes(task.kind))throw new AppError('USE_DOCUMENT_OR_ASSISTANCE_REVIEW_ENDPOINT');
      const changed=await tx.botApodHumanTask.updateMany({where:{id,status:'OPEN'},data:{status:'RESOLVED',resolvedAt:new Date(),resolvedBy:b.operatorId,resolutionRef:b.evidenceRef}});
      if(changed.count!==1)throw new AppError('TASK_ALREADY_RESOLVED');
      await tx.botApodAuditLog.create({data:{expedienteId:task.expedienteId,event:'HUMAN_TASK_RESOLVED',operator:b.operatorId,metadata:json({taskId:id,kind:task.kind,evidenceRef:b.evidenceRef,chargesApplied:false})}});
      return {status:'RESOLVED'};
    });
  });
  api.post('/cases/:id/automation',async request=>{
    const {id}=params.parse(request.params);const b=z.object({paused:z.boolean(),version:z.number().int().nonnegative(),reason:z.string().trim().min(5).max(200)}).strict().parse(request.body);
    return flow.locked(id,async()=>flow.db.$transaction(async tx=>{
      const c=await tx.botApodExpediente.findUniqueOrThrow({where:{id}});
      if(c.version!==b.version)throw new AppError('CASE_CHANGED_RELOAD');
      if(c.phaseOneClosedAt||flow.env.APUD_VERSION===1&&phaseOneExpired(c))throw new AppError('PHASE_ONE_CLOSED',409);
      if(!b.paused&&(c.optOutAt||c.currentState==='ESCALATED_HUMAN'))throw new AppError('CASE_REQUIRES_EXPLICIT_RECOVERY');
      if(!b.paused&&await tx.botApodHumanTask.count({where:{expedienteId:id,kind:'NO_RESPONSE_30_DAYS',status:'OPEN'}}))throw new AppError('MANAGEMENT_REVIEW_REQUIRED');
      const anchor=c.phaseOneStartedAt??new Date();
      const row=await tx.botApodExpediente.update({where:{id},data:{automationPaused:b.paused,version:{increment:1},reminderCycle:{increment:1},reminderAnchorAt:anchor,...(!c.phaseOneStartedAt?{reminderCount:0,lastReminderDay:0}:{}),nextReminderAt:!b.paused&&canFollowUp(c)?nextFollowUp(anchor,c.phaseOneStartedAt?c.lastReminderDay:0):null}});
      await tx.botApodAuditLog.create({data:{expedienteId:id,event:b.paused?'AUTOMATION_PAUSED':'AUTOMATION_RESUMED',operator:'OPERATOR',metadata:json({reason:b.reason,stepReached:c.stepReached})}});
      return row;
    }));
  });
  api.get('/cases/:id/messages',async request=>{const {id}=params.parse(request.params);return flow.db.botApodMessage.findMany({where:{expedienteId:id},orderBy:{createdAt:'asc'},take:300});});
  api.post('/cases/:id/messages',async request=>{
    const {id}=params.parse(request.params);
    const b=z.object({sourceRef:z.string().trim().min(5).max(200),identityVerified:z.literal(true),messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(4000),timestamp:z.string().datetime()}).strict()).min(1).max(100)}).strict().parse(request.body);
    if(b.messages.some(m=>Date.parse(m.timestamp)>Date.now()+60_000))throw new AppError('FUTURE_HISTORY_REJECTED');
    return flow.locked(id,async()=>flow.db.$transaction(async tx=>{
      const c=await tx.botApodExpediente.findUniqueOrThrow({where:{id}});if(!c.identityVerified)throw new AppError('IDENTITY_NOT_VERIFIED');
      const messages=b.messages.map(m=>({expedienteId:id,externalId:'history:'+createHash('sha256').update(JSON.stringify([id,b.sourceRef,m.role,m.timestamp,m.content])).digest('hex'),role:m.role,content:redactConversationPii(m.content).slice(0,2000),source:'OPERATOR_IMPORT:'+b.sourceRef,createdAt:new Date(m.timestamp)}));
      const inserted=await tx.botApodMessage.createMany({data:messages,skipDuplicates:true});
      await tx.botApodExpediente.update({where:{id},data:{priorConversation:true}});
      await tx.botApodAuditLog.create({data:{expedienteId:id,event:'CONVERSATION_HISTORY_IMPORTED',operator:'OPERATOR',metadata:json({sourceRef:b.sourceRef,count:inserted.count,redacted:true})}});
      return {imported:inserted.count,redacted:true};
    }));
  });
}
