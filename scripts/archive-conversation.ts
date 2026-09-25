/**
 * Archive a demo conversation before it is cleared, so real test chats become training material
 * and a record of mistakes. Client text is stored exactly as the app already stored it (redacted at
 * ingress); nothing extra is exposed here.
 *
 * Usage: ENV_FILE=.env.wce tsx scripts/archive-conversation.ts [phone] [--label "manager demo"]
 */
import '../src/config/load-env-file.js';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PrismaClient} from '@prisma/client';
import { demoPhoneNumber } from '../src/demo/demo-fixture.js';

const ARCHIVE_DIR='evidence/conversations';
const phone=process.argv.find(a=>/^\d{6,}$/.test(a))??demoPhoneNumber();
const label=process.argv.includes('--label')?process.argv[process.argv.indexOf('--label')+1]??'':'';

const db=new PrismaClient();
try{
  const c=await db.botApodExpediente.findUnique({where:{telefono:phone}});
  if(!c){console.log(JSON.stringify({archived:false,reason:'CASE_NOT_FOUND',phone}));process.exit(0);}
  const [messages,actions,inbox,tasks,audit]=await Promise.all([
    db.botApodMessage.findMany({where:{expedienteId:c.id},orderBy:[{createdAt:'asc'},{id:'asc'}],select:{role:true,content:true,createdAt:true,source:true}}),
    db.botApodAccion.findMany({where:{expedienteId:c.id},orderBy:{createdAt:'asc'},select:{actionType:true,status:true,payload:true,lastError:true,createdAt:true}}),
    db.botApodInbox.findMany({where:{expedienteId:c.id},orderBy:{createdAt:'asc'},select:{eventType:true,status:true,lastError:true,createdAt:true}}),
    db.botApodHumanTask.findMany({where:{expedienteId:c.id},select:{kind:true,reason:true,createdAt:true}}),
    db.botApodAuditLog.findMany({where:{expedienteId:c.id},orderBy:{createdAt:'asc'},select:{event:true,createdAt:true}}),
  ]);
  if(!messages.length){console.log(JSON.stringify({archived:false,reason:'NO_MESSAGES',phone}));process.exit(0);}

  const startedAt=messages[0]!.createdAt.toISOString();
  const id=`${startedAt.replace(/[:.]/g,'-')}-${c.id.slice(0,8)}`;
  const record={
    id,label,archivedAt:new Date().toISOString(),startedAt,
    caseId:c.id,finalState:c.currentState,hasDigitalCert:c.hasDigitalCert,automationPaused:c.automationPaused,optOut:Boolean(c.optOutAt),
    counts:{messages:messages.length,clientMessages:messages.filter(m=>m.role==='user').length,actions:actions.length,humanTasks:tasks.length},
    turns:messages.map(m=>({role:m.role,content:m.content,at:m.createdAt.toISOString(),source:m.source})),
    actions:actions.map(a=>({type:a.actionType,status:a.status,template:(a.payload as Record<string,unknown>)?.template,error:a.lastError,at:a.createdAt.toISOString()})),
    inbox:inbox.map(i=>({event:i.eventType,status:i.status,error:i.lastError,at:i.createdAt.toISOString()})),
    humanTasks:tasks.map(t=>({kind:t.kind,reason:t.reason,at:t.createdAt.toISOString()})),
    audit:audit.map(a=>({event:a.event,at:a.createdAt.toISOString()})),
  };
  await mkdir(resolve(ARCHIVE_DIR),{recursive:true,mode:0o700});
  await writeFile(resolve(ARCHIVE_DIR,`${id}.json`),JSON.stringify(record,null,2),{mode:0o600});
  await appendFile(resolve(ARCHIVE_DIR,'index.jsonl'),JSON.stringify({id,label,archivedAt:record.archivedAt,finalState:record.finalState,...record.counts})+'\n',{mode:0o600});
  console.log(JSON.stringify({archived:true,file:`${ARCHIVE_DIR}/${id}.json`,...record.counts,finalState:record.finalState}));
}finally{await db.$disconnect();}
