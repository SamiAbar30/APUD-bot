/**
 * The first live WhatsApp test (23 Sep, two real phones) found seven problems. The parts that are
 * plain functions are pinned here; the full flow (webhook, queue, delivery status) is verified live
 * with scripts/training/replay-live-findings.ts on the running stack.
 */
import assert from 'node:assert/strict';
import { ApodState, PrismaClient } from '@prisma/client';
import { normalizeWebhook } from '../src/adapters/whatsapp/webhook-router.js';
import { evaluateNextStep } from '../src/core/decision-engine.js';
import { allowedConversationOptions } from '../src/core/conversation-policy.js';
import { EventType } from '../src/domain/fsm/states.js';

const envelope = (message: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '999' },
  messages: [{ from: '34600000999', id: 'wamid.1', timestamp: '1790000000', ...message }] } }] }] });

// 1. A tapped button keeps its title, so it can be saved as the client's answer.
const tap = normalizeWebhook(envelope({ type: 'interactive', context: { id: 'wamid.q' }, interactive: { type: 'button_reply', button_reply: { id: 'NO_PC', title: 'No tengo ordenador' } } }), '999').messages[0]!;
assert.equal(tap.buttonId, 'NO_PC');
assert.equal(tap.buttonTitle, 'No tengo ordenador');
assert.equal(tap.contextId, 'wamid.q');

const db = new PrismaClient();
const base = await db.botApodExpediente.findFirstOrThrow({ where: { identityVerified: true } });
await db.$disconnect();
const onPhone = { ...base, currentState: ApodState.MOBILE_TRIAGE_PC_CHECK, hasDigitalCert: true, certDevice: 'MOBILE', version: 3, automationPaused: false, optOutAt: null } as never;

// 2. "No computer" with the certificate on the phone goes to the office route (protocol 2.2),
//    not back to "do you have a computer?".
const noPc = evaluateNextStep(onPhone, { type: EventType.CLIENT_HAS_NO_PC, payload: { conversationOption: 'NO_PC', conversationConfidence: 'EXACT' } } as never);
assert.equal(noPc.nextStep, 'MOBILE_ASSIST_CONSENT_REQUESTED');
assert.equal((noPc.actionPayload as { template?: string }).template, 'ASSIST_CONSENT_REQUEST');

// 4. "Ya lo tengo en el ordenador" is reachable from the phone steps and sends the PC guide.
assert.ok(allowedConversationOptions({ currentState: 'MOBILE_TRIAGE_PC_CHECK', hasDigitalCert: true } as never).includes('DEVICE_PC'));
assert.ok(allowedConversationOptions({ currentState: 'MOBILE_ASSIST_CONSENT_REQUESTED', hasDigitalCert: true } as never).includes('DEVICE_PC'));
const onPc = evaluateNextStep(onPhone, { type: EventType.CLIENT_HAS_CERT_PC, payload: { conversationOption: 'DEVICE_PC', conversationConfidence: 'NORMALIZED' } } as never);
assert.equal(onPc.nextStep, 'PC_TUTORIAL_SENT');

console.log(JSON.stringify({ result: 'PASS', suite: 'live-findings-23sep', checked: ['button title kept', 'no PC → office route', 'PC guide reachable from phone steps'] }));
