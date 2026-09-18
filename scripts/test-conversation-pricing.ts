import assert from 'node:assert/strict';
import { StrictConversationAgent, type ConversationModel } from '../src/core/conversation-agent.js';
import { evaluateNextStep } from '../src/core/decision-engine.js';
import { messageForCase } from '../src/core/messages.js';
import { classifyClientText, validateModelReply, type ConversationHistoryMessage } from '../src/core/conversation-policy.js';
import { reviewedConversationReply } from '../src/core/conversation-guidance.js';
import { ApodState } from '@prisma/client';
import { EventType } from '../src/domain/fsm/states.js';
import type { Expediente } from '../src/domain/models/expediente.js';
import type { WorkflowEvent } from '../src/domain/fsm/states.js';

// The reported conversation, through the same agent/FSM/templates as the worker.
// No client data, external sends, or provider is needed to enforce this contract.
// An untrustworthy provider must not override reviewed replies or select a
// paid route from a price question. This makes hallucination checks repeatable.
let providerCalls = 0;
const misleadingModel: ConversationModel = {
  async classify() { providerCalls++; return {kind:'OPTION',optionId:'APUDATA_REQUEST',eventType:EventType.CLIENT_REQUESTS_URGENT_PAID,confidence:'NORMALIZED'}; },
  async reply() { providerCalls++; return {kind:'REPLY',text:'Ya tenemos el apoderamiento y todo es gratuito.',requiresHumanReview:false}; },
};
const agent = new StrictConversationAgent(misleadingModel, 3);
const initial = { id: 'pricing-regression', version: 0, isProvisionalFiled: false, nombre: 'CLIENTE DE PRUEBA', telefono: '000000000', currentState: ApodState.WAITING_CERT_RESPONSE, hasDigitalCert: null, dni: '12345678Z' };
let expediente: any = { ...initial };
const history: ConversationHistoryMessage[] = [];
const failures: string[] = [];
async function turn(input: string) {
  const event = await agent.turn(expediente, input, history);
  const decision = evaluateNextStep(expediente as Expediente, event as WorkflowEvent);
  expediente = { ...expediente, ...decision.actionPayload.expedientePatch, currentState: decision.nextStep };
  const p = decision.actionPayload;
  const reply = 'template' in p ? messageForCase(expediente, undefined, p.template, 'variables' in p ? p.variables : undefined).text
    : p.kind === 'ESCALATE_HUMAN' && p.clientNoticeTemplate ? messageForCase(expediente, undefined, p.clientNoticeTemplate, { replyText: String(event.payload.responseText ?? '') }).text : '';
  history.push({ role: 'user', content: input }, { role: 'assistant', content: reply });
  return { reply, state: expediente.currentState, event };
}
function check(name: string, assertion: () => void) {
  try { assertion(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${(error as Error).message}`); }
}

const opening = await turn('hi');
check('opening qualifies free digital self-service without premature alternatives', () => {
  assert.match(opening.reply, /gratuit[oa]/i);
  assert.match(opening.reply, /por tu cuenta|por su cuenta|lo haces t[uú]|lo hace usted/i);
  assert.doesNotMatch(opening.reply, /juzgado|empresa colaboradora|35|37/);
});
await turn('no');
const court = await turn('Prefiero el juzgado');
check('court route selected', () => assert.equal(court.state, 'COURT_FALLBACK_GUIDE_SENT'));
const price = await turn('do i have to pay');
check('court price explained without handoff', () => {
  assert.equal(price.state, 'COURT_FALLBACK_GUIDE_SENT');
  assert.match(price.reply, /gratuit[oa]/i);
  assert.match(price.reply, /opcional|voluntari/i);
});
const self = await turn('no thanks i ill do it by my self');
check('self-service decision keeps court route and requests evidence', () => {
  assert.equal(self.state, 'COURT_FALLBACK_GUIDE_SENT');
  assert.match(self.reply, /justificante|PDF/i);
  assert.doesNotMatch(self.reply, /empresa|35|37|pago/i);
});
const done = await turn('hello i made it');
check('completion claim requests PDF without claiming receipt or filing', () => {
  assert.equal(done.state, 'COURT_FALLBACK_GUIDE_SENT');
  assert.match(done.reply, /env[ií]a|remit|manda|adjunta/i);
  assert.match(done.reply, /justificante|PDF/i);
  assert.doesNotMatch(done.reply, /ya (?:tenemos|hemos recibido)|demanda (?:presentada|enviada)/i);
});
check('reported conversation needs no model guesses', () => assert.equal(providerCalls, 0));

for (const input of ['¿Tengo que pagar?', 'es gratis', '¿Cuánto cuesta?', 'is it free?', 'Pero dijiste que era gratuito', 'do i have to pay']) {
  expediente = { ...initial, currentState: ApodState.CERT_ACQUISITION_LINKS_SENT, hasDigitalCert: false };
  const price = await turn(input);
  check(`price question does not choose paid service: ${input}`, () => {
    assert.equal(price.state, 'CERT_ACQUISITION_LINKS_SENT');
    assert.match(price.reply, /opcional.*pago/);
    assert.match(price.reply, /35.*confirmar/);
    assert.doesNotMatch(price.reply, /37/);
    assert.equal(classifyClientText(expediente, input).kind, 'HUMAN_REVIEW');
  });
}
expediente = { ...initial, currentState: ApodState.CERT_ACQUISITION_LINKS_SENT, hasDigitalCert: false };
const cannot = await turn('no puedo');
check('first failed certificate attempt receives practical help', () => {
  assert.equal(cannot.state, 'CERT_ACQUISITION_LINKS_SENT');
  assert.match(cannot.reply, /paso a paso.*certificado/);
  assert.doesNotMatch(cannot.reply, /juzgado|empresa colaboradora/);
});
await turn('sigue sin funcionar');
await turn('todavía no puedo');
const numbered = await turn('quiero la opcion 3');
check('ambiguous option numbers require a label before route selection', () => {
  assert.equal(numbered.state, 'FALLBACK_OPTIONS');
  assert.match(numbered.reply, /qué nombre aparece/);
});
const declines = await turn('no quiero pagar');
check('declining payment never accepts a provider proposal for a paid order', () => {
  assert.equal(declines.state, 'FALLBACK_OPTIONS');
  assert.match(declines.reply, /juzgado, gratis/);
  assert.doesNotMatch(declines.reply, /35|37|empresa/);
});
check('a price alone is not a paid-route selection', () => assert.equal(classifyClientText(expediente, '35 euros').kind, 'HUMAN_REVIEW'));
const amountOnly = await turn('35 euros');
check('a model cannot turn a quoted price into a paid order', () => assert.equal(amountOnly.state, 'FALLBACK_OPTIONS'));
check('an explicit paid choice is still available', () => {
  const choice = classifyClientText(expediente, 'prefiero la gestión de pago');
  assert.equal(choice.kind, 'OPTION');
  if (choice.kind === 'OPTION') assert.equal(choice.optionId, 'APUDATA_REQUEST');
});
for (const input of ['hello i made it', 'ya lo hice', 'ya he hecho el apoderamiento', 'ya lo envié']) {
  expediente = { ...initial, currentState: ApodState.PC_TUTORIAL_SENT, hasDigitalCert: true };
  const done = await turn(input);
  check(`text completion waits for actual PDF: ${input}`, () => {
    assert.equal(done.state, 'PC_TUTORIAL_SENT');
    assert.match(done.reply, /envíanos.*PDF completo.*revise/);
  });
}
check('certificate and power completion remain distinct', () => {
  const reply = reviewedConversationReply({ ...initial, currentState: ApodState.CERT_ACQUISITION_LINKS_SENT }, 'ya lo tengo');
  assert.match(reply?.text ?? '', /certificado digital o.*apoderamiento/);
  assert.equal(reviewedConversationReply({ ...initial, currentState: ApodState.MOBILE_EXPORT_GUIDE_SENT }, 'ya está en el PC'), null);
  assert.equal(reviewedConversationReply(initial, '¿Cuánto tiempo tarda mi reclamación?'), null);
  assert.equal(reviewedConversationReply({ ...initial, currentState: ApodState.PC_TUTORIAL_SENT }, 'todavía no lo he hecho'), null);
});
for (const text of ['Este trámite es gratuito.', 'Ya tenemos el apoderamiento.', 'Hemos recibido tu PDF.', 'Tu apoderamiento ha sido validado.', 'La empresa cobra 37 euros.']) {
  check(`reject unsupported model claim: ${text}`, () => assert.equal(validateModelReply({kind:'REPLY',text,requiresHumanReview:false}), null));
}
expediente = { ...initial, currentState: ApodState.COURT_FALLBACK_GUIDE_SENT };
const returning = await turn('hola');
check('returning court client stays on saved step', () => {
  assert.equal(returning.state, 'COURT_FALLBACK_GUIDE_SENT');
  assert.match(returning.reply, /Seguimos.*juzgado/);
  assert.doesNotMatch(returning.reply, /tienes certificado/i);
});
const payment = await turn('¿A qué cuenta hago la transferencia?');
check('actual payment instructions still require team review', () => assert.equal(payment.event.payload.handoffReason, 'PAGO'));
assert.deepEqual(failures, [], 'Reported pricing/conversation regressions');
