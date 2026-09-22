import assert from 'node:assert/strict';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {DebounceBuffer} from '../src/core/debounce-buffer.js';
import {relatedConversationText} from '../src/core/conversation-batching.js';
import {validateModelReply} from '../src/core/conversation-policy.js';

const failures:string[]=[];
async function check(name:string,run:()=>Promise<void>){try{await run();console.log('PASS',name);}catch(error){failures.push(name);console.error('FAIL',name,String(error));}}
const agent=new StrictConversationAgent({async classify(){return {kind:'HUMAN_REVIEW',reason:'UNSUPPORTED_TEXT'};},async reply(){return {kind:'REPLY',text:'Te paso con una persona del equipo.',requiresHumanReview:true};}},3);
for(const text of ['solo quiero salir de esto porfavor','i wanna finish thi whole process what to do','estoy harto, ayúdame a terminar']){
  await check(`completion help: ${text}`,async()=>{const turn=await agent.turn({currentState:'CERT_ACQUISITION_LINKS_SENT',hasDigitalCert:false},text,[],true);assert.notEqual(turn.payload.requiresHumanReview,true);assert.equal(turn.type,'CLIENT_REQUESTS_ASSISTANCE');});
}
for(const text of ['vale','ok','lo haré luego','no tengo tiempo','I will do it later','Vale, lo haré mañana que ahora estoy trabajando','Vale, pero no lo puedo hacer hasta mañana','ayuda porfavor\nlo haré luego']){
  await check(`yield: ${text}`,async()=>{const turn=await agent.turn({currentState:'CERT_ACQUISITION_LINKS_SENT',hasDigitalCert:false},text,[],true);assert.equal(turn.type,'CLIENT_SMALL_TALK');assert.equal(turn.payload.requiresHumanReview,false);assert.doesNotMatch(String(turn.payload.responseText),/¿|\?|envía|FNMT|juzgado|te paso/i);});
}
await check('text burst waits at least a minute, durable deadline equals queue deadline',async()=>{
  let saved:any;let queued:any;
  const db:any={$queryRaw:async()=>[],botApodInbox:{findUnique:async()=>null,create:async({data}:any)=>(saved={id:'one',...data}),updateMany:async()=>({count:1})},botApodExpediente:{updateMany:async()=>({count:1}),update:async()=>({}),findUniqueOrThrow:async()=>({id:'one',phaseOneStartedAt:null,phaseOneClosedAt:null,automationPaused:false,lastReminderDay:0,reminderCycle:0})},botApodMessage:{create:async()=>({})},$transaction:async(fn:any)=>fn(db)};
  const buffer=new DebounceBuffer(db,{add:async(...args:any[])=>{queued=args;}} as any);
  const before=Date.now();await buffer.ingestMessage({externalId:'one',expedienteId:'test',telefono:'00000',eventType:'CONVERSATION_TEXT',payload:{text:'tengo NIE'}});
  assert.ok(saved.notBefore.getTime()-before>=60_000,'must not reply after only four seconds');assert.ok(queued[2].delay>=59_900);
});
await check('related corrections and help stay together; cost and claim topics split',async()=>{
  assert.equal(relatedConversationText(['que no tengo DNI'],'tengo NIE'),true);
  assert.equal(relatedConversationText(['que no tengo DNI','tengo NIE'],'ayuda porfavor'),true);
  assert.equal(relatedConversationText(['tengo NIE'],'cuanto cuesta?'),false);
  assert.equal(relatedConversationText(['tengo NIE'],'como va mi reclamación?'),false);
  assert.equal(relatedConversationText(['tengo NIE'],'otra cosa, tengo una duda'),false);
  assert.equal(relatedConversationText(['tengo NIE'],'stop'),false);
  assert.equal(relatedConversationText(['ayuda porfavor'],'lo haré luego'),true);
});
await check('acknowledgment is not a yes answer, consent or a mixed help request',async()=>{
  const c={currentState:'WAITING_CERT_RESPONSE' as const,hasDigitalCert:null};
  assert.equal((await agent.turn(c,'sí')).type,'CLIENT_HAS_CERT');
  assert.equal((await agent.turn(c,'ok, cómo hago el apoderamiento?')).type,'CLIENT_REQUESTS_ASSISTANCE');
  assert.equal((await agent.turn(c,'quiero hablar con una persona')).payload.requiresHumanReview,true);
  assert.equal((await agent.turn({currentState:'MOBILE_ASSIST_CONSENT_REQUESTED',hasDigitalCert:true},'vale')).type,'CLIENT_SMALL_TALK');
});
await check('reply formatting retains short paragraphs',async()=>{
  assert.equal(validateModelReply({kind:'REPLY',text:'Entendido, tienes NIE.\n\nTe ayudo con esa vía.',requiresHumanReview:false})?.text,'Entendido, tienes NIE.\n\nTe ayudo con esa vía.');
});
assert.deepEqual(failures,[]);
