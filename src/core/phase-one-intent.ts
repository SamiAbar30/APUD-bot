/** A client report ends conversational follow-up; it never proves a legal filing or a payment. */
export type PhaseOneReportedOutcome = 'PAYMENT_REPORTED' | 'COURT_REPORTED' | 'SELF_COMPLETED_REPORTED';
export interface PhaseOneIntentContext {
  currentState?: string;
  pendingQuestion?: string | null;
}

const normalize = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
const POWER = /\b(?:apud(?: acta)?|apoderamiento|power of attorney)\b/;
const COURT = /\b(?:juzgado|decanato|oficina judicial|court)\b/;
const COURT_STEP = 'COURT_FALLBACK_GUIDE_SENT';
const POWER_STEPS = new Set(['PC_TUTORIAL_SENT', 'WAITING_PDF_SUBMISSION', COURT_STEP, 'WAITING_REVOCATION_REISSUE']);
const PAYMENT_STEPS = new Set(['APUDATA_WAITING_PAYMENT']);
const COMPLETED = /\b(?:(?:ya )?(?:he |hemos )?(?:firmado|otorgado|completado|terminado|realizado)|(?:ya )?(?:firme|otorgue|complete|termine|hice)|(?:ya )?(?:lo )?(?:tengo|tenemos) hecho|(?:ya )?esta (?:hecho|firmado|otorgado|completado)|(?:i |we )(?:have |already |have already )?(?:signed|completed|finished)|ive (?:signed|completed|finished))\b/;
const SHORT_COMPLETION = /^(?:(?:hola|buenos dias|buenas tardes|gracias)[,!. ]+)?(?:ya (?:lo )?(?:he hecho|hice|termine|he terminado|he firmado|tengo hecho)|(?:i have|ive|i) (?:already )?(?:done|finished|completed|signed) it)[.! ]*$/;
const PAID = /\b(?:(?:ya )?(?:he |hemos )?(?:pagado|abonado)|(?:ya )?(?:pague|abon[eé])|(?:i |we )(?:have |already |have already )?paid|ive paid)\b/;

function explicitlyCompletedPower(text: string): boolean {
  const powers = [...text.matchAll(new RegExp(POWER, 'g'))];
  const completions = [...text.matchAll(new RegExp(COMPLETED, 'g'))];
  return powers.some(power => completions.some(completion => {
    const start = Math.min(power.index! + power[0].length, completion.index! + completion[0].length);
    const end = Math.max(power.index!, completion.index!);
    const between = text.slice(start, end);
    // Bind the completion verb to the power, not another item elsewhere in a compound message.
    return between.length <= 65 && !/[.;!?]|\b(?:acuerdo|contrato|reclamacion|demanda|certificado|solicitud|prestamo|transferencia|que|porque)\b/.test(between);
  }));
}

/**
 * Intentionally conservative: ambiguous statements remain a conversation, not a terminal fact.
 * Questions, negatives, future plans, quoted reports and lender payments cannot close APUD v1.
 * An omitted subject is accepted only in an established matching workflow step.
 */
export function phaseOneReportedOutcome(text: string, context: PhaseOneIntentContext = {}): PhaseOneReportedOutcome | null {
  if (!text.trim() || text.length > 4000 || /[?¿"“”«»]/.test(text)) return null;
  const n = normalize(text);
  if (/\b(?:no|nunca|todavia|aun|not|never|havent|hasnt|didnt|dont|cannot|cant|if|cuando|si|ojala)\b/.test(n)) return null;
  if (/\b(?:voy a|vamos a|quiero|queremos|prefiero|necesito|tengo que|falta|pendiente|intent|hare|pagare|firmare|manana|proximamente|will|going to|want to|need to|plan to|tomorrow)\b/.test(n)) return null;
  if (/\b(?:me (?:dijeron|dicen|han dicho)|dice que|dijiste|me pregunta|he leido|mi (?:madre|padre|hijo|hija|pareja|amigo|amiga)|mi cliente|el cliente|su cliente)\b/.test(n)) return null;
  if (/\b(?:creo|supongo|se supone|imagino|tal vez|quizas|puede que|i think|i guess|maybe|perhaps)\b/.test(n)) return null;
  const state = context.currentState ?? '';
  const explicitPower = POWER.test(n);

  if (PAID.test(n)) {
    // A paid loan, invoice or FNMT certificate is a separate matter even during the payment step.
    if (/\b(?:prestamo|deuda|credito|cuota|banco|financiera|factura|honorarios|perito|peritaje|reclamacion|fnmt|certificado|loan|debt|lender|invoice)\b/.test(n)) return null;
    if (explicitPower || /\b(?:apudata|empresa colaboradora|proveedor del apoderamiento)\b/.test(n)
      || PAYMENT_STEPS.has(state) && /^(?:ya (?:lo )?(?:he pagado|pague)|he pagado|i (?:have |already )?paid|ive paid)[.! ]*$/.test(n)) return 'PAYMENT_REPORTED';
    return null;
  }

  const completed = explicitlyCompletedPower(n);
  const shortCompleted = POWER_STEPS.has(state) && SHORT_COMPLETION.test(n);
  if (!completed && !shortCompleted) return null;
  // Merely obtaining a certificate, appointment or access code is not completing the power.
  if (/\b(?:certificado|certificate|cita|appointment|codigo|code|solicitud|application)\b/.test(n) && !explicitPower) return null;
  if (COURT.test(n) && completed || state === COURT_STEP && shortCompleted) return 'COURT_REPORTED';
  if (completed || shortCompleted) return 'SELF_COMPLETED_REPORTED';
  return null;
}
