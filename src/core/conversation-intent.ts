/**
 * What the client is actually trying to do, read from the whole conversation.
 *
 * The deterministic branches recognise wording; this layer recognises meaning. A client who
 * writes "not now", "luego lo hago" or "mañana si eso" is doing one thing, and a bot that only
 * matches the phrasings somebody thought of ends up restating the pending step, which reads as
 * if every message started a new conversation. The model reads the context and returns one of
 * these labels; the office keeps deciding what is said, so understanding widens without the
 * model gaining the ability to invent a fact, a price or a step.
 */
import type { CaseContext } from './conversation-guidance.js';
import { officialLinks } from './guides.js';

export const CONVERSATION_INTENTS = [
  'DEFER_LATER',            // "not now", "luego", "mañana lo hago"
  'READY_TO_SEND',          // has the copy and is about to send it, or asks whether to send it
  'ASKS_WHERE_TO_SEND',     // "¿dónde te la mando?"
  'ASKS_WHICH_APP',         // "¿qué app?", "¿dónde lo busco?"
  'WANTS_OFFICE_TO_DO_IT',  // "hazlo tú", "do it for me"
  'REFUSES_TO_SEND',        // will not hand over the certificate
  'STUCK',                  // an error, a step that will not work
  'CONFUSED',               // does not understand what is being asked
  'ACK_ONLY',               // "vale", "ok", nothing else
  'ALREADY_DID_IT',         // says the step is already done
  'CLAIM_TOPIC',            // asks about the claim, money, ASNEF, a lender
  'PERSONAL_SITUATION',     // illness, bereavement, work, family
  'ASKS_FOR_CALL',          // wants to be phoned
  'DOUBTS_IDENTITY',        // suspects a scam, asks who we are
  'OTHER',                  // understood, but none of the above
] as const;

export type ConversationIntent = typeof CONVERSATION_INTENTS[number];

export const CONVERSATION_INTENT_GUIDE: Record<ConversationIntent, string> = {
  DEFER_LATER: 'the client is postponing: not now, later, tomorrow, when they get home',
  READY_TO_SEND: 'the client has the certificate copy, is sending it, or asks whether to send it now',
  ASKS_WHERE_TO_SEND: 'the client asks where or how to send the certificate or its password',
  ASKS_WHICH_APP: 'the client asks which app, where to look, what the file is called',
  WANTS_OFFICE_TO_DO_IT: 'the client asks the office to do the procedure for them',
  REFUSES_TO_SEND: 'the client does not want to hand over the certificate or the password',
  STUCK: 'a step fails: an error, a button missing, the web or the app not working',
  CONFUSED: 'the client says they do not understand or do not know what to do',
  ACK_ONLY: 'the client only acknowledges: vale, ok, gracias, entendido, nothing else',
  ALREADY_DID_IT: 'the client says they already did or already sent what was asked',
  CLAIM_TOPIC: 'the message is about the claim itself: money, dates, ASNEF, a lender, an invoice',
  PERSONAL_SITUATION: 'the client talks about illness, a death, work or family',
  ASKS_FOR_CALL: 'the client asks to be phoned or to speak to a person',
  DOUBTS_IDENTITY: 'the client suspects a scam or asks who is writing',
  OTHER: 'understood but none of the above',
};

export type IntentReply = { text: string; requiresHumanReview: boolean; handoffReason?: string };

const OFFICE_EMAIL = 'reclamaciones@litigios.es';

/**
 * The approved answer for an understood intent. Returning null means the intent carries no
 * standing answer and the workflow keeps the turn.
 */
export function replyForIntent(intent: ConversationIntent, c: CaseContext): IntentReply | null {
  const hasCert = c.hasDigitalCert === true;
  switch (intent) {
    case 'DEFER_LATER':
      return { text: 'Perfecto, sin prisa. Lo dejo apuntado y seguimos por aquí cuando puedas.', requiresHumanReview: false };
    case 'READY_TO_SEND':
      return { text: 'Sí, mándamelo ahora por aquí y la contraseña en otro mensaje. Con eso me encargo yo del apoderamiento.', requiresHumanReview: false };
    case 'ASKS_WHERE_TO_SEND':
      return { text: 'Aquí mismo, por este chat. Mándame el archivo del certificado y, en un mensaje aparte, su contraseña.', requiresHumanReview: false };
    case 'ASKS_WHICH_APP':
      return { text: 'Es la aplicación donde instalaste el certificado; ábrela y busca «copia de seguridad» o «exportar». Si no la encuentras, dime qué ves y lo miramos.', requiresHumanReview: false };
    case 'WANTS_OFFICE_TO_DO_IT':
      return hasCert
        ? { text: 'Claro, te lo hacemos nosotros. Mándame por aquí el archivo de tu certificado y, en otro mensaje, su contraseña.', requiresHumanReview: false }
        : { text: 'Claro, te lo hacemos nosotros en cuanto tengas el certificado. Si prefieres no sacarlo, lo gestiona la empresa colaboradora por 35 €.', requiresHumanReview: false };
    case 'REFUSES_TO_SEND':
      return { text: 'Sin problema, no hace falta. Puedes firmarlo gratis en el juzgado pidiendo cita en el decanato, o lo tramita por ti la empresa colaboradora por 35 €.', requiresHumanReview: false };
    case 'STUCK':
      return { text: 'Entiendo, ahí se ha atascado. No te pelees más: mándame el archivo de tu certificado y, en otro mensaje, su contraseña, y lo termino yo por ti.', requiresHumanReview: false };
    case 'CONFUSED':
      return hasCert
        ? { text: `Te lo simplifico: con tu certificado se firma el apoderamiento en la Sede Judicial (${officialLinks.sede}). Si lo prefieres, me mandas el archivo con su contraseña y lo hago yo.`, requiresHumanReview: false }
        : { text: 'Te lo simplifico: primero el certificado digital de la FNMT, con DNI electrónico o vídeo identificación, y después se firma el apoderamiento. Si lo prefieres, lo firmas gratis en el juzgado.', requiresHumanReview: false };
    case 'ALREADY_DID_IT':
      return { text: 'Perfecto, si ya está hecho no lo repitas. Lo compruebo con el despacho y te confirmamos por aquí.', requiresHumanReview: true, handoffReason: 'FALTA_DATO' };
    case 'CLAIM_TOPIC':
      return { text: `Eso lo lleva el equipo de reclamaciones, que tiene tu expediente delante. Escríbeles a ${OFFICE_EMAIL} y te lo explican.`, requiresHumanReview: false };
    case 'PERSONAL_SITUATION':
      return { text: 'Siento lo que me cuentas, y gracias por contármelo. Esto no corre ninguna prisa: cuando estés, seguimos.', requiresHumanReview: true, handoffReason: 'HUMANO' };
    case 'ASKS_FOR_CALL':
      return { text: 'Claro, se lo paso a una persona del despacho para que te llame y lo veáis por teléfono.', requiresHumanReview: true, handoffReason: 'HUMANO' };
    case 'DOUBTS_IDENTITY':
      return { text: 'Te escribimos desde el despacho que lleva tu reclamación y nunca te pediremos dinero ni datos bancarios por aquí. Si quieres, llama al número de la oficina que ya tengas y te lo confirman.', requiresHumanReview: true, handoffReason: 'HUMANO' };
    case 'ACK_ONLY':
    case 'OTHER':
      return null;
  }
}
