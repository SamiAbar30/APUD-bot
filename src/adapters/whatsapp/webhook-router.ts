import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ReplyButtonIdSchema, type WhatsAppInboundMessage, type WhatsAppStatus } from '../../contracts/whatsapp.contract.js';
import { AdapterError } from '../common/http.js';

export function verifyWebhookSignature(raw: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!appSecret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
export function verifyWebhookChallenge(query: Record<string, unknown>, verifyToken: string): string | null {
  if (!verifyToken || query['hub.mode'] !== 'subscribe' || typeof query['hub.verify_token'] !== 'string' || typeof query['hub.challenge'] !== 'string') return null;
  const actual = Buffer.from(query['hub.verify_token']); const expected = Buffer.from(verifyToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? query['hub.challenge'] : null;
}
const Media = z.object({id:z.string().regex(/^\d+$/),mime_type:z.string().max(100),sha256:z.string().max(100).optional(),filename:z.string().max(256).optional(),caption:z.string().max(1024).nullable().optional()});
const Message = z.object({
  id:z.string().min(1).max(256),from:z.string().regex(/^\d{5,20}$/),timestamp:z.string().regex(/^\d+$/),type:z.string(),
  text:z.object({body:z.string().min(1).max(4000)}).optional(),
  context:z.object({id:z.string().max(256)}).optional(),document:Media.optional(),image:Media.optional(),audio:z.object({id:z.string()}).passthrough().optional(),video:z.object({id:z.string()}).passthrough().optional(),
  interactive:z.object({button_reply:z.object({id:z.string().max(256),title:z.string().max(256).optional()}).optional(),list_reply:z.object({id:z.string().max(256),title:z.string().max(256).optional()}).optional()}).optional(),
  button:z.object({payload:z.string().max(256),text:z.string().max(256).optional()}).optional(),
});
const Status = z.object({id:z.string().min(1).max(256),recipient_id:z.string().regex(/^\d{5,20}$/),timestamp:z.string().regex(/^\d+$/),status:z.enum(['sent','delivered','read','failed']),errors:z.array(z.object({code:z.number().int()})).optional()});
const Envelope = z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({changes:z.array(z.object({field:z.string(),value:z.object({metadata:z.object({phone_number_id:z.string()}),messages:z.array(z.unknown()).optional(),statuses:z.array(z.unknown()).optional()})}))}))});
/**
 * The bot writes its own notes into the conversation in brackets ("[Adjunto del cliente: …]",
 * "[CERTIFICADO:OK]", "[CONTENIDO_SENSIBLE_OMITIDO]") and acts on them. A client typing the same
 * text must not be read as one, so their bracket becomes a parenthesis before anything else sees it.
 */
export function neutralizeSystemMarkers(text:string):string{
  return text.replace(/\[(\s*)(adjunto del cliente|certificado\s*:|contenido[_ ]sensible|contenido[_ ]no[_ ]fiable|(?:posible_)?contrase[ñn]a[_ ]redactada|mensaje[_ ]largo)/gi,'($1$2');
}

/** The input must have passed raw HMAC verification. Never persist or log input. */
export function normalizeWebhook(payload: unknown, expectedPhoneNumberId: string): {messages:WhatsAppInboundMessage[];statuses:WhatsAppStatus[]} {
  if (!expectedPhoneNumberId) throw new AdapterError('MISSING_WHATSAPP_PHONE_NUMBER_ID');
  const parsed = Envelope.safeParse(payload);
  if (!parsed.success) throw new AdapterError('INVALID_WHATSAPP_WEBHOOK');
  const messages:WhatsAppInboundMessage[]=[]; const statuses:WhatsAppStatus[]=[];
  for (const entry of parsed.data.entry) for (const change of entry.changes) {
    if (change.field !== 'messages') continue;
    if (change.value.metadata.phone_number_id !== expectedPhoneNumberId) throw new AdapterError('WRONG_WHATSAPP_ACCOUNT');
    for (const raw of change.value.messages ?? []) {
      const result = Message.safeParse(raw); if (!result.success) throw new AdapterError('INVALID_WHATSAPP_MESSAGE');
      const m=result.data;
      const type:WhatsAppInboundMessage['type'] = ['text','document','image','interactive','button'].includes(m.type) ? m.type as WhatsAppInboundMessage['type'] : 'unsupported';
      const timestamp=Number(m.timestamp); if (!Number.isSafeInteger(timestamp)) throw new AdapterError('INVALID_MESSAGE_TIMESTAMP');
      const clean:WhatsAppInboundMessage={id:m.id,from:m.from,timestamp,phoneNumberId:expectedPhoneNumberId,type,textPresent:type==='text',...(type==='text'&&m.text?.body?{text:neutralizeSystemMarkers(m.text.body)}:{})};
      if(m.context) clean.contextId=m.context.id;
      const button=ReplyButtonIdSchema.safeParse(m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload);
      if(button.success){
        clean.buttonId=button.data;
        const title=(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.button?.text)?.trim();
        if(title) clean.buttonTitle=neutralizeSystemMarkers(title.slice(0,100));
      }
      const media=type==='document'?m.document:type==='image'?m.image:undefined;
      if(media) clean.media={id:media.id,mimeType:media.mime_type,...(media.sha256?{sha256:media.sha256}:{}),...(media.filename?{filename:media.filename}:{})};
      // What the client wrote with the file is part of their message; it used to be dropped.
      if(media?.caption?.trim()) clean.caption=neutralizeSystemMarkers(media.caption.trim());
      if(['audio','video','sticker','voice'].includes(m.type)) clean.unreadableMedia=m.type;
      messages.push(clean);
    }
    for(const raw of change.value.statuses ?? []) {
      const result=Status.safeParse(raw); if(!result.success) throw new AdapterError('INVALID_WHATSAPP_STATUS');
      const s=result.data; const timestamp=Number(s.timestamp);if(!Number.isSafeInteger(timestamp)) throw new AdapterError('INVALID_STATUS_TIMESTAMP');
      statuses.push({id:s.id,recipientId:s.recipient_id,timestamp,status:s.status,errorCodes:(s.errors??[]).map(e=>e.code)});
    }
  }
  return {messages,statuses};
}
