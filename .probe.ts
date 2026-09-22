import './src/config/load-env-file.js';
import {classifyClientText, allowedConversationOptions} from './src/core/conversation-policy.js';
import {guidanceRequest} from './src/core/conversation-guidance.js';

const c = {
  currentState: 'MOBILE_TRIAGE_PC_CHECK', hasDigitalCert: true, certDevice: 'MOBILE',
  dni: '12345678Z', stepReached: 'TRIAGE_MOVIL', digitalHelpAttempts: 0, certificateHelpAttempts: 0,
  consentGranted: false, documentApproved: false, priorConversation: true, pendingQuestion: null,
  lastInboundAt: null, automationPaused: false, optOutAt: null, version: 1,
} as never;

for (const text of ['No tengo ordenador', 'no tengo ordenador', 'No tengo pc']) {
  console.log(JSON.stringify({
    text,
    allowed: allowedConversationOptions(c),
    local: classifyClientText(c, text),
    guidance: guidanceRequest(c, text)?.type ?? null,
  }));
}
