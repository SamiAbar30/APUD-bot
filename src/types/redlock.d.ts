/** redlock v5 beta omits a types condition in its package exports. NodeNext needs this public API declaration. */
declare module 'redlock' {
  import { EventEmitter } from 'node:events';
  import type { Redis } from 'ioredis';
  export interface RedlockSignal extends AbortSignal { error?: Error }
  export interface Lock { resources:string[]; value:string; expiration:number; release():Promise<unknown>; extend(duration:number):Promise<Lock> }
  export default class Redlock extends EventEmitter {
    constructor(clients:Redis[],settings?:{retryCount?:number;retryDelay?:number;retryJitter?:number;driftFactor?:number;automaticExtensionThreshold?:number});
    using<T>(resources:string[],duration:number,routine:(signal:RedlockSignal)=>Promise<T>):Promise<T>;
    acquire(resources:string[],duration:number):Promise<Lock>;
    quit():Promise<void>;
  }
}
