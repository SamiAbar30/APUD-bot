/** Replay the user's actual 16 September conversation, with the real provider and FSM.
 * Read-only PostgreSQL; no fabricated messages, provider doubles or external sends.
 */
import '../src/config/load-env-file.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaClient, type BotApodExpediente } from '@prisma/client';
import { conversationAiFromEnv } from '../src/config/conversation-ai.js';
import { loadReferenceAgentPackage } from '../src/config/reference-agent.js';
import { OpenAICompatibleConversationModel } from '../src/adapters/ai/openai-compatible-conversation.js';
import { StrictConversationAgent } from '../src/core/conversation-agent.js';
import { evaluateNextStep } from '../src/core/decision-engine.js';
import { firstContactText, messageForCase } from '../src/core/messages.js';
import { allowedConversationOptions, validateModelClassification, type ConversationHistoryMessage } from '../src/core/conversation-policy.js';
import { rolloutInstruction } from '../src/core/conversation-rollout.js';
import type { Expediente } from '../src/domain/models/expediente.js';
import type { WorkflowEvent } from '../src/domain/fsm/states.js';

const db = new PrismaClient();
try {
  const stored = await db.botApodExpediente.findUniqueOrThrow({where:{telefono:'34663094035'}});
  const messages = await db.botApodMessage.findMany({where:{expedienteId:stored.id,role:'user',createdAt:{gte:new Date('2026-09-16T21:49:00Z'),lte:new Date('2026-09-16T21:54:00Z')}},orderBy:[{createdAt:'asc'},{id:'asc'}]});
  assert.equal(messages.length,8,'Original reported conversation must remain intact');
  const config = conversationAiFromEnv();
  assert.equal(config.status,'CONFIGURED');
  if(config.status!=='CONFIGURED')throw new Error('REAL_PROVIDER_REQUIRED');
  assert.equal(config.config.mode,'online');
  const reference = await loadReferenceAgentPackage(process.env.APOD_AGENT_PACKAGE_DIR,process.env.APOD_MASTER_PROMPT_FILE);
  assert.equal(reference.status,'LOADED');
  const model = new OpenAICompatibleConversationModel(config.config,reference.context??undefined);
  const agent = new StrictConversationAgent(model,3);
  let c:BotApodExpediente={...stored,currentState:'WAITING_CERT_RESPONSE',hasDigitalCert:null,certDevice:null,automationPaused:false,optOutAt:null};
  const modelChoice=validateModelClassification(c,await model.classify({phase:3,instruction:rolloutInstruction(3),state:c.currentState,hasDigitalCert:c.hasDigitalCert,allowedOptions:allowedConversationOptions(c),text:messages[2]!.content,history:[]}));
  const history:ConversationHistoryMessage[]=[];
  const turns=[];
  // Preserve real timing: "i" then "si" belong to the same four-second input burst.
  const groups:typeof messages[]=[];
  for(const message of messages){
    const group=groups.at(-1);
    if(group&&message.createdAt.getTime()-group.at(-1)!.createdAt.getTime()<=4000)group.push(message);
    else groups.push([message]);
  }
  for(const group of groups){
    const input=group.map(m=>m.content).join('\n');
    if(c.automationPaused){turns.push({input,reply:'',state:c.currentState,hasDigitalCert:c.hasDigitalCert,event:'PAUSED'});continue;}
    const turn=await agent.turn(c,input,history);
    const decision=evaluateNextStep(c as unknown as Expediente,turn as WorkflowEvent);
    c={...c,...decision.actionPayload.expedientePatch,currentState:decision.nextStep as BotApodExpediente['currentState'],automationPaused:decision.nextStep==='ESCALATED_HUMAN'} as BotApodExpediente;
    const p=decision.actionPayload;
    const guide='template'in p?messageForCase(c,undefined,p.template,'variables'in p?p.variables:undefined):p.kind==='ESCALATE_HUMAN'&&p.clientNoticeTemplate?messageForCase(c,undefined,p.clientNoticeTemplate,{replyText:String(turn.payload.responseText??'')}):undefined;
    const reply=guide?.text??'';
    turns.push({input,reply,state:c.currentState,hasDigitalCert:c.hasDigitalCert,event:turn.type});
    history.push({role:'user',content:input},{role:'assistant',content:reply});
    console.log(JSON.stringify(turns.at(-1)));
  }
  const checks={
    completeOpening: /Dayana/.test(turns[0]?.reply??'')&&/LITIGIOS/.test(turns[0]?.reply??'')&&/apoderamiento apud acta/.test(turns[0]?.reply??''),
    proactiveOpening: /Dayana/.test(firstContactText(stored)),
    oneIntroduction: turns.filter(t=>/soy Dayana/.test(t.reply)).length===1,
    claimStatusContact: /reclamaciones@litigios.es/.test(turns[1]?.reply??''),
    certificatePersisted: turns[2]?.hasDigitalCert===true,
    mobileAccepted: turns[3]?.state==='MOBILE_TRIAGE_PC_CHECK',
    shortYesContinues: turns[4]?.state==='MOBILE_EXPORT_GUIDE_SENT',
    noFalseHandoff: !c.automationPaused&&turns.every(t=>t.reply.length>0),
    oneQuestion: turns.every(t=>(t.reply.match(/\?/g)?.length??0)<=1),
    providerHealthy:model.metrics.failures===0,
    modelUsesValidEvent:modelChoice.kind==='OPTION'&&modelChoice.optionId==='HAS_CERT_YES',
  };
  const pass=Object.values(checks).every(Boolean);
  const report={at:new Date().toISOString(),pass,scope:'REAL_REPORTED_MESSAGES_REAL_GPT_AND_FSM_READ_ONLY_DB',sourceMessageIds:messages.map(m=>m.id),checks,turns,provider:model.metrics,dbWrites:0,clientSends:0};
  await mkdir('evidence',{recursive:true});
  await writeFile(`evidence/reported-conversation-${process.argv.includes('--baseline')?'baseline':'verification'}.json`,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({pass,checks}));
  if(!pass)process.exitCode=1;
}finally{await db.$disconnect();}
