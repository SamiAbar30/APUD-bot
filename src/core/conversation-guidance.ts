import type { BotApodExpediente } from '@prisma/client';
import type { ConversationReply } from './conversation-policy.js';
import { officialLinks } from './guides.js';
import { EventType } from '../domain/fsm/states.js';

export const SELF_SERVICE_COST = 'El apoderamiento es gratuito si lo haces por tu cuenta en la Sede Judicial o en el juzgado.';
export const PARTNER_COST = 'La gestión con la empresa colaboradora es opcional y de pago: la referencia del despacho es 35 €, pendiente de confirmar antes de contratar.';
export const REQUEST_POWER_PDF = 'Perfecto, envíanos el justificante PDF completo del apoderamiento, con todas sus páginas, para que el equipo lo revise.';

export type CaseContext = Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'> & {digitalHelpAttempts?:number;certificateHelpAttempts?:number};
const powerSteps = new Set(['PC_TUTORIAL_SENT', 'WAITING_PDF_SUBMISSION', 'COURT_FALLBACK_GUIDE_SENT', 'WAITING_REVOCATION_REISSUE']);
const intakeSteps = new Set(['INITIAL_TRIAGE', 'WAITING_CERT_RESPONSE', 'CERT_ACQUISITION_LINKS_SENT', 'FALLBACK_OPTIONS']);
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();

/** Short acknowledgments yield the floor; a mixed message containing a question doesn't. */
export function conversationYield(text:string):ConversationReply|null {
  const lines=text.trim().split(/\n+/);const last=normalize(lines.at(-1)??'');
  // A final deferral withdraws an earlier help request in the same burst.
  const n=lines.length>1&&/luego|despues|mas tarde|manana|later|no tengo tiempo|dont have time|do not have time|busy|ocupad|trabajando/.test(last)?last:normalize(text);
  if(/[?¿]|\b(?:ayuda|help|como|how|what|explicame|guiame|pagar|juzgado|court)\b|(?:quiero|necesito).*(?:terminar|acabar|finalizar)/.test(n))return null;
  if(/^(?:(?:vale|ok|okay|perfecto|de acuerdo|gracias|thanks|thank you)[,!. ]*)+$/.test(n))return {text:'De acuerdo, aquí estoy cuando me necesites.',requiresHumanReview:false};
  if(/\b(?:ahora no puedo|no tengo tiempo|estoy (?:ocupado|ocupada|trabajando)|lo (?:hare|hago) (?:luego|despues|mas tarde|manana)|(?:i will|ill) do it later|i dont have time|i do not have time|im busy|no lo puedo hacer hasta manana)\b/.test(n))return {text:'Claro, seguimos cuando puedas.',requiresHumanReview:false};
  return null;
}

/** This changes guidance only, never the verified legal identity on the case. */
export function declaredDocumentType(text:string):'NIE'|'DNI'|undefined {
  const n=normalize(text);
  const matches=[...n.matchAll(/\b(?:tengo|mi documento es|i have)(?: (?:un|el|a))? (nie|dni)\b/g)];
  const affirmative=matches.filter(match=>!/\b(?:no|not|dont|do not)\s*$/.test(n.slice(0,match.index)));
  const last=affirmative.at(-1);
  if(!last)return undefined;
  return last[1]!.toUpperCase() as 'NIE'|'DNI';
}

export const DIGITAL_GUIDANCE_STATES = new Set(['INITIAL_TRIAGE','WAITING_CERT_RESPONSE','CERT_ACQUISITION_LINKS_SENT','PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION','MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT']);

/** A client's difficulty asks for guidance, never implicitly chooses a fallback. */
export function guidanceRequest(c:CaseContext,text:string):{type:EventType;payload:Record<string,unknown>}|null {
  if(!DIGITAL_GUIDANCE_STATES.has(c.currentState)&&!['COURT_FALLBACK_GUIDE_SENT','FALLBACK_OPTIONS'].includes(c.currentState))return null;
  const n=normalize(text);
  if(/(?:quiero|prefiero|voy a|i prefer|i want).*(?:juzgado|court|empresa|company)|\b(?:precio|pagar|cost|price|pay)\b/.test(n))return null;
  const failed=/no puedo|no me deja|no funciona|no consigo|he intentado|lo he intentado|sigue sin|todavia no|still (?:cant|cannot|doesnt)|i (?:cant|cannot)|doesnt work|i (?:have )?tried/.test(n)&&!/\b(?:si no puedo|if i cant|if i cannot)\b/.test(n);
  const wantsDigital=/(?:quiero|prefiero).*(?:hacerlo|hacer el apoderamiento).*(?:certificado|online|digital)|i (?:want|wanna|waana).*(?:make|do) it.*(?:certificado|sertificado|certificate|digital|degital)/.test(n);
  const wantsToFinish=/(?:quiero|necesito).*(?:terminar|acabar|finalizar|salir de esto)|i (?:want|wanna|need).*(?:finish|complete)|what (?:to do|do i do)|que (?:tengo que|debo) hacer/.test(n);
  const help=wantsDigital||wantsToFinish||failed||declaredDocumentType(text)!==undefined||/ayuda|ayudas|ayudame|no entiendo|como (?:lo )?(?:hago|hacer|obtener|conseguir|descargar)|explicame|guiame|paso a paso|\bhelp\b|show me how|how (?:do i|to) (?:make|do|get)|guide me/.test(n);
  if(!help)return null;
  if(['COURT_FALLBACK_GUIDE_SENT','FALLBACK_OPTIONS'].includes(c.currentState)){
    if(c.hasDigitalCert===false)return {type:EventType.CLIENT_HAS_NO_CERT,payload:{}};
    if(c.hasDigitalCert===true)return {type:EventType.CLIENT_REQUESTS_ASSISTANCE,payload:{resumeDigital:true}};
  }
  if(['INITIAL_TRIAGE','WAITING_CERT_RESPONSE'].includes(c.currentState)&&c.hasDigitalCert!==true&&!/\b(?:dni|nie)\b/.test(n)&&/no (?:lo )?tengo|dont have|do not have/.test(n))return {type:EventType.CLIENT_HAS_NO_CERT,payload:{}};
  const helpTopic=/autofirma|firmar|firma|sign/.test(n)?'AUTOFIRMA':/descargar.*(?:pdf|justificante)|download.*pdf/.test(n)?'DOWNLOAD':'';
  return {type:failed?EventType.CLIENT_EXPORT_FAILED:EventType.CLIENT_REQUESTS_ASSISTANCE,payload:{helpTopic}};
}

/** Questions explain a route; they never select it or authorize a payment. */
export function isConversationQuestion(text: string): boolean {
  return /[?¿]/.test(text) || /^(?:hola[, ]+|hello[, ]+|hi[, ]+)?(?:cuanto|cuesta|tengo que pagar|hay que pagar|es gratis|es gratuito|que es|que significa|como |donde |por que |para que |do i |does |is it |how |what |why |where |can i |tengo una duda)/.test(normalize(text));
}

/** Reviewed explanations, before either model call. These cannot change state. */
export function reviewedConversationReply(c: CaseContext, text: string): ConversationReply | null {
  const n = normalize(text);
  const reply = (text: string): ConversationReply => ({ text, requiresHumanReview: false });
  const court = c.currentState === 'COURT_FALLBACK_GUIDE_SENT';
  const declinesPayment = /\b(?:no (?:quiero|voy a|pienso|puedo) pagar|no quiero (?:la gestion|el servicio|una empresa)|dont want to pay|do not want to pay|wont pay|cannot pay|cant pay)\b/.test(n);
  if (declinesPayment && (powerSteps.has(c.currentState) || intakeSteps.has(c.currentState))) {
    if (powerSteps.has(c.currentState)) return reply(`De acuerdo, seguimos con ${court ? 'la vía gratuita del juzgado' : 'el apoderamiento por tu cuenta'}. Cuando termines, envíanos el justificante PDF completo para revisarlo.`);
    return reply(c.currentState==='FALLBACK_OPTIONS'?'Puedes hacer el apoderamiento por tu cuenta en el juzgado, gratis y sin certificado digital. ¿Prefieres que te indique cómo hacerlo allí?':'De acuerdo, te ayudaré a hacerlo por tu cuenta en la Sede Judicial. ¿En qué paso te has quedado?');
  }
  const priceQuestion = /^\d+(?:[.,]\d+)?\s*(?:€|euros?)[?!. ]*$/.test(n)
    || /\b(?:gratuit[oa]|gratis|coste|costo|precio|cuesta|cuanto vale|free|cost|price|pay|pagar|pago|cobrais|cobrar)\b/.test(n)
      && (isConversationQuestion(text) || /\b(?:pero|dijiste|dijeron|said|told|obligatorio|mandatory)\b/.test(n));
  if (priceQuestion) {
    if (/\b(?:fnmt|certificado|certificate)\b/.test(n) && !/apud|apoderamiento/.test(n)) {
      return reply(`Obtener el certificado y otorgar el apoderamiento son pasos distintos: la vídeo identificación de la FNMT tiene un coste propio, que puedes consultar en ${officialLinks.fnmtVideo}. ${SELF_SERVICE_COST} ${PARTNER_COST}`);
    }
    return reply(court
      ? `Si lo haces tú en el juzgado, el apoderamiento es gratuito. ${PARTNER_COST} Puedes seguir con el juzgado sin contratar esa gestión.`
      : `Dime: ¿tienes certificado digital a tu nombre? El apud acta es gratis por tu cuenta en la Sede Judicial o, sin certificado, en el juzgado. ${PARTNER_COST}`);
  }
  // A numbered option from an old export/app is not a current route selection.
  if (/\b(?:opcion|option)\s*\d\b/.test(n)) {
    return reply('Para no confundir las opciones de la aplicación con las del despacho, ¿qué nombre aparece junto a esa opción?');
  }
  const completed = /\b(?:ya (?:lo )?(?:hice|he hecho|tengo|termine|esta hecho|esta listo)|ya (?:he )?(?:enviado|mandado)|lo (?:he )?(?:hecho|termine|envie|mande)|i (?:have )?(?:made|did|finished|sent|done) it|ive (?:done|sent|finished) it|done)\b/.test(n);
  const negated = /\b(?:no|not|havent|didnt|todavia|aun|cuando|cuando pueda|when|if)\b/.test(n);
  const explicitPower = /\b(?:apud|apoderamiento|justificante)\b/.test(n) && /\b(?:hecho|tengo|he (?:terminado|enviado|mandado)|hice|done|sent|finished)\b/.test(n);
  // A client supplying an application code has NOT finished anything: "ya tengo el código" must not
  // be read as "ya lo tengo" (manager test, 18 September).
  const suppliesCode = /\b(?:codigo|code|solicitud|referencia)\b/.test(n) || /\b[a-z]{0,3}\d{6,}[a-z]?\b/.test(n);
  if ((completed || explicitPower) && !negated && !suppliesCode && (powerSteps.has(c.currentState) || intakeSteps.has(c.currentState))) {
    if (powerSteps.has(c.currentState) || explicitPower) return reply(REQUEST_POWER_PDF);
    // "Ya lo tengo" after FNMT instructions may mean the certificate, not the power.
    if (!/certificad|certificate|\bpc\b|ordenador|movil|mobile/.test(n)) return reply('¿Has obtenido el certificado digital o ya has terminado el apoderamiento apud acta?');
  }
  const selfService = /\b(?:lo (?:hare|hago|voy a hacer) (?:yo|por mi cuenta)|por mi cuenta|by my ?self|on my own|do it myself|ill do it|i will do it)\b/.test(n);
  if (selfService && !/no (?:lo|puedo)|cant|cannot|wont/.test(n) && powerSteps.has(c.currentState)) {
    return reply(`De acuerdo, seguimos con ${court ? 'la vía del juzgado' : 'el apoderamiento por tu cuenta'}. Cuando lo termines, envíanos el justificante PDF completo para revisarlo.`);
  }
  if (/^(?:no[,]? )?(?:gracias|thanks|thank you|ok|okay|vale|perfecto|de acuerdo)[.! ]*$/.test(n) && powerSteps.has(c.currentState)) {
    return reply('De acuerdo. Cuando tengas el justificante del apoderamiento, envíanos el PDF completo para revisarlo.');
  }
  if (/^(?:hola[, ]+)?(?:que es|que significa|para que (?:es|sirve)|what is|whats)\b.*(?:apud|apoderamiento|poder)/.test(n)) {
    return reply(`El apoderamiento apud acta es el documento que autoriza a los procuradores a representarte en la reclamación ante el juzgado. ${SELF_SERVICE_COST} ${PARTNER_COST}`);
  }
  return null;
}

/** Adapted from the provided Bot exports; no client identities or obsolete app numbers. */
export const REVIEWED_CONVERSATION_STYLE = `
Use the office's WhatsApp style: acknowledge the client's specific situation,
give one practical next step, and ask at most one necessary question. Explain
the selected route first; do not repeatedly offer a paid route after it is declined.
Priority: guide the client to complete the digital power; if stuck after guided
attempts, help locate/provide their certificate for assistance. Only after repeated
unsuccessful attempts may the FSM offer paid partner or court self-service.
A generic help request is never a reason to propose court or a human handoff.
The current input may contain several related WhatsApp messages on separate lines.
Read the entire group before answering, apply the client's latest correction, and
address its details in one concise reply with short paragraphs. Do not answer each
line as a new conversation. "Quiero salir de esto" and "I wanna finish this process"
ask for progress, not cancellation. Frustration alone is not a human handoff.
"Vale", "OK", "no tengo tiempo", and "lo haré mañana" yield the floor: acknowledge
briefly, without another question, full tutorial, sales pitch or fabricated reminder.
If the client says they have NIE, explain that route rather than repeating DNIe.
The examples below are adapted explanations, never proof of a completed action:
- Client: "No tengo certificado" -> Explain the DNI/NIE acquisition route for the saved identity; do not restart introductions.
- Client (court route): "Lo hago yo" -> "De acuerdo, seguimos con el juzgado. Cuando termines, envíanos el justificante PDF completo para revisarlo."
- Client: "Ya hice el apoderamiento" -> "Perfecto, envíanos el justificante PDF completo, con todas sus páginas, para que el equipo lo revise."
- Client (acquiring a certificate): "Ya lo tengo" -> "¿Te refieres al certificado digital o al apoderamiento?"
- Client: "¿Por qué habláis de pago?" -> Explain free self-service versus optional paid partner management, without assuming a purchase or requesting payment.
- Client: "Lo haré mañana" -> Acknowledge and preserve the current step; do not repeat the full tutorial or promise a reminder.
`;
