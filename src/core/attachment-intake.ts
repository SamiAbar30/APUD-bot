import { sniffAttachment, readPdf } from './attachment-kind.js';
import { CertInspector, CertificateRejectionReason } from './cert-inspector.js';
import { redactConversationPii } from './conversation-policy.js';
import type { CredentialVault } from '../infrastructure/credential-vault.js';
import { imageMimeFromBytes, type OpenAIVisionReader } from '../adapters/ai/openai-vision.js';

/**
 * What the office does with a file a client sends on WhatsApp. It is downloaded once, identified by
 * its bytes, and turned into something the conversation can use:
 * - the apud acta justificante goes to the existing PDF audit;
 * - a certificate is kept encrypted and checked against its password (never shown to any model);
 * - a screenshot is described in words by the vision model (the image itself is not kept);
 * - anything else gets a plain explanation of why we cannot use it.
 * The brain only ever sees the resulting line of text.
 */
export type CertificateCheck = 'OK' | 'WAITING_PASSWORD' | 'WAITING_CERTIFICATE' | 'PASSWORD_INVALID' | 'EXPIRED' | 'OTHER_PERSON' | 'NOT_USABLE';
export type IntakeResult =
  | { route: 'APUD_PDF'; marker: string }
  | { route: 'TEXT'; marker: string }
  | { route: 'CERTIFICATE'; marker: string; check: CertificateCheck };

export interface MediaSource { download(mediaId: string): Promise<{ content: Buffer; mimeType: string }> }
export interface MediaPayload { mediaId?: unknown; mediaType?: unknown; filename?: unknown; caption?: unknown }

export const certificateMarker = (check: CertificateCheck, validTo?: Date | null) =>
  `[CERTIFICADO:${check}${validTo ? `:${validTo.toISOString().slice(0, 10)}` : ''}]`;

export class AttachmentIntake {
  constructor(private readonly deps: { media: MediaSource; vault: CredentialVault | null; vision: OpenAIVisionReader | null }) {}

  async read(c: { id: string; dni: string }, payload: MediaPayload): Promise<IntakeResult> {
    const caption = typeof payload.caption === 'string' && payload.caption.trim() ? ` El cliente escribió con el archivo: «${redactConversationPii(payload.caption).slice(0, 300)}».` : '';
    if (typeof payload.mediaId !== 'string') return { route: 'TEXT', marker: `[Adjunto del cliente: nota de voz, vídeo o sticker; no se puede escuchar ni ver.]${caption}` };
    let file: { content: Buffer; mimeType: string };
    try { file = await this.deps.media.download(payload.mediaId); }
    catch { return { route: 'TEXT', marker: `[Adjunto del cliente: no se ha podido descargar el archivo.]${caption}` }; }
    const bytes = file.content;
    try {
      const kind = sniffAttachment(bytes);
      if (kind === 'PDF') {
        const pdf = await readPdf(bytes);
        if (pdf.kind === 'APUD_ACTA') return { route: 'APUD_PDF', marker: `[Adjunto del cliente: PDF que parece el justificante del apud acta (${pdf.pages ?? '?'} páginas). El sistema lo está revisando.]${caption}` };
        const what = pdf.kind === 'FIRM_GUIDE' ? 'es la guía del despacho que le enviamos, no el justificante firmado'
          : pdf.kind === 'NO_TEXT' ? 'es un PDF escaneado o una foto en PDF, sin texto; no sirve como justificante, hace falta el PDF original que descarga la Sede'
          : pdf.kind === 'UNREADABLE' ? 'es un PDF que no se puede abrir (dañado o protegido)'
          : `es un PDF que no es el justificante del apud acta${pdf.hint ? ` (parece ${pdf.hint})` : ''}`;
        return { route: 'TEXT', marker: `[Adjunto del cliente: ${what}.]${caption}` };
      }
      if (kind === 'CERTIFICATE') {
        if (!this.deps.vault) return { route: 'CERTIFICATE', marker: certificateMarker('NOT_USABLE'), check: 'NOT_USABLE' };
        await this.deps.vault.savePending(c.id, 'certificate', bytes);
        const result = await this.checkPair(c);
        return { route: 'CERTIFICATE', marker: certificateMarker(result.check, result.validTo), check: result.check };
      }
      if (kind === 'IMAGE') {
        const mime = imageMimeFromBytes(bytes);
        const seen = mime && this.deps.vision ? await this.deps.vision.read(bytes, mime) : null;
        if (!seen) return { route: 'TEXT', marker: `[Adjunto del cliente: una imagen que no se ha podido ver${mime ? '' : ' (formato no compatible, por ejemplo HEIC)'}.]${caption}` };
        if (seen.kind === 'DOCUMENTO_IDENTIDAD') return { route: 'TEXT', marker: `[Adjunto del cliente: foto de un documento de identidad. No se ha guardado ni se usa; no hace falta para el apoderamiento.]${caption}` };
        const visible = seen.visibleText ? ` Texto en pantalla: «${redactConversationPii(seen.visibleText)}».` : '';
        return { route: 'TEXT', marker: `[Adjunto del cliente: imagen (${seen.kind}). ${redactConversationPii(seen.description)}${visible}]${caption}` };
      }
      const what = kind === 'OFFICE' ? 'un documento de Word o Excel' : kind === 'ARCHIVE' ? 'un archivo comprimido (ZIP)' : kind === 'HTML' ? 'una página web guardada' : 'un tipo de archivo que no se puede abrir';
      return { route: 'TEXT', marker: `[Adjunto del cliente: ${what}; no lo podemos usar. Si es el justificante, hace falta en PDF.]${caption}` };
    } finally {
      bytes.fill(0);
    }
  }

  /** Keep a password that just arrived, encrypted, for the check that runs with the conversation turn. */
  async storePassword(c: { id: string }, candidates: string[]): Promise<void> {
    if (!this.deps.vault || !candidates.length) return;
    await this.deps.vault.savePending(c.id, 'password', Buffer.from(JSON.stringify(candidates.slice(0, 6))));
  }

  async checkPair(c: { id: string; dni: string }): Promise<{ check: CertificateCheck; validTo?: Date | null }> {
    const vault = this.deps.vault;
    if (!vault) return { check: 'NOT_USABLE' };
    const certificate = await vault.readPending(c.id, 'certificate');
    const passwordBlob = await vault.readPending(c.id, 'password');
    if (!certificate) { passwordBlob?.fill(0); return { check: 'WAITING_CERTIFICATE' }; }
    if (!passwordBlob) { certificate.fill(0); return { check: 'WAITING_PASSWORD' }; }
    let candidates: string[] = [];
    try { candidates = JSON.parse(passwordBlob.toString('utf8')) as string[]; } catch { /* unreadable slot */ } finally { passwordBlob.fill(0); }
    try {
      let lastReasons: CertificateRejectionReason[] = [];
      for (const password of candidates) {
        const inspection = await CertInspector.inspect({ pfx: Buffer.from(certificate), password, expectedDni: c.dni });
        if (!inspection.passwordValid) { lastReasons = inspection.reasons; continue; }
        if (inspection.expired) return { check: 'EXPIRED', validTo: inspection.validTo };
        if (inspection.reasons.includes(CertificateRejectionReason.IDENTITY_MISMATCH)) return { check: 'OTHER_PERSON' };
        if (!inspection.usable) return { check: 'NOT_USABLE' };
        // The pair works: keep it as the office's record and drop the waiting slots.
        await vault.save(c.id, certificate, Buffer.from(password));
        await vault.clearPending(c.id);
        return { check: 'OK', validTo: inspection.validTo };
      }
      return { check: lastReasons.includes(CertificateRejectionReason.NOT_PKCS12) ? 'NOT_USABLE' : 'PASSWORD_INVALID' };
    } finally {
      certificate.fill(0);
    }
  }
}

/**
 * The values in a message that could be the certificate password: what follows a label
 * ("contraseña: X", "la clave es X") and, for a message that is only one word, the word itself.
 */
export function passwordCandidates(text: string): string[] {
  const out = new Set<string>();
  // Passwords often end in "!" or "."; try the value as written and without surrounding punctuation.
  const add = (raw: string) => { const trimmed = raw.replace(/^[«"'“(]+|[»"'”)]+$/g, ''); out.add(trimmed); out.add(trimmed.replace(/[.,;:!?]+$/, '')); };
  for (const m of text.matchAll(/(?:contrase[ñn]a|password|clave|pass|pin)\b[^\n]{0,30}?(?:\bes\b|[:=]|\s)\s*(\S{3,64})/gi)) add(m[1]!);
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && words[0]!.length >= 3) add(words[0]!);
  for (const w of words) if (w.length >= 6 && /\d/.test(w) && /[a-z]/i.test(w)) add(w);
  return [...out].filter(v => v.length >= 3 && !/^(?:del|mi|es|el|la|de|certificado)$/i.test(v));
}
