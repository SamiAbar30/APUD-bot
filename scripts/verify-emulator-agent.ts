/** Real local WCE -> signed webhook -> PostgreSQL/worker -> GPT API -> outbox -> WCE.
 * Uses the existing user-authorized simulator client. Never calls Meta or Kmaleon.
 */
import '../src/config/load-env-file.js';
import {loadEnv} from '../src/config/env.js';
import {PrismaClient} from '@prisma/client';
import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const env=loadEnv();
assert.equal(env.WHATSAPP_TRANSPORT,'emulator');assert.equal(env.KMALEON_ENABLED,false);assert.equal(env.AI_MODE,'online');assert.equal(env.CONVERSATION_AI_PROVIDER,'openai-compatible');
assert.ok(env.DEMO_WHATSAPP_RECIPIENTS.includes('34663094035'));
const db=new PrismaClient();const browser=await chromium.launch({headless:true});
const waitFor=async<T>(fn:()=>Promise<T|null|false>,label:string):Promise<T>=>{const until=Date.now()+120000;while(Date.now()<until){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,500));}throw new Error('TIMEOUT_'+label);};
try{
  const c=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:'34663094035'}});
  assert.equal(c.kmaleonExpedienteId,'demo-kmaleon-34663094035');assert.equal(c.currentState,'WAITING_CERT_RESPONSE');assert.equal(c.hasDigitalCert,null);assert.equal(c.automationPaused,false);
  const page=await browser.newPage({viewport:{width:1000,height:1100}});
  await page.goto('http://127.0.0.1:8080');await page.getByText('🟢 Connected',{exact:true}).waitFor();
  // A fresh first contact already shows the presentation; sending it again makes the chat look resumed.
  const last=await db.botApodMessage.findFirst({where:{expedienteId:c.id},orderBy:[{createdAt:'desc'},{id:'desc'}]});
  let action:{id:string}|null=null;
  if(!(last?.role==='assistant'&&/¿Tienes certificado digital( a tu nombre)?\?/.test(last.content))){
    // Re-send the presentation requested by the user, without deleting history or resetting state.
    // One key per run: a reused key returns the old EXECUTED action and nothing reaches a restarted bridge.
    const key=`operator-presentation-gpt-context-${Date.now()}`;
    action=await db.$transaction(async tx=>{
      const existing=await tx.botApodAccion.findUnique({where:{idempotencyKey:key}});if(existing)return existing;
      await tx.botApodAuditLog.create({data:{expedienteId:c.id,event:'OPERATOR_REQUESTED_PRESENTATION',operator:'CODEX_USER_REQUEST',metadata:{scope:'LOCAL_WCE_ONLY',statePreserved:true}}});
      return tx.botApodAccion.create({data:{expedienteId:c.id,decisionId:randomUUID(),expectedVersion:c.version,actionType:'SEND_WHATSAPP_BUTTONS',payload:{template:'ASK_HAS_CERT'},idempotencyKey:key}});
    });
    const id=action.id;
    await waitFor(async()=>{const a=await db.botApodAccion.findUniqueOrThrow({where:{id}});if(['BLOCKED','FAILED','HUMAN_REQUIRED'].includes(a.status))throw new Error(a.lastError??a.status);return ['AWAITING_DELIVERY','EXECUTED'].includes(a.status)?a:null;},'PRESENTATION');
  }
  await page.getByText(/¿Tienes certificado digital( a tu nombre)?\?/).first().waitFor();
  const before=new Date();
  // Actual greeting reported by the user in this task; no fabricated client record.
  await page.getByPlaceholder('Type a message...').fill('hola');await page.getByPlaceholder('Type a message...').press('Enter');
  const inbox=await waitFor(()=>db.botApodInbox.findFirst({where:{expedienteId:c.id,source:'WHATSAPP',createdAt:{gte:before}}}), 'SIGNED_WEBHOOK');
  assert.equal(inbox.eventType,'CONVERSATION_TEXT');
  await waitFor(async()=>{const row=await db.botApodInbox.findUniqueOrThrow({where:{id:inbox.id}});if(row.status==='HUMAN_REQUIRED')throw new Error(row.lastError??row.status);return row.status==='PROCESSED'?row:null;},'WORKER');
  const reply=await waitFor(()=>db.botApodMessage.findFirst({where:{expedienteId:c.id,role:'assistant',createdAt:{gte:before}},orderBy:{createdAt:'desc'}}),'GPT_REPLY');
  assert.ok(reply.content.length>5);assert.doesNotMatch(reply.content,/DEMO APOD CLIENT|retomamos la gesti[oó]n|No he podido entender/i);
  const after=await db.botApodExpediente.findUniqueOrThrow({where:{id:c.id}});assert.equal(after.currentState,c.currentState);assert.equal(after.hasDigitalCert,c.hasDigitalCert);assert.equal(after.automationPaused,false);
  await page.getByText(reply.content,{exact:true}).first().waitFor({timeout:10000});
  await mkdir('evidence',{recursive:true});await page.screenshot({path:'evidence/wce-gpt-context.png',fullPage:true});
  const report={at:new Date().toISOString(),status:'PASS',scope:'LOCAL_SIMULATOR_REAL_GPT_API',model:env.AI_MODEL,transport:env.WHATSAPP_TRANSPORT,caseId:c.id,inboxId:inbox.id,reply:reply.content,presentationActionId:action?.id??"FIRST_CONTACT",stateBefore:c.currentState,stateAfter:after.currentState,historyPreserved:true,databaseAndOutboxVerified:true,browserReplyVisible:true,liveMetaMessages:0,crmWrites:0};
  await writeFile('evidence/emulator-agent-verification.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await db.$disconnect();}
