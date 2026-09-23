import assert from 'node:assert/strict';
import { ApodState } from '@prisma/client';
import { StrictConversationAgent } from '../src/core/conversation-agent.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';
import {messageForCase} from '../src/core/messages.js';
import {EventType,type WorkflowEvent} from '../src/domain/fsm/states.js';
import type {Expediente} from '../src/domain/models/expediente.js';

// Reproduce the latest report with a provider that repeats the bad court reply.
const agent = new StrictConversationAgent({
  async classify() { return {kind:'HUMAN_REVIEW',reason:'UNSUPPORTED_TEXT'}; },
  async reply() { return {kind:'REPLY',text:'Puedes acudir al Decanato o Juzgado de Paz y solicitar un apoderamiento apud acta. ¿Quieres que una persona del equipo te confirme los requisitos?',requiresHumanReview:false}; },
},3);
const result=await agent.turn({currentState:ApodState.COURT_FALLBACK_GUIDE_SENT,hasDigitalCert:false},'no i dont have it can you show me how to make it');
assert.notEqual(result.payload.requiresHumanReview,true);
assert.doesNotMatch(String(result.payload.responseText??''),/Decanato|Juzgado|persona del equipo|empresa colaboradora/i);
assert.ok(result.type==='CLIENT_HAS_NO_CERT'||/certificado|FNMT/.test(String(result.payload.responseText??'')),'A request for help must resume digital guidance');
console.log('PASS reported help request resumes digital guidance');
const digitalCorrection=await agent.turn({currentState:ApodState.COURT_FALLBACK_GUIDE_SENT,hasDigitalCert:false},'no i waana make it with sertificado degital');
assert.equal(digitalCorrection.type,EventType.CLIENT_HAS_NO_CERT);
assert.notEqual(digitalCorrection.payload.requiresHumanReview,true);
console.log('PASS actual misspelled digital-route correction resumes guidance');

const initial={id:'guidance-regression',version:0,nombre:'PRUEBA',telefono:'000000000',dni:'12345678Z',isProvisionalFiled:false,digitalHelpAttempts:0,certificateHelpAttempts:0};
let c:any={...initial,currentState:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'PC'};
async function apply(input:string){
  // Fresh agent and empty history each time: progression must use persisted facts.
  const fresh=new StrictConversationAgent(undefined,3);
  const event=await fresh.turn(c,input,[],true);
  const d=evaluateNextStep(c as Expediente,event as WorkflowEvent);
  c={...c,...d.actionPayload.expedientePatch,currentState:d.nextStep,version:c.version+1};
  assert.notEqual(c.currentState,'ESCALATED_HUMAN',input);
  const p=d.actionPayload;
  const guide='template' in p?messageForCase(c,undefined,p.template,'variables' in p?p.variables:undefined):undefined;
  assert.ok(guide,'Expected a usable next-step reply');
  return guide;
}
const first=await apply('no puedo');
assert.match(first.text,/Certificado Digital.*Área del ciudadano/);
assert.equal(c.currentState,'PC_TUTORIAL_SENT');
assert.equal(c.digitalHelpAttempts,1);
const second=await apply('sigue sin funcionar');
assert.match(second.text,/En calidad de poderdante/);
assert.equal(c.certificateHelpAttempts,0);
const third=await apply('todavía no puedo');
assert.match(third.text,/copia de tu certificado/);
assert.equal(c.certificateHelpAttempts,1);
for(const guide of [first,second,third])assert.doesNotMatch(guide.text,/juzgado|decanato|empresa colaboradora|te paso con/i);
const greeting=await apply('hola');
assert.match(greeting.text,/copia de tu certificado/);
assert.equal(c.digitalHelpAttempts,3);
assert.equal(c.certificateHelpAttempts,1);
const locate=await apply('no consigo encontrarlo');
assert.match(locate.text,/Descargas.*\.p12/);
const exportGuide=await apply('todavía no puedo');
assert.match(exportGuide.text,/copia de seguridad o exportación/);
assert.equal(c.currentState,'PC_TUTORIAL_SENT');
assert.equal(c.certificateHelpAttempts,3);
const alternatives=await apply('lo he intentado y no puedo');
assert.equal(c.currentState,'FALLBACK_OPTIONS');
assert.match(alternatives.text,/juzgado.*gratis/);
assert.match(alternatives.text,/empresa colaboradora.*opcional.*pago/);
console.log('PASS digital help → certificate copy help → fallback only after repeated failures; restart and greeting preserve progress');

c={...initial,currentState:ApodState.CERT_ACQUISITION_LINKS_SENT,hasDigitalCert:false,certDevice:'NONE'};
const acquisitionHelp=await apply('can you show me how to make it');
assert.match(acquisitionHelp.text,/FNMT/);
assert.doesNotMatch(acquisitionHelp.text,/juzgado|empresa/);
assert.equal(c.currentState,'CERT_ACQUISITION_LINKS_SENT');
await apply('no puedo');
await apply('todavía no puedo');
assert.equal(c.currentState,'FALLBACK_OPTIONS');
console.log('PASS no-certificate route gives guidance before offering alternatives');

c={...initial,currentState:ApodState.COURT_FALLBACK_GUIDE_SENT,hasDigitalCert:false};
const back=await apply('no i dont have it can you show me how to make it');
assert.equal(c.currentState,'CERT_ACQUISITION_LINKS_SENT');
assert.match(back.text,/opciones para conseguir el certificado digital/);
assert.doesNotMatch(back.text,/juzgado|empresa colaboradora/);
assert.deepEqual(back.buttons?.map(b=>b.id),['DEVICE_PC','DEVICE_MOBILE','NEEDS_ASSISTANCE']);
console.log('PASS exact reported turn produces digital guidance and help buttons through the FSM');

c={...initial,currentState:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'PC'};
const signHelp=await apply('AutoFirma no funciona');
assert.match(signHelp.text,/Comprueba que AutoFirma está instalado/);
assert.equal(c.certificateHelpAttempts,0);
const explicitHuman=await agent.turn(c,'quiero hablar con una persona');
assert.equal(explicitHuman.payload.requiresHumanReview,true);
assert.equal(explicitHuman.type,EventType.CLIENT_SMALL_TALK);
console.log('PASS specific signing guidance and explicit human request');

c={...initial,currentState:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'PC',digitalHelpAttempts:3,certificateHelpAttempts:1};
const mobileCopy=await apply('en el móvil');
assert.match(mobileCopy.text,/m[oó]vil/);
assert.match(mobileCopy.text,/aplicaci[oó]n/);
assert.match(mobileCopy.text,/copia de seguridad|exportar/);
assert.doesNotMatch(mobileCopy.text,/¿Has encontrado ese archivo\?/,'No pushy trailing question (manager note, 18 Sep)');
assert.equal(c.certificateHelpAttempts,2);
const readyCopy=await agent.turn(c,'ya tengo el archivo');
assert.equal(readyCopy.type,EventType.CLIENT_REQUESTS_ASSISTANCE,'Locating the copy must advance to assisted processing');
const consent=evaluateNextStep(c,readyCopy as any);
assert.equal(consent.nextStep,ApodState.MOBILE_ASSIST_CONSENT_REQUESTED,'Assistance requires explicit consent first');
console.log('PASS certificate-copy answers stay contextual; a located copy moves to assisted consent');
