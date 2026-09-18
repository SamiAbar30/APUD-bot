import type { PrismaClient, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { redactConversationPii } from './conversation-policy.js';
import { CONVERSATION_QUIET_MS } from './conversation-batching.js';
/** Durable inbox is authoritative. Only minimized conversation text is retained. */
export class DebounceBuffer {
  constructor(private db: PrismaClient, private queue: Queue, private quietMs=CONVERSATION_QUIET_MS) {}
  async ingestMessage(input: {externalId:string; expedienteId:string|null; telefono:string; eventType:string; payload:Prisma.InputJsonObject; source?:string; conversationText?:string}) {
    const existing=await this.db.botApodInbox.findUnique({where:{externalId:input.externalId}});if(existing)return existing.id;
    let row;
    try{row=await this.db.$transaction(async tx => {
      // Text waits for a quiet client; buttons/media keep their short processing delay.
      const now = new Date(); const notBefore = new Date(now.getTime()+(input.eventType==='CONVERSATION_TEXT'?this.quietMs:input.eventType==='CLIENT_OPT_OUT'?0:4000));
      const {conversationText,...inbox}=input;
      // Serialize arrival with the worker's final stale-burst check, not its model call.
      if(input.expedienteId)await tx.$queryRaw`SELECT id FROM bot_apod_expedientes WHERE id = ${input.expedienteId} FOR UPDATE`;
      const row = await tx.botApodInbox.create({data:{...inbox,source:input.source??'WHATSAPP',notBefore,status:input.expedienteId?'PENDING':'UNMATCHED'}});
      if (input.expedienteId) {
        if(input.eventType==='CONVERSATION_TEXT')await tx.botApodInbox.updateMany({where:{expedienteId:input.expedienteId,status:'PENDING',eventType:'CONVERSATION_TEXT'},data:{notBefore}});
        const timestamp=typeof input.payload.timestamp==='number'?new Date(Math.min(input.payload.timestamp*1000,now.getTime())):now;
        await tx.botApodExpediente.updateMany({where:{id:input.expedienteId,OR:[{lastInboundAt:null},{lastInboundAt:{lt:timestamp}}]},data:{lastInboundAt:timestamp,priorConversation:true,reminderCycle:{increment:1},reminderCount:0,lastReminderDay:0,reminderAnchorAt:now,nextReminderAt:null}});
        if(conversationText)await tx.botApodMessage.create({data:{expedienteId:input.expedienteId,externalId:input.externalId,role:'user',content:redactConversationPii(conversationText).slice(0,2000),source:input.source??'WHATSAPP',createdAt:timestamp}});
        if(input.eventType==='CLIENT_OPT_OUT')await tx.botApodExpediente.update({where:{id:input.expedienteId},data:{optOutAt:now,automationPaused:true,nextReminderAt:null}});
      }
      return row;
    });}catch(error){if((error as {code?:string}).code==='P2002'){const duplicate=await this.db.botApodInbox.findUniqueOrThrow({where:{externalId:input.externalId}});return duplicate.id;}throw error;}
    // Redis can be unavailable after DB commit: recovery dispatcher schedules pending rows.
    if (row.expedienteId && row.status==='PENDING') await this.queue.add('process',{expedienteId:row.expedienteId},{jobId:`inbox-${row.id}`,delay:Math.max(0,row.notBefore.getTime()-Date.now()),removeOnComplete:1000,removeOnFail:1000}).catch(()=>undefined);
    return row.id;
  }
}
