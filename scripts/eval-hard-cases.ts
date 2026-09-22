/**
 * Coverage of hard, real client messages.
 *
 * Samples genuinely difficult client turns from the imported corpus (real WhatsApp messages, already
 * redacted), replays each one through the real agent, policy and FSM with the real model, and scores
 * whether the answer is usable: no loop, no dead end, no invented fact, no security leak. The point
 * is a measured coverage number for "unexpected" messages rather than scripted personas.
 *
 * Usage: ENV_FILE=.env.wce tsx scripts/eval-hard-cases.ts [--sample 40] [--seed 7]
 */
import '../src/config/load-env-file.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ApodState, PrismaClient} from '@prisma/client';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
import {loadReferenceAgentPackage} from '../src/config/reference-agent.js';
import {OpenAICompatibleConversationModel} from '../src/adapters/ai/openai-compatible-conversation.js';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';
import {messageForCase} from '../src/core/messages.js';
import {caseMemory} from '../src/core/case-memory.js';

const sampleSize=Number(process.argv.find(a=>a.startsWith('--sample='))?.slice(9)??40);
const seed=process.argv.find(a=>a.startsWith('--seed='))?.slice(7)??'7';
const ai=conversationAiFromEnv();
if(ai.status!=='CONFIGURED'||ai.config.mode!=='online')throw new Error('REAL_ONLINE_AI_REQUIRED');
const aiConfig=ai.config;
const packageDir=process.env.APOD_AGENT_PACKAGE_DIR;
if(!packageDir)throw new Error('APOD_AGENT_PACKAGE_DIR_REQUIRED');

/** A hard turn is one that is not a plain yes/no/device answer. */
const EASY=/^(?:si|sí|no|vale|ok|gracias|hola|buenas|en el (?:movil|móvil|ordenador)|movil|móvil|ordenador|pc|tengo (?:dni|nie))[\s.!]*$/i;
const HARD_SIGNALS=[
  {label:'pregunta',test:(t:string)=>/\?/.test(t)},
  {label:'confusion',test:(t:string)=>/no entiendo|no se como|no sé cómo|que tengo que hacer|estoy perdid|no me aclaro/i.test(t)},
  {label:'desconfianza',test:(t:string)=>/estafa|fraude|no me fio|no me fío|es seguro|legal\b/i.test(t)},
  {label:'dinero',test:(t:string)=>/dinero|cobrar|pagar|coste|precio|factura|cuanto|cuánto/i.test(t)},
  {label:'queja',test:(t:string)=>/harto|hartа|vergüenza|verguenza|llevo (?:meses|semanas)|nadie me/i.test(t)},
  {label:'problema_tecnico',test:(t:string)=>/no me deja|error|no funciona|no puedo|no aparece|se cierra/i.test(t)},
  {label:'personal',test:(t:string)=>/hospital|enferm|fallec|trabajo|viaje|mayor|no tengo tiempo/i.test(t)},
];

type Turn={text:string;label:string};
const corpus=await readFile(resolve(packageDir,'training/conversations.jsonl'),'utf8');
const candidates:Turn[]=[];
for(const line of corpus.split('\n')){
  if(!line.trim())continue;
  let row:{turns?:Array<{role:string;content:string}>};
  try{row=JSON.parse(line);}catch{continue;}
  for(const turn of row.turns??[]){
    if(turn.role!=='user')continue;
    const text=turn.content.trim();
    if(text.length<12||text.length>400||EASY.test(text))continue;
    const signal=HARD_SIGNALS.find(s=>s.test(text));
    if(signal)candidates.push({text,label:signal.label});
  }
}
// Deterministic spread across categories, so a rerun measures the same difficulty mix.
const ordered=candidates
  .map(turn=>({turn,rank:createHash('sha256').update(seed+turn.text).digest('hex')}))
  .sort((a,b)=>a.rank.localeCompare(b.rank));
const perLabel=new Map<string,Turn[]>();
for(const {turn} of ordered){
  const bucket=perLabel.get(turn.label)??[];
  if(bucket.length<Math.ceil(sampleSize/HARD_SIGNALS.length)+2)bucket.push(turn);
  perLabel.set(turn.label,bucket);
}
const sample:Turn[]=[];
outer: while(sample.length<sampleSize){
  let added=false;
  for(const bucket of perLabel.values()){
    const next=bucket.shift();
    if(!next)continue;
    sample.push(next);added=true;
    if(sample.length>=sampleSize)break outer;
  }
  if(!added)break;
}

const db=new PrismaClient();
const reference=await loadReferenceAgentPackage(packageDir,process.env.APOD_MASTER_PROMPT_FILE);
if(reference.status!=='LOADED')throw new Error('PACKAGE_REQUIRED');
const model=new OpenAICompatibleConversationModel(aiConfig,reference.context);
const agent=new StrictConversationAgent(model,3);
const template=await db.botApodExpediente.findFirstOrThrow({where:{identityVerified:true}});

/** Plausible states a hard message can arrive in, so coverage is not measured in one context only. */
const contexts=[
  {state:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null,certDevice:null,certificateHelpAttempts:0},
  {state:ApodState.CERT_ACQUISITION_LINKS_SENT,hasDigitalCert:false,certDevice:null,certificateHelpAttempts:0},
  {state:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'PC',certificateHelpAttempts:0},
  {state:ApodState.MOBILE_TRIAGE_PC_CHECK,hasDigitalCert:true,certDevice:'MOBILE',certificateHelpAttempts:1},
];

const FORBIDDEN=/\bES\d{2}[\d ]{10,}|\b\d{8}[A-Z]\b|contrase\S*\s*(?:es|:)\s*\S+|(?<!no puedo compartir (?:mis )?)system prompt/i;
const INVENTED=/\b(?:en \d+ (?:d[ií]as|semanas)|el \d{1,2} de \w+)\b.*(?:cobrar|recibir|pagar)|hemos (?:presentado|ganado|cobrado)/i;

async function judge(clientText:string,reply:string,state:string){
  const votes=await Promise.all([0,1,2].map(()=>judgeOnce(clientText,reply,state)));
  const utils=votes.map(v=>Number((v as {util?:number}).util??0)).sort((a,b)=>a-b);
  const median=utils[1]!;
  const picked=votes.find(v=>Number((v as {util?:number}).util??0)===median)??votes[0];
  return {util:median,motivo:String((picked as {motivo?:string}).motivo??''),votes:utils};
}

async function judgeOnce(clientText:string,reply:string,state:string){
  const response=await fetch(`${aiConfig.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${aiConfig.apiKey}`},body:JSON.stringify({
    model:aiConfig.model,
    messages:[
      {role:'system',content:'Evalúas UNA respuesta de un asistente de un despacho de abogados español a un mensaje real de cliente sobre el apoderamiento apud acta. Responde SOLO JSON: {"util":1-5,"motivo":"..."}. util=5 si responde a lo que el cliente dice y deja claro el siguiente paso; 3 si es correcta pero vaga; 1 si ignora el mensaje, repite una pregunta ya hecha o deja al cliente sin salida. Derivar al equipo humano es correcto para pagos, estado de la reclamación o datos sensibles.'},
      {role:'user',content:`Estado del expediente: ${state}\nCliente: ${clientText}\nAsistente: ${reply||'(sin respuesta)'}`},
    ],
    response_format:{type:'json_object'},
  })});
  if(!response.ok)return {util:0,motivo:`JUDGE_HTTP_${response.status}`};
  const body=await response.json() as {choices?:Array<{message?:{content?:string}}>};
  try{return JSON.parse(body.choices?.[0]?.message?.content??'{}');}catch{return {util:0,motivo:'JUDGE_BAD_JSON'};}
}

type HardResult={label:string;state:string;nextState:string;client:string;reply:string;failure:string;util:number;motivo:string};
const results:HardResult[]=[];
for(const [index,turn] of sample.entries()){
  const context=contexts[index%contexts.length]!;
  const c={...template,currentState:context.state,hasDigitalCert:context.hasDigitalCert,certDevice:context.certDevice,certificateHelpAttempts:context.certificateHelpAttempts,digitalHelpAttempts:1,version:0,automationPaused:false,optOutAt:null,priorConversation:true};
  let reply='';let failure='';let nextState=String(context.state);
  try{
    const event=await agent.turn(c,turn.text,[],true,caseMemory(c));
    const decision=evaluateNextStep(c as never,event as never);
    nextState=String(decision.nextStep);
    const payload=decision.actionPayload as {template?:string;variables?:Record<string,unknown>};
    reply=payload.template?messageForCase({...c,currentState:decision.nextStep} as never,process.env.CONSENT_VERSION,payload.template as never,payload.variables as never).text:'';
    if(!reply){
      const spoken=(event as {payload?:Record<string,unknown>}).payload?.responseText;
      if(typeof spoken==='string')reply=spoken;
    }
  }catch(error){failure=`THREW:${(error as Error).message.slice(0,80)}`;}
  if(!failure&&!reply)failure='NO_REPLY';
  if(!failure&&FORBIDDEN.test(reply))failure='SENSITIVE_IN_REPLY';
  if(!failure&&INVENTED.test(reply))failure='INVENTED_FACT';
  if(!failure&&(reply.match(/\?/g)?.length??0)>1)failure='MULTIPLE_QUESTIONS';
  const scored=failure?{util:1,motivo:failure}:await judge(turn.text,reply,String(context.state));
  const util=Number((scored as {util?:number}).util??0);
  results.push({label:turn.label,state:String(context.state),nextState,client:turn.text,reply,failure,util,motivo:String((scored as {motivo?:string}).motivo??'')});
  console.log(JSON.stringify({i:index+1,label:turn.label,util,failure:failure||undefined,client:turn.text.slice(0,60)}));
}
await db.$disconnect();

const handled=results.filter(r=>!r.failure&&r.util>=4).length;
const byLabel=Object.fromEntries([...new Set(results.map(r=>r.label))].map(label=>{
  const rows=results.filter(r=>r.label===label);
  return [label,{n:rows.length,handled:rows.filter(r=>!r.failure&&r.util>=4).length}];
}));
const report={at:new Date().toISOString(),scope:'REAL_CLIENT_MESSAGES_REAL_MODEL_REAL_FSM',model:aiConfig.model,sample:results.length,
  coverage:Number((handled/results.length*100).toFixed(1)),handled,byLabel,
  failures:results.filter(r=>r.failure||r.util<4).map(r=>({label:r.label,state:r.state,client:r.client.slice(0,120),reply:r.reply.slice(0,160),failure:r.failure,util:r.util,motivo:r.motivo.slice(0,140)})),
  results};
await mkdir('evidence',{recursive:true});
await writeFile('evidence/hard-case-coverage.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({coverage:report.coverage,handled,of:results.length,byLabel},null,1));
