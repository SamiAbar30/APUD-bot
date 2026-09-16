import {createHmac,timingSafeEqual} from 'node:crypto';
import {ApudataApprovalSchema,type ApudataApproval,type ApudataOrder,type ApprovedPayment} from '../../contracts/apudata.contract.js';
import {AdapterError,requireId,requireValue} from '../common/http.js';
import {ApudataClient} from './apudata-client.js';
/** APOD callback protocol. The partner must explicitly confirm this exact signing format. */
export function verifyApudataCallback(raw:Buffer,timestamp:string|undefined,signature:string|undefined,secret:string,nowMs=Date.now()):boolean{
  if(!secret||!timestamp||!/^\d{10}$/.test(timestamp)||!signature||!/^sha256=[a-fA-F0-9]{64}$/.test(signature)||Math.abs(nowMs-Number(timestamp)*1000)>300_000)return false;
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
function validIban(value:string):boolean{
  if(!/^ES\d{22}$/.test(value))return false;
  const digits=(value.slice(4)+value.slice(0,4)).replace(/[A-Z]/g,c=>String(c.charCodeAt(0)-55));
  let mod=0;for(const c of digits)mod=(mod*10+Number(c))%97;return mod===1;
}
export class ApudataGateway{
  private readonly payment:ApprovedPayment;
  constructor(private readonly client:ApudataClient,approvedPayment:ApprovedPayment){
    this.payment={...approvedPayment,iban:approvedPayment.iban.replace(/\s/g,'').toUpperCase()};
    if(!validIban(this.payment.iban)||this.payment.amountCents!==3500||this.payment.currency!=='EUR')throw new AdapterError('APUDATA_PAYMENT_TERMS_NOT_APPROVED');
    requireValue(this.payment.evidenceRef,'APUDATA_PAYMENT_REVIEW');
  }
  private approval(value:ApudataApproval,clientId:string):ApudataApproval{
    const parsed=ApudataApprovalSchema.safeParse(value);
    if(!parsed.success||parsed.data.clientId!==clientId||Date.parse(parsed.data.expiresAt)<=Date.now())throw new AdapterError('APUDATA_VALID_PREAPPROVAL_REQUIRED');return parsed.data;
  }
  preapprove(input:{clientId:string;dni:string;nombre?:string;idempotencyKey:string}):Promise<ApudataApproval>{requireId(input.idempotencyKey,'IDEMPOTENCY_KEY');return this.client.preapprove(input);}
  buildPaymentInstruction(approval:ApudataApproval,expectedClientId:string):string{
    this.approval(approval,expectedClientId);
    return `Preaprobación ${approval.id}. Para tramitar su apoderamiento mediante el proveedor aprobado, realice el ingreso de 35,00 € en ${this.payment.iban}, indicando la referencia ${approval.id}.`;
  }
  private verifyOrder(order:ApudataOrder,input:{clientId:string;idempotencyKey:string;approval:ApudataApproval}):ApudataOrder{
    if(order.clientId!==input.clientId||order.idempotencyKey!==input.idempotencyKey||order.approvalId!==input.approval.id||order.amountCents!==this.payment.amountCents||order.currency!==this.payment.currency)throw new AdapterError('APUDATA_ORDER_IDENTITY_MISMATCH','uncertain');if(order.status==='failed')throw new AdapterError('APUDATA_ORDER_FAILED','uncertain');return order;
  }
  async createOrder(input:{clientId:string;idempotencyKey:string;approval:ApudataApproval;paymentEvidenceRef:string;reconcileOnly?:boolean}):Promise<ApudataOrder>{
    requireId(input.idempotencyKey,'IDEMPOTENCY_KEY');requireValue(input.paymentEvidenceRef,'APUDATA_PAYMENT_EVIDENCE');
    const existing=await this.client.findOrder(input.idempotencyKey);
    if(existing)return this.verifyOrder(existing,input);
    this.approval(input.approval,input.clientId);
    if(input.reconcileOnly)throw new AdapterError('APUDATA_ORDER_OUTCOME_UNRESOLVED','uncertain');
    // Persist an intent before calling; a timeout never authorizes another POST.
    try{this.verifyOrder(await this.client.createOrder({...input,amountCents:this.payment.amountCents,currency:this.payment.currency}),input);}
    catch(error){if(error instanceof AdapterError&&(error.outcome==='not_applied'||['APUDATA_ORDER_IDENTITY_MISMATCH','APUDATA_ORDER_FAILED'].includes(error.code)))throw error;}
    for(let attempt=0;attempt<3;attempt++){
      try{const order=await this.client.findOrder(input.idempotencyKey);if(order)return this.verifyOrder(order,input);}catch(error){if(error instanceof AdapterError&&['APUDATA_ORDER_IDENTITY_MISMATCH','APUDATA_ORDER_FAILED'].includes(error.code))throw error;}
      if(attempt<2)await new Promise<void>(resolve=>setTimeout(resolve,1000));
    }
    throw new AdapterError('APUDATA_ORDER_NOT_VERIFIED','uncertain');
  }
}
