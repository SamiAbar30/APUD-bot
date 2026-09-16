import { z } from 'zod';
export const ApudataApprovalSchema=z.object({
  id:z.string().min(1),clientId:z.string().min(1),preApproved:z.literal(true),
  expiresAt:z.string().datetime({offset:true}),evidenceRef:z.string().min(1),
});
export type ApudataApproval=z.infer<typeof ApudataApprovalSchema>;
export const ApudataOrderSchema=z.object({
  id:z.string().min(1),clientId:z.string().min(1),idempotencyKey:z.string().min(1),
  approvalId:z.string().min(1),amountCents:z.number().int().positive(),currency:z.literal('EUR'),
  status:z.enum(['created','video_pending','document_ready','failed']),videoUrl:z.string().url().optional(),documentSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ApudataOrder=z.infer<typeof ApudataOrderSchema>;
export const ApudataCallbackSchema=z.object({
  eventId:z.string().min(1).max(200),orderId:z.string().min(1).max(200),clientId:z.string().min(1).max(200),
  status:z.enum(['video_pending','document_ready','failed']),documentSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export interface ApprovedPayment {iban:string;amountCents:number;currency:'EUR';evidenceRef:string}
export interface ApudataRequest {path:string;method:'GET'|'POST';body?:Record<string,unknown>}
export interface ApudataCreateInput {clientId:string;idempotencyKey:string;approval:ApudataApproval;paymentEvidenceRef:string;amountCents:number;currency:'EUR'}
export interface ApudataMapping {
  reviewEvidenceRef:string;
  preapproveRequest(input:{clientId:string;dni:string;nombre?:string;idempotencyKey:string}):ApudataRequest;
  parseApproval(raw:unknown):ApudataApproval;
  findOrderRequest(key:string):ApudataRequest;
  parseFoundOrder(raw:unknown):ApudataOrder|null;
  createOrderRequest(input:ApudataCreateInput):ApudataRequest;
  parseCreatedOrder(raw:unknown):ApudataOrder;
}
