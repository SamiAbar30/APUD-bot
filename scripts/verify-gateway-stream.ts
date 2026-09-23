// Real check against the live gateway: connects with the bot token, replays what the gateway holds,
// and runs every delivery through the bot's own webhook validation. Writes nothing to the database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GatewayStream, envelopeFromDelivery, type GatewayDelivery } from '../src/adapters/whatsapp/gateway-stream.js';
import { normalizeWebhook } from '../src/adapters/whatsapp/webhook-router.js';
const url=process.env.GATEWAY_URL??'https://whatsapp-gateway-pkkx.onrender.com';
const token=process.env.GATEWAY_BOT_TOKEN??readFileSync(process.env.GATEWAY_TOKEN_FILE??'/dev/stdin','utf8').trim();
const phone=process.env.WA_PHONE_NUMBER_ID??'1354206657772976';
const seen:GatewayDelivery[]=[];const normalized:ReturnType<typeof normalizeWebhook>[]=[];let saved=0;
const stream=new GatewayStream({url,token,loadCursor:async()=>0,saveCursor:async c=>{saved=c;},
  handle:async d=>{seen.push(d);normalized.push(normalizeWebhook(envelopeFromDelivery(d),phone));},
  log:{info:(o,m)=>console.log('info',m,JSON.stringify(o)),warn:(o,m)=>console.log('warn',m,JSON.stringify(o))}});
stream.start();
const health=async()=>await (await fetch(url+'/health')).json() as {cursor:number;listeners:number};
let live=await health();
for(let i=0;i<60&&(live.listeners<1||saved<live.cursor);i++){await new Promise(r=>setTimeout(r,1000));live=await health();}
await stream.stop();
const messages=normalized.flatMap(n=>n.messages);const statuses=normalized.flatMap(n=>n.statuses);
console.log(JSON.stringify({gatewayCursor:live.cursor,savedCursor:saved,deliveries:seen.length,listenersWhileOpen:live.listeners,messages:messages.map(m=>({id:m.id.slice(0,20),from:m.from,type:m.type,text:m.text})),statuses:statuses.map(s=>s.status)},null,1));
assert.ok(live.listeners>=1,'gateway did not count the bot as a listener');
assert.equal(seen.length,live.cursor,'every delivery the gateway holds reached the bot');
if(seen.length)assert.equal(saved,Math.max(...seen.map(d=>d.cursor)));
console.log('PASS');
