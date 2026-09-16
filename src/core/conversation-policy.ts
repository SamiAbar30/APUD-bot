import { z } from 'zod';
import type { BotApodExpediente } from '@prisma/client';
import { EventType, State } from '../domain/fsm/states.js';
import { ReplyButtonIdSchema, type ReplyButtonId } from '../contracts/whatsapp.contract.js';

/**
 * The conversation model is a bounded classifier. It may select one reviewed
 * option for the current state, but it never writes a state, calls a tool, or
 * invents client-facing text.
 */
export const ConversationClassificationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('OPTION'),
    optionId: ReplyButtonIdSchema,
    eventType: z.nativeEnum(EventType),
    confidence: z.enum(['EXACT', 'NORMALIZED']),
  }).strict(),
  z.object({
    kind: z.literal('HUMAN_REVIEW'),
    reason: z.enum(['AMBIGUOUS_TEXT', 'UNSUPPORTED_TEXT', 'PROMPT_INJECTION', 'BUTTON_REQUIRED']),
  }).strict(),
]);
export type ConversationClassification = z.infer<typeof ConversationClassificationSchema>;

/** A model-generated support reply is still bounded and reviewed before it is sent. */
const ConversationReplySchema = z.object({
  kind: z.literal('REPLY'),
  text: z.string().trim().min(1).max(1600),
  requiresHumanReview: z.boolean().default(false),
  handoffReason:z.enum(['HUMANO','FALTA_DATO','PAGO','DESCONFIANZA','APUD_ACTA_RECIBIDO','CERTIFICADO_RECIBIDO']).optional(),
}).strict();
export type ConversationReply = { text: string; requiresHumanReview: boolean; handoffReason?:string };

export type ConversationHistoryMessage = { role: 'user' | 'assistant'; content: string };
export const CONVERSATION_HISTORY_LIMITS = Object.freeze({ messages: 12, messageChars: 2000, totalChars: 12000 });

/** Minimize stored text and provider context; never retain credential-like input. */
export function redactConversationPii(text: string): string {
  if (text.length > 4000) return '[MENSAJE_LARGO_OMITIDO]';
  const normalized = normalizeText(text);
  const identityMethodOnly = /^(?:(?:solo )?tengo )?cl[a@]ve(?: pin)?[.!]*$/.test(normalized);
  const secretLabel = /\b(?:contrasena|password|passphrase|passwd|pin|sms|otp|token|api[ _-]?key|secret|clave|codigo(?:\s+(?:de\s+)?(?:acceso|verificacion|seguridad|autorizacion|sms)))\s*(?:es\s+|[:=]\s*)\S+|(?:mi contrasena|mi password)\s+(?!es segura|para que|por que)\S+|(?:contrasena|password)\s+(?=\S*\d)\S+/i;
  const secretMaterial = /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)|\b(?:sk|pk)[_-][a-z0-9_-]{12,}|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|\bBearer\s+\S+|\.(?:p12|pfx|pem|key)\b/i;
  const opaqueValue = /^(?:(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9!@#$%^&*+=_./:-]{8,}|\d{4,8}|[A-Za-z0-9+/=_-]{40,})$/;
  if ((!identityMethodOnly && secretLabel.test(normalized)) || secretMaterial.test(text) || opaqueValue.test(text.trim())) return '[CONTENIDO_SENSIBLE_OMITIDO]';
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\bES\s*\d{2}(?:[\s-]?\d{4}){5}\b/gi, '[IBAN]')
    .replace(/\b[XYZ]\s*\d{7}\s*[A-Z]\b/gi, '[NIE]')
    .replace(/\b\d{8}\s*[A-Z]\b/gi, '[DNI]')
    .replace(/(?<!\w)(?:\+?34[\s.-]?)?[6789](?:[\s.-]?\d){8}(?!\d)/g, '[TELEFONO]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, '[ENLACE]')
    .replace(/\b(?:me llamo|mi nombre es)\s+[^.!?;\n]+/gi, '[NOMBRE]')
    .replace(/\b(?:vivo en|mi domicilio es|mi direccion es|mi dirección es)\s+[^.!?;\n]+/gi, '[DIRECCION]');
}

/** Old messages are context only, with fresh redaction and a fixed budget. */
export function boundedConversationHistory(history: readonly ConversationHistoryMessage[] = []): ConversationHistoryMessage[] {
  const result: ConversationHistoryMessage[] = [];
  let remaining = CONVERSATION_HISTORY_LIMITS.totalChars;
  for (const message of history.slice(-CONVERSATION_HISTORY_LIMITS.messages).reverse()) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
    const content = (isPromptInjection(normalizeText(message.content))
      ? '[CONTENIDO_NO_FIABLE_OMITIDO]'
      : redactConversationPii(message.content)).trim().slice(0, Math.min(CONVERSATION_HISTORY_LIMITS.messageChars, remaining));
    if (!content) continue;
    result.push({ role: message.role, content });
    remaining -= content.length;
    if (remaining === 0) break;
  }
  return result.reverse();
}

const OPTION_EVENT: Record<ReplyButtonId, EventType> = {
  HAS_CERT_YES: EventType.CLIENT_HAS_CERT,
  HAS_CERT_NO: EventType.CLIENT_HAS_NO_CERT,
  DEVICE_PC: EventType.CLIENT_HAS_CERT_PC,
  DEVICE_MOBILE: EventType.CLIENT_HAS_CERT_MOBILE,
  HAS_PC: EventType.CLIENT_HAS_PC,
  NO_PC: EventType.CLIENT_HAS_NO_PC,
  NEEDS_ASSISTANCE: EventType.CLIENT_REQUESTS_ASSISTANCE,
  CONSENT_YES: EventType.CLIENT_CONSENT_GRANTED,
  CONSENT_NO: EventType.CLIENT_CONSENT_DENIED,
  DRAFT_APPROVED: EventType.CLIENT_DRAFT_APPROVED,
  DRAFT_REJECTED: EventType.CLIENT_DRAFT_REJECTED,
  REVOKED: EventType.CLIENT_REVOCATION_DONE,
  REISSUED: EventType.CLIENT_ACKNOWLEDGED,
  COURT_APPOINTMENT: EventType.CLIENT_CANNOT_GET_CERT,
  APUDATA_REQUEST: EventType.CLIENT_REQUESTS_URGENT_PAID,
  HUMAN_HELP: EventType.CLIENT_REQUESTS_HUMAN,
};

const PHRASES: Record<ReplyButtonId, readonly string[]> = {
  HAS_CERT_YES: ['si', 'si lo tengo', 'tengo certificado', 'dispongo de certificado', 'tengo el certificado'],
  HAS_CERT_NO: ['no', 'no lo tengo', 'no tengo certificado', 'sin certificado', 'no dispongo de certificado', 'tengo clave', 'solo tengo clave', 'cl@ve'],
  DEVICE_PC: ['pc', 'ordenador', 'computador', 'en el ordenador', 'en pc', 'ya esta en el pc', 'ya lo tengo en pc'],
  DEVICE_MOBILE: ['movil', 'telefono', 'en el movil', 'en mi movil', 'en el telefono'],
  HAS_PC: ['tengo ordenador', 'si tengo ordenador', 'dispongo de ordenador', 'tengo pc', 'si tengo pc'],
  NO_PC: ['no tengo ordenador', 'sin ordenador', 'no dispongo de ordenador', 'no tengo pc'],
  NEEDS_ASSISTANCE: ['necesito asistencia', 'necesito ayuda', 'quiero ayuda', 'ayuda del gestor', 'hablar con una persona'],
  CONSENT_YES: ['autorizo asistencia', 'si autorizo', 'doy mi consentimiento'],
  CONSENT_NO: ['no autorizo', 'retiro el permiso', 'no doy mi consentimiento'],
  DRAFT_APPROVED: ['revisado y conforme', 'esta correcto', 'todo correcto'],
  DRAFT_REJECTED: ['necesita correccion', 'hay que corregir', 'no esta correcto'],
  REVOKED: ['revocacion realizada', 'ya lo revoque', 'lo he revocado', 'revocado'],
  REISSUED: ['nuevo documento', 'nuevo pdf', 'lo he reenviado', 'reenviado'],
  COURT_APPOINTMENT: ['juzgado', 'via presencial', 'presencial', 'cita en el juzgado'],
  APUDATA_REQUEST: ['apudata', 'servicio de pago', 'pagar', 'pago', '35 euros', '35€'],
  HUMAN_HELP: ['gestor', 'persona', 'humano', 'agente'],
};

const SECURE_BUTTON_ONLY = new Set<ReplyButtonId>(['CONSENT_YES', 'CONSENT_NO', 'DRAFT_APPROVED', 'DRAFT_REJECTED']);

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function allowedOptions(expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>): ReplyButtonId[] {
  switch (expediente.currentState as State) {
    case State.INITIAL_TRIAGE:
      return ['HAS_CERT_YES', 'HAS_CERT_NO','DEVICE_PC','DEVICE_MOBILE'];
    case State.WAITING_CERT_RESPONSE:
      return expediente.hasDigitalCert === true ? ['DEVICE_PC', 'DEVICE_MOBILE', 'NEEDS_ASSISTANCE'] : ['HAS_CERT_YES', 'HAS_CERT_NO','DEVICE_PC','DEVICE_MOBILE'];
    case State.PC_TUTORIAL_SENT:
    case State.WAITING_PDF_SUBMISSION:
      return ['NEEDS_ASSISTANCE','HUMAN_HELP'];
    case State.MOBILE_TRIAGE_PC_CHECK:
      return ['HAS_PC', 'NO_PC', 'NEEDS_ASSISTANCE'];
    case State.MOBILE_EXPORT_GUIDE_SENT:
      return ['DEVICE_PC', 'NEEDS_ASSISTANCE'];
    case State.MOBILE_ASSIST_CONSENT_REQUESTED:
      return ['CONSENT_YES', 'CONSENT_NO'];
    case State.MOBILE_ASSIST_PROCESSING:
      return ['HUMAN_HELP'];
    case State.CERT_ACQUISITION_LINKS_SENT:
      return ['HAS_CERT_YES', 'DEVICE_PC', 'DEVICE_MOBILE', 'NEEDS_ASSISTANCE', 'COURT_APPOINTMENT', 'APUDATA_REQUEST'];
    case State.FALLBACK_OPTIONS:
      return ['COURT_APPOINTMENT', 'APUDATA_REQUEST', 'HUMAN_HELP'];
    case State.PROVISIONAL_VIABILIZED:
    case State.REVOCATION_GUIDE_SENT:
      return ['REVOKED', 'HUMAN_HELP'];
    case State.WAITING_REVOCATION_REISSUE:
      return ['REISSUED', 'HUMAN_HELP'];
    default:
      return [];
  }
}

function isPromptInjection(text: string): boolean {
  return /(?:ignore|ignora|olvida).*(?:previous|anteriores?|instrucciones?|prompt|sistema)|(?:system|developer)\s+prompt|(?:actua|act as|pretend|hazte pasar)|(?:override|jailbreak)|<\/?(?:system|developer)>|api\s*key|clave\s+secreta|\[\[handoff:/.test(text);
}

/** These inputs must never be reinterpreted as an action by a model. */
export function requiresDeterministicHandoff(text: string): boolean {
  return !text.trim() || text.length > 4000 || isPromptInjection(normalizeText(text))
    || redactConversationPii(text) === '[CONTENIDO_SENSIBLE_OMITIDO]'
    || /\b(?:stop|parar|cancelar|no me escribas|no quiero seguir)\b/.test(normalizeText(text));
}

/** Classify only an unambiguous, reviewed answer for the case's current state. */
export function classifyClientText(
  expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>,
  text: string,
): ConversationClassification {
  if (typeof text !== 'string' || text.length < 1 || text.length > 4000) return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
  const normalized = normalizeText(text);
  if (isPromptInjection(normalized)) return { kind: 'HUMAN_REVIEW', reason: 'PROMPT_INJECTION' };
  const options = allowedOptions(expediente);
  if (!options.length) return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
  const explicitStop = /\b(?:stop|parar|cancelar|no me escribas|no quiero seguir)\b/.test(normalized);
  if (explicitStop) return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
  const plain = normalized.replace(/[.,;:!?¿¡]/g, ' ').replace(/\s+/g, ' ').trim();
  // Brief answers refer to the persisted question, never to consent or document approval.
  // Also accept an unfinished "i" followed immediately by the client's correction.
  const brief=plain.replace(/^i (?=si$|yes$)/,'');
  const yes=/^(?:si|yes|yeah|yep|i said yes|he dicho que si|ya te he dicho que si)$/.test(brief);
  const no=/^(?:no|nope|i said no)$/.test(brief);
  const briefOption=yes?(expediente.currentState===State.MOBILE_TRIAGE_PC_CHECK?'HAS_PC':'HAS_CERT_YES'):no?(expediente.currentState===State.MOBILE_TRIAGE_PC_CHECK?'NO_PC':'HAS_CERT_NO'):null;
  if(briefOption&&options.includes(briefOption))return {kind:'OPTION',optionId:briefOption,eventType:OPTION_EVENT[briefOption],confidence:'NORMALIZED'};
  if(options.includes('HAS_CERT_YES')&&/^(?:ok(?:ay)? )?i (?:have|got) (?:a |my )?(?:digital )?(?:certificado(?: digital)?|certificate)$/.test(plain))return {kind:'OPTION',optionId:'HAS_CERT_YES',eventType:OPTION_EVENT.HAS_CERT_YES,confidence:'NORMALIZED'};
  if(options.includes('DEVICE_MOBILE')&&expediente.hasDigitalCert===true&&/^(?:en (?:el |mi )?|on (?:my |the )?)?(?:movile|mobile|phone)$/.test(plain))return {kind:'OPTION',optionId:'DEVICE_MOBILE',eventType:OPTION_EVENT.DEVICE_MOBILE,confidence:'NORMALIZED'};
  if(/^(?:hola )?si(?: (?:tengo|lo tengo|tengo certificado|tengo certificado digital))? (?:en (?:el |mi )?)?(ordenador|pc|movil)$/.test(plain)){
    const optionId=/movil$/.test(plain)?'DEVICE_MOBILE':'DEVICE_PC';
    if(options.includes(optionId))return {kind:'OPTION',optionId,eventType:OPTION_EVENT[optionId],confidence:'NORMALIZED'};
  }
  // "No tengo nada de eso, ni certificado ni clave": having neither is still a no-certificate answer.
  if(options.includes('HAS_CERT_NO')&&/^no (?:tengo|dispongo de) (?:nada de eso|ni (?:el )?certificado|ni (?:la )?cl(?:a|@)ve)(?: |$)|(?:^| )ni (?:el )?certificado(?: digital)? ni (?:la )?cl(?:a|@)ve(?: |$)/.test(plain)){
    return {kind:'OPTION',optionId:'HAS_CERT_NO',eventType:OPTION_EVENT.HAS_CERT_NO,confidence:'NORMALIZED'};
  }
  const exact = options.filter(option => PHRASES[option].includes(plain));
  // Short answers such as "si" and "no" must be whole answers, never
  // substrings of a question. A negative answer cannot match a positive
  // phrase embedded inside it ("no tengo ordenador").
  const matches = exact.length ? exact : options.filter(option => PHRASES[option].some(phrase => {
    if (phrase.length <= 2 || (/^no\b/.test(plain) && !/^no\b/.test(phrase))) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`).exec(plain);
    if (!match) return false;
    return !/(?:^|\s)no\s*$/.test(plain.slice(0, match.index));
  }));
  if (matches.length !== 1) return { kind: 'HUMAN_REVIEW', reason: matches.length > 1 ? 'AMBIGUOUS_TEXT' : 'UNSUPPORTED_TEXT' };
  const optionId = matches[0]!;
  if (SECURE_BUTTON_ONLY.has(optionId)) return { kind: 'HUMAN_REVIEW', reason: 'BUTTON_REQUIRED' };
  const confidence = normalized === PHRASES[optionId][0] ? 'EXACT' : 'NORMALIZED';
  return ConversationClassificationSchema.parse({ kind: 'OPTION', optionId, eventType: OPTION_EVENT[optionId], confidence });
}

/** Validate a future Gemini/Claude structured response against the same gate. */
export function validateModelClassification(
  expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>,
  raw: unknown,
): ConversationClassification {
  const parsed = ConversationClassificationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== 'OPTION') {
    return parsed.success ? parsed.data : { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
  }
  const allowed = allowedOptions(expediente);
  if (!allowed.includes(parsed.data.optionId) || SECURE_BUTTON_ONLY.has(parsed.data.optionId)) return { kind: 'HUMAN_REVIEW', reason: 'BUTTON_REQUIRED' };
  if (OPTION_EVENT[parsed.data.optionId] !== parsed.data.eventType) return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
  return parsed.data;
}

/**
 * Validate model wording at the provider boundary. Replies may explain the
 * reviewed process, but they cannot contain secrets, internal URLs, or
 * identity/telephone values that the model could have copied from context.
 */
export function validateModelReply(raw: unknown): ConversationReply | null {
  const parsed = ConversationReplySchema.safeParse(raw);
  if (!parsed.success) return null;
  const text = parsed.data.text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 1600) return null;
  if (/localhost|127\.0\.0\.1|(?:api|access|private|client)[ _-]?key|token|secret|\b(?:[XYZ]\s*\d{7}\s*[A-Z]|\d{8}\s*[A-Z])\b|\b(?:\+?34[ .-]?)?[6789]\d{8}\b|\p{Extended_Pictographic}|\[\[|\bTODO\b/iu.test(text)) return null;
  const allowedUrls=['https://sedejudicial.justicia.es/-/apoderamiento-apud-acta','https://firmaelectronica.gob.es/Home/Descargas.htm','https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-con-dnie','https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion','https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software/acreditar-identidad'];
  let safe=text.replaceAll('reclamaciones@litigios.es','correo del despacho');
  for(const url of allowedUrls)safe=safe.replaceAll(url,'enlace oficial');
  if(redactConversationPii(safe)!==safe||(text.match(/\?/g)?.length??0)>1)return null;
  const normalized = normalizeText(text);
  const withoutVirtualIdentity=normalized.replace(/\bsoy dayana, (?:la )?asistente virtual de litigios\b/g,'');
  if (/(?:soy|me llamo|mi nombre es|te (?:habla|atiende))\b.{0,40}\bdayana\b|\bsoy (?:una? |la |el )?(?:persona|humana?|abogad[oa]|auditora?|responsable|profesional)\b/.test(withoutVirtualIdentity)) return null;
  // The model has no evidence of legal completion, fee terms, or deadlines.
  if (/\b(?:honorarios|penalizacion|abandono contractual)\b|\b\d+(?:[.,]\d+)?\s*(?:€|(?:euros?|dias?|meses?|horas?)\b)|\b(?:demanda|reclamacion)\b.{0,60}\b(?:presentad[oa]|lista|se presentara|presentaremos)\b|\b(?:hemos|he)\s+(?:presentado|subido|registrado|enviado|completado)\b/.test(normalized)) return null;
  if(/(?:enviame|mandame|pasame|comparte|necesito|dime|introduce).{0,70}(?:contrasena|password|\bpin\b|\bsms\b|codigo)|puedes (?:firmar|hacerlo).{0,20}(?:con cl[a@]ve|desde el movil)/.test(normalized))return null;
  return { text, requiresHumanReview: parsed.data.requiresHumanReview,...(parsed.data.handoffReason?{handoffReason:parsed.data.handoffReason}:{}) };
}

export function allowedConversationOptions(expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>): readonly ReplyButtonId[] {
  return allowedOptions(expediente);
}

export function conversationOptionEvents(options:readonly string[]):Record<string,EventType>{
  return Object.fromEntries(options.filter(id=>Object.hasOwn(OPTION_EVENT,id)).map(id=>[id,OPTION_EVENT[id as ReplyButtonId]]));
}
