/**
 * Archive the current demo conversation, clear it, and send the presentation message again.
 * Archiving first is the point: no test chat is lost when the demo is restarted.
 *
 * Usage: ENV_FILE=.env.wce tsx scripts/reset-demo.ts [--label "manager demo"]
 */
import '../src/config/load-env-file.js';
import {spawnSync} from 'node:child_process';
import {PrismaClient} from '@prisma/client';
import { demoPhoneNumber } from '../src/demo/demo-fixture.js';

const phone=demoPhoneNumber();
const label=process.argv.includes('--label')?process.argv[process.argv.indexOf('--label')+1]??'':'';

const archived=spawnSync('npx',['tsx','scripts/archive-conversation.ts',phone,...(label?['--label',label]:[])],{encoding:'utf8',env:process.env});
if(archived.status!==0)throw new Error(`ARCHIVE_FAILED: ${(archived.stderr||'').slice(0,300)}`);
console.log((archived.stdout||'').trim());

const db=new PrismaClient();
try{
  const c=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:phone}});
  if(c.kmaleonExpedienteId!==`demo-kmaleon-${demoPhoneNumber()}`)throw new Error('NOT_THE_DEMO_CASE');
  await db.$transaction(async tx=>{
    for(const table of ['botApodAccion','botApodInbox','botApodMessage','botApodHumanTask','botApodTrigger','botApodAuditLog','botApodDocumento'] as const)
      await (tx[table] as {deleteMany:(a:unknown)=>Promise<unknown>}).deleteMany({where:{expedienteId:c.id}});
    await tx.botApodExpediente.update({where:{id:c.id},data:{currentState:'INITIAL_TRIAGE',version:0,hasDigitalCert:null,certDevice:null,consentGranted:false,automationPaused:false,optOutAt:null,previousState:null,stepReached:'INITIAL_TRIAGE',stepEnteredAt:new Date(),digitalHelpAttempts:0,certificateHelpAttempts:0,reminderCycle:0,reminderCount:0,lastReminderDay:0,nextReminderAt:null,priorConversation:false,documentId:null,documentApproved:false,clientReviewed:false,lastInboundAt:null,lastOutboundAt:null}});
  });
  // Browsers keep their own chat copy; this empties every connected and future viewer.
  const cleared=await fetch('http://127.0.0.1:3001/clear-ui',{method:'POST',headers:{authorization:`Bearer ${process.env.WA_ACCESS_TOKEN??''}`}});
  console.log(JSON.stringify({uiCleared:cleared.ok}));
  const opened=await fetch(`http://127.0.0.1:4720/api/cases/${c.id}/events`,{method:'POST',headers:{authorization:`Bearer ${process.env.OPERATOR_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({version:0,type:'CASE_OPENED'})});
  let presentation='';
  for(let attempt=0;attempt<40;attempt++){
    const rows=await db.botApodMessage.findMany({where:{expedienteId:c.id},orderBy:{createdAt:'asc'}});
    if(rows.length){presentation=rows[0]!.content;break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  console.log(JSON.stringify({reset:true,firstContact:opened.status,presentationSent:Boolean(presentation)}));
  if(presentation)console.log(presentation);
}finally{await db.$disconnect();}
