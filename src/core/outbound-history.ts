import {officialLinks} from './guides.js';
import {redactConversationPii} from './conversation-policy.js';

/**
 * Stored history for messages the bot itself sent.
 *
 * Client data is redacted exactly as everywhere else, but the reviewed official links are kept:
 * they are public, they were approved, and replacing them with `[ENLACE]` hides from the model
 * (and from any reviewer reading the case) which link the client was actually given.
 */
/** The office's own published address is not client data; keeping it makes history readable. */
const OFFICE_EMAIL = 'reclamaciones@litigios.es';

export function redactOutboundHistory(text: string): string {
  const approved = [...Object.values(officialLinks), OFFICE_EMAIL];
  let masked = text;
  approved.forEach((url, index) => {masked = masked.split(url).join(`_APPROVEDLINK${index}_`);});
  let redacted = redactConversationPii(masked);
  approved.forEach((url, index) => {redacted = redacted.split(`_APPROVEDLINK${index}_`).join(url);});
  return redacted;
}
