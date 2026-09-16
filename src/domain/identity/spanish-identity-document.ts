/**
 * Spanish identity document parsing (DNI / NIE) with check-letter validation.
 *
 * Algorithm (official): the numeric part modulo 23 indexes the letter table
 * `TRWAGMYFPDXBNJZSQVHLCKE`. For NIE the leading letter X/Y/Z is replaced by 0/1/2 before
 * computing the remainder. Everything here is deterministic and side-effect free.
 */

export enum IdentityDocumentType {
  DNI = 'DNI',
  NIE = 'NIE',
  UNKNOWN = 'UNKNOWN',
}

export interface ParsedIdentityDocument {
  /** Canonical upper-case value without separators, e.g. `12345678Z` or `X1234567L`. */
  normalized: string;
  type: IdentityDocumentType;
  /** True only when the format is recognised AND the check letter is correct. */
  valid: boolean;
  /** Present when the format is recognised but the letter does not match. */
  expectedLetter?: string;
}

const CHECK_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const DNI_REGEX = /^(\d{8})([A-Z])$/;
const NIE_REGEX = /^([XYZ])(\d{7})([A-Z])$/;

/** Upper-cases and removes spaces, dots and dashes. Also strips FNMT `IDCES-` style prefixes. */
export function normalizeIdentityDocument(raw: string): string {
  const upper = raw.toUpperCase().replace(/^IDC[A-Z]{2}[-\s]?/, '');
  return upper.replace(/[\s.\-_/]/g, '');
}

function checkLetter(numeric: string): string {
  const remainder = Number.parseInt(numeric, 10) % 23;
  return CHECK_LETTERS.charAt(remainder);
}

/** Parses any string that should contain exactly one DNI or NIE. */
export function parseSpanishIdentityDocument(raw: string): ParsedIdentityDocument {
  const normalized = normalizeIdentityDocument(raw);

  const dni = DNI_REGEX.exec(normalized);
  if (dni) {
    const numeric = dni[1] ?? '';
    const letter = dni[2] ?? '';
    const expected = checkLetter(numeric);
    return { normalized, type: IdentityDocumentType.DNI, valid: expected === letter, expectedLetter: expected };
  }

  const nie = NIE_REGEX.exec(normalized);
  if (nie) {
    const prefix = nie[1] ?? '';
    const digits = nie[2] ?? '';
    const letter = nie[3] ?? '';
    const prefixDigit = prefix === 'X' ? '0' : prefix === 'Y' ? '1' : '2';
    const expected = checkLetter(prefixDigit + digits);
    return { normalized, type: IdentityDocumentType.NIE, valid: expected === letter, expectedLetter: expected };
  }

  return { normalized, type: IdentityDocumentType.UNKNOWN, valid: false };
}

/** True when `raw` is a well-formed DNI or NIE with a correct check letter. */
export function isValidSpanishIdentityDocument(raw: string): boolean {
  return parseSpanishIdentityDocument(raw).valid;
}

/**
 * Tolerant patterns for identity documents embedded in prose: allow dots/spaces inside the
 * digit groups and an optional dash/space before the letter. Candidates are validated with
 * the check letter, so false positives from arbitrary 8-digit numbers are discarded.
 */
const DNI_IN_TEXT = /(?<![0-9A-Z])(\d{1,2}[.\s]?\d{3}[.\s]?\d{3})[\s\-–]?([A-Za-z])(?![0-9A-Za-z])/g;
const NIE_IN_TEXT = /(?<![0-9A-Z])([XYZxyz])[\s\-–.]?(\d{7}|\d[.\s]?\d{3}[.\s]?\d{3})[\s\-–]?([A-Za-z])(?![0-9A-Za-z])/g;

/**
 * Finds every VALID DNI/NIE inside free text. Returns unique canonical values in order of
 * first appearance. Invalid check letters are ignored (they are not identity documents).
 */
export function findIdentityDocumentsInText(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(DNI_IN_TEXT)) {
    const digits = (match[1] ?? '').replace(/[.\s]/g, '');
    if (digits.length !== 8) continue;
    const parsed = parseSpanishIdentityDocument(digits + (match[2] ?? ''));
    if (parsed.valid) found.add(parsed.normalized);
  }

  for (const match of text.matchAll(NIE_IN_TEXT)) {
    const digits = (match[2] ?? '').replace(/[.\s]/g, '');
    if (digits.length !== 7) continue;
    const parsed = parseSpanishIdentityDocument((match[1] ?? '') + digits + (match[3] ?? ''));
    if (parsed.valid) found.add(parsed.normalized);
  }

  return [...found];
}

/**
 * Strict identity comparison: both sides must be VALID documents and equal after
 * normalisation. An invalid expected value never matches anything (fail-closed).
 */
export function identityDocumentsEqual(expected: string, candidate: string): boolean {
  const a = parseSpanishIdentityDocument(expected);
  const b = parseSpanishIdentityDocument(candidate);
  return a.valid && b.valid && a.normalized === b.normalized;
}

/** Masks all but the last three characters for logs (`*****78Z`). */
export function maskIdentityDocument(raw: string): string {
  const normalized = normalizeIdentityDocument(raw);
  if (normalized.length <= 3) return '***';
  return '*'.repeat(normalized.length - 3) + normalized.slice(-3);
}
