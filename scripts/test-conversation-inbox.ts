/** Real database/locks, synthetic cases, controlled durable deadlines. No external providers. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PrismaClient} from '@prisma/client';
import {parse} from 'dotenv';
import {Redis} from 'ioredis';
import Redlock from 'redlock';
import {loadEnv} from '../src/config/env.js';
import {DebounceBuffer} from '../src/core/debounce-buffer.js';
import {WorkflowService} from '../src/core/workflow-service.js';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {DocumentStorage} from '../src/infrastructure/storage.js';
import {conversationActivity} from '../src/core/conversation-activity.js';
import {messageForCase} from '../src/core/messages.js';

const config=parse(await readFile(process.env.ENV_FILE??'.env.wce','utf8'));
const pg=new URL(config.DATABASE_URL!);const redisUrl=new URL(config.REDIS_URL!);
for(const url of [pg,redisUrl])assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
const suffix=randomUUID().replaceAll('-','');const schema=`apod_setup_${suffix}`;
pg.searchParams.set('schema',schema);
await promisify(execFile)(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{PATH:process.env.PATH,DATABASE_URL:pg.href,PRISMA_HIDE_UPDATE_MESSAGE:'true',CHECKPOINT_DISABLE:'1'}});
const db=new PrismaClient({datasources:{db:{url:pg.href}},log:[]});
const redis=new Redis(redisUrl.href,{maxRetriesPerRequest:null});
const env=loadEnv({NODE_ENV:'test',DATA_MODE:'mock',SERVICE_MODE:'setup',DATABASE_URL:pg.href,REDIS_URL:redisUrl.href,QUEUE_PREFIX:`apod-setup-${suffix}`,OPERATOR_TOKEN:randomUUID(),STORAGE_DIR:`.runtime/inbox-tests/${suffix}`});
const flow=new WorkflowService(db,new Redlock([redis],{retryCount:2}),new DocumentStorage(env.STORAGE_DIR,env.MAX_DOCUMENT_BYTES),env);
flow.conversationAgent=new StrictConversationAgent(undefined,3);
const queue={add:async()=>({})};const buffer=new DebounceBuffer(db,queue as any);
let index=0;
const makeCase=()=>db.botApodExpediente.create({data:{nombre:'SYNTHETIC TEST',dni:`TEST-${++index}`,telefono:`0000${index}`,identityVerified:true,currentState:'CERT_ACQUISITION_LINKS_SENT',hasDigitalCert:false}});
const ingest=(c:{id:string;telefono:string},text:string,externalId:string=randomUUID(),eventType='CONVERSATION_TEXT')=>buffer.ingestMessage({expedienteId:c.id,telefono:c.telefono,externalId,eventType,payload:{text},conversationText:text});
const due=(id:string)=>db.botApodInbox.updateMany({where:{expedienteId:id,status:'PENDING'},data:{notBefore:new Date(Date.now()-1)}});
const processCase=(id:string)=>flow.processInbox(id,async()=>{throw new Error('NO_MEDIA_EXPECTED');});
const clearOutbox=(id:string)=>db.botApodAccion.updateMany({where:{expedienteId:id},data:{status:'EXECUTED'}});
try{
  const c=await makeCase();
  const a=await ingest(c,'que no tengo DNI');
  const b=await ingest(c,'tengo NIE');
  const d=await ingest(c,'ayuda porfavor');
  const price=await ingest(c,'otra cosa, tengo que pagar?');
  const rows=await db.botApodInbox.findMany({where:{expedienteId:c.id},orderBy:{createdAt:'asc'}});
  assert.equal(new Set(rows.map(r=>r.notBefore.getTime())).size,1);
  assert.ok(rows[0]!.notBefore.getTime()>Date.now()+59000);
  await ingest(c,'ignored duplicate',rows[0]!.externalId);
  assert.equal((await db.botApodInbox.findUniqueOrThrow({where:{id:a}})).notBefore.getTime(),rows[0]!.notBefore.getTime());
  assert.equal((await conversationActivity(db,c.telefono)).phase,'waiting');
  await processCase(c.id);assert.equal(await db.botApodAccion.count({where:{expedienteId:c.id}}),0);
  console.log('PASS durable quiet deadline resets, duplicate does not extend it, no early answer, UI waiting state');

  // Also recover related unanswered messages older than one quiet interval.
  // The common durable deadline identifies the burst, not arbitrary time gaps.
  for(const [i,id] of [a,b,d,price].entries())await db.botApodInbox.update({where:{id},data:{createdAt:new Date(Date.now()-240000+i*75000)}});
  await due(c.id);assert.equal((await conversationActivity(db,c.telefono)).phase,'preparing');
  await processCase(c.id);
  assert.equal(await db.botApodInbox.count({where:{id:{in:[a,b,d]},status:'PROCESSED'}}),3);
  assert.equal((await db.botApodInbox.findUniqueOrThrow({where:{id:price}})).status,'PENDING');
  assert.equal(await db.botApodAccion.count({where:{expedienteId:c.id}}),1);
  const action=await db.botApodAccion.findFirstOrThrow({where:{expedienteId:c.id}});
  const payload=action.payload as any;const latest=await flow.load(c.id);
  const reply=messageForCase(latest,undefined,payload.template,payload.variables);
  assert.match(reply.text,/tienes NIE/);assert.doesNotMatch(reply.text,/DNIe|vídeo/);
  assert.equal(latest.dni,c.dni);assert.equal(latest.automationPaused,false);
  assert.equal((await conversationActivity(db,c.telefono)).phase,'sending');
  console.log('PASS three related lines → one NIE-aware reply; unrelated price question stays separate; legal identity preserved');
  await clearOutbox(c.id);await processCase(c.id);
  assert.equal((await db.botApodInbox.findUniqueOrThrow({where:{id:price}})).status,'PROCESSED');
  assert.equal(await db.botApodAccion.count({where:{expedienteId:c.id}}),2);
  const priceAction=await db.botApodAccion.findFirstOrThrow({where:{expedienteId:c.id,status:'PENDING'}});
  assert.match(JSON.stringify(priceAction.payload),/35/);
  await clearOutbox(c.id);assert.equal((await conversationActivity(db,c.telefono)).phase,'idle');
  console.log('PASS separate topic gets its own answer after the first outbound is completed; status returns idle');

  const race=await makeCase();await ingest(race,'que no tengo DNI');await due(race.id);
  let began!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
  const original=flow.conversationAgent.turn.bind(flow.conversationAgent);
  flow.conversationAgent.turn=async(...args)=>{began();await held;return original(...args);};
  const running=processCase(race.id);await started;await ingest(race,'tengo NIE');release();await running;
  assert.equal(await db.botApodAccion.count({where:{expedienteId:race.id}}),0);
  assert.equal(await db.botApodInbox.count({where:{expedienteId:race.id,status:'PENDING'}}),2);
  // Simulate worker restart: new flow/agent instance, same durable inbox.
  const restarted=new WorkflowService(db,flow.redlock,flow.storage,env);restarted.conversationAgent=new StrictConversationAgent(undefined,3);
  await due(race.id);await restarted.processInbox(race.id,async()=>{});
  assert.equal(await db.botApodInbox.count({where:{expedienteId:race.id,status:'PROCESSED'}}),2);
  assert.equal(await db.botApodAccion.count({where:{expedienteId:race.id}}),1);
  console.log('PASS arrival during generation discards the incomplete draft; restarted worker answers the combined burst once');

  const media=await makeCase();const mediaId=await ingest(media,'attachment',randomUUID(),'PDF_MEDIA');
  const mediaDue=(await db.botApodInbox.findUniqueOrThrow({where:{id:mediaId}})).notBefore.getTime();
  await ingest(media,'vale');assert.equal((await db.botApodInbox.findUniqueOrThrow({where:{id:mediaId}})).notBefore.getTime(),mediaDue);
  await ingest(media,'stop',randomUUID(),'CLIENT_OPT_OUT');
  assert.equal((await flow.load(media.id)).automationPaused,true);assert.equal((await conversationActivity(db,media.telefono)).phase,'paused');
  console.log('PASS text does not change media deadline; explicit stop pauses immediately, including visible status');
}finally{
  assert.match(schema,/^apod_setup_[a-f0-9]{32}$/);
  await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await db.$disconnect();await redis.quit();
}
