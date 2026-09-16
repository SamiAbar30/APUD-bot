import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { json, type WorkflowService } from '../core/workflow-service.js';
import type { ActionExecutor } from './action-executor.js';
import type { Queues } from './queues.js';
import type { FastifyBaseLogger } from 'fastify';
import type { WhatsAppStatus } from '../contracts/whatsapp.contract.js';
import { scheduleFollowUps, pollAviso27 } from '../core/automation.js';
export function startWorkers(flow:WorkflowService,executor:ActionExecutor,queues:Queues,connection:Redis,logger:FastifyBaseLogger){
  const workers:Worker[]=[];
  const options={connection,prefix:queues.inbound.opts.prefix,concurrency:4,lockDuration:180000};
  async function enqueueAudit(doc:{id:string;rawAuditJson:unknown}){
    const audit=doc.rawAuditJson as Record<string,unknown>|null;
    if(audit?.status!=='PENDING')return;
    const requestId=typeof audit.requestId==='string'?audit.requestId:undefined;
    await queues.audit.add('audit',{documentId:doc.id,requestId},{jobId:`audit-${doc.id}-${requestId??'legacy'}`});
  }
  workers.push(new Worker('inbound-messages',async job=>{await flow.processInbox(job.data.expedienteId,async(id,mediaId,externalId)=>{
    if(!executor.wa)throw new Error('WHATSAPP_NOT_CONFIGURED');
    const media=await executor.wa.downloadMedia(mediaId,{allowedMimeTypes:['application/pdf']});
    try{const c=await flow.load(id);const d=await flow.intakeDocument(id,c.version,media.content,externalId);await enqueueAudit(d);}finally{media.content.fill(0);}
  });},options));
  workers.push(new Worker('pdf-audit',async job=>flow.auditDocument(job.data.documentId,job.data.requestId),{...options,concurrency:2}));
  for(const name of ['kmaleon-sync','notifications'])workers.push(new Worker(name,async job=>executor.execute(job.data.actionId),options));
  for(const worker of workers){worker.on('error',()=>logger.error({worker:worker.name},'Queue worker error'));worker.on('failed',(job)=>{if(job&&job.attemptsMade>=(job.opts.attempts??3))void(async()=>{
    if(worker.name==='pdf-audit'){
      const doc=await flow.db.botApodDocumento.findUnique({where:{id:job.data.documentId}});
      const audit=doc?.rawAuditJson as Record<string,unknown>|null;
      // An old job must not overwrite a newer audit request or a committed result.
      if(doc&&audit?.status==='PENDING'&&audit.requestId===job.data.requestId)await flow.db.botApodDocumento.updateMany({where:{id:doc.id,rawAuditJson:{equals:json(audit)}},data:{rawAuditJson:json({...audit,status:'FAILED_REQUIRES_REVIEW'})}});
    }
    await queues.deadLetter.add('worker-failed',{queue:worker.name,jobId:job.id,data:job.data},{jobId:`worker-${worker.name}-${job.id}`});
  })().catch(()=>logger.error({worker:worker.name},'Worker failure evidence could not be recorded'));});}
  let ticking=false;
  async function dispatch(){if(ticking)return;ticking=true;try{
    await scheduleFollowUps(flow);
    // Never rerun a potentially completed remote effect after a crash.
    await flow.db.botApodAccion.updateMany({where:{status:'RUNNING',startedAt:{lt:new Date(Date.now()-600000)}},data:{status:'UNCERTAIN',lastError:'WORKER_RESTART_RECONCILE_REQUIRED'}});
    const deliveries=await flow.db.botApodInbox.findMany({where:{source:'WHATSAPP_STATUS',status:'PENDING'},orderBy:{createdAt:'asc'},take:200});
    for(const row of deliveries){const handled=await executor.delivery(row.payload as unknown as WhatsAppStatus);if(handled)await flow.db.botApodInbox.updateMany({where:{id:row.id,status:'PENDING'},data:{status:'PROCESSED',processedAt:new Date()}});else if(row.createdAt.getTime()<Date.now()-86400000)await flow.db.botApodInbox.updateMany({where:{id:row.id,status:'PENDING'},data:{status:'HUMAN_REQUIRED',lastError:'UNMATCHED_DELIVERY_CALLBACK'}});}
    const pending=await flow.db.botApodInbox.findMany({where:{status:'PENDING',notBefore:{lte:new Date()},expedienteId:{not:null}},distinct:['expedienteId'],take:100});
    for(const row of pending)await queues.inbound.add('process',{expedienteId:row.expedienteId},{jobId:`recovery-${row.expedienteId}-${Math.floor(Date.now()/10000)}`});
    const docs=await flow.db.botApodDocumento.findMany({where:{rawAuditJson:{path:['status'],equals:'PENDING'}},take:50});
    for(const doc of docs)await enqueueAudit(doc);
    const actions=await flow.db.botApodAccion.findMany({where:{status:'PENDING'},orderBy:{createdAt:'asc'},take:100});
    for(const a of actions){const queue=a.actionType.includes('KMALEON')||a.actionType.includes('DAYANA')?queues.kmaleon:queues.notifications;await queue.add('effect',{actionId:a.id},{jobId:`effect-${a.id}-${a.retryCount}`});}
  }catch{logger.error('Outbox dispatch unavailable; durable rows retained');}finally{ticking=false;}}
  const interval=setInterval(()=>void dispatch(),5000);interval.unref();void dispatch();
  let polling:Promise<void>|undefined;
  const poll=()=>{if(polling||!flow.env.KMALEON_POLLER_ENABLED)return;polling=flow.redlock.using(['lock:apod:aviso27-poller'],300000,async signal=>{if(!signal.aborted)await pollAviso27(flow,executor.adapters,signal as AbortSignal);}).then(()=>undefined).catch(()=>{logger.error('Aviso 27 scan requires review; no incomplete scan applied');}).finally(()=>{polling=undefined;});};
  const pollInterval=setInterval(poll,flow.env.KMALEON_POLL_INTERVAL_MS);pollInterval.unref();poll();
  return {dispatch,async close(){clearInterval(interval);clearInterval(pollInterval);await Promise.all(workers.map(w=>w.close()));await polling;}};
}
