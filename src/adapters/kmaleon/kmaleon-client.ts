import { z } from 'zod';
import { Agent } from 'undici';
import { AdapterError, checkedHttpsUrl, requestJson, requireValue } from '../common/http.js';
export interface KmaleonOptions {
  baseUrl:string;clientId:string;clientSecret:string;authState:string;redirectUri:string;
  writesEnabled?:boolean;timeoutMs?:number;authTimeoutMs?:number;rejectUnauthorized?:boolean;
}
const READ_METHODS=new Set(['projects/getProject','calendar/annotations/getAnnotations','documents/viewDocument','cards/getCards','projects/getProjects','macros/getMacros']);
const WRITE_METHODS=new Set(['calendar/annotations/newAnnotation']);
const AuthResponse=z.union([z.object({authcode:z.string().min(1)}),z.object({data:z.object({result:z.object({authcode:z.string().min(1)})})})]);
const TokenResponse=z.union([z.object({access_token:z.string().min(1)}),z.object({data:z.object({result:z.object({access_token:z.string().min(1)})})})]);
export class KmaleonClient {
  private readonly base:URL;private readonly dispatcher:Agent;private accessToken:string|null=null;private authenticating:Promise<void>|null=null;
  constructor(private readonly options:KmaleonOptions) {
    this.base=checkedHttpsUrl(options.baseUrl);
    this.dispatcher=new Agent({connect:{rejectUnauthorized:options.rejectUnauthorized??true}});
    for(const [key,value]of Object.entries({CLIENT_ID:options.clientId,CLIENT_SECRET:options.clientSecret,AUTH_STATE:options.authState,REDIRECT_URI:options.redirectUri}))requireValue(value,`KMALEON_${key}`);
  }
  private async authenticate():Promise<void>{
    if(this.authenticating)return this.authenticating;
    this.authenticating=this.doAuthenticate();
    try{await this.authenticating;}finally{this.authenticating=null;}
  }
  private async doAuthenticate():Promise<void>{
    const timeoutMs=this.options.authTimeoutMs??120_000;
    const auth=AuthResponse.safeParse(await requestJson(new URL('/api/server/autorize/',this.base),{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({response_type:'code',client_id:this.options.clientId,state:this.options.authState,redirect_uri:this.options.redirectUri}).toString(),
    },{timeoutMs,dispatcher:this.dispatcher}));
    if(!auth.success)throw new AdapterError('KMALEON_AUTH_RESPONSE_INVALID');
    const code='authcode'in auth.data?auth.data.authcode:auth.data.data.result.authcode;
    const token=TokenResponse.safeParse(await requestJson(new URL('/api/server/token/',this.base),{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`},
      body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.options.redirectUri}).toString(),
    },{timeoutMs,dispatcher:this.dispatcher}));
    if(!token.success)throw new AdapterError('KMALEON_TOKEN_RESPONSE_INVALID');
    this.accessToken='access_token'in token.data?token.data.access_token:token.data.data.result.access_token;
  }
  async invokeRead(method:string,payload:Record<string,unknown>={}):Promise<unknown>{
    if(!READ_METHODS.has(method))throw new AdapterError('KMALEON_READ_METHOD_NOT_ALLOWED');
    try{return await this.invoke(method,payload,false);}catch(error){
      if(error instanceof AdapterError&&error.code==='HTTP_401'){this.accessToken=null;return this.invoke(method,payload,false);}throw error;
    }
  }
  async invokeWrite(method:string,payload:Record<string,unknown>):Promise<unknown>{
    if(!this.options.writesEnabled)throw new AdapterError('KMALEON_WRITES_DISABLED');
    if(!WRITE_METHODS.has(method))throw new AdapterError('KMALEON_WRITE_METHOD_NOT_ALLOWED');
    return this.invoke(method,payload,true);
  }
  private async invoke(method:string,payload:Record<string,unknown>,write:boolean):Promise<unknown>{
    if('method_call'in payload)throw new AdapterError('KMALEON_RPC_OVERRIDE_REJECTED');
    if(!this.accessToken)await this.authenticate();
    const result=await requestJson(new URL('/api/request/',this.base),{
      method:'POST',headers:{Authorization:`Bearer ${this.accessToken}`,'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({...payload,method_call:Buffer.from(method).toString('base64')}),
    },{write,timeoutMs:this.options.timeoutMs??120_000,maxBytes:40*1024*1024,dispatcher:this.dispatcher});
    // Error envelopes are deliberately left to reviewed operation parsers; no 200 means success assertion.
    return result;
  }
}
