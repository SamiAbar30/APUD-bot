import type {PrismaClient} from '@prisma/client';

/** Minimized simulator telemetry: no client content, identifiers or credentials. */
export async function conversationActivity(db:PrismaClient,telefono:string,quietMs=60_000){
  const c=await db.botApodExpediente.findFirst({where:{telefono},select:{id:true,automationPaused:true,optOutAt:true,lastInboundAt:true}});
  const now=Date.now();
  if(!c)return {phase:'idle',serverNow:now};
  if(c.automationPaused||c.optOutAt)return {phase:'paused',serverNow:now};
  const pending=await db.botApodInbox.findMany({where:{expedienteId:c.id,status:'PENDING'},select:{notBefore:true,createdAt:true},orderBy:{createdAt:'desc'}});
  const action=await db.botApodAccion.findFirst({where:{expedienteId:c.id,actionType:{in:['SEND_WHATSAPP_MESSAGE','SEND_WHATSAPP_BUTTONS','SEND_WHATSAPP_MEDIA']},status:{in:['PENDING','RUNNING','BLOCKED','HUMAN_REQUIRED','UNCERTAIN']}},orderBy:{createdAt:'desc'},select:{status:true,createdAt:true}});
  if(action&&['BLOCKED','HUMAN_REQUIRED','UNCERTAIN'].includes(action.status))return {phase:'blocked',serverNow:now};
  if(action)return {phase:'sending',serverNow:now};
  if(pending.length){
    const replyAfter=Math.max(...pending.map(x=>x.notBefore.getTime()));
    return {phase:replyAfter>now?'waiting':'preparing',pendingCount:pending.length,startedAt:Math.max(pending[0]!.createdAt.getTime(),replyAfter-quietMs),replyAfter,serverNow:now};
  }
  return {phase:'idle',serverNow:now};
}
