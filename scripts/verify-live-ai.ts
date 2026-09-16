/** Contacts the configured provider with a real, locally anonymized historical turn. No client sends. */
import '../src/config/load-env-file.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
import {OpenAICompatibleConversationModel} from '../src/adapters/ai/openai-compatible-conversation.js';
import {loadReferenceAgentPackage} from '../src/config/reference-agent.js';
import {boundedConversationHistory,validateModelReply} from '../src/core/conversation-policy.js';
import {rolloutInstruction} from '../src/core/conversation-rollout.js';
const db=new PrismaClient();
try{
 const bytes=await readFile('.runtime/conversations/whatsapp-example-anonymized.jsonl');const entries=bytes.toString().trim().split('\n').map(x=>JSON.parse(x));assert.equal(entries[0].meta.anonymized,true);
 const turns=entries.filter(x=>typeof x.text==='string');const index=turns.findIndex(x=>x.role==='client'&&x.text==='Tengo CLAVE');assert.ok(index>=0,'Real historical turn required');
 const config=conversationAiFromEnv();if(config.status!=='CONFIGURED')throw new Error(config.reason);
 const c=await db.botApodExpediente.findFirst({where:{currentState:'WAITING_CERT_RESPONSE'}});assert.ok(c,'Existing waiting case required');
 const reference=await loadReferenceAgentPackage(process.env.APOD_AGENT_PACKAGE_DIR);const model=new OpenAICompatibleConversationModel(config.config,reference.status==='LOADED'?reference.context:undefined);
 const result=await model.reply({phase:3,instruction:rolloutInstruction(3),state:c.currentState,hasDigitalCert:c.hasDigitalCert,text:turns[index].text,history:boundedConversationHistory(turns.slice(0,index).map(x=>({role:x.role==='client'?'user' as const:'assistant' as const,content:x.text})))});
 const validated=validateModelReply(result);assert.ok(validated,'Provider output must satisfy production reply policy');
 const report={at:new Date().toISOString(),providerCall:'REAL',mode:config.config.mode,model:config.config.model,sourceSha256:createHash('sha256').update(bytes).digest('hex'),historicalTurn:turns[index].turn,reply:validated.text,requiresHumanReview:validated.requiresHumanReview,clientMessagesSent:0,productionEndToEnd:'NOT_VERIFIED',fineTuningPerformed:false};
 await writeFile('evidence/new-spec-live-ai.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await db.$disconnect()}
