/** Offline replay of the failing sequence: deterministic classifier + FSM, no provider. */
import '../src/config/load-env-file.js';
import {ApodState} from '@prisma/client';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {classifyClientText} from '../src/core/conversation-policy.js';
import {relatedConversationText} from '../src/core/conversation-batching.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';

const agent=new StrictConversationAgent(undefined,3);
type Case=Parameters<typeof evaluateNextStep>[0];
let c={id:'debug',version:0,currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null,dni:'12345678Z',nombre:'X',telefono:'0',digitalHelpAttempts:0,certificateHelpAttempts:0,isProvisionalFiled:false} as unknown as Case;

const turns=['Hola buenas','Sí, tengo certificado digital','Lo tengo en el ordenador'];
console.log('batching: turn2 with turn1 ->',relatedConversationText([turns[0]!],turns[1]!));
console.log('batching: turn3 with turn2 ->',relatedConversationText([turns[1]!],turns[2]!));
for(const text of turns){
  const local=classifyClientText(c as Parameters<typeof classifyClientText>[0],text);
  const event=await agent.turn(c as Parameters<typeof agent.turn>[0],text,[],true);
  const decision=evaluateNextStep(c,event as Parameters<typeof evaluateNextStep>[1]);
  c={...(c as object),...(decision.actionPayload as {expedientePatch?:object}).expedientePatch,currentState:decision.nextStep} as unknown as Case;
  console.log(JSON.stringify({text,local:local.kind==='OPTION'?local.optionId:local.reason,event:event.type,state:decision.nextStep,template:(decision.actionPayload as {template?:string}).template}));
}
