import { ApudataApprovalSchema,ApudataOrderSchema,type ApudataMapping,type ApudataApproval,type ApudataOrder,type ApudataCreateInput,type ApudataRequest } from '../../contracts/apudata.contract.js';
import {AdapterError,checkedHttpsUrl,requestJson,requireValue} from '../common/http.js';
export interface ApudataOptions {baseUrl:string;accessToken:string;writesEnabled?:boolean;timeoutMs?:number;reviewedMapping:ApudataMapping}
export class ApudataClient {
  private readonly base:URL;
  constructor(private readonly options:ApudataOptions){this.base=checkedHttpsUrl(options.baseUrl);requireValue(options.accessToken,'APUDATA_ACCESS_TOKEN');requireValue(options.reviewedMapping.reviewEvidenceRef,'APUDATA_MAPPING_REVIEW');}
  private async call(request:ApudataRequest,write:boolean):Promise<unknown>{
    if(write&&!this.options.writesEnabled)throw new AdapterError('APUDATA_WRITES_DISABLED');
    const url=checkedHttpsUrl(new URL(request.path,this.base).href,[this.base.origin]);
    if(!['GET','POST'].includes(request.method)||request.method==='GET'&&request.body)throw new AdapterError('INVALID_APUDATA_REQUEST');
    return requestJson(url,{method:request.method,headers:{Authorization:`Bearer ${this.options.accessToken}`,'Content-Type':'application/json'},...(request.body?{body:JSON.stringify(request.body)}:{})},{write,timeoutMs:this.options.timeoutMs});
  }
  async preapprove(input:{clientId:string;dni:string;nombre?:string;idempotencyKey:string}):Promise<ApudataApproval>{
    const raw=await this.call(this.options.reviewedMapping.preapproveRequest(input),true);
    let mapped:unknown;try{mapped=this.options.reviewedMapping.parseApproval(raw);}catch{throw new AdapterError('APUDATA_PREAPPROVAL_UNVERIFIED','uncertain');}
    const approval=ApudataApprovalSchema.safeParse(mapped);
    if(!approval.success||approval.data.clientId!==input.clientId)throw new AdapterError('APUDATA_PREAPPROVAL_UNVERIFIED','uncertain');return approval.data;
  }
  private checkVideoUrl(order:ApudataOrder,write:boolean):ApudataOrder{
    if(order.videoUrl){try{checkedHttpsUrl(order.videoUrl,[this.base.origin]);}catch{throw new AdapterError('APUDATA_VIDEO_URL_UNAPPROVED',write?'uncertain':'not_applied');}}
    return order;
  }
  async findOrder(key:string):Promise<ApudataOrder|null>{
    const raw=await this.call(this.options.reviewedMapping.findOrderRequest(key),false);
    const mapped=this.options.reviewedMapping.parseFoundOrder(raw);if(mapped===null)return null;
    const parsed=ApudataOrderSchema.safeParse(mapped);
    if(!parsed.success||parsed.data.idempotencyKey!==key)throw new AdapterError('APUDATA_ORDER_RECONCILIATION_INVALID');return this.checkVideoUrl(parsed.data,false);
  }
  async createOrder(input:ApudataCreateInput):Promise<ApudataOrder>{
    const raw=await this.call(this.options.reviewedMapping.createOrderRequest(input),true);
    let mapped:unknown;try{mapped=this.options.reviewedMapping.parseCreatedOrder(raw);}catch{throw new AdapterError('APUDATA_CREATE_RESPONSE_INVALID','uncertain');}
    const parsed=ApudataOrderSchema.safeParse(mapped);
    if(!parsed.success)throw new AdapterError('APUDATA_CREATE_RESPONSE_INVALID','uncertain');return this.checkVideoUrl(parsed.data,true);
  }
}
