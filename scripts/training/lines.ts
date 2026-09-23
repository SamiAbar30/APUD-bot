/**
 * Training lines: extra demo cases on their own phone numbers, so several simulated clients can
 * talk to the real running bot at once. They live in the same demo database, are allowlisted by
 * setup-wce, and the emulator never shows them on the manager's screen.
 */
import {createHmac} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {Redis} from 'ioredis';

export const DEMO_PHONE='34600000000';
export const BASE='http://127.0.0.1:4720';

export function trainingPhones():string[]{
  return (process.env.DEMO_WHATSAPP_RECIPIENTS??'').split(',').map(p=>p.trim()).filter(p=>p&&p!==DEMO_PHONE);
}

/** Half the lines hold a DNI and half an NIE, so both certificate routes get exercised. */
function identity(phone:string,index:number){
  const letters='TRWAGMYFPDXBNJZSQVHLCKE';
  if(index%2===0){const n=40000000+Number(phone.slice(-4));return {dni:`${n}${letters[n%23]}`,kind:'DNI' as const};}
  const n=Number(phone.slice(-7));return {dni:`X${String(n).padStart(7,'0')}${letters[n%23]}`,kind:'NIE' as const};
}

export async function seedTrainingLines(db:PrismaClient){
  const demo=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:DEMO_PHONE}});
  const lines=[];
  for(const [index,phone] of trainingPhones().entries()){
    const {dni,kind}=identity(phone,index);
    const {id:_id,createdAt:_c,updatedAt:_u,...template}=demo as typeof demo&{createdAt?:Date;updatedAt?:Date};
    const row=await db.botApodExpediente.upsert({
      where:{telefono:phone},
      update:{},
      create:{...(template as Record<string,unknown>),telefono:phone,dni,nombre:`TRAINING CLIENT ${index+1}`,kmaleonExpedienteId:`train-kmaleon-${phone}`,numeroExpediente:`T${phone.slice(-4)}`} as never,
    });
    lines.push({phone,caseId:row.id,document:kind});
  }
  return lines;
}

/** Empty one line and open it again, exactly as a new Aviso 27 would. */
export async function resetLine(db:PrismaClient,phone:string){
  const c=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:phone}});
  if(c.kmaleonExpedienteId!==`train-kmaleon-${phone}`)throw new Error('NOT_A_TRAINING_LINE');
  await db.$transaction(async tx=>{
    for(const table of ['botApodAccion','botApodInbox','botApodMessage','botApodHumanTask','botApodTrigger','botApodAuditLog','botApodDocumento'] as const)
      await (tx[table] as {deleteMany:(a:unknown)=>Promise<unknown>}).deleteMany({where:{expedienteId:c.id}});
    await tx.botApodExpediente.update({where:{id:c.id},data:{currentState:'INITIAL_TRIAGE',version:0,hasDigitalCert:null,certDevice:null,consentGranted:false,automationPaused:false,optOutAt:null,previousState:null,stepReached:'INITIAL_TRIAGE',stepEnteredAt:new Date(),digitalHelpAttempts:0,certificateHelpAttempts:0,reminderCycle:0,reminderCount:0,lastReminderDay:0,nextReminderAt:null,priorConversation:false,documentId:null,documentApproved:false,clientReviewed:false,lastInboundAt:null,lastOutboundAt:null,conversationSummary:null}});
  });
  const started=new Date();
  const opened=await fetch(`${BASE}/api/cases/${c.id}/events`,{method:'POST',headers:{authorization:`Bearer ${process.env.OPERATOR_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({version:0,type:'CASE_OPENED'})});
  if(!opened.ok)throw new Error(`CASE_OPENED_${opened.status}`);
  return {caseId:c.id,started};
}

export async function clearQueueFor(caseIds:string[]){
  // Jobs left over from an interrupted run would be delivered into a fresh conversation.
  const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  try{
    const keys=await redis.keys(`${process.env.QUEUE_PREFIX??'apod'}:*`);
    for(const key of keys){
      const type=await redis.type(key);
      if(type!=='hash')continue;
      const data=await redis.hget(key,'data');
      if(data&&caseIds.some(id=>data.includes(id)))await redis.del(key);
    }
  }finally{await redis.quit();}
}

export async function sendText(phone:string,text:string){
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'wce-local-business',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{display_phone_number:phone,phone_number_id:'999000000000'},contacts:[{profile:{name:'Cliente'},wa_id:phone}],messages:[{from:phone,id:`wamid-train-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]});
  const signature=`sha256=${createHmac('sha256',process.env.WA_APP_SECRET!).update(body).digest('hex')}`;
  const response=await fetch(`${BASE}/webhooks/whatsapp`,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature},body});
  if(!response.ok)throw new Error(`WEBHOOK_${response.status}`);
}

/**
 * Everything the office sent after `after`, once the bot has gone quiet: a turn can produce more
 * than one message (a reply plus a guide), and a held case produces none.
 */
export async function officeReplies(db:PrismaClient,caseId:string,after:Date,{firstWithinMs=120_000,settleMs=6_000}={}){
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const until=Date.now()+firstWithinMs;
  let rows:Array<{id:string;content:string;createdAt:Date}>=[];
  while(Date.now()<until){
    rows=await db.botApodMessage.findMany({where:{expedienteId:caseId,role:'assistant',createdAt:{gt:after}},orderBy:{createdAt:'asc'},select:{id:true,content:true,createdAt:true}});
    if(rows.length)break;
    const c=await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{automationPaused:true,currentState:true}});
    const pending=await db.botApodInbox.count({where:{expedienteId:caseId,status:'PENDING'}});
    const actions=await db.botApodAccion.count({where:{expedienteId:caseId,status:{in:['PENDING','RUNNING']}}});
    // Nothing queued and nothing being sent: the bot decided to stay silent.
    if(!pending&&!actions&&Date.now()>until-firstWithinMs+15_000)break;
    await sleep(800);
  }
  if(rows.length){
    let count=rows.length;
    for(;;){
      await sleep(settleMs);
      rows=await db.botApodMessage.findMany({where:{expedienteId:caseId,role:'assistant',createdAt:{gt:after}},orderBy:{createdAt:'asc'},select:{id:true,content:true,createdAt:true}});
      if(rows.length===count)break;
      count=rows.length;
    }
  }
  return rows.map(r=>r.content);
}
