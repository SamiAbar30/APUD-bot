/** User-reported messages through the running WCE UI, signed webhook, real DB,
 * worker, provider and outbox. Restricted to the existing local demo client.
 * Preserves original history; never sends to Meta, Kmaleon, Sede or email.
 */
import '../src/config/load-env-file.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { loadEnv } from '../src/config/env.js';

const env=loadEnv();
assert.equal(env.WHATSAPP_TRANSPORT,'emulator');
assert.equal(env.KMALEON_ENABLED,false);assert.equal(env.SEDE_ENABLED,false);assert.equal(env.APUDATA_ENABLED,false);
assert.equal(env.AI_MODE,'online');assert.equal(env.CONVERSATION_AI_PROVIDER,'openai-compatible');
assert.ok(env.DEMO_WHATSAPP_RECIPIENTS.includes('34600000000'));
const db=new PrismaClient();const browser=await chromium.launch({headless:true});
const waitFor=async<T>(fn:()=>Promise<T|null|false>,label:string):Promise<T>=>{
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,400));}
  throw new Error(`TIMEOUT_${label}`);
};
try{
  const original=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:'34600000000'}});
  assert.equal(original.kmaleonExpedienteId,'demo-kmaleon-34600000000');assert.equal(original.optOutAt,null);
  const source=await db.botApodMessage.findMany({where:{expedienteId:original.id,role:'user',createdAt:{gte:new Date('2026-09-16T21:49:00Z'),lte:new Date('2026-09-16T21:54:00Z')}},orderBy:[{createdAt:'asc'},{id:'asc'}]});
  assert.equal(source.length,8);
  await mkdir('evidence',{recursive:true});
  await writeFile('evidence/reported-conversation-live-before.json',JSON.stringify({at:new Date().toISOString(),case:original,originalMessageIds:source.map(m=>m.id)},null,2),{mode:0o600});
  if(original.automationPaused){
    assert.equal(original.currentState,'ESCALATED_HUMAN');assert.equal(original.previousState,'WAITING_CERT_RESPONSE');
    assert.equal(original.hasDigitalCert,null);
    const failure=await db.botApodMessage.findFirst({where:{expedienteId:original.id,role:'assistant'},orderBy:{createdAt:'desc'}});
    assert.match(failure?.content??'',/No he entendido tu mensaje/);
    const resumed=await fetch(`http://127.0.0.1:4720/api/cases/${original.id}/recover`,{method:'POST',headers:{authorization:`Bearer ${env.OPERATOR_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({version:original.version,reason:'User requested correction of false simulator handoff after the actual i / si input burst; preserve all history.'})});
    assert.equal(resumed.status,200,await resumed.text());
  }
  const current=await db.botApodExpediente.findUniqueOrThrow({where:{id:original.id}});
  assert.equal(current.currentState,'WAITING_CERT_RESPONSE');assert.equal(current.hasDigitalCert,null);assert.equal(current.automationPaused,false);
  const page=await browser.newPage({viewport:{width:1000,height:1400}});
  await page.goto('http://127.0.0.1:8080');await page.getByText('🟢 Connected',{exact:true}).waitFor();
  // One operator-requested replacement introduction; no history deletion/reset.
  const introduction=await db.$transaction(async tx=>{
    await tx.botApodAuditLog.create({data:{expedienteId:current.id,event:'OPERATOR_REQUESTED_PRESENTATION',operator:'CODEX_USER_REQUEST',metadata:{scope:'LOCAL_WCE_ONLY',reason:'Single Dayana/company/purpose opening requested by user',historyPreserved:true}}});
    return tx.botApodAccion.create({data:{expedienteId:current.id,decisionId:randomUUID(),expectedVersion:current.version,actionType:'SEND_WHATSAPP_MESSAGE',payload:{template:'ASK_HAS_CERT'},idempotencyKey:`dayana-opening-${randomUUID()}`}});
  });
  const intro=await waitFor(()=>db.botApodMessage.findUnique({where:{externalId:`outbox:${introduction.id}`}}),'OPENING');
  assert.match(intro.content,/soy Dayana, la asistente virtual de LITIGIOS/);assert.match(intro.content,/apoderamiento apud acta/);
  await page.getByText(intro.content,{exact:true}).waitFor();
  const groups:typeof source[]=[];
  for(const message of source){const last=groups.at(-1);if(last&&message.createdAt.getTime()-last.at(-1)!.createdAt.getTime()<=4000)last.push(message);else groups.push([message]);}
  const turns=[];
  for(const group of groups){
    const before=new Date();
    const beforeCount=await db.botApodMessage.count({where:{expedienteId:current.id,role:'assistant'}});
    for(const message of group){await page.getByPlaceholder('Type a message...').fill(message.content);await page.getByPlaceholder('Type a message...').press('Enter');}
    const inbox=await waitFor(async()=>{const rows=await db.botApodInbox.findMany({where:{expedienteId:current.id,source:'WHATSAPP',createdAt:{gte:before}},orderBy:{createdAt:'asc'}});return rows.length===group.length?rows:null;},'SIGNED_WEBHOOK');
    await waitFor(async()=>{const rows=await db.botApodInbox.findMany({where:{id:{in:inbox.map(r=>r.id)}}});assert.ok(rows.every(r=>r.status!=='HUMAN_REQUIRED'),JSON.stringify(rows.map(r=>({status:r.status,error:r.lastError}))));return rows.every(r=>r.status==='PROCESSED')?rows:null;},'PROCESSED');
    const reply=await waitFor(()=>db.botApodMessage.findFirst({where:{expedienteId:current.id,role:'assistant',createdAt:{gte:before}},orderBy:{createdAt:'desc'}}),'OUTBOX_REPLY');
    await page.getByText(reply.content.replace('[EMAIL]','reclamaciones@litigios.es'),{exact:true}).first().waitFor();
    const after=await db.botApodExpediente.findUniqueOrThrow({where:{id:current.id}});
    assert.equal(after.automationPaused,false);
    assert.equal(await db.botApodMessage.count({where:{expedienteId:current.id,role:'assistant'}}),beforeCount+1,'Exactly one outbound reply per input burst');
    assert.doesNotMatch(reply.content,/soy Dayana|No he entendido tu mensaje/);
    const index=turns.length;
    if(index===2)assert.equal(after.hasDigitalCert,true);
    if(index===3)assert.equal(after.currentState,'MOBILE_TRIAGE_PC_CHECK');
    if(index>=4)assert.equal(after.currentState,'MOBILE_EXPORT_GUIDE_SENT');
    const turn={input:group.map(m=>m.content),inboxIds:inbox.map(r=>r.id),reply:reply.content,state:after.currentState,hasDigitalCert:after.hasDigitalCert,automationPaused:after.automationPaused};
    turns.push(turn);console.log(JSON.stringify(turn));
  }
  assert.equal(await db.botApodMessage.count({where:{id:{in:source.map(m=>m.id)}}}),8);
  await page.screenshot({path:'evidence/reported-conversation-live.png',fullPage:true});
  const report={at:new Date().toISOString(),status:'PASS',scope:'EXISTING_LOCAL_SIMULATOR_REAL_GPT_POSTGRES_REDIS_WEBHOOK_OUTBOX_BROWSER',sourceMessageIds:source.map(m=>m.id),introActionId:introduction.id,introduction:intro.content,turns,historyPreserved:true,liveMetaSends:0,crmWrites:0,emailAccess:0};
  await writeFile('evidence/reported-conversation-live.json',JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({status:'PASS',turns:turns.length,oneOpening:true,oneReplyPerBurst:true,historyPreserved:true}));
}finally{await browser.close();await db.$disconnect();}
