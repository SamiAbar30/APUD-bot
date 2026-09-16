import { z } from 'zod';
import { MediaMetadataSchema, type WhatsAppAccepted, type ReplyButtonId } from '../../contracts/whatsapp.contract.js';
import { AdapterError, checkedHttpsUrl, readBounded, requestJson, requireValue, sha256 } from '../common/http.js';
export interface WhatsAppOptions {accessToken:string;phoneNumberId:string;apiVersion:string;transport?:'meta'|'emulator';apiBaseUrl?:string;writesEnabled?:boolean;allowedRecipients?:readonly string[];mediaHosts?:string[];maxMediaBytes?:number;timeoutMs?:number}
const Accepted=z.object({messages:z.array(z.object({id:z.string().min(1)})).min(1)});
export function assertWhatsAppRecipientAllowed(to:string,allowedRecipients?:readonly string[]):void{
  const recipient=to.trim();
  if(!/^\d{5,20}$/.test(recipient))throw new AdapterError('INVALID_WHATSAPP_RECIPIENT');
  if(allowedRecipients&&!allowedRecipients.includes(recipient))throw new AdapterError('DEMO_RECIPIENT_NOT_ALLOWED');
}
export class WhatsAppClient {
  private readonly origin='https://graph.facebook.com';
  private readonly emulatorEndpoint?:URL;
  constructor(private readonly options:WhatsAppOptions) {
    requireValue(options.accessToken,'WHATSAPP_ACCESS_TOKEN');
    if(!/^\d+$/.test(options.phoneNumberId)||!/^v\d+\.\d+$/.test(options.apiVersion))throw new AdapterError('INVALID_WHATSAPP_CONFIGURATION');
    if(options.transport==='emulator'){
      if(!options.apiBaseUrl)throw new AdapterError('WHATSAPP_EMULATOR_BASE_URL_REQUIRED');
      const url=new URL(options.apiBaseUrl);
      if(url.protocol!=='http:'||url.username||url.password||url.hash||!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname))throw new AdapterError('WHATSAPP_EMULATOR_ENDPOINT_NOT_LOOPBACK');
      this.emulatorEndpoint=url;
    }else if(options.apiBaseUrl)throw new AdapterError('WHATSAPP_API_BASE_URL_ONLY_FOR_EMULATOR');
  }
  private endpoint(id:string):URL {if(!/^\d+$/.test(id))throw new AdapterError('INVALID_META_ID');return this.emulatorEndpoint?new URL(this.emulatorEndpoint):new URL(`/${this.options.apiVersion}/${id}`,this.origin);}
  private headers():Record<string,string>{return {Authorization:`Bearer ${this.options.accessToken}`};}
  private async send(to:string,body:Record<string,unknown>):Promise<WhatsAppAccepted>{
    if(!this.options.writesEnabled)throw new AdapterError('WHATSAPP_WRITES_DISABLED');
    assertWhatsAppRecipientAllowed(to,this.options.allowedRecipients);
    const url=this.endpoint(this.options.phoneNumberId);if(!this.emulatorEndpoint)url.pathname+='/messages';
    const raw=await requestJson(url,{method:'POST',headers:{...this.headers(),'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,...body})},{write:true,timeoutMs:this.options.timeoutMs});
    const result=Accepted.safeParse(raw);if(!result.success)throw new AdapterError('INVALID_META_SEND_RESPONSE','uncertain');
    return {messageId:result.data.messages[0]!.id,accepted:true};
  }
  sendText(to:string,text:string):Promise<WhatsAppAccepted>{if(!text||text.length>4096)throw new AdapterError('INVALID_MESSAGE_TEXT');return this.send(to,{type:'text',text:{preview_url:false,body:text}});}
  sendButtons(to:string,body:string,buttons:Array<{id:ReplyButtonId;title:string}>):Promise<WhatsAppAccepted>{
    if(!body||body.length>1024||buttons.length<1||buttons.length>3||buttons.some(b=>!b.title||b.title.length>20)||new Set(buttons.map(b=>b.id)).size!==buttons.length)throw new AdapterError('INVALID_MESSAGE_BUTTONS');
    return this.send(to,{type:'interactive',interactive:{type:'button',body:{text:body},action:{buttons:buttons.map(b=>({type:'reply',reply:b}))}}});
  }
  sendDocumentButtons(to:string,mediaId:string,body:string,buttons:Array<{id:ReplyButtonId;title:string}>):Promise<WhatsAppAccepted>{
    if(!/^(?:\d+|wce-media-[a-f0-9]{12})$/.test(mediaId)||!body||body.length>1024||buttons.length<1||buttons.length>3||buttons.some(b=>!b.title||b.title.length>20)||new Set(buttons.map(b=>b.id)).size!==buttons.length)throw new AdapterError('INVALID_DOCUMENT_BUTTONS');
    return this.send(to,{type:'interactive',interactive:{type:'button',header:{type:'document',document:{id:mediaId}},body:{text:body},action:{buttons:buttons.map(b=>({type:'reply',reply:b}))}}});
  }
  sendTemplate(to:string,name:string,languageCode:string,parameters:string[]=[]):Promise<WhatsAppAccepted>{
    if(!/^[a-z0-9_]{1,512}$/.test(name)||! /^[a-z]{2}(?:_[A-Z]{2})?$/.test(languageCode))throw new AdapterError('INVALID_TEMPLATE');
    return this.send(to,{type:'template',template:{name,language:{code:languageCode},...(parameters.length?{components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}:{})}});
  }
  sendDocument(to:string,mediaId:string,filename?:string,caption?:string):Promise<WhatsAppAccepted>{if(!/^(?:\d+|wce-media-[a-f0-9]{12})$/.test(mediaId))throw new AdapterError('INVALID_MEDIA_ID');return this.send(to,{type:'document',document:{id:mediaId,...(filename?{filename:filename.slice(0,200)}:{}),...(caption?{caption:caption.slice(0,1024)}:{})}});}
  async uploadMedia(content:Buffer,mimeType:string,filename:string):Promise<string>{
    if(!this.options.writesEnabled)throw new AdapterError('WHATSAPP_WRITES_DISABLED');
    if(content.length<1||content.length>(this.options.maxMediaBytes??20*1024*1024)||mimeType!=='application/pdf'||content.subarray(0,5).toString()!=='%PDF-')throw new AdapterError('INVALID_OUTBOUND_DOCUMENT');
    if(this.emulatorEndpoint)return `wce-media-${sha256(content).slice(0,12)}`;
    const body=new FormData();body.set('messaging_product','whatsapp');body.set('type',mimeType);body.set('file',new Blob([new Uint8Array(content)],{type:mimeType}),filename);
    const url=this.endpoint(this.options.phoneNumberId);url.pathname+='/media';
    const raw=await requestJson(url,{method:'POST',headers:this.headers(),body},{write:true,timeoutMs:this.options.timeoutMs});
    const parsed=z.object({id:z.string().regex(/^\d+$/)}).safeParse(raw);if(!parsed.success)throw new AdapterError('INVALID_META_UPLOAD_RESPONSE','uncertain');return parsed.data.id;
  }
  async downloadMedia(mediaId:string,checks:{expectedSha256?:string;allowedMimeTypes?:string[]}={}):Promise<{content:Buffer;sha256:string;mimeType:string}>{
    if(this.emulatorEndpoint)throw new AdapterError('EMULATOR_MEDIA_DOWNLOAD_UNSUPPORTED');
    const metadata=MediaMetadataSchema.safeParse(await requestJson(this.endpoint(mediaId),{headers:this.headers()},{timeoutMs:this.options.timeoutMs}));
    if(!metadata.success||metadata.data.id!==mediaId)throw new AdapterError('INVALID_META_MEDIA_METADATA');
    const meta=metadata.data;const max=this.options.maxMediaBytes??20*1024*1024;
    if(meta.file_size>max||!(checks.allowedMimeTypes??['application/pdf']).includes(meta.mime_type))throw new AdapterError('MEDIA_POLICY_REJECTED');
    const url=checkedHttpsUrl(meta.url);
    if(!(this.options.mediaHosts??['lookaside.fbsbx.com']).includes(url.hostname)||url.port)throw new AdapterError('UNAPPROVED_MEDIA_HOST');
    let response:Response;
    try{response=await fetch(url,{headers:this.headers(),redirect:'error',signal:AbortSignal.timeout(this.options.timeoutMs??30_000)});}catch{throw new AdapterError('MEDIA_DOWNLOAD_FAILED');}
    if(!response.ok){await response.body?.cancel();throw new AdapterError('MEDIA_DOWNLOAD_FAILED');}
    const content=await readBounded(response,max);const digest=sha256(content);
    const matches=(v:string)=>v.toLowerCase()===digest||v===Buffer.from(digest,'hex').toString('base64');
    const mime=response.headers.get('content-type')?.split(';')[0]?.trim();
    if(content.length!==meta.file_size||!matches(meta.sha256)||(checks.expectedSha256&&!matches(checks.expectedSha256))||(mime&&mime!==meta.mime_type)) {content.fill(0);throw new AdapterError('MEDIA_INTEGRITY_MISMATCH');}
    if(meta.mime_type==='application/pdf'&&content.subarray(0,5).toString()!=='%PDF-'){content.fill(0);throw new AdapterError('MEDIA_MAGIC_MISMATCH');}
    return {content,sha256:digest,mimeType:meta.mime_type};
  }
}
