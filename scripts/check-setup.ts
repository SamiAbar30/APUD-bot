import '../src/config/load-env-file.js';
import {loadEnv,readinessConfig} from '../src/config/env.js';
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const selected=resolve(process.env.ENV_FILE??resolve(root,'.env'));
const checks:{name:string;passed:boolean;detail?:string}[]=[];
try{
  const env=loadEnv();
  const info=await lstat(selected);
  checks.push({name:'Private regular environment file',passed:info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o077)===0});
  const fileValues=parse(await readFile(selected,'utf8'));
  const keys=Object.keys(parse(await readFile(resolve(root,'.env.example'),'utf8')));
  const missing=keys.filter(key=>!Object.hasOwn(fileValues,key));
  checks.push({name:'All setup fields exist in environment file',passed:missing.length===0,...(missing.length?{detail:missing.join(', ')}:{})});
  for(const key of ['KMALEON_CONFIG_FILE','APUDATA_CONFIG_FILE','SEDE_RECIPE_FILE'] as const){
    const path=env[key];let readable=false;
    try{if(path){const mapping=JSON.parse(await readFile(path,'utf8'))as unknown;readable=Boolean(mapping&&typeof mapping==='object'&&'reviewed'in mapping);}}catch{/* Only report field name, never configuration values. */}
    checks.push({name:`Mapping template ${key}`,passed:readable});
  }
  const configuration=readinessConfig(env);
  const report={at:new Date().toISOString(),runtime:process.version,environmentFile:selected,configuredKeys:keys.length,
    result:checks.every(c=>c.passed)?'PASS':'FAIL',configuration,demoData:configuration.demoData,demoRecipientCount:configuration.demoRecipientCount,
    pendingProviderFields:keys.filter(key=>/^(?:WA_|KMALEON_|APUDATA_)/.test(key)&&!fileValues[key]),
    optionalProviderFields:keys.filter(key=>key==='CARMEN_USER_ID'&&!fileValues[key]),
    liveProviderValidation:'PENDING_ACCOUNTS_AND_REVIEW',externalProviderCalls:0,emailInteraction:'NONE',secretValuesPrinted:false,checks};
  await mkdir(resolve(root,'evidence'),{recursive:true,mode:0o700});
  await writeFile(resolve(root,'evidence/setup-check.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));if(report.result==='FAIL')process.exitCode=1;
}catch(error){
  // Validation errors can contain user input. Report field names/codes only.
  const issues=error&&typeof error==='object'&&'issues'in error?(error as {issues:{path:unknown[];code:string}[]}).issues.map(i=>({field:i.path.join('.'),code:i.code})):[];
  console.error(JSON.stringify({result:'FAIL',code:'SETUP_CONFIGURATION_INVALID',issues,secretValuesPrinted:false}));process.exitCode=1;
}
