/**
 * Review archived demo conversations for mistakes.
 *
 * Two layers: deterministic rules (security, WhatsApp style, loops, dead ends) over every archived
 * chat, and — unless --rules-only — a real GPT pass that rates tone and names what went wrong.
 * Input is `evidence/conversations/*.json` written by archive-conversation.ts.
 *
 * Usage: ENV_FILE=.env.wce tsx scripts/review-conversations.ts [--rules-only] [--since 2026-09-18]
 */
import '../src/config/load-env-file.js';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';

const DIR='evidence/conversations';
const rulesOnly=process.argv.includes('--rules-only');
const since=process.argv.includes('--since')?process.argv[process.argv.indexOf('--since')+1]:undefined;

type Turn={role:string;content:string;at:string};
type Archive={id:string;label?:string;startedAt:string;finalState:string;automationPaused?:boolean;turns:Turn[];humanTasks:Array<{kind:string;reason:string}>;actions:Array<{status:string;error?:string|null}>};

const SECRET=/\b[A-Z]{2}\d{2}[\d ]{10,}|\b\d{8}[A-Z]\b|\b[XYZ]\d{7}[A-Z]\b|system prompt|instrucciones internas del sistema/i;
const PLACEHOLDER=/\[(?:CONTENIDO_SENSIBLE_OMITIDO|ENLACE|EMAIL|IBAN|DNI|NIE|TELEFONO)\]/;
const ROBOTIC=/no he podido entender|ha surgido un problema al responder/i;

/** Deterministic checks; each returned string is a defect worth fixing. */
function ruleFindings(chat:Archive):string[] {
  const findings:string[]=[];
  const bot=chat.turns.filter(t=>t.role==='assistant');
  const client=chat.turns.filter(t=>t.role==='user');
  bot.forEach((turn,index)=>{
    const text=turn.content;
    if(SECRET.test(text))findings.push(`SECRET_IN_REPLY: ${text.slice(0,90)}`);
    if(PLACEHOLDER.test(text))findings.push(`PLACEHOLDER_SHOWN: ${text.slice(0,90)}`);
    if(ROBOTIC.test(text))findings.push(`ROBOTIC_FALLBACK: ${text.slice(0,90)}`);
    if(/\p{Extended_Pictographic}/u.test(text))findings.push(`EMOJI: ${text.slice(0,60)}`);
    if((text.match(/\?/g)?.length??0)>1)findings.push(`MULTIPLE_QUESTIONS: ${text.slice(0,90)}`);
    if(text.length>700)findings.push(`TOO_LONG(${text.length}): ${text.slice(0,60)}`);
    const previous=bot[index-1]?.content;
    if(previous&&previous===text)findings.push(`REPEATED_VERBATIM: ${text.slice(0,70)}`);
    else if(previous&&question(previous)&&question(previous)===question(text))findings.push(`REPEATED_QUESTION: ${question(text)}`);
  });
  // A client who wrote and never got an answer is the worst failure in a WhatsApp flow.
  const lastClient=client.at(-1),lastBot=bot.at(-1);
  if(lastClient&&(!lastBot||lastBot.at<lastClient.at)&&!chat.automationPaused)findings.push('CLIENT_LEFT_WITHOUT_REPLY');
  for(const action of chat.actions)if(['FAILED','BLOCKED'].includes(action.status))findings.push(`ACTION_${action.status}: ${action.error??''}`.slice(0,90));
  return findings;
}
const question=(text:string)=>text.match(/[^.!?\n]*\?/)?.[0]?.trim().toLowerCase();

async function judge(chat:Archive,config:{baseUrl:string;apiKey:string;model:string}){
  const transcript=chat.turns.map(t=>`${t.role==='user'?'Cliente':'Asistente'}: ${t.content}`).join('\n');
  const response=await fetch(`${config.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.apiKey}`},body:JSON.stringify({
    model:config.model,
    messages:[
      {role:'system',content:'Revisas conversaciones reales de WhatsApp entre un despacho de abogados español y un cliente sobre el apoderamiento apud acta. Responde SOLO JSON: {"humano":1-5,"claridad":1-5,"persuasion":1-5,"errores":["..."],"mejor_respuesta":"reescribe el peor mensaje del asistente"}. En "errores" indica fallos concretos del asistente: repetir preguntas, ignorar lo que dijo el cliente, tecnicismos, prometer plazos, o dejar al cliente sin siguiente paso.'},
      {role:'user',content:transcript.slice(0,12000)},
    ],
    response_format:{type:'json_object'},
  })});
  if(!response.ok)return {error:`JUDGE_HTTP_${response.status}`};
  const body=await response.json() as {choices?:Array<{message?:{content?:string}}>};
  try{return JSON.parse(body.choices?.[0]?.message?.content??'{}');}catch{return {error:'JUDGE_BAD_JSON'};}
}

const files=(await readdir(resolve(DIR)).catch(()=>[])).filter(f=>f.endsWith('.json'));
if(!files.length){console.log(JSON.stringify({reviewed:0,reason:'NO_ARCHIVED_CONVERSATIONS',dir:DIR}));process.exit(0);}
const ai=conversationAiFromEnv();
const aiConfig=!rulesOnly&&ai.status==='CONFIGURED'?ai.config:null;

const reviews=[];
for(const file of files.sort()){
  const chat=JSON.parse(await readFile(resolve(DIR,file),'utf8')) as Archive;
  if(since&&chat.startedAt<since)continue;
  const findings=ruleFindings(chat);
  const scores=aiConfig?await judge(chat,aiConfig):undefined;
  reviews.push({id:chat.id,label:chat.label??'',startedAt:chat.startedAt,finalState:chat.finalState,clientMessages:chat.turns.filter(t=>t.role==='user').length,ruleFindings:findings,scores});
  console.log(JSON.stringify({id:chat.id,findings:findings.length,state:chat.finalState,...(scores&&typeof scores==='object'?{scores}:{})}));
}
const withFindings=reviews.filter(r=>r.ruleFindings.length);
const report={at:new Date().toISOString(),reviewed:reviews.length,conversationsWithFindings:withFindings.length,
  findingsByType:Object.entries(reviews.flatMap(r=>r.ruleFindings.map(f=>f.split(':')[0]!)).reduce<Record<string,number>>((counts,type)=>({...counts,[type]:(counts[type]??0)+1}),{})).sort((a,b)=>b[1]-a[1]),
  judged:Boolean(aiConfig),reviews};
await writeFile('evidence/conversation-review.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({reviewed:report.reviewed,withFindings:report.conversationsWithFindings,findingsByType:report.findingsByType,report:'evidence/conversation-review.json'},null,1));
