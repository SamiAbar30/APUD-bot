/**
 * Catalogue of litigation powers the firm requires in an apoderamiento apud acta
 * (poder general para pleitos plus the special powers of art. 25.2 LEC).
 *
 * Detection is purely lexical and deterministic. It supports two outcomes per power:
 *   - present:  at least one positive mention that is NOT preceded by a negation cue;
 *   - negated:  mentions exist but every one is preceded by a negation cue
 *               ("sin facultad de allanarse", "se excluye la renuncia", ...).
 * A negated power counts as MISSING and additionally forces human review. Lexical checks
 * never establish legal authenticity or validity; they only gate the workflow.
 */

export enum LegalPowerKey {
  PODER_GENERAL_PLEITOS = 'PODER_GENERAL_PLEITOS',
  ALLANAMIENTO = 'ALLANAMIENTO',
  DESISTIMIENTO = 'DESISTIMIENTO',
  TRANSACCION = 'TRANSACCION',
  RENUNCIA = 'RENUNCIA',
  COBRO_MANDAMIENTOS_PAGO = 'COBRO_MANDAMIENTOS_PAGO',
}

export interface LegalPowerDefinition {
  key: LegalPowerKey;
  /** Spanish label for operator-facing messages. */
  label: string;
  /** Legal basis reference (informational). */
  basis: string;
  /** Patterns evaluated against `normalizeForMatch(text)` (lower-case, no diacritics, single spaces). */
  positive: readonly RegExp[];
}

/** Ordered catalogue; order is used for stable `missingPowers` output. */
export const REQUIRED_POWERS: readonly LegalPowerDefinition[] = Object.freeze([
  {
    key: LegalPowerKey.PODER_GENERAL_PLEITOS,
    label: 'Poder general para pleitos',
    basis: 'Art. 25.1 LEC',
    positive: [/poder general para pleitos/g, /poder general (?:de|para) (?:representacion|pleitos)/g, /para pleitos/g],
  },
  {
    key: LegalPowerKey.ALLANAMIENTO,
    label: 'Allanamiento',
    basis: 'Art. 25.2.1º LEC',
    positive: [/allanamiento/g, /allanarse/g, /allanar/g],
  },
  {
    key: LegalPowerKey.DESISTIMIENTO,
    label: 'Desistimiento',
    basis: 'Art. 25.2.1º LEC',
    positive: [/desistimiento/g, /desistir/g],
  },
  {
    key: LegalPowerKey.TRANSACCION,
    label: 'Transacción',
    basis: 'Art. 25.2.1º LEC',
    positive: [/transaccion/g, /transigir/g, /transacciones/g],
  },
  {
    key: LegalPowerKey.RENUNCIA,
    label: 'Renuncia',
    basis: 'Art. 25.2.1º LEC',
    positive: [/renuncia\b/g, /renunciar/g, /renuncias/g],
  },
  {
    key: LegalPowerKey.COBRO_MANDAMIENTOS_PAGO,
    label: 'Cobro y mandamientos de pago',
    basis: 'Facultad especial de cobro (práctica del despacho)',
    positive: [/mandamientos? de pago/g, /cobro/g, /cobrar/g, /percibir/g, /percepcion de cantidades/g],
  },
]);

/**
 * Negation cues that, when found in the window immediately preceding a mention, mark that
 * mention as negated. Evaluated on normalised text.
 */
export const NEGATION_CUES: readonly RegExp[] = Object.freeze([
  /\bno\b/,
  /\bsin\b/,
  /\bsalvo\b/,
  /\bexcepto\b/,
  /\bexclu\w*/,
  /\bexcluid\w*/,
  /\bniega\b/,
  /\bprohib\w*/,
  /\brevoc\w*/,
  /\bno se (?:concede|otorga|confiere|incluye)\b/,
  /\bqueda\w* excluid\w*/,
  /\bcarece\w* de\b/,
]);

/** Characters of preceding context inspected for negation cues. */
export const NEGATION_WINDOW_CHARS = 48;

export interface PowerDetection {
  key: LegalPowerKey;
  /** Number of positive mentions found. */
  mentions: number;
  /** Mentions that were NOT preceded by a negation cue. */
  affirmativeMentions: number;
  present: boolean;
  negated: boolean;
  /** Normalised text snippet of the first affirmative (or first) mention. */
  evidence: string | null;
}

export interface PowersDetectionResult {
  detections: readonly PowerDetection[];
  missing: readonly LegalPowerKey[];
  negated: readonly LegalPowerKey[];
}

function isNegatedAt(normalized: string, index: number): boolean {
  const window = normalized.slice(Math.max(0, index - NEGATION_WINDOW_CHARS), index);
  return NEGATION_CUES.some((cue) => cue.test(window));
}

/**
 * Detects required powers in ALREADY NORMALISED text (see `normalizeForMatch`).
 * Deterministic: same input, same output.
 */
export function detectPowers(normalizedText: string): PowersDetectionResult {
  const detections: PowerDetection[] = [];
  const missing: LegalPowerKey[] = [];
  const negated: LegalPowerKey[] = [];

  for (const power of REQUIRED_POWERS) {
    let mentions = 0;
    let affirmative = 0;
    let firstAffirmativeEvidence: string | null = null;
    let firstEvidence: string | null = null;

    for (const pattern of power.positive) {
      const re = new RegExp(pattern.source, 'g');
      for (const match of normalizedText.matchAll(re)) {
        const index = match.index ?? 0;
        mentions += 1;
        const snippet = normalizedText.slice(Math.max(0, index - 40), Math.min(normalizedText.length, index + 60));
        firstEvidence ??= snippet;
        if (!isNegatedAt(normalizedText, index)) {
          affirmative += 1;
          firstAffirmativeEvidence ??= snippet;
        }
      }
    }

    const present = affirmative > 0;
    const isNegated = mentions > 0 && affirmative === 0;
    detections.push({
      key: power.key,
      mentions,
      affirmativeMentions: affirmative,
      present,
      negated: isNegated,
      evidence: firstAffirmativeEvidence ?? firstEvidence,
    });
    if (!present) missing.push(power.key);
    if (isNegated) negated.push(power.key);
  }

  return { detections, missing, negated };
}

export function powerLabel(key: LegalPowerKey): string {
  return REQUIRED_POWERS.find((p) => p.key === key)?.label ?? key;
}
