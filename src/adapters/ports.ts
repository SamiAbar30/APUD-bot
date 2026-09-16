import type {WhatsAppClient} from './whatsapp/whatsapp-client.js';
import type {KmaleonGateway} from './kmaleon/kmaleon-gateway.js';
import type {ApudataGateway} from './apudata/apudata-gateway.js';
import type {SedePlaywright} from './sede-judicial/sede-playwright.js';
/** Public boundaries allow local setup tests without instantiating live network clients. */
export type WhatsAppPort=Pick<WhatsAppClient,'sendText'|'sendButtons'|'sendDocument'|'sendDocumentButtons'|'sendTemplate'|'uploadMedia'|'downloadMedia'>;
export interface AdapterPorts{
  kmaleon?:(Pick<KmaleonGateway,'uploadAndVerifyDocument'|'notifyDayana'|'getVerifiedAddress'|'searchExpedientes'|'getExpediente'> & Partial<Pick<KmaleonGateway,'notifyCarmen'|'listPendingApudActa'|'resolveTriggerExpediente'>> & {addressLookupConfigured?:boolean});
  apudata?:Pick<ApudataGateway,'preapprove'|'createOrder'|'buildPaymentInstruction'>;
  sede?:Pick<SedePlaywright,'prepareDraft'>;
}
