import assert from 'node:assert/strict';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';
import {messageForCase} from '../src/core/messages.js';
import type {ConversationHistoryMessage} from '../src/core/conversation-policy.js';

const agent=new StrictConversationAgent(undefined,3);
let c:any={id:'continuity-test',version:0,currentState:'CERT_ACQUISITION_LINKS_SENT',hasDigitalCert:false,dni:'X0000000T',nombre:'SYNTHETIC',telefono:'00000',digitalHelpAttempts:0,certificateHelpAttempts:0,isProvisionalFiled:false};
const history:ConversationHistoryMessage[]=[];
async function reply(text:string){
  const event=await agent.turn(c,text,history,true);
  const decision=evaluateNextStep(c,event as any);
  c={...c,...decision.actionPayload.expedientePatch,currentState:decision.nextStep,version:c.version+1};
  const p=decision.actionPayload as any;
  assert.ok(p.template,'Expected a useful reply');
  const message=messageForCase(c,undefined,p.template,p.variables);
  history.push({role:'user',content:text},{role:'assistant',content:message.text});
  return message.text;
}
const first=await reply('tengo NIE, ayuda porfavor');
const second=await reply('i wanna finish thi whole process what to do');
assert.notEqual(second,first,'A separate follow-up must not repeat the identical NIE paragraph');
assert.doesNotMatch(second,/Entendido, tienes NIE/,'Do not re-acknowledge an established fact');
assert.equal(c.automationPaused,undefined);
console.log('PASS repeated help follows the pending question instead of repeating the NIE paragraph');
