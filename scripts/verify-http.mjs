import './lib/load-env.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base=`http://127.0.0.1:${process.env.PORT??4720}`;
const auth={Authorization:`Bearer ${process.env.OPERATOR_TOKEN}`};
const results=[];
for(const path of ['/health/live','/health/ready','/','/app.js','/app.css']){const r=await fetch(base+path);assert.equal(r.status,200,path);results.push({path,status:r.status});}
const denied=await fetch(base+'/api/cases');assert.equal(denied.status,401);results.push({path:'/api/cases',withoutToken:denied.status});
for(const path of ['/api/setup','/api/capabilities','/api/cases','/api/actions','/api/inbox']){const r=await fetch(base+path,{headers:auth});assert.equal(r.status,200,path);const b=await r.json();results.push({path,status:r.status,...(Array.isArray(b)?{count:b.length}:{})});}
const wrongWebhook=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.ok([401,503].includes(wrongWebhook.status));results.push({path:'/webhooks/whatsapp',unsigned:wrongWebhook.status});
const report={at:new Date().toISOString(),runtime:process.version,realHTTP:true,businessDataWritten:false,checks:results};await writeFile('evidence/http-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
