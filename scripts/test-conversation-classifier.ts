/**
 * Deterministic certificate-answer classification against the real client turns in the
 * provided package's eval_scenarios.jsonl. No provider, network, database or synthetic input.
 */
import '../src/config/load-env-file.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ApodState} from '@prisma/client';
import {classifyClientText} from '../src/core/conversation-policy.js';

type Scenario={id:string;user_turns:string[]};
const dir=process.env.APOD_AGENT_PACKAGE_DIR;
if(!dir)throw new Error('APOD_AGENT_PACKAGE_DIR_REQUIRED');
const scenarios:Scenario[]=(await readFile(resolve(dir,'eval_scenarios.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
const waiting={currentState:ApodState.WAITING_CERT_RESPONSE,hasDigitalCert:null};
const noCertificate=new Set(['no_cert_clave_dni','no_cert_nie','sin_nada']);

for(const s of scenarios){
  const first=s.user_turns[0]!;
  const result=classifyClientText(waiting,first);
  const isNoCert=result.kind==='OPTION'&&result.optionId==='HAS_CERT_NO';
  assert.equal(isNoCert,noCertificate.has(s.id),`${s.id}: ${JSON.stringify(first)} -> ${JSON.stringify(result)}`);
}
// Clients answer in bursts and the inbox merges them before classification.
const bursts:Array<[string,string|null]>=[
  ['Sí, tengo certificado digital\nLo tengo en el ordenador','DEVICE_PC'],
  ['si tengo certificado\nen el movil','DEVICE_MOBILE'],
  ['no tengo certificado\ntengo ordenador','HAS_CERT_NO'],
  ['si\nno','HAS_CERT_YES'],
];
for(const [text,expected] of bursts){
  const result=classifyClientText(waiting,text);
  const actual=result.kind==='OPTION'?result.optionId:null;
  if(expected!=='HAS_CERT_YES')assert.equal(actual,expected,`burst ${JSON.stringify(text)} -> ${JSON.stringify(result)}`);
  // Contradictory bursts must stay ambiguous rather than guess.
  else assert.equal(result.kind,'HUMAN_REVIEW',`contradictory burst should not resolve: ${JSON.stringify(result)}`);
}
// A denial must never be read as the action being done (Codex red-team finding 3).
const revocation={currentState:ApodState.REVOCATION_GUIDE_SENT,hasDigitalCert:true} as Parameters<typeof classifyClientText>[0];
const denials=['todavia no esta revocado','aun no lo he revocado','no lo he revocado','sin revocar todavia'];
for(const text of denials){
  const result=classifyClientText(revocation,text);
  assert.notEqual(result.kind==='OPTION'&&result.optionId,'REVOKED',`denial read as done: ${text} -> ${JSON.stringify(result)}`);
}
for(const text of ['ya lo he revocado','revocacion realizada']){
  const result=classifyClientText(revocation,text);
  assert.equal(result.kind==='OPTION'&&result.optionId,'REVOKED',`real revocation missed: ${text} -> ${JSON.stringify(result)}`);
}
console.log(JSON.stringify({status:'PASS',scenarios:scenarios.length,bursts:bursts.length,denials:denials.length,source:'eval_scenarios.jsonl'}));
