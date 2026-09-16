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
console.log(JSON.stringify({status:'PASS',scenarios:scenarios.length,source:'eval_scenarios.jsonl'}));
