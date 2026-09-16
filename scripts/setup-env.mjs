import {readFile,writeFile,lstat,chmod,mkdir,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {parse} from 'dotenv';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=resolve(process.env.ENV_FILE??resolve(project,'.env'));
await mkdir(dirname(target),{recursive:true,mode:0o700});
const info=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
if(info?.isSymbolicLink()||info&&!info.isFile())throw new Error('ENV_TARGET_MUST_BE_REGULAR_FILE');
const template=await readFile(resolve(project,'.env.example'),'utf8');
const old=info?await readFile(target,'utf8'):'';const existing=parse(old);const defaults=parse(template);
const generated={POSTGRES_PASSWORD:existing.POSTGRES_PASSWORD||randomBytes(24).toString('hex'),OPERATOR_TOKEN:existing.OPERATOR_TOKEN||randomBytes(32).toString('hex')};
const values={...defaults,...generated,...Object.fromEntries(Object.entries(existing).filter(([,value])=>value!==''))};
values.DATABASE_URL=existing.DATABASE_URL||`postgresql://apod:${encodeURIComponent(values.POSTGRES_PASSWORD)}@127.0.0.1:55432/apoderamientos?schema=public`;
const encode=value=>JSON.stringify(value);
let result=old;
if(!info){result=template.replace(/^([A-Z][A-Z0-9_]*)=.*$/gm,(_,key)=>`${key}=${encode(values[key]??'')}`);}
else{
  // Preserve existing entries/comments; populate only absent or blank local secrets.
  for(const key of ['POSTGRES_PASSWORD','OPERATOR_TOKEN','DATABASE_URL'])if(Object.hasOwn(existing,key)&&!existing[key])result=result.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${encode(values[key])}`);
  const missing=Object.keys(defaults).filter(key=>!Object.hasOwn(existing,key));
  if(missing.length)result+='\n# Additional APOD setup fields; live accounts remain pending.\n'+missing.map(key=>`${key}=${encode(values[key]??'')}`).join('\n')+'\n';
}
await writeFile(target,result,{mode:0o600});await chmod(target,0o600);
await mkdir(resolve(dirname(target),'config'),{recursive:true});
for(const name of ['kmaleon','apudata','sede'])try{await copyFile(resolve(project,`config/${name}.example.json`),resolve(dirname(target),`config/${name}.json`),1);}catch(e){if(e.code!=='EEXIST')throw e;}
console.log(JSON.stringify({environmentFile:target,configuredKeys:Object.keys(parse(result)).length,existingValuesPreserved:true,liveAccounts:'PENDING',secretValuesPrinted:false},null,2));
