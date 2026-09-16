/**
 * Deterministic structural audit of an apoderamiento apud acta PDF.
 *
 * `PdfAuditor.audit(buffer, options)` returns the report shape fixed in docs/ARCHITECTURE.md:
 *   isValid, pageCount, hasAiram, missingPowers, canViabilize, identityMatches,
 *   requiresHumanReview, sha256, status, extractedText
 * `extractedText` is personal data: never log it, never persist it (the orchestrator strips it).
 * `auditDetailed()` additionally returns machine-readable reasons for operators and the real
 * verification runner.
 *
 * What this module does NOT do: it never establishes legal authenticity, signature validity or
 * legal sufficiency. Lexical checks gate the workflow; a human operator approves every filing.
 * Policy constants (exactly five pages, provisional only below five pages) are the firm's
 * internal heuristics, not legal guarantees.
 *
 * Fail-closed choices
 *   - No configured Airam full name  => hasAiram=false (a bare first name is not evidence).
 *   - No/invalid expected identity   => identityMatches=false.
 *   - Negated powers ("sin facultad de allanarse") count as missing and force human review.
 *   - Encrypted, corrupt, image-only or oversized files => UNREADABLE_OR_CORRUPT.
 */

import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AuditStatus } from '../domain/models/expediente.js';
import { LegalPowerKey, REQUIRED_POWERS, detectPowers } from '../domain/legal/powers.js';
import { collapseWhitespace, normalizeForMatch, tokens } from '../domain/text/normalize.js';
import {
  findIdentityDocumentsInText,
  identityDocumentsEqual,
  maskIdentityDocument,
  parseSpanishIdentityDocument,
} from '../domain/identity/spanish-identity-document.js';
import { InvalidArgumentError } from '../domain/errors/index.js';

/** Firm policy constants (heuristics, not law). */
export const PDF_AUDIT_POLICY = Object.freeze({
  /** A complete apoderamiento with every power and representative prints on exactly five pages. */
  REQUIRED_PAGE_COUNT: 5,
  /** Fewer tokens than this means there is no usable text layer (scan without OCR). */
  MIN_TEXT_TOKENS: 40,
  /** Pages beyond this are counted but not text-extracted (bounded CPU). */
  MAX_TEXT_PAGES: 60,
  DEFAULT_MAX_BYTES: 30_000_000,
  DEFAULT_TIMEOUT_MS: 30_000,
});

export interface PdfAuditOptions {
  /** DNI/NIE of the client; identity check is fail-closed when absent or invalid. */
  expectedDni?: string;
  /** Full name of the essential procurador as configured by the firm (AIRAM_FULL_NAME). */
  airamFullName?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Exact report shape (binding interface). */
export interface AuditReport {
  isValid: boolean;
  pageCount: number;
  hasAiram: boolean;
  /** `LegalPowerKey` values not affirmatively present (negated ones included). */
  missingPowers: string[];
  canViabilize: boolean;
  identityMatches: boolean;
  requiresHumanReview: boolean;
  sha256: string;
  status: AuditStatus;
  /** Full extracted text. Personal data: never log, never persist. */
  extractedText: string;
}

export enum AuditReason {
  NOT_A_PDF = 'NOT_A_PDF',
  OVERSIZED = 'OVERSIZED',
  ENCRYPTED = 'ENCRYPTED',
  PARSE_FAILED = 'PARSE_FAILED',
  TIMEOUT = 'TIMEOUT',
  NO_PAGES = 'NO_PAGES',
  NO_TEXT_LAYER = 'NO_TEXT_LAYER',
  TEXT_EXTRACTION_TRUNCATED = 'TEXT_EXTRACTION_TRUNCATED',
  PAGE_COUNT_MISMATCH_BETWEEN_PARSERS = 'PAGE_COUNT_MISMATCH_BETWEEN_PARSERS',
  PAGE_COUNT_NOT_FIVE = 'PAGE_COUNT_NOT_FIVE',
  PAGE_COUNT_OVER_FIVE = 'PAGE_COUNT_OVER_FIVE',
  EXPECTED_IDENTITY_MISSING = 'EXPECTED_IDENTITY_MISSING',
  EXPECTED_IDENTITY_INVALID = 'EXPECTED_IDENTITY_INVALID',
  IDENTITY_NOT_FOUND = 'IDENTITY_NOT_FOUND',
  AIRAM_NAME_NOT_CONFIGURED = 'AIRAM_NAME_NOT_CONFIGURED',
  AIRAM_NOT_FOUND = 'AIRAM_NOT_FOUND',
  POWERS_MISSING = 'POWERS_MISSING',
  POWERS_NEGATED = 'POWERS_NEGATED',
}

export interface AuditDetails {
  reasons: AuditReason[];
  negatedPowers: string[];
  powers: { key: LegalPowerKey; present: boolean; negated: boolean; mentions: number }[];
  /** Masked (`*****78Z`) valid identity documents found in the text. */
  identityDocumentsFound: string[];
  airamMatch: 'FULL_NAME' | 'NOT_FOUND' | 'NOT_CONFIGURED';
  /** Page count reported by pdf-lib, or null when it could not parse the file. */
  pageCountCrossCheck: number | null;
  encrypted: boolean;
  textTokens: number;
  pagesScanned: number;
  durationMs: number;
}

export interface DetailedAuditResult {
  report: AuditReport;
  details: AuditDetails;
}

const ALL_POWER_KEYS: string[] = REQUIRED_POWERS.map((p) => p.key);
const NAME_PARTICLES: ReadonlySet<string> = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'dos', 'das', 'van', 'von', 'di', 'san']);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

interface Extraction {
  pageCount: number;
  text: string;
  pagesScanned: number;
}

class ExtractionFailure extends Error {
  constructor(readonly reason: AuditReason, message: string) {
    super(message);
    this.name = 'ExtractionFailure';
  }
}

function classifyPdfjsError(error: unknown): AuditReason {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === 'PasswordException' || message.includes('password')) return AuditReason.ENCRYPTED;
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'MissingPDFException' || message.includes('invalid pdf')) return AuditReason.PARSE_FAILED;
  return AuditReason.PARSE_FAILED;
}

async function extractText(bytes: Uint8Array, timeoutMs: number): Promise<Extraction> {
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void task.destroy().catch(() => undefined);
      reject(new ExtractionFailure(AuditReason.TIMEOUT, `PDF processing exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
  });

  const work = (async (): Promise<Extraction> => {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await task.promise;
    } catch (error) {
      throw new ExtractionFailure(classifyPdfjsError(error), 'PDF could not be opened');
    }
    try {
      const pageCount = doc.numPages;
      const limit = Math.min(pageCount, PDF_AUDIT_POLICY.MAX_TEXT_PAGES);
      const parts: string[] = [];
      for (let index = 1; index <= limit; index += 1) {
        const page = await doc.getPage(index);
        try {
          const content = await page.getTextContent();
          for (const item of content.items) {
            if ('str' in item) {
              parts.push(item.str);
              parts.push(item.hasEOL ? '\n' : ' ');
            }
          }
          parts.push('\n');
        } finally {
          page.cleanup();
        }
      }
      return { pageCount, text: parts.join(''), pagesScanned: limit };
    } catch (error) {
      if (error instanceof ExtractionFailure) throw error;
      throw new ExtractionFailure(classifyPdfjsError(error), 'PDF text extraction failed');
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function crossCheckPageCount(buffer: Buffer): Promise<{ pageCount: number | null; encrypted: boolean }> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    return { pageCount: doc.getPageCount(), encrypted: doc.isEncrypted };
  } catch {
    return { pageCount: null, encrypted: false };
  }
}

/** All name tokens (minus particles) must appear within a short token window, any order. */
export function matchesFullName(normalizedText: string, fullName: string): boolean {
  const nameTokens = [...new Set(tokens(normalizeForMatch(fullName)).filter((t) => !NAME_PARTICLES.has(t) && t.length > 1))];
  if (nameTokens.length < 2) return false;
  const textTokens = tokens(normalizedText);
  const window = nameTokens.length + 3;
  const first = new Set(nameTokens);
  for (let i = 0; i < textTokens.length; i += 1) {
    const token = textTokens[i];
    if (token === undefined || !first.has(token)) continue;
    const slice = new Set(textTokens.slice(i, i + window));
    if (nameTokens.every((t) => slice.has(t))) return true;
  }
  return false;
}

function unreadable(sha256: string, reasons: AuditReason[], details: Omit<AuditDetails, 'reasons' | 'negatedPowers' | 'powers' | 'identityDocumentsFound' | 'airamMatch'>, pageCount: number): DetailedAuditResult {
  return {
    report: {
      isValid: false,
      pageCount,
      hasAiram: false,
      missingPowers: [...ALL_POWER_KEYS],
      canViabilize: false,
      identityMatches: false,
      requiresHumanReview: true,
      sha256,
      status: AuditStatus.UNREADABLE_OR_CORRUPT,
      extractedText: '',
    },
    details: { ...details, reasons, negatedPowers: [], powers: [], identityDocumentsFound: [], airamMatch: 'NOT_CONFIGURED' },
  };
}

export class PdfAuditor {
  /** Binding interface: exact report shape, never throws for document problems. */
  static async audit(buffer: Buffer, options: PdfAuditOptions = {}): Promise<AuditReport> {
    return (await PdfAuditor.auditDetailed(buffer, options)).report;
  }

  /** Report plus machine-readable reasons (for operators and the real verification runner). */
  static async auditDetailed(buffer: Buffer, options: PdfAuditOptions = {}): Promise<DetailedAuditResult> {
    if (!Buffer.isBuffer(buffer)) throw new InvalidArgumentError('PdfAuditor.audit expects a Buffer');
    const startedAt = Date.now();
    const maxBytes = options.maxBytes ?? PDF_AUDIT_POLICY.DEFAULT_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? PDF_AUDIT_POLICY.DEFAULT_TIMEOUT_MS;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const base = { pageCountCrossCheck: null as number | null, encrypted: false, textTokens: 0, pagesScanned: 0, durationMs: 0 };

    if (buffer.length === 0 || !buffer.subarray(0, 1024).includes(PDF_MAGIC)) {
      return unreadable(sha256, [AuditReason.NOT_A_PDF], { ...base, durationMs: Date.now() - startedAt }, 0);
    }
    if (buffer.length > maxBytes) {
      return unreadable(sha256, [AuditReason.OVERSIZED], { ...base, durationMs: Date.now() - startedAt }, 0);
    }

    const cross = await crossCheckPageCount(buffer);
    let extraction: Extraction;
    try {
      extraction = await extractText(new Uint8Array(buffer), timeoutMs);
    } catch (error) {
      const reason = error instanceof ExtractionFailure ? error.reason : AuditReason.PARSE_FAILED;
      const reasons = [reason];
      if (cross.encrypted && reason !== AuditReason.ENCRYPTED) reasons.push(AuditReason.ENCRYPTED);
      return unreadable(sha256, reasons, { ...base, pageCountCrossCheck: cross.pageCount, encrypted: cross.encrypted || reason === AuditReason.ENCRYPTED, durationMs: Date.now() - startedAt }, cross.pageCount ?? 0);
    }

    const reasons: AuditReason[] = [];
    const pageCount = extraction.pageCount;
    if (pageCount === 0) {
      return unreadable(sha256, [AuditReason.NO_PAGES], { ...base, pageCountCrossCheck: cross.pageCount, encrypted: cross.encrypted, durationMs: Date.now() - startedAt }, 0);
    }
    if (cross.pageCount !== null && cross.pageCount !== pageCount) reasons.push(AuditReason.PAGE_COUNT_MISMATCH_BETWEEN_PARSERS);
    if (extraction.pagesScanned < pageCount) reasons.push(AuditReason.TEXT_EXTRACTION_TRUNCATED);

    const extractedText = collapseWhitespace(extraction.text);
    const normalized = normalizeForMatch(extractedText);
    const textTokens = tokens(normalized).length;
    if (textTokens < PDF_AUDIT_POLICY.MIN_TEXT_TOKENS) {
      return unreadable(sha256, [AuditReason.NO_TEXT_LAYER, ...reasons], {
        ...base,
        pageCountCrossCheck: cross.pageCount,
        encrypted: cross.encrypted,
        textTokens,
        pagesScanned: extraction.pagesScanned,
        durationMs: Date.now() - startedAt,
      }, pageCount);
    }

    // ---- identity ------------------------------------------------------------------------
    const found = findIdentityDocumentsInText(extractedText);
    let identityMatches = false;
    if (!options.expectedDni || options.expectedDni.trim().length === 0) {
      reasons.push(AuditReason.EXPECTED_IDENTITY_MISSING);
    } else if (!parseSpanishIdentityDocument(options.expectedDni).valid) {
      reasons.push(AuditReason.EXPECTED_IDENTITY_INVALID);
    } else {
      identityMatches = found.some((candidate) => identityDocumentsEqual(options.expectedDni as string, candidate));
      if (!identityMatches) reasons.push(AuditReason.IDENTITY_NOT_FOUND);
    }

    // ---- Airam ---------------------------------------------------------------------------
    let airamMatch: AuditDetails['airamMatch'];
    let hasAiram = false;
    if (!options.airamFullName || options.airamFullName.trim().length === 0) {
      airamMatch = 'NOT_CONFIGURED';
      reasons.push(AuditReason.AIRAM_NAME_NOT_CONFIGURED);
    } else if (matchesFullName(normalized, options.airamFullName)) {
      airamMatch = 'FULL_NAME';
      hasAiram = true;
    } else {
      airamMatch = 'NOT_FOUND';
      reasons.push(AuditReason.AIRAM_NOT_FOUND);
    }

    // ---- powers --------------------------------------------------------------------------
    const powers = detectPowers(normalized);
    const missingPowers = powers.missing.map(String);
    const negatedPowers = powers.negated.map(String);
    if (missingPowers.length > 0) reasons.push(AuditReason.POWERS_MISSING);
    if (negatedPowers.length > 0) reasons.push(AuditReason.POWERS_NEGATED);

    // ---- page policy ---------------------------------------------------------------------
    const isFivePages = pageCount === PDF_AUDIT_POLICY.REQUIRED_PAGE_COUNT;
    if (!isFivePages) reasons.push(pageCount > PDF_AUDIT_POLICY.REQUIRED_PAGE_COUNT ? AuditReason.PAGE_COUNT_OVER_FIVE : AuditReason.PAGE_COUNT_NOT_FIVE);

    // ---- verdict -------------------------------------------------------------------------
    let status: AuditStatus;
    let isValid = false;
    let canViabilize = false;
    if (!hasAiram) {
      status = AuditStatus.DEFECTIVE_NO_AIRAM;
    } else if (isFivePages && missingPowers.length === 0 && identityMatches) {
      status = AuditStatus.VALID_FULL_5_PAGES;
      isValid = true;
    } else {
      status = AuditStatus.DEFECTIVE_WITH_AIRAM;
      canViabilize = identityMatches && pageCount < PDF_AUDIT_POLICY.REQUIRED_PAGE_COUNT;
    }
    const anomalies: ReadonlySet<AuditReason> = new Set([
      AuditReason.PAGE_COUNT_MISMATCH_BETWEEN_PARSERS,
      AuditReason.TEXT_EXTRACTION_TRUNCATED,
      AuditReason.EXPECTED_IDENTITY_MISSING,
      AuditReason.EXPECTED_IDENTITY_INVALID,
      AuditReason.POWERS_NEGATED,
    ]);
    const requiresHumanReview = !isValid || reasons.some((r) => anomalies.has(r));

    return {
      report: { isValid, pageCount, hasAiram, missingPowers, canViabilize, identityMatches, requiresHumanReview, sha256, status, extractedText },
      details: {
        reasons,
        negatedPowers,
        powers: powers.detections.map((d) => ({ key: d.key, present: d.present, negated: d.negated, mentions: d.mentions })),
        identityDocumentsFound: found.map(maskIdentityDocument),
        airamMatch,
        pageCountCrossCheck: cross.pageCount,
        encrypted: cross.encrypted,
        textTokens,
        pagesScanned: extraction.pagesScanned,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

/** Log-safe projection: everything except the extracted text. */
export function redactAuditReport(report: AuditReport): Omit<AuditReport, 'extractedText'> {
  const { extractedText: _text, ...safe } = report;
  return safe;
}
