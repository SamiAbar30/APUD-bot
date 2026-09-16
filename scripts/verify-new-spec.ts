/** Read-only verification of the running local system and preserved database; no fixtures or sends. */
import '../src/config/load-env-file.js';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {PrismaClient} from '@prisma/client';
import {canFollowUp,nextFollowUp,stepFor,followUpText,DAY_MS} from '../src/core/follow-up.js';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
const db=new PrismaClient();
const report:Record<string,unknown>={at:new Date().toISOString(),verification:'READ_ONLY_LOCAL_LIVE',crmWrites:0,messagesSent:0};
try{
 const rows=await db.botApodExpediente.findMany({orderBy:{id:'asc'}});assert.ok(rows.length,'Existing local cases required');
 const before=JSON.parse(await readFile('evidence/pre-spec-migration-state.json','utf8')) as Record<string,unknown>[];
 for(const previous of before){const c=rows.find(r=>r.id===previous.id);assert.ok(c);for(const key of ['currentState','version','consentGranted','documentId','documentApproved','clientReviewed'])assert.equal(c[key as keyof typeof c],previous[key],`Migration changed ${key}`);}
 report.preservedCases=before.length;
 for(const c of rows){
  assert.equal(c.stepReached,stepFor(c));
  if(canFollowUp(c))for(const day of [3,7,15])assert.ok(followUpText(c,day).length>10);
  const anchor=c.updatedAt;for(const [last,next]of [[0,3],[3,7],[7,15],[15,30]])assert.equal(nextFollowUp(anchor,last!)?.getTime(),anchor.getTime()+next!*DAY_MS);
 }
 report.savedStepsAndCadence='PASS';
 const migrations=await db.$queryRawUnsafe<Array<{migration_name:string}>>('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL');assert.ok(migrations.some(x=>x.migration_name==='20260916150000_aviso27_automation'));
 report.databaseMigration='APPLIED';
 const base=`http://127.0.0.1:${process.env.PORT??4720}`;
 const get=async(path:string)=>{const response=await fetch(base+path,{headers:{Authorization:`Bearer ${process.env.OPERATOR_TOKEN}`}});assert.equal(response.status,200,path);return response.json() as Promise<Record<string,unknown>>};
 const automation=await get('/api/automation');assert.deepEqual(automation.reminderDays,[3,7,15]);assert.equal(automation.expiryDay,30);assert.equal(automation.dayanaConfigured,true);assert.equal(automation.aiMode,'online');assert.equal(automation.aiStatus,'CONFIGURED');
 report.automation={...automation,triggers:Array.isArray(automation.triggers)?automation.triggers.length:undefined};
 await get('/api/human-tasks');for(const c of rows)await get(`/api/cases/${c.id}/messages`);
 assert.equal((await fetch(base+'/automation.js')).status,200);
 assert.equal((await fetch(base+'/api/human-tasks')).status,401);
 const local=conversationAiFromEnv({...process.env,AI_MODE:'local'});assert.equal(local.status,'INCOMPLETE');assert.equal(local.config,null);assert.ok(local.reason.includes('LOCAL_AI_MODEL'));report.localModel='PENDING_USER_SELECTION_NO_ONLINE_FALLBACK';
 report.productionEndToEnd='NOT_VERIFIED';
 await writeFile('evidence/new-spec-verification.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await db.$disconnect()}
