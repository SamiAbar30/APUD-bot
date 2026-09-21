/**
 * The six findings from the manager's live test on 18 September 2026, locked as assertions.
 * Real code paths (FSM, agent, templates, batching), no provider and no network.
 */
import '../src/config/load-env-file.js';
import assert from 'node:assert/strict';
import {ApodState} from '@prisma/client';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';
import {messageForCase} from '../src/core/messages.js';
import {relatedConversationText} from '../src/core/conversation-batching.js';
import {classifyClientText} from '../src/core/conversation-policy.js';
import {reviewedConversationReply,declaredDocumentType} from '../src/core/conversation-guidance.js';
import {EventType} from '../src/domain/fsm/states.js';

const agent=new StrictConversationAgent(undefined,3);
type Case=Parameters<typeof evaluateNextStep>[0];
type Row=Parameters<typeof messageForCase>[0];
type Template=Parameters<typeof messageForCase>[2];
const asRow=(c:Case):Row=>c as unknown as Row;
const base={id:'manager-findings',version:0,nombre:'SYNTHETIC',telefono:'00000',dni:'12345678Z',digitalHelpAttempts:0,certificateHelpAttempts:0,isProvisionalFiled:false};
const caseWith=(fields:Record<string,unknown>):Case=>({...base,...fields}) as unknown as Case;
const render=(c:Case,event:{type:EventType;payload:Record<string,unknown>})=>{
  const decision=evaluateNextStep(c,event as Parameters<typeof evaluateNextStep>[1]);
  const payload=decision.actionPayload as {template?:string;variables?:Record<string,unknown>};
  const after={...(c as object),currentState:decision.nextStep} as unknown as Case;
  return {decision,text:payload.template?messageForCase(asRow(after),undefined,payload.template as Template,payload.variables as Parameters<typeof messageForCase>[3]).text:''};
};

// Finding 5: refusing to share the certificate must open the court / partner routes, not stall.
const refusals=[
  'escuchame, pero q ya te e dicho q tengo el archivo en mi movil pero no te lo quiero enviar ni tampoco tengo la aplicación esta',
  'no quiero enviarlo a Litigios',
  'prefiero no compartir mi certificado',
  'no lo voy a mandar',
];
for(const text of refusals){
  const stuck=caseWith({currentState:ApodState.MOBILE_TRIAGE_PC_CHECK,hasDigitalCert:true,certDevice:'MOBILE',certificateHelpAttempts:2});
  const event=await agent.turn(stuck as Parameters<typeof agent.turn>[0],text,[],true);
  assert.equal(event.type,EventType.CLIENT_CONSENT_DENIED,`refusal not recognised: ${text}`);
  const {decision,text:reply}=render(stuck,event);
  assert.equal(decision.nextStep,ApodState.FALLBACK_OPTIONS,`refusal did not reach the alternatives: ${text}`);
  assert.match(reply,/juzgado/i,'The court route must be offered');
}

// Finding 3: the device is already known, so the copy help must not ask "PC or mobile?" again.
const mobileCase=caseWith({currentState:ApodState.MOBILE_TRIAGE_PC_CHECK,hasDigitalCert:true,certDevice:'MOBILE',certificateHelpAttempts:1});
const copyHelp=messageForCase(asRow(mobileCase),undefined,'CERTIFICATE_COPY_HELP' as Template,undefined).text;
assert.doesNotMatch(copyHelp,/ordenador o en una aplicación del móvil/,'Device was already established as mobile');
assert.match(copyHelp,/m[oó]vil/);

// Finding 4: no pushy trailing questions in the copy-help sequence.
for(const attempts of [1,2,3]){
  const text=messageForCase(asRow(caseWith({currentState:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'MOBILE',certificateHelpAttempts:attempts})),undefined,'CERTIFICATE_COPY_HELP' as Template,undefined).text;
  assert.doesNotMatch(text,/¿Has encontrado ese archivo\?|¿la has encontrado ya\?/,`pushy question at attempt ${attempts}`);
  assert.ok(text.length<=320,`too long for WhatsApp at attempt ${attempts}: ${text.length}`);
}

// Finding 1: an NIE client goes straight to the Ayuntamiento, is never asked for an FNMT code,
// and is never told about DNIe first.
const nieText=messageForCase(asRow(caseWith({currentState:ApodState.CERT_ACQUISITION_LINKS_SENT,hasDigitalCert:false,dni:'X1234567L'})),undefined,'CERT_ACQUISITION_LINKS_NIE' as Template,undefined).text;
assert.match(nieText,/[Aa]yuntamiento/);
assert.match(nieText,/cita/);
assert.doesNotMatch(nieText,/c[oó]digo (?:de )?solicitud|DNIe/,'NIE route must not mention an FNMT code or DNIe');
assert.doesNotMatch(nieText,/¿Has pedido ya cita/,'Clients almost never have an appointment yet');

// Finding 1 (regex guard): supplying a code is not "already done".
const codeReply=reviewedConversationReply(caseWith({currentState:ApodState.CERT_ACQUISITION_LINKS_SENT,hasDigitalCert:false}) as Parameters<typeof reviewedConversationReply>[0],'ya tengo el codigo de solicitud');
assert.equal(codeReply,null,'An application code must not trigger the completion question');

// Finding 2: thinking aloud and then answering is one turn.
assert.equal(relatedConversationText(['¿Cuál de las dos vías prefieres?'],'mm no sé'),true);
assert.equal(relatedConversationText(['mm no sé'],'yo creo que la primera'),true);
assert.equal(relatedConversationText(['tengo certificado'],'otra cosa, ¿cuándo cobro?'),false,'An explicit new subject still splits');

// Round 7 regression: a device answer must name the device, and a stop request must be honoured.
const deviceCase=caseWith({currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null});
const certOnly=await agent.turn(deviceCase as Parameters<typeof agent.turn>[0],'Sí, tengo certificado digital',[],true);
assert.equal(certOnly.type,EventType.CLIENT_HAS_CERT,'Saying you have a certificate is not a device answer');
// Once the certificate is confirmed, naming the computer routes to the PC branch.
const confirmedCase=caseWith({currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:true});
const onPc=await agent.turn(confirmedCase as Parameters<typeof agent.turn>[0],'Lo tengo en el ordenador',[],true);
assert.equal(onPc.type,EventType.CLIENT_HAS_CERT_PC,'Naming the computer must take the PC route');
const stop=await agent.turn(caseWith({currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null}) as Parameters<typeof agent.turn>[0],'no quiero seguir, dejad de escribirme',[],true);
assert.doesNotMatch(String((stop.payload as Record<string,unknown>).responseText??''),/contrase/i,'A stop request must not be answered with a password notice');
assert.match(String((stop.payload as Record<string,unknown>).responseText??''),/dejo de escribirte|retomarlo/i,'A stop request is acknowledged');

// Clients contradict themselves mid-message; the correction is what counts, not the first claim.
const waitingCert=caseWith({currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null});
const corrections:Array<[string,string]>=[
  ['si tengo certificado no espera no tengo','HAS_CERT_NO'],
  ['no tengo certificado perdon si tengo','HAS_CERT_YES'],
  ['no tengo','HAS_CERT_NO'],
  ['si tengo','HAS_CERT_YES'],
];
for(const [text,expected] of corrections){
  const result=classifyClientText(waitingCert as Parameters<typeof classifyClientText>[0],text);
  assert.equal(result.kind==='OPTION'&&result.optionId,expected,`self-correction: ${text} -> ${JSON.stringify(result)}`);
}
// "No tengo ordenador" is about the computer, never about the certificate.
const noPc=classifyClientText(caseWith({currentState:ApodState.MOBILE_TRIAGE_PC_CHECK,hasDigitalCert:true,certDevice:'MOBILE'}) as Parameters<typeof classifyClientText>[0],'no tengo ordenador');
assert.equal(noPc.kind==='OPTION'&&noPc.optionId,'NO_PC','"no tengo ordenador" must be the PC answer');
// Contradictory document declarations keep the affirmative one.
assert.equal(declaredDocumentType('tengo dni no tengo nie'),'DNI');
assert.equal(declaredDocumentType('tengo dni perdon tengo nie'),'NIE');

// Manager test 19 Sep: "ya lo tengo" was not recognised and the bot repeated one question forever.
const copyCase=caseWith({currentState:ApodState.PC_TUTORIAL_SENT,hasDigitalCert:true,certDevice:'MOBILE',certificateHelpAttempts:2});
const located=['ya lo tengo','que ya lo tenia localizado','y descargado en mi movil','vale estaba en mis documentos en el movil','lo encontre'];
for(const text of located){
  const event=await agent.turn(copyCase as Parameters<typeof agent.turn>[0],text,[],true);
  assert.equal(event.type,EventType.CLIENT_REQUESTS_ASSISTANCE,`located copy not recognised: ${text}`);
}
// The same question twice is the worst thing a client sees: the case must move on instead.
const pending='Seguimos con la copia de tu certificado para ayudarte con el apoderamiento. ¿Has podido localizarla en el dispositivo donde la instalaste?';
const repeated=await agent.turn(copyCase as Parameters<typeof agent.turn>[0],'que hago ahora',[{role:'assistant',content:pending}],true);
const repeatedText=String((repeated.payload as Record<string,unknown>).responseText??'');
assert.doesNotMatch(repeatedText,/Has podido localizarla/,'The bot repeated the pending question');
assert.match(repeatedText,/juzgado|empresa colaboradora/i,'A blocked client must be offered the alternatives');

console.log(JSON.stringify({status:'PASS',refusals:refusals.length,corrections:corrections.length,locatedCopy:located.length,findings:['NIE route','burst batching','device memory','pacing','fallback transition']}));
