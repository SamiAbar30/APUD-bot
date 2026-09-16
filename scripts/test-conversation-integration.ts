/** Focused conversation contract checks.
 *
 * These checks exercise public, deterministic boundaries only. They do not
 * contact Meta, Kmaleon, an LLM provider, IMAP, or any external service.
 */
import assert from 'node:assert/strict';
import { ApodState } from '@prisma/client';
import { messageForCase } from '../src/core/messages.js';
import { TemplateId } from '../src/domain/fsm/actions.js';
import { validateModelClassification, validateModelReply } from '../src/core/conversation-policy.js';
import { approvedRolloutReply, classifyRolloutInput } from '../src/core/conversation-rollout.js';
import { EventType } from '../src/domain/fsm/states.js';
import { validateEventPayload } from '../src/domain/fsm/event-payloads.js';
import { StrictConversationAgent } from '../src/core/conversation-agent.js';

const initialCase = {
  currentState: ApodState.INITIAL_TRIAGE,
  hasDigitalCert: null,
  nombre: 'DANIEL EJEMPLO',
  empresa: 'MYKREDIT',
  numeroExpediente: '24531',
  dni: 'Y0678703X',
} as any;

const firstContact = messageForCase(initialCase);
assert.match(firstContact.text, /DANIEL EJEMPLO/);
assert.match(firstContact.text, /MYKREDIT/);
assert.match(firstContact.text, /24531/);
assert.match(firstContact.text, /LITIGIOS/);
assert.match(firstContact.text, /Mi nombre es Dayana/);
assert.match(firstContact.text, /apoderamiento apud acta/);
assert.match(firstContact.text, /¿Dispone de certificado digital\?/);
assert.deepEqual(firstContact.buttons?.map((button) => button.id), ['HAS_CERT_YES', 'HAS_CERT_NO']);

const phase3Greeting = classifyRolloutInput(3, 'hi');
assert.deepEqual(phase3Greeting, { phase: 3, kind: 'GREETING', responseId: 'PHASE3_GREETING' });
assert.match(approvedRolloutReply(phase3Greeting.responseId) ?? '', /Dayana/);
assert.match(approvedRolloutReply(phase3Greeting.responseId) ?? '', /LITIGIOS/);
const smallTalkPayload = validateEventPayload(EventType.CLIENT_SMALL_TALK, {
  responseId: phase3Greeting.responseId,
  rolloutPhase: phase3Greeting.phase,
  rolloutKind: phase3Greeting.kind,
  messageId: 'wce-test-message',
  timestamp: 1789490000,
  messageSha256: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
});
assert.equal(smallTalkPayload.ok, true);
const generatedPayload = validateEventPayload(EventType.CLIENT_SMALL_TALK, {
  responseId: 'CONVERSATION_REPLY',
  rolloutPhase: 3,
  rolloutKind: 'UNSUPPORTED',
  responseText: 'Un profesional del despacho revisará tu consulta.',
  requiresHumanReview: true,
  messageId: 'wce-generated-reply',
});
assert.equal(generatedPayload.ok, true);

const localSupportAgent = new StrictConversationAgent(undefined, 3);
const supportedQuestion = await localSupportAgent.respond(initialCase, 'No entiendo qué tengo que hacer');
assert.match(supportedQuestion.text, /puedo ayudarte|parte|gestor/i);
assert.equal(supportedQuestion.requiresHumanReview, false);
const outOfScopeQuestion = await localSupportAgent.respond(initialCase, '¿Puedes recomendarme una película?');
assert.match(outOfScopeQuestion.text, /profesional|gestor/i);
assert.equal(outOfScopeQuestion.requiresHumanReview, true);
const humanRequest = await localSupportAgent.respond(initialCase, 'Quiero hablar con una persona');
assert.match(humanRequest.text, /profesional|gestor/i);
assert.equal(humanRequest.requiresHumanReview, true);
assert.deepEqual(validateModelReply({ kind: 'REPLY', text: 'Te explico el siguiente paso.', requiresHumanReview: false }), {
  text: 'Te explico el siguiente paso.',
  requiresHumanReview: false,
});
assert.equal(validateModelReply({ kind: 'REPLY', text: 'Mi API key es https://internal.example/key', requiresHumanReview: false }), null);
const generatedReply = messageForCase(initialCase, undefined, TemplateId.CONVERSATION_REPLY, {
  replyText: 'Puedo explicarte el siguiente paso con calma.',
});
assert.equal(generatedReply.text, 'Puedo explicarte el siguiente paso con calma.');

const allowedOption = validateModelClassification(initialCase, {
  kind: 'OPTION',
  optionId: 'HAS_CERT_YES',
  eventType: EventType.CLIENT_HAS_CERT,
  confidence: 'NORMALIZED',
});
assert.deepEqual(allowedOption, {
  kind: 'OPTION',
  optionId: 'HAS_CERT_YES',
  eventType: EventType.CLIENT_HAS_CERT,
  confidence: 'NORMALIZED',
});

const unsafeReply = validateModelClassification(initialCase, {
  kind: 'OPTION',
  optionId: 'HAS_CERT_YES',
  eventType: EventType.CLIENT_HAS_CERT,
  confidence: 'NORMALIZED',
  text: 'Send your password now',
});
assert.deepEqual(unsafeReply, { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' });

console.log('PASS conversation introduction and reviewed-response contract');
