import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redlock from 'redlock';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
const name=`verification-${randomUUID()}`;const queue=new Queue(name,{connection:redis,prefix:'apod-verification'});
let worker:Worker|undefined;
try {
  const tables=await db.$queryRaw<{tablename:string}[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'bot_apod_%' ORDER BY tablename`;
  assert.equal(tables.length,5,'Five real APOD tables must exist');
  assert.equal(await redis.ping(),'PONG');
  const locks=new Redlock([redis],{retryCount:0});locks.on('error',()=>undefined);
  const lockKey='apod-verification-'+randomUUID();const held=await locks.acquire([lockKey],5000);
  let excluded=false;try{const conflicting=await locks.acquire([lockKey],5000);await conflicting.release();}catch{excluded=true;}
  assert.equal(excluded,true,'Real Redis must exclude concurrent holders');await held.release();const reacquired=await locks.acquire([lockKey],5000);await reacquired.release();
  // Real queue round trip; this is infrastructure telemetry, not fabricated legal/client input.
  const job=await queue.add('health',{kind:'infra-health',requestedAt:new Date().toISOString()});
  let resolveDone:()=>void=()=>{};let rejectDone:(e:Error)=>void=()=>{};
  const done=new Promise<void>((resolve,reject)=>{resolveDone=resolve;rejectDone=reject});
  worker=new Worker(name,async received=>{assert.equal(received.id,job.id);assert.equal(received.data.kind,'infra-health');return {workerRespondedAt:new Date().toISOString()};},{connection:redis,prefix:'apod-verification'});
  worker.on('completed',()=>resolveDone());worker.on('failed',(_job,e)=>rejectDone(e));worker.on('error',e=>rejectDone(e));
  const timer=setTimeout(()=>rejectDone(new Error('Real queue timeout')),10000);await done.finally(()=>clearTimeout(timer));
  const receipt=await queue.getJob(job.id!);assert.equal(await receipt?.getState(),'completed');
  const result={at:new Date().toISOString(),postgres:'CONNECTED',tables:tables.map(t=>t.tablename),redis:'PONG',bullmq:'REAL_WORKER_ROUNDTRIP',redlock:'REAL_MUTUAL_EXCLUSION_AND_RELEASE',businessE2E:'NOT_VERIFIED_REQUIRES_REAL_DOCUMENTS_AND_VENDOR_CONFIGURATION'};
  await writeFile('evidence/infra-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally { await worker?.close();await queue.obliterate({force:true});await queue.close();await redis.quit();await db.$disconnect(); }
