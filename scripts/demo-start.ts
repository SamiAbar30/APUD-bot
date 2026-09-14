import './lib/load-env.mjs';
import { loadEnv } from '../src/config/env.js';
import { DEMO_FIXTURE_SOURCE, DEMO_PHONE_NUMBER } from '../src/demo/demo-fixture.js';

const env=loadEnv();
if(!env.DEMO_DATA_ENABLED)throw new Error('DEMO_DATA_DISABLED');
if(!env.DEMO_WHATSAPP_RECIPIENTS.includes(DEMO_PHONE_NUMBER))throw new Error('DEMO_PHONE_NOT_ALLOWLISTED');
if(!['127.0.0.1','localhost','::1'].includes(env.HOST))throw new Error('DEMO_API_MUST_BE_LOOPBACK');
const base=new URL(`http://${env.HOST}:${env.PORT}`);
const auth={Authorization:`Bearer ${env.OPERATOR_TOKEN}`};
const listResponse=await fetch(new URL('/api/cases',base),{headers:auth});
if(!listResponse.ok){await listResponse.body?.cancel();throw new Error('DEMO_CASE_LIST_FAILED');}
const listed=await listResponse.json() as unknown;
if(!Array.isArray(listed))throw new Error('DEMO_CASE_LIST_INVALID');
const candidates=listed.filter((value):value is {id:string;version:number;source:string;telefono:string}=>Boolean(value&&typeof value==='object'&&typeof (value as any).id==='string'&&typeof (value as any).version==='number'&&(value as any).source===DEMO_FIXTURE_SOURCE&&(value as any).telefono===DEMO_PHONE_NUMBER));
if(candidates.length===0)throw new Error('DEMO_CASE_NOT_SEEDED');
if(candidates.length>1)throw new Error('DEMO_CASE_AMBIGUOUS');
const selected=candidates[0]!;
const eventResponse=await fetch(new URL(`/api/cases/${encodeURIComponent(selected.id)}/events`,base),{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({version:selected.version,type:'CASE_OPENED'})});
const body=await eventResponse.json().catch(()=>({}));
if(!eventResponse.ok)throw new Error(typeof body==='object'&&body&&'error'in body&&typeof (body as any).error==='string'?(body as any).error:'DEMO_START_FAILED');
console.log(JSON.stringify({result:'PASS',caseId:selected.id,version:(body as any).version??null,action:(body as any).decision?.actionRequired??null,externalProviderCalls:0,secretValuesPrinted:false}));
