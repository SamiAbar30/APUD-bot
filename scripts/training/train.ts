/**
 * Training loop: simulated clients talk to the real running bot, an independent model judges each
 * conversation the way the manager does, and the round is written to evidence/training/.
 *
 * Everything is live: the signed WhatsApp webhook, the queue, the worker, the conversation brain
 * with the real model, the state machine and the Postgres database. Only the client is simulated,
 * by a different model than the bot, playing a persona built from real situations and real client
 * messages. Training lines are separate demo cases the manager's screen never shows.
 *
 * Usage: ENV_FILE=.env.wce npx tsx scripts/training/train.ts [--round=N] [--only=a,b] [--corpus=6] [--seed=1] [--turns=12]
 */
import '../../src/config/load-env-file.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {conversationAiFromEnv} from '../../src/config/conversation-ai.js';
import {PERSONAS,type Persona} from './personas.js';
import {seedTrainingLines,resetLine,clearQueueFor,sendText,officeReplies,tapButton,deliveryFailed,sentIds,buttonsOnScreen} from './lines.js';

const arg=(name:string)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const round=arg('round')??new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
const only=arg('only')?.split(',');
const corpusCount=Number(arg('corpus')??'6');
const seed=arg('seed')??'1';
const maxTurns=Number(arg('turns')??'12');
const SIM_MODEL=process.env.TRAIN_SIM_MODEL??'gpt-5.5';
const JUDGE_MODEL=process.env.TRAIN_JUDGE_MODEL??'gpt-5.5';

const ai=conversationAiFromEnv();
if(ai.status!=='CONFIGURED'||ai.config.mode!=='online')throw new Error('REAL_ONLINE_AI_REQUIRED');
const aiConfig=ai.config;
const playbook=await readFile(resolve('config/brain/playbook.md'),'utf8');
const roster=await (async()=>{try{const p=JSON.parse(await readFile(resolve(process.env.APOD_AGENT_PACKAGE_DIR??'.','placeholders.json'),'utf8')) as Record<string,{value?:string}>;return p.LISTA_PROCURADORES_ABOGADOS?.value??'';}catch{return '';}})();
/** What the Sede really shows, from the firm's guide, so the simulated client does not invent screens. */
const SEDE_SCREENS=playbook.slice(playbook.indexOf('### Paso a paso en la Sede'),playbook.indexOf('### Certificado en el móvil'));

async function chatJson(model:string,system:string,user:string):Promise<Record<string,unknown>>{
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(`${aiConfig.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${aiConfig.apiKey}`},
      body:JSON.stringify({model,messages:[{role:'system',content:system},{role:'user',content:user}],response_format:{type:'json_object'}})});
    if(response.ok){
      const body=await response.json() as {choices?:Array<{message?:{content?:string}}>};
      try{return JSON.parse(body.choices?.[0]?.message?.content??'{}');}catch{/* retry */}
    }
    await new Promise(r=>setTimeout(r,3000*(attempt+1)));
  }
  return {};
}

type Line={who:'bot'|'cliente';text:string};
const show=(t:Line[])=>t.map((l,i)=>`${i+1}. ${l.who==='bot'?'DESPACHO':'CLIENTE'}: ${l.text}`).join('\n');

/** Real client conversations from the imported WhatsApp corpus become extra personas. */
async function corpusPersonas():Promise<Persona[]>{
  if(!corpusCount)return [];
  const dir=process.env.APOD_AGENT_PACKAGE_DIR;if(!dir)return [];
  const rows=(await readFile(resolve(dir,'training/conversations.jsonl'),'utf8')).split('\n').filter(Boolean);
  const candidates=rows.map(line=>{try{return JSON.parse(line) as {turns?:Array<{role:string;content:string}>};}catch{return null;}})
    .filter((r):r is {turns:Array<{role:string;content:string}>}=>Boolean(r?.turns))
    .map(r=>r.turns.filter(t=>t.role==='user').map(t=>t.content.trim()).filter(t=>t.length>3&&t.length<300))
    .filter(msgs=>msgs.length>=4&&msgs.join(' ').length>150);
  const picked=candidates.map(msgs=>({msgs,rank:createHash('sha256').update(seed+msgs.join('|')).digest('hex')})).sort((a,b)=>a.rank.localeCompare(b.rank)).slice(0,corpusCount);
  return picked.map((p,i)=>({id:`real_${seed}_${i+1}`,facts:'Eres un cliente real del despacho. Tu situación se deduce de tus mensajes reales de abajo; mantenla coherente.',
    behaviour:`Escribe EXACTAMENTE con el estilo, las preocupaciones y las reacciones de este cliente real. Sus mensajes reales fueron:\n${p.msgs.slice(0,14).map(m=>`- ${m}`).join('\n')}`,
    goal:'Lo que este cliente quería según sus mensajes.'}));
}

type ClientMove={texts:string[];button?:string;done:boolean;why:string;text?:string};
async function simulateClient(p:Persona,transcript:Line[],screen:{current:string[];older:string[]}):Promise<ClientMove>{
  if(transcript.filter(l=>l.who==='cliente').length===0&&p.openWith)return {texts:[p.openWith],done:false,why:''};
  const out=await chatJson(SIM_MODEL,`Eres un cliente de un despacho de abogados español hablando por WhatsApp con su asistente virtual sobre el "apoderamiento apud acta" de tu reclamación. Juegas un papel; nunca reveles que eres una simulación.
Tus hechos (solo los sabes tú, revélalos cuando sea natural): ${p.facts}
Tu forma de ser y escribir: ${p.behaviour}
Lo que quieres conseguir: ${p.goal}
Reglas: escribe como en WhatsApp real, normalmente una o dos frases cortas, en español salvo que tu papel diga otra cosa. Reacciona a lo que te acaban de decir: si te dan un paso, lo intentas y cuentas qué pasa según tus hechos. Si te repiten lo mismo o no te entienden, muestra frustración como lo haría una persona. No puedes enviar archivos ni imágenes; si tuvieras que mandar un archivo, di que lo mandas y termina.\nSi estás en la Sede Judicial, lo que ves en pantalla es lo de esta guía oficial; no inventes pantallas, campos ni datos que la Sede pida fuera de ella:\n${SEDE_SCREENS}
Como en WhatsApp real: a veces partes lo que dices en varios mensajes cortos seguidos ("Vale" / "Dame un segundo" / "ya está"), y cuando el último mensaje trae botones a menudo contestas pulsando uno en vez de escribir. Muy de vez en cuando, por despiste, pulsas un botón de un mensaje anterior.
Botones del último mensaje: ${screen.current.length?screen.current.join(' | '):'(ninguno)'}.
Botones de mensajes anteriores: ${screen.older.length?screen.older.join(' | '):'(ninguno)'}.
Termina ("fin": true) cuando: consigues tu objetivo, te dicen que te atiende una persona y ya no hay más que decir, te despides, o llevas varios mensajes sin avanzar y lo dejas.
Devuelve SOLO JSON: {"mensajes":["uno o varios mensajes cortos que envías seguidos (vacío si pulsas un botón o si fin)"],"boton":"título exacto del botón que pulsas, o vacío","fin":true|false,"motivo":"por qué terminas (si fin)"}`,
    `Conversación hasta ahora:\n${show(transcript)}\n\nEscribe tu siguiente movimiento como el cliente.`);
  const texts=(Array.isArray(out.mensajes)?out.mensajes:[out.mensaje]).map(t=>String(t??'').trim()).filter(Boolean).slice(0,5);
  const button=String(out.boton??'').trim()||undefined;
  return {texts,...(button?{button}:{}),done:out.fin===true||(!texts.length&&!button),why:String(out.motivo??'')};
}

async function judge(p:Persona,transcript:Line[],finalState:string,document:string){
  return chatJson(JUDGE_MODEL,`Eres la responsable de apoderamientos del despacho LITIGIOS y revisas conversaciones de WhatsApp de la asistente virtual con clientes, igual que revisarías a una compañera nueva. Eres exigente: marcas cada respuesta que un cliente real encontraría inútil, repetitiva, robótica o incorrecta.
Lo que el despacho espera (manual de la asistente):
---
${playbook}

Datos reales del despacho (correctos, la asistente puede darlos). En la Sede el cliente pone el procurador Airam Díaz Ruiz (530, Las Palmas) y el abogado Fernando Gómez (134543, Madrid), que son los de la guía PDF; darlos es correcto:
${roster}
---
Criterios de la revisión (1 a 5 cada uno):
- comprension: entiende lo que el cliente quiere decir, no palabras sueltas.
- sigue_el_punto: sabe en qué punto está el cliente y da el siguiente paso concreto desde ahí; no vuelve a preguntar lo ya dicho (una respuesta con [botón] cuenta como dicha).
- no_repite: no repite mensajes ni ideas que ya no funcionaron; cambia de enfoque.
- respeta_decisiones: si el cliente dice que no comparte su certificado o que prefiere hacerlo él, lo respeta y le ayuda en eso.
- exactitud: todo lo que dice cumple el manual (enlaces, precios, pasos, seguridad); no inventa nada.
- traspaso: pasa a una persona cuando hace falta (el cliente lo pide, no le entiende, se atasca repetidamente, casos delicados) y no cuando no hace falta.
- humano: suena a una persona del despacho por WhatsApp: breve, natural, cálida, sin fórmulas repetidas.
Tras un traspaso, el sistema envía como mucho un acuse breve ('Gracias, lo tengo apuntado…') y luego calla: es lo previsto. Tras un traspaso a una persona, que la asistente deje de contestar es lo correcto: la conversación sigue con una persona. Juzga si el traspaso fue oportuno, no el silencio posterior.
Aprobado = una responsable exigente daría esta conversación por buena sin correcciones importantes.
Devuelve SOLO JSON: {"aprobado":true|false,"puntuaciones":{"comprension":n,"sigue_el_punto":n,"no_repite":n,"respeta_decisiones":n,"exactitud":n,"traspaso":n,"humano":n},"resultado":"una frase: cómo acaba el cliente","problemas":[{"turno":número de línea,"problema":"qué está mal","deberia":"qué debería haber dicho o hecho"}]}`,
    `Documento de identidad que consta en el sistema del despacho: ${document}.\nSituación del cliente (el despacho no la conocía): ${p.facts}\nObjetivo del cliente: ${p.goal}\nEstado final del expediente en el sistema: ${finalState}\n\nConversación:\n${show(transcript)}`);
}

function mechanicalProblems(transcript:Line[]):string[]{
  const problems:string[]=[];const seen=new Map<string,number>();
  transcript.forEach((l,i)=>{
    if(l.who!=='bot')return;
    if(l.text==='(sin respuesta)'){
      // Quiet after "vale, voy a hacerlo" is what a person does too; quiet after a question is not.
      const latest:Line[]=[];for(let j=i-1;j>=0&&transcript[j]!.who==='cliente';j--)latest.push(transcript[j]!);
      const asked=latest.some(x=>/\?|ayuda|no (?:me )?(?:deja|sale|funciona|entiendo)|qu[eé] hago/i.test(x.text));
      if(asked)problems.push(`L${i+1}: el bot no contesta a una pregunta y el caso no está con una persona`);
      return;
    }
    const key=l.text.toLowerCase().replace(/\s+/g,' ').trim();
    if(seen.has(key))problems.push(`L${i+1}: mensaje idéntico al de la línea ${seen.get(key)}`);else seen.set(key,i+1);
    if((l.text.match(/\?/g)?.length??0)>1)problems.push(`L${i+1}: más de una pregunta`);
    if(/\p{Extended_Pictographic}/u.test(l.text))problems.push(`L${i+1}: emoji`);
  });
  return problems;
}

const db=new PrismaClient();
const lines=await seedTrainingLines(db);
if(!lines.length)throw new Error('NO_TRAINING_LINES: restart the stack so setup-wce allowlists them');
const personas=[...PERSONAS.filter(p=>!only||only.includes(p.id)),...(only?[]:await corpusPersonas())];
console.log(JSON.stringify({round,personas:personas.length,lines:lines.length,sim:SIM_MODEL,judge:JUDGE_MODEL}));

type Result={id:string;line:string;document:string;transcript:Line[];traces:string[];end:string;state:string;paused:boolean;mechanical:string[];verdict:Record<string,unknown>};
const results:Result[]=[];
const queue=[...personas];
const free=[...lines];
const retried=new Set<string>();

/** Deterministic, so a rerun of a round refuses the same openings. */
function refuseOpening(id:string){return createHash('sha256').update(seed+id).digest()[0]!%4===0;}

async function run(p:Persona,line:typeof lines[number]):Promise<Result>{
  // The previous conversation on this line may still hold the case lock for a last reply.
  let opened:Awaited<ReturnType<typeof resetLine>>|null=null;
  for(let attempt=0;attempt<8&&!opened;attempt++){
    const busy=await db.botApodInbox.count({where:{expedienteId:line.caseId,status:'PENDING'}})+await db.botApodAccion.count({where:{expedienteId:line.caseId,status:{in:['PENDING','RUNNING']}}});
    if(!busy){await clearQueueFor([line.caseId]);try{opened=await resetLine(db,line.phone);}catch{/* retry */}}
    if(!opened)await new Promise(r=>setTimeout(r,5000));
  }
  // Still busy after 40 s means a stuck row, not a reply in flight: the reset clears it anyway.
  if(!opened){await clearQueueFor([line.caseId]);opened=await resetLine(db,line.phone);}
  const {caseId,started}=opened;
  const opening=await officeReplies(db,caseId,new Date(started.getTime()-1),{firstWithinMs:60_000,settleMs:2_000});
  // One conversation in four starts like the manager's live test: Meta refuses the opening, so the
  // client never saw it and writes first.
  const refused=refuseOpening(p.id);
  if(refused){const [first]=await sentIds(db,caseId);if(first)await deliveryFailed(line.phone,first);await new Promise(r=>setTimeout(r,3000));}
  const transcript:Line[]=refused?[{who:'bot',text:'(primer mensaje no entregado por WhatsApp: el cliente no lo vio)'}]:opening.map(text=>({who:'bot' as const,text}));
  let end='max_turns';
  const traces:string[]=[];
  for(let turn=0;turn<maxTurns;turn++){
    const screens=await buttonsOnScreen(db,caseId);
    const lastSent=(await sentIds(db,caseId)).at(-1);
    const current=screens.find(x=>x.messageId===lastSent);
    const older=screens.filter(x=>x!==current);
    const next=await simulateClient(p,transcript,{current:current?.buttons.map(b=>b.title)??[],older:[...new Set(older.flatMap(x=>x.buttons.map(b=>b.title)))]});
    if(next.done){end=`cliente: ${next.why}`;break;}
    const before=new Date();
    const pressed=next.button?[current,...[...older].reverse()].flatMap(x=>x?x.buttons.map(b=>({...b,messageId:x.messageId})):[]).find(b=>b.title.toLowerCase()===next.button!.toLowerCase()):undefined;
    if(pressed){await tapButton(line.phone,pressed.id,pressed.title,pressed.messageId);transcript.push({who:'cliente',text:`[botón] ${pressed.title}${pressed.messageId!==current?.messageId?' (de un mensaje anterior)':''}`});}
    for(const text of next.texts){await sendText(line.phone,text);transcript.push({who:'cliente',text});await new Promise(r=>setTimeout(r,150));}
    if(!pressed&&!next.texts.length){end='cliente: botón inexistente';break;}
    next.text=[pressed?.title,...next.texts].filter(Boolean).join(' / ');
    const replies=await officeReplies(db,caseId,before);
    const audits=await db.botApodAuditLog.findMany({where:{expedienteId:caseId,createdAt:{gt:before}},orderBy:{createdAt:'asc'},select:{event:true,fromState:true,toState:true,metadata:true}});
    traces.push(`T${turn+1} «${next.text.slice(0,60)}» → `+(audits.map(a=>{const e=((a.metadata as {evidence?:Record<string,unknown>}|null)?.evidence)??{};return `${a.event} ${a.fromState}→${a.toState}${e.brainUnderstanding?` | entiende: ${e.brainUnderstanding}`:''}${e.brainNote?` | nota: ${e.brainNote}`:''}${e.brainLead?' | con frase previa':''}`;}).join(' ; ')||'sin evento'));
    for(const text of replies)transcript.push({who:'bot',text});
    if(!replies.length){
      const c=await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{automationPaused:true}});
      const state=(await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{currentState:true}})).currentState;
      if(c.automationPaused||state==='ESCALATED_HUMAN'){transcript.push({who:'bot',text:'(sin respuesta: caso en manos de una persona)'});end='traspaso a persona';break;}
      transcript.push({who:'bot',text:'(sin respuesta)'});
    }
  }
  const c=await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{currentState:true,automationPaused:true}});
  const verdict=await judge(p,transcript,`${c.currentState}${c.automationPaused?' (pausado: atendido por persona)':''}`,line.document);
  return {id:p.id,line:line.phone,document:line.document,transcript,traces,end,state:c.currentState,paused:c.automationPaused,mechanical:mechanicalProblems(transcript),verdict};
}

await new Promise<void>(done=>{
  let active=0;
  const pump=()=>{
    if(!queue.length&&!active)return done();
    while(queue.length&&free.length){
      const index=queue.findIndex(p=>!p.document||free.some(l=>l.document===p.document));
      if(index<0)break;
      const p=queue.splice(index,1)[0]!;
      const lineIndex=free.findIndex(l=>!p.document||l.document===p.document);
      const line=free.splice(lineIndex,1)[0]!;
      active++;
      run(p,line).then(r=>{
        results.push(r);
        const v=r.verdict as {aprobado?:boolean;puntuaciones?:Record<string,number>};
        console.log(JSON.stringify({persona:r.id,aprobado:v.aprobado,scores:v.puntuaciones,end:r.end,state:r.state,mechanical:r.mechanical.length}));
      }).catch(error=>{console.log(JSON.stringify({persona:p.id,error:String((error as Error).message).slice(0,200)}));if(!retried.has(p.id)){retried.add(p.id);queue.push(p);}})
        .finally(()=>{active--;free.push(line);pump();});
    }
  };
  pump();
});
await db.$disconnect();

const approved=results.filter(r=>(r.verdict as {aprobado?:boolean}).aprobado===true).length;
const keys=['comprension','sigue_el_punto','no_repite','respeta_decisiones','exactitud','traspaso','humano'];
const average=Object.fromEntries(keys.map(k=>{const v=results.map(r=>Number((r.verdict as {puntuaciones?:Record<string,number>}).puntuaciones?.[k])).filter(Number.isFinite);return [k,v.length?Number((v.reduce((a,b)=>a+b,0)/v.length).toFixed(2)):null];}));
const report={round,at:new Date().toISOString(),scope:'LIVE_STACK_REAL_MODEL_SIMULATED_CLIENTS',botModel:process.env.BRAIN_MODEL||aiConfig.model,simModel:SIM_MODEL,judgeModel:JUDGE_MODEL,
  conversations:results.length,approved,approvalRate:Number((approved/Math.max(1,results.length)*100).toFixed(1)),average,
  mechanical:results.reduce((n,r)=>n+r.mechanical.length,0),results};
await mkdir('evidence/training',{recursive:true});
await writeFile(`evidence/training/round-${round}.json`,JSON.stringify(report,null,2),{mode:0o600});
const md=[`# Ronda ${round}`,`Aprobadas ${approved}/${results.length} (${report.approvalRate}%). Medias: ${JSON.stringify(average)}. Problemas mecánicos: ${report.mechanical}.`,'',
  ...results.sort((a,b)=>Number((a.verdict as {aprobado?:boolean}).aprobado)-Number((b.verdict as {aprobado?:boolean}).aprobado)).map(r=>{
    const v=r.verdict as {aprobado?:boolean;resultado?:string;problemas?:Array<{turno?:number;problema?:string;deberia?:string}>};
    return [`## ${v.aprobado?'OK':'FALLA'} — ${r.id} (${r.document}, ${r.state}${r.paused?', con persona':''}; fin: ${r.end})`,v.resultado??'',
      ...(v.problemas??[]).map(x=>`- L${x.turno}: ${x.problema} → ${x.deberia}`),...r.mechanical.map(m=>`- ${m}`),'','```',show(r.transcript),'```','','<details><summary>Decisiones del bot</summary>','',...r.traces.map(t=>`- ${t}`),'</details>',''].join('\n');
  })].join('\n');
await writeFile(`evidence/training/round-${round}.md`,md,{mode:0o600});
console.log(JSON.stringify({round,approved,of:results.length,rate:report.approvalRate,average,mechanical:report.mechanical}));
