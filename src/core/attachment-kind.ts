import { extractPdfText } from './pdf-auditor.js';

/**
 * What a received file really is, decided from its bytes rather than from the name or the type label
 * the sender's phone attached. A certificate sent as "document.bin", a PDF renamed ".jpg" or a
 * screenshot sent as a document are all common on WhatsApp.
 */
export type AttachmentKind = 'PDF' | 'CERTIFICATE' | 'IMAGE' | 'OFFICE' | 'ARCHIVE' | 'HTML' | 'OTHER';

const startsWith = (b: Buffer, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
// OID 1.2.840.113549.1.7.1 (PKCS#7 data), which every PKCS#12 AuthenticatedSafe carries.
const PKCS7_DATA_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);

export function sniffAttachment(bytes: Buffer): AttachmentKind {
  if (!bytes.length) return 'OTHER';
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'PDF';
  // PKCS#12: a DER SEQUENCE whose first element is INTEGER 3 (version), with PKCS#7 data inside.
  if (bytes[0] === 0x30) {
    const lengthBytes = bytes[1]! & 0x80 ? (bytes[1]! & 0x7f) : 0;
    const versionAt = 2 + lengthBytes;
    if (startsWith(bytes, [0x02, 0x01, 0x03], versionAt) && bytes.subarray(0, 64).includes(PKCS7_DATA_OID)) return 'CERTIFICATE';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
    || (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    || (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(?:heic|heix|hevc|mif1|msf1|avif)$/.test(bytes.subarray(8, 12).toString('latin1')))) return 'IMAGE';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'OFFICE';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return /word\/|xl\/|ppt\//.test(bytes.subarray(0, 4096).toString('latin1')) ? 'OFFICE' : 'ARCHIVE';
  if (/^\s*<(?:!doctype html|html)/i.test(bytes.subarray(0, 256).toString('utf8'))) return 'HTML';
  return 'OTHER';
}

export type PdfKind = 'APUD_ACTA' | 'FIRM_GUIDE' | 'NO_TEXT' | 'UNREADABLE' | 'OTHER';
export interface PdfReading { kind: PdfKind; pages: number | null; hint: string | null }

/**
 * Whether a PDF is the apud acta justificante from the Sede. Measured on the firm's real WhatsApp
 * export (24 Sep): justificantes carry poderdante, apoderado, procurador and facultades together
 * (135-143 of 150); other PDFs almost never do. The legal check itself stays with PdfAuditor.
 */
export function classifyPdfText(text: string): Exclude<PdfKind, 'UNREADABLE'> {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (t.replace(/\s+/g, '').length < 60) return 'NO_TEXT';
  // The guide's text layer comes out letter-spaced ("c o mo"), so it is matched with spaces removed.
  const squeezed = t.replace(/\s+/g, '');
  if (/comopoderrealizarelapoderamiento|listadodeldespachoparaeltutorial|accedaatravesdelaopcioncertificadodigital/.test(squeezed)) return 'FIRM_GUIDE';
  const signals = [/poderdante/, /apoderad[oa]/, /procurador/, /facultades/, /apud\s*acta/].filter(r => r.test(t)).length;
  return signals >= 4 ? 'APUD_ACTA' : 'OTHER';
}

/** A few words for the brain about what another PDF seems to be; never names or numbers from it. */
function otherPdfHint(text: string): string | null {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const kinds: Array<[RegExp, string]> = [
    [/contrato de (?:prestamo|credito)|condiciones (?:generales|particulares)/, 'un contrato de préstamo o crédito'],
    [/factura/, 'una factura'], [/extracto|movimientos/, 'un extracto bancario'], [/burofax|requerimiento de pago|reclamacion de deuda/, 'una carta de reclamación de deuda'],
    [/documento nacional de identidad|numero de soporte/, 'un documento de identidad'], [/sentencia|juzgado de|auto\b|decreto/, 'un documento judicial'],
  ];
  return kinds.find(([re]) => re.test(t))?.[1] ?? null;
}

export async function readPdf(bytes: Buffer): Promise<PdfReading> {
  try {
    const { text, pageCount } = await extractPdfText(new Uint8Array(bytes), 8000);
    const kind = classifyPdfText(text);
    return { kind, pages: pageCount, hint: kind === 'OTHER' ? otherPdfHint(text) : null };
  } catch {
    return { kind: 'UNREADABLE', pages: null, hint: null };
  }
}
