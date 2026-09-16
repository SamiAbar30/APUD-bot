import { z } from 'zod';
export const ReplyButtonIdSchema = z.enum([
  'HAS_CERT_YES','HAS_CERT_NO','DEVICE_PC','DEVICE_MOBILE','HAS_PC','NO_PC','NEEDS_ASSISTANCE',
  'CONSENT_YES','CONSENT_NO','DRAFT_APPROVED','DRAFT_REJECTED','REVOKED',
  'REISSUED','COURT_APPOINTMENT','APUDATA_REQUEST','HUMAN_HELP',
]);
export type ReplyButtonId = z.infer<typeof ReplyButtonIdSchema>;
export interface WhatsAppInboundMessage {
  id: string; from: string; timestamp: number; phoneNumberId: string;
  type: 'text' | 'document' | 'image' | 'interactive' | 'button' | 'unsupported';
  textPresent: boolean; text?: string; contextId?: string; buttonId?: ReplyButtonId;
  media?: {id: string; mimeType: string; sha256?: string; filename?:string};
}
export interface WhatsAppStatus {
  id: string; recipientId: string; timestamp: number;
  status: 'sent' | 'delivered' | 'read' | 'failed'; errorCodes: number[];
}
export interface WhatsAppAccepted { messageId: string; accepted: true }
export const MediaMetadataSchema = z.object({
  id: z.string().min(1), url: z.string().url(), mime_type: z.string().min(1),
  sha256: z.string().min(1), file_size: z.number().int().positive(),
});
