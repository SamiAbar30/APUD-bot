import { randomUUID } from 'node:crypto';
import type { WorkflowService } from './workflow-service.js';
import type { ConfiguredAdapters } from '../adapters/configured.js';
import { json } from './workflow-service.js';
import { canFollowUp, FOLLOW_UP_STATES, DAY_MS, REMINDER_DAYS, followUpTemplate } from './follow-up.js';
import { errorCode } from '../infrastructure/security.js';
import { closePhaseOne, phaseOneExpired } from './phase-one.js';

/** A durable action is proposed once per silence cycle; the executor rechecks it before sending. */
export async function scheduleFollowUps(flow:WorkflowService,now=new Date()):Promise<void>{
  // The deadline remains enforceable when reminders are disabled or a human hold is active.
  if(flow.env.APUD_VERSION===1){
    const expired=await flow.db.botApodExpediente.findMany({where:{phaseOneClosedAt:null,...(flow.env.DEMO_DATA_ENABLED?{telefono:{in:flow.env.DEMO_WHATSAPP_RECIPIENTS}}:{}),phaseOneStartedAt:{lte:new Date(now.getTime()-30*DAY_MS)}},take:100,orderBy:{phaseOneStartedAt:'asc'}});
    for(const row of expired)await flow.locked(row.id,async signal=>{
      const c=await flow.load(row.id);if(signal.aborted||c.phaseOneClosedAt||!phaseOneExpired(c,now))return;
      await flow.db.$transaction(tx=>closePhaseOne(tx,c,'DEADLINE_REACHED',{stepReached:c.stepReached,anchor:c.phaseOneStartedAt!.toISOString()}));
    });
  }
  if(!flow.env.REMINDERS_ENABLED)return;
  const cases=await flow.db.botApodExpediente.findMany({where:{phaseOneClosedAt:null,...(flow.env.DEMO_DATA_ENABLED?{telefono:{in:flow.env.DEMO_WHATSAPP_RECIPIENTS}}:{}),automationPaused:false,optOutAt:null,nextReminderAt:{lte:now},currentState:{in:[...FOLLOW_UP_STATES]}},take:100,orderBy:{nextReminderAt:'asc'}});
  for(const row of cases){
    if(flow.env.DEMO_DATA_ENABLED&&!flow.env.DEMO_WHATSAPP_RECIPIENTS.includes(row.telefono))continue;
    await flow.locked(row.id,async signal=>{
      const c=await flow.load(row.id);
      if(signal.aborted||c.phaseOneClosedAt||c.automationPaused||c.optOutAt||!c.reminderAnchorAt||!canFollowUp(c))return;
      if(await flow.db.botApodInbox.count({where:{expedienteId:c.id,status:'PENDING'}}))return;
      const days=Math.floor((now.getTime()-c.reminderAnchorAt.getTime())/DAY_MS);
      if(days>=30){
        await flow.db.$transaction(async tx=>{
          const paused=await tx.botApodExpediente.updateMany({where:{id:c.id,reminderCycle:c.reminderCycle,automationPaused:false,optOutAt:null},data:{automationPaused:true,nextReminderAt:null}});
          if(paused.count!==1)return;
          await tx.botApodHumanTask.upsert({where:{dedupeKey:`expiry:${c.id}:${c.reminderCycle}`},create:{expedienteId:c.id,dedupeKey:`expiry:${c.id}:${c.reminderCycle}`,kind:'NO_RESPONSE_30_DAYS',assignedTo:'DAYANA',reason:'Fin del seguimiento. Revisar la última respuesta y el paso pendiente del cliente.',evidence:json({stepReached:c.stepReached,anchor:c.reminderAnchorAt,reminderCount:c.reminderCount})},update:{}});
        });return;
      }
      // After downtime send at most the latest due reminder, never a burst of historical reminders.
      const day=[...REMINDER_DAYS].reverse().find(d=>days>=d&&d>c.lastReminderDay);if(!day)return;
      if(await flow.db.botApodAccion.count({where:{expedienteId:c.id,status:{in:['PENDING','RUNNING','UNCERTAIN','BLOCKED','FAILED','HUMAN_REQUIRED']},payload:{path:['reminderCycle'],equals:c.reminderCycle}}}))return;
      const key=`followup-${c.id}-${c.reminderCycle}-${day}`;
      await flow.db.botApodAccion.upsert({where:{idempotencyKey:key},create:{expedienteId:c.id,decisionId:randomUUID(),expectedVersion:c.version,actionType:'SEND_WHATSAPP_MESSAGE',payload:json({template:followUpTemplate(day),reminderDay:day,reminderCycle:c.reminderCycle,stepReached:c.stepReached,anchor:c.reminderAnchorAt.toISOString()}),idempotencyKey:key},update:{}});
    });
  }
}

/** Source IDs are persisted before linking. Repeated Aviso 27 observations never reset a case. */
export async function pollAviso27(flow:WorkflowService,adapters:ConfiguredAdapters,signal?:AbortSignal):Promise<void>{
  if(!flow.env.KMALEON_POLLER_ENABLED)return;
  const km=adapters.kmaleon;
  if(!km?.listPendingApudActa||!km.resolveTriggerExpediente)throw new Error('AVISO27_READ_MAPPING_REQUIRED');
  const page=await km.listPendingApudActa({page:1});
  // Adapter contract supplies a complete scan; a partial scan cannot authorize intake.
  if(page.hasMore)throw new Error('AVISO27_PAGINATION_INCOMPLETE');
  for(const item of page.items){
    if(signal?.aborted)throw new Error("AVISO27_LOCK_LOST");
    const trigger=await flow.db.botApodTrigger.upsert({where:{externalId:item.externalId},create:{externalId:item.externalId,projectId:item.projectId,evidenceRef:item.evidenceRef,provenance:json(item)},update:{}});
    if(trigger.status==='PROCESSED')continue;
    try{
      const candidate=await km.resolveTriggerExpediente(item.projectId,item);
      if(flow.env.DEMO_DATA_ENABLED&&!flow.env.DEMO_WHATSAPP_RECIPIENTS.includes(candidate.telefono))throw new Error('TRIGGER_RECIPIENT_OUTSIDE_ALLOWLIST');
      if(signal?.aborted)throw new Error('AVISO27_LOCK_LOST');
      await flow.linkKmaleon(candidate,{source:item.macroCode===24?'AVISO_24':'AVISO_27',triggerId:trigger.id});
    }catch(error){await flow.db.botApodTrigger.update({where:{id:trigger.id},data:{status:'HUMAN_REQUIRED',lastError:errorCode(error)}});}
  }
}
