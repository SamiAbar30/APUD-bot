import type { BotApodExpediente } from '@prisma/client';
import { EventType } from '../domain/fsm/states.js';
import { evaluateNextStep } from './decision-engine.js';
import { messageForCase } from './messages.js';
import { allowedConversationOptions, conversationOptionEvents, redactConversationPii, type ConversationHistoryMessage } from './conversation-policy.js';
import type { CaseContext } from './conversation-guidance.js';

/**
 * The conversation brain.
 *
 * One model call per client turn reads the whole conversation, the firm's playbook and where the
 * case stands, and decides what to do: answer in its own words, move the workflow one step (the
 * state machine then sends that step's approved message), stay silent after a bare
 * acknowledgement, or hand the case to a person. Understanding and wording belong to the model.
 * Code keeps only what must never depend on a model: which workflow steps are reachable from the
 * current state, and the safety limits every outgoing reply is checked against.
 */

export interface BrainModel {
  think(input: { system: string; history: readonly ConversationHistoryMessage[]; text: string; feedback?: string }): Promise<unknown>;
}

export type BrainTurn = { type: EventType; payload: Record<string, unknown> };

/** Workflow steps the brain may take. Everything else it does through its own reply. */
const STEP_MEANING: Record<string, string> = {
  HAS_CERT_YES: 'El cliente confirma que tiene certificado digital, sin decir aún dónde.',
  HAS_CERT_NO: 'El cliente confirma que NO tiene certificado digital.',
  DEVICE_PC: 'El cliente tiene el certificado en un ordenador (o acaba de pasarlo al ordenador).',
  DEVICE_MOBILE: 'El cliente tiene el certificado solo en el móvil.',
  HAS_PC: 'El cliente (con el certificado en el móvil) dispone de un ordenador.',
  NO_PC: 'El cliente (con el certificado en el móvil) no dispone de ordenador.',
  COURT_APPOINTMENT: 'El cliente ELIGE expresamente hacerlo en persona en el juzgado.',
  APUDATA_REQUEST: 'El cliente ELIGE expresamente la empresa colaboradora de pago (35 €).',
  OFFICE_TAKES_OVER: 'El cliente, que tiene certificado, quiere que lo hagamos nosotros y está dispuesto a mandarnos el archivo y la contraseña.',
};

const HANDOFF_REASONS = ['HUMANO', 'FALTA_DATO', 'PAGO', 'DESCONFIANZA'] as const;

const STATE_MEANING: Record<string, string> = {
  INITIAL_TRIAGE: 'Primer contacto: aún no sabemos si tiene certificado.',
  WAITING_CERT_RESPONSE: 'Le preguntamos si tiene certificado digital (y dónde).',
  MOBILE_TRIAGE_PC_CHECK: 'Tiene el certificado en el móvil; le preguntamos si tiene ordenador.',
  MOBILE_EXPORT_GUIDE_SENT: 'Le explicamos cómo pasar el certificado del móvil al ordenador.',
  MOBILE_ASSIST_CONSENT_REQUESTED: 'Le preguntamos si nos manda su certificado y contraseña para hacerlo nosotros (responde con los botones).',
  MOBILE_ASSIST_PROCESSING: 'Aceptó que lo hagamos nosotros; esperamos su archivo y contraseña.',
  PC_TUTORIAL_SENT: 'Tiene el certificado en el ordenador: ya le enviamos la guía PDF con los procuradores, el enlace de la Sede y AutoFirma. Ahora le acompañamos a hacerlo en la Sede y esperamos el PDF final.',
  WAITING_PDF_SUBMISSION: 'Esperamos que nos envíe el PDF del apud acta.',
  CERT_ACQUISITION_LINKS_SENT: 'No tiene certificado: le enviamos cómo conseguirlo según su documento (DNI o NIE).',
  FALLBACK_OPTIONS: 'Le ofrecimos las dos vías alternativas: juzgado gratis o empresa colaboradora de pago.',
  COURT_FALLBACK_GUIDE_SENT: 'Eligió el juzgado: le enviamos la lista para llevar; esperamos el justificante.',
};

export interface BrainCase extends CaseContext {
  id?: string;
  dni?: string;
  certDevice?: string | null;
}

export class ConversationBrain {
  constructor(
    private readonly model: BrainModel,
    private readonly playbook: string,
    private readonly firmFacts = '',
    private readonly consentVersion?: string,
  ) {}

  /** Returns null only when the model could not be reached; the caller then uses its fallback. */
  async decide(c: BrainCase, text: string, history: readonly ConversationHistoryMessage[], memory?: string): Promise<BrainTurn | null> {
    const steps = this.availableSteps(c, history);
    const system = this.systemPrompt(c, steps, memory);
    const cleanHistory = recentHistory(history);
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: unknown;
      try { raw = await this.model.think({ system, history: cleanHistory, text: redactConversationPii(text), ...(feedback ? { feedback } : {}) }); }
      catch { raw = null; }
      if (!raw || typeof raw !== 'object') { if (attempt === 0) continue; return null; }
      const decision = raw as Record<string, unknown>;
      const problem = checkDecision(decision, steps, history, text);
      if (!problem) return toTurn(decision, steps);
      feedback = problem;
    }
    // Three unusable drafts: a person answers rather than a guess or a canned loop.
    return reply('Déjame que lo revise con una compañera del equipo y te escribe por aquí en cuanto pueda.', 'HUMANO', 'brain drafts rejected: ' + (feedback ?? 'no response'));
  }

  private availableSteps(c: BrainCase, history: readonly ConversationHistoryMessage[]): Map<string, { event: EventType; payload: Record<string, unknown>; preview: string }> {
    const steps = new Map<string, { event: EventType; payload: Record<string, unknown>; preview: string }>();
    const events = conversationOptionEvents(allowedConversationOptions(c));
    const candidates: Array<[string, EventType, Record<string, unknown>]> = Object.entries(events)
      .filter(([id]) => id in STEP_MEANING)
      .map(([id, event]) => [id, event, { conversationOption: id, conversationConfidence: 'NORMALIZED' }]);
    if (c.hasDigitalCert === true) candidates.push(['OFFICE_TAKES_OVER', EventType.CLIENT_REQUESTS_ASSISTANCE, { copyLocated: true, takeoverRequested: true }]);
    const sent = history.filter(m => m.role === 'assistant').map(m => normalize(m.content));
    for (const [id, event, payload] of candidates) {
      const preview = this.preview(c, event, payload);
      if (preview === null) continue;
      // A step whose message the client already received is not a way forward: it is the loop.
      if (preview && sent.some(previous => similarity(previous, normalize(preview)) > 0.7)) continue;
      steps.set(id, { event, payload, preview });
    }
    return steps;
  }

  /** What the state machine would actually send for a step, so the brain chooses knowingly. */
  private preview(c: BrainCase, event: EventType, payload: Record<string, unknown>): string | null {
    if (!c.id) return '';
    try {
      const decision = evaluateNextStep(c as never, { type: event, payload } as never);
      if (decision.nextStep === c.currentState && decision.actionRequired === 'NO_OP') return null;
      if (decision.nextStep === 'ESCALATED_HUMAN' || decision.actionRequired === 'ESCALATE_HUMAN') return null;
      const action = decision.actionPayload as { template?: string; variables?: Record<string, unknown> };
      if (!action.template) return '';
      return messageForCase({ ...c, currentState: decision.nextStep } as BotApodExpediente, this.consentVersion, action.template as never, action.variables as never).text;
    } catch {
      return null;
    }
  }

  private systemPrompt(c: BrainCase, steps: Map<string, { preview: string }>, memory?: string): string {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('es-ES', { hour: 'numeric', hour12: false, timeZone: 'Europe/Madrid' }).format(now));
    const document = /^[XYZ]/i.test(c.dni ?? '') ? 'NIE' : /^\d{8}[A-Z]$/i.test(c.dni ?? '') ? 'DNI' : 'sin confirmar';
    const stepLines = [...steps.entries()].map(([id, s]) =>
      `- ${id}: ${STEP_MEANING[id]}${s.preview ? `\n  Si eliges este paso, el sistema envía este mensaje en lugar del tuyo: «${s.preview.replace(/\s+/g, ' ').slice(0, 500)}»` : ''}`).join('\n');
    return `${this.playbook}

${this.firmFacts ? `## Datos del despacho\n${this.firmFacts}\n` : ''}
## Situación de este expediente (datos del sistema)
- Hora en España: ${hour}h (${hour < 14 ? 'buenos días' : hour < 21 ? 'buenas tardes' : 'buenas noches'}, solo si saludas).
- Documento de identidad: ${document}.
- Certificado digital según el sistema: ${c.hasDigitalCert === true ? 'sí' : c.hasDigitalCert === false ? 'no' : 'sin confirmar'}${c.certDevice === 'PC' ? ', en el ordenador' : c.certDevice === 'MOBILE' ? ', en el móvil' : ''}.
- Paso guardado del flujo: ${c.currentState} — ${STATE_MEANING[c.currentState] ?? 'paso interno del despacho.'}
${memory ? `- Memoria del expediente: ${memory.slice(0, 4000)}` : ''}
Lo que el cliente haya dicho en la conversación vale más que estos datos si es más reciente.

## Qué puedes hacer en este turno
- RESPONDER: escribes tú el mensaje al cliente. Es lo normal.
- SILENCIO: el cliente solo confirma o agradece algo y no hace falta contestar (por ejemplo, un
  segundo "vale" seguido). Úsalo poco.
${stepLines ? `- Avanzar el flujo con uno de estos pasos, SOLO si el cliente acaba de dejarlo claro:\n${stepLines}` : '- Ahora no hay pasos del flujo disponibles: responde tú.'}
- Además, en cualquier caso puedes pasar el caso a una persona con "traspaso".

## Formato de salida
Devuelve SOLO un objeto JSON:
{"entiendo":"qué quiere decir o pedir el cliente, en una frase",
 "punto":"en qué punto del trámite está el cliente según toda la conversación",
 "accion":"RESPONDER" | "SILENCIO" | "<uno de los pasos listados>",
 "mensaje":"con RESPONDER, tu mensaje al cliente. Con un paso, opcional: una o dos frases que van DELANTE del mensaje del sistema, para responder antes a lo que el cliente preguntó (no repitas lo que ya dice el mensaje del sistema). Vacío con SILENCIO.",
 "traspaso":null | ${HANDOFF_REASONS.map(r => `"${r}"`).join(' | ')}}
Si pones traspaso, "mensaje" es lo último que le dices antes de que le atienda una persona.`;
  }
}

function toTurn(d: Record<string, unknown>, steps: Map<string, { event: EventType; payload: Record<string, unknown> }>): BrainTurn {
  const action = String(d.accion ?? '');
  const handoff = typeof d.traspaso === 'string' && (HANDOFF_REASONS as readonly string[]).includes(d.traspaso) ? d.traspaso : null;
  const trace = { brainUnderstanding: String(d.entiendo ?? '').slice(0, 300), brainProgress: String(d.punto ?? '').slice(0, 300) };
  const step = steps.get(action);
  const lead = cleanText(String(d.mensaje ?? ''));
  if (step && !handoff) return { type: step.event, payload: { ...step.payload, ...trace, ...(lead ? { brainLead: lead } : {}) } };
  if (action === 'SILENCIO' && !handoff)
    return { type: EventType.CLIENT_SMALL_TALK, payload: { responseId: 'CONVERSATION_REPLY', rolloutPhase: 3, rolloutKind: 'WORKFLOW_REQUEST', silent: true, requiresHumanReview: false, ...trace } };
  const turn = reply(cleanText(String(d.mensaje ?? '')), handoff, '');
  return { ...turn, payload: { ...turn.payload, ...trace } };
}

function reply(text: string, handoff: string | null, note: string): BrainTurn {
  return {
    type: EventType.CLIENT_SMALL_TALK,
    payload: {
      responseId: 'CONVERSATION_REPLY', rolloutPhase: 3, rolloutKind: 'WORKFLOW_REQUEST', responseText: text,
      requiresHumanReview: Boolean(handoff),
      ...(handoff ? { handoffReason: handoff, handoffMarker: `[[HANDOFF:${handoff}]]` } : {}),
      ...(note ? { brainNote: note } : {}),
    },
  };
}

const APPROVED_URLS = [
  'https://sedejudicial.justicia.es/-/apoderamiento-apud-acta',
  'https://firmaelectronica.gob.es/Home/Descargas.htm',
  'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-con-dnie',
  'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion',
  'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software/acreditar-identidad',
  'https://play.google.com/store/apps/details?id=es.fnmtrcm.ceres.certificadoDigitalFNMT&hl=en-US',
];

/** The limits every draft must respect. Returns the reason to redraft, or null when it is fine. */
export function checkDecision(d: Record<string, unknown>, steps: Map<string, unknown>, history: readonly ConversationHistoryMessage[], clientText: string): string | null {
  const action = String(d.accion ?? '');
  if (action !== 'RESPONDER' && action !== 'SILENCIO' && !steps.has(action))
    return `La acción "${action}" no está disponible ahora. Elige RESPONDER, SILENCIO o uno de los pasos listados.`;
  if (d.traspaso != null && !(HANDOFF_REASONS as readonly string[]).includes(String(d.traspaso)))
    return `Motivo de traspaso no válido. Usa null o uno de: ${HANDOFF_REASONS.join(', ')}.`;
  const text = cleanText(String(d.mensaje ?? ''));
  if (action === 'SILENCIO' && d.traspaso == null) return null;
  if (!text) return action === 'RESPONDER' || d.traspaso != null ? 'Falta el mensaje para el cliente.' : null;
  // With a step, the message is a short lead in front of the step's approved message.
  if (steps.has(action) && text.length > 400) return 'Con un paso, "mensaje" es solo una frase breve que va delante del mensaje del sistema.';
  return checkReply(text, history, clientText);
}

export function checkReply(text: string, history: readonly ConversationHistoryMessage[], clientText: string): string | null {
  if (text.length > 900) return 'El mensaje es demasiado largo para WhatsApp. Acórtalo: un paso cada vez.';
  if ((text.match(/\?/g)?.length ?? 0) > 1) return 'Haz como mucho una pregunta por mensaje.';
  const urls = text.match(/https?:\/\/[^\s)»"]+/g) ?? [];
  const unknown = urls.map(u => u.replace(/[.,;:]+$/, '')).filter(u => !APPROVED_URLS.includes(u));
  if (unknown.length) return `Has puesto un enlace que no está aprobado (${unknown[0]}). Usa solo los enlaces del manual.`;
  const n = normalize(text);
  const amounts = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:€|euros?\b)/gi)].map(m => m[1]!.replace(',', '.'));
  if (amounts.some(a => !['35', '3.62'].includes(a))) return 'Solo puedes mencionar los importes aprobados: 35 € (empresa colaboradora) y 3,62 € (certificado por la app de la FNMT).';
  if (/\b(?:codigo|clave)s? (?:sms|de verificacion|de seguridad)\b|\bpin (?:de|del) (?:cl@ve|clave|dni|banco)\b|(?:mandame|enviame|pasame|dime) (?:el |tu )?pin\b|datos bancarios|numero de cuenta|\biban\b.{0,20}(?:mandame|enviame|dime)|foto (?:de|del) (?:tu )?dni/.test(n)
    && /(?:mandame|enviame|pasame|dime|necesito|comparte)/.test(n) && !/\bno (?:me )?(?:mandes|envies|compartas|des)\b|nunca/.test(n))
    return 'No puedes pedir códigos SMS, PIN, datos bancarios ni fotos del DNI.';
  // Never echo secret material the client sent; the redactor recognises it.
  const withoutApproved = APPROVED_URLS.reduce((acc, url) => acc.replaceAll(url, 'enlace'), text).replaceAll('reclamaciones@litigios.es', 'correo');
  if (redactConversationPii(withoutApproved) !== withoutApproved) return 'El mensaje contiene datos personales o una contraseña. No los repitas.';
  if (/\b(?:ya (?:tenemos|hemos recibido|he recibido)|(?:hemos|he) (?:presentado|registrado|revisado y validado))\b.{0,50}(?:apoderamiento|apud|pdf|justificante|demanda)/.test(n))
    return 'No digas que algo está recibido o presentado: no te consta.';
  if (/(?:soy|me llamo) (?:una persona|humana|la abogada)|no soy (?:un bot|una ia|virtual)/.test(n)) return 'No digas que eres una persona: eres la asistente virtual.';
  const previous = history.filter(m => m.role === 'assistant').slice(-8).map(m => normalize(m.content));
  const mine = normalize(text);
  const repeated = previous.find(p => similarity(p, mine) > 0.6);
  if (repeated) return `Esto ya se lo dijiste casi igual antes («${repeated.slice(0, 120)}…»). Si no le sirvió, cambia de enfoque: responde a lo que pregunta ahora con el paso concreto, explícalo de otra forma o pásalo a una persona.`;
  const opener = mine.split(' ').slice(0, 3).join(' ');
  if (opener.length > 8 && previous.slice(-3).filter(p => p.startsWith(opener)).length >= 2) return `Empiezas igual que tus últimos mensajes («${opener}…»). Varía, suena a robot.`;
  void clientText;
  return null;
}

function cleanText(text: string): string {
  return text.replace(/\p{Extended_Pictographic}️?/gu, '').replace(/\[\[[^\]]*\]\]/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@.€:/ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Word-overlap between two messages; 1 means the same words. */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.split(' ').filter(w => w.length > 2));
  const x = words(a), y = words(b);
  if (x.size < 4 || y.size < 4) return a === b ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) * (Math.min(x.size, y.size) / Math.max(x.size, y.size)) ** 0.5;
}

/** The whole recent conversation, redacted, so the brain can see what already happened. */
function recentHistory(history: readonly ConversationHistoryMessage[]): ConversationHistoryMessage[] {
  const out: ConversationHistoryMessage[] = [];
  let budget = 24_000;
  for (const m of [...history].reverse().slice(0, 40)) {
    // Our own messages passed the reply checks when they were sent; only client text is redacted,
    // so the brain still sees the links and steps it already gave.
    const content = (m.role === 'user' ? redactConversationPii(m.content) : m.content).slice(0, 1500);
    if (budget - content.length < 0) break;
    budget -= content.length;
    out.push({ role: m.role, content });
  }
  return out.reverse();
}
