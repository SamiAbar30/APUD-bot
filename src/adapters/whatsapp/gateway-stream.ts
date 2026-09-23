import { z } from 'zod';
import { WebSocket } from 'undici';
import { AdapterError } from '../common/http.js';

/** What the gateway hands over: a flattened client message (with Meta's original object) or a status. */
export const GatewayDeliverySchema = z.union([
  z.object({cursor:z.number().int().positive(),kind:z.literal('status'),id:z.string().min(1).max(256),phoneNumberId:z.string().regex(/^\d+$/),recipient:z.string(),status:z.string().max(40),timestamp:z.number(),error:z.object({code:z.number().int().optional()}).optional()}),
  z.object({cursor:z.number().int().positive(),kind:z.undefined(),id:z.string().min(1).max(256),phoneNumberId:z.string().regex(/^\d+$/),from:z.string(),raw:z.record(z.unknown())}),
]);
export type GatewayDelivery = z.infer<typeof GatewayDeliverySchema>;

/** A Meta-shaped envelope, so a gateway delivery passes the exact validation a signed webhook does. */
export function envelopeFromDelivery(delivery:GatewayDelivery):unknown {
  const value = delivery.kind==='status'
    ? {statuses:[{id:delivery.id,recipient_id:delivery.recipient,timestamp:String(delivery.timestamp),status:delivery.status,...(delivery.error?.code!==undefined?{errors:[{code:delivery.error.code}]}:{})}]}
    : {messages:[delivery.raw]};
  return {object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:delivery.phoneNumberId},...value}}]}]};
}

export interface GatewayStreamOptions {
  url:string;
  token:string;
  loadCursor:()=>Promise<number>;
  saveCursor:(cursor:number)=>Promise<void>;
  handle:(delivery:GatewayDelivery)=>Promise<void>;
  log:{info:(o:object,m:string)=>void;warn:(o:object,m:string)=>void};
  /** Render's free plan sleeps without inbound HTTP and silently drops sockets; a periodic check covers both. */
  keepAliveMs?:number;
}

/**
 * Keeps one socket open to the gateway and feeds each delivery, in order, into the bot's intake.
 *
 * The cursor only advances after a delivery is committed, so a crash or a dropped socket replays
 * from the last committed point; the inbox dedupes on the Meta message id.
 */
export class GatewayStream {
  private socket?:WebSocket;
  private stopped=false;
  private backoffMs=1000;
  private chain:Promise<void>=Promise.resolve();
  private cursor=0;
  private timer?:NodeJS.Timeout;
  private keepAlive?:NodeJS.Timeout;
  /** After a failed delivery, the rest of that socket's messages wait for the replay instead of jumping ahead. */
  private readonly abandoned=new WeakSet<WebSocket>();
  constructor(private readonly options:GatewayStreamOptions) {}

  start():void {
    this.keepAlive=setInterval(()=>void this.checkAlive(),this.options.keepAliveMs??240_000);
    void this.connect();
  }

  async stop():Promise<void> {
    this.stopped=true;
    clearTimeout(this.timer);clearInterval(this.keepAlive);
    this.socket?.close();
    await this.chain;
  }

  private path(path:string,protocol?:'ws'):URL {
    const url=new URL(this.options.url);url.pathname=url.pathname.replace(/\/$/,'')+path;
    if(protocol)url.protocol=url.protocol==='https:'?'wss:':'ws:';
    return url;
  }

  private async gatewayCursor():Promise<number> {
    const response=await fetch(this.path('/health'),{signal:AbortSignal.timeout(90_000)});
    const body=z.object({cursor:z.number().int().nonnegative(),listeners:z.number().int().nonnegative()}).parse(await response.json());
    return body.cursor;
  }

  private async connect():Promise<void> {
    if(this.stopped)return;
    try {
      // Wakes a sleeping free-plan gateway, and tells whether it restarted: its cursor starts again at 0.
      const latest=await this.gatewayCursor();
      this.cursor=await this.options.loadCursor();
      if(this.cursor>latest){this.options.log.warn({saved:this.cursor,latest},'gateway restarted; replaying its whole buffer');this.cursor=0;await this.options.saveCursor(0);}
      const url=this.path('/stream','ws');url.searchParams.set('since',String(this.cursor));
      // Header only: the gateway refuses a token in the query string.
      const socket=new WebSocket(url,{headers:{authorization:`Bearer ${this.options.token}`}});
      this.socket=socket;
      socket.onopen=()=>{this.backoffMs=1000;this.options.log.info({since:this.cursor},'gateway stream connected');};
      socket.onmessage=event=>{const data=String(event.data);this.chain=this.chain.then(()=>this.deliver(socket,data)).catch(()=>undefined);};
      socket.onclose=()=>{if(this.socket===socket)this.socket=undefined;this.retry();};
      socket.onerror=()=>undefined;
    } catch(error) {
      this.options.log.warn({error:error instanceof Error?error.message:'UNKNOWN'},'gateway unreachable');
      this.retry();
    }
  }

  private retry():void {
    if(this.stopped||this.timer)return;
    const wait=this.backoffMs;this.backoffMs=Math.min(this.backoffMs*2,30_000);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.connect();},wait);
  }

  private async deliver(socket:WebSocket,data:string):Promise<void> {
    if(this.abandoned.has(socket))return;
    let delivery:GatewayDelivery;
    try{delivery=GatewayDeliverySchema.parse(JSON.parse(data));}
    catch{this.options.log.warn({},'gateway sent an unreadable delivery; skipped');return;}
    if(delivery.cursor<=this.cursor)return;
    try{await this.options.handle(delivery);}
    catch(error){
      // A delivery the bot's own validation rejects will never pass; retrying it would stall every later message.
      if(!(error instanceof AdapterError)){
        this.options.log.warn({cursor:delivery.cursor,error:error instanceof Error?error.message:'UNKNOWN'},'delivery not committed; reconnecting to replay');
        this.abandoned.add(socket);socket.close();
        return;
      }
      this.options.log.warn({cursor:delivery.cursor,code:error.code},'delivery rejected by validation; skipped');
    }
    this.cursor=delivery.cursor;
    await this.options.saveCursor(delivery.cursor);
  }

  /** A socket the gateway no longer counts is dead even if this side never saw it close. */
  private async checkAlive():Promise<void> {
    if(this.stopped)return;
    try{
      const response=await fetch(this.path('/health'),{signal:AbortSignal.timeout(90_000)});
      const {listeners}=z.object({listeners:z.number()}).parse(await response.json());
      if(this.socket&&listeners===0){this.options.log.warn({},'gateway lost this listener; reconnecting');this.socket.close();}
    }catch{/* the next connect attempt reports it */}
  }
}
