import type { DocumentType } from './expediente.js';

/** Persisted document metadata (never the bytes, never extracted text). */
export interface Documento {
  id: string;
  expedienteId: string;
  documentType: DocumentType | string;
  /** Private, content-addressed storage location. */
  storagePath: string;
  /** SHA-256 hex of the exact bytes. Immutable identity of the document. */
  sha256: string;
  pageCount: number;
  hasAiram: boolean;
  hasPowersArt25: boolean;
  identityMatches: boolean;
  uploadedKmaleon: boolean;
  kmaleonDocumentId: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  clientReviewedAt: Date | null;
  createdAt: Date;
}

/** Source channel through which a document entered the system. */
export enum DocumentSource {
  WHATSAPP = 'WHATSAPP',
  OPERATOR_UPLOAD = 'OPERATOR_UPLOAD',
  SEDE_AUTOMATION = 'SEDE_AUTOMATION',
  APUDATA = 'APUDATA',
}

/** Lower-case hex SHA-256. */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_REGEX.test(value);
}
