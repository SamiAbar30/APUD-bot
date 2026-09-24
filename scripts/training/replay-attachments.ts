/**
 * Clients sending files, through the whole live path on the test stack: signed webhook → queue →
 * download → identification by content → PDF reading / certificate check / vision → brain → reply.
 * The emulator has no media server, so files are dropped in WCE_MEDIA_DIR under a numeric id.
 *
 * Usage: ENV_FILE=.env.wce npx tsx scripts/training/replay-attachments.ts
 */
import '../../src/config/load-env-file.js';
import {createHmac,randomInt} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {BASE,seedTrainingLines,resetLine,clearQueueFor,sendText,officeReplies} from './lines.js';
import {makeTestCertificates,TEST_CERT_PASSWORD} from './make-test-certificates.js';

const db=new PrismaClient();
const mediaDir=process.env.WCE_MEDIA_DIR??'.runtime/wce-media';
const guidePdf='/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento/docs/guia_cliente_apud_acta.pdf';
const checks:Array<{name:string;pass:boolean;detail:string}>=[];
const check=(name:string,pass:boolean,detail='')=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` — ${detail.replace(/\s+/g,' ').slice(0,170)}`:''}`);};
const transcript:string[]=[];

async function sendMedia(phone:string,kind:'document'|'image'|'audio',bytes:Buffer,mimeType:string,extra:{filename?:string;caption?:string}={}){
  const id=String(randomInt(10**11,10**12));
  await mkdir(mediaDir,{recursive:true,mode:0o700});
  await writeFile(join(mediaDir,id),bytes,{mode:0o600});
  await writeFile(join(mediaDir,`${id}.json`),JSON.stringify({mimeType}),{mode:0o600});
  const media={id,mime_type:mimeType,...(extra.filename?{filename:extra.filename}:{}),...(extra.caption?{caption:extra.caption}:{})};
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'wce-local-business',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{display_phone_number:'x',phone_number_id:'999000000000'},contacts:[{profile:{name:'Cliente'},wa_id:phone}],messages:[{from:phone,id:`wamid-media-${Date.now()}-${id}`,timestamp:String(Math.floor(Date.now()/1000)),type:kind,[kind]:media}]}}]}]});
  const signature=`sha256=${createHmac('sha256',process.env.WA_APP_SECRET!).update(body).digest('hex')}`;
  const response=await fetch(`${BASE}/webhooks/whatsapp`,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature},body});
  if(!response.ok)throw new Error(`WEBHOOK_${response.status}`);
}
async function turn(caseId:string,label:string,act:()=>Promise<void>){
  const before=new Date();await act();transcript.push(`CLIENTE: ${label}`);
  const replies=await officeReplies(db,caseId,before,{firstWithinMs:150_000});
  for(const r of replies)transcript.push(`DESPACHO: ${r}`);if(!replies.length)transcript.push('DESPACHO: (sin respuesta)');
  return replies.join(' ');
}
async function fresh(line:{phone:string;caseId:string}){
  await clearQueueFor([line.caseId]);const r=await resetLine(db,line.phone);
  await officeReplies(db,r.caseId,new Date(r.started.getTime()-1),{firstWithinMs:60_000,settleMs:2_000});return r.caseId;
}

const lines=(await seedTrainingLines(db)).filter(l=>l.document==='DNI');
const line=lines[0]!;
const dni=(await db.botApodExpediente.findUniqueOrThrow({where:{id:line.caseId},select:{dni:true}})).dni;
const certs=await makeTestCertificates(dni);

// ---- Screens and documents ----
transcript.push('=== Pantallas y documentos ===');
let caseId=await fresh(line);
await turn(caseId,'Sí tengo, en el ordenador',()=>sendText(line.phone,'Sí tengo, en el ordenador'));
const screenshot=await readFile('.runtime/training-media/sede/img-008.png');
let r=await turn(caseId,'[imagen: captura de la Sede] «estoy aquí, ¿qué pulso?»',()=>sendMedia(line.phone,'image',screenshot,'image/png',{caption:'estoy aquí, ¿qué pulso?'}));
check('screenshot is understood and answered with a step',!/no puedo (?:ver|recibir|abrir) (?:im[aá]genes|la imagen|capturas)/i.test(r)&&/apoderamiento|certificado digital|[aá]rea del ciudadano|poderdante|siguiente|pulsa/i.test(r),r);
r=await turn(caseId,'[PDF: la guía del despacho, como si fuera el justificante] «ya está, te mando el justificante»',async()=>sendMedia(line.phone,'document',await readFile(guidePdf),'application/pdf',{filename:'justificante.pdf',caption:'ya está, te mando el justificante'}));
check('the firm guide sent as justificante is recognised as the guide',/gu[ií]a|no es el justificante|justificante (?:que|firmado)|pdf que (?:descarga|te da)/i.test(r)&&!/est[aá] (?:todo )?correcto/i.test(r),r);
r=await turn(caseId,'[nota de voz]',async()=>{const id=String(randomInt(10**11,10**12));const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'wce-local-business',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{display_phone_number:'x',phone_number_id:'999000000000'},contacts:[{profile:{name:'Cliente'},wa_id:line.phone}],messages:[{from:line.phone,id:`wamid-voice-${Date.now()}`,timestamp:String(Math.floor(Date.now()/1000)),type:'audio',audio:{id,mime_type:'audio/ogg; codecs=opus',voice:true}}]}}]}]});const signature=`sha256=${createHmac('sha256',process.env.WA_APP_SECRET!).update(body).digest('hex')}`;await fetch(`${BASE}/webhooks/whatsapp`,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature},body});});
check('voice note gets a request to write it',/escrib|no (?:puedo|podemos) (?:escuchar|o[ií]r)/i.test(r),r);
r=await turn(caseId,'[ZIP]',()=>sendMedia(line.phone,'document',Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(200)]),'application/zip',{filename:'cosas.zip'}));
check('a file we cannot open gets a clear request (PDF)',/pdf|no (?:lo )?(?:puedo|podemos) abrir/i.test(r),r);

// ---- Certificates ----
transcript.push('=== Certificado correcto, contraseña mal y luego bien ===');
caseId=await fresh(line);
r=await turn(caseId,'[certificado valid.p12]',()=>sendMedia(line.phone,'document',certs.valid,'application/x-pkcs12',{filename:'certificado.p12'}));
check('certificate without password: asks for the password',/contrase/i.test(r)&&/aparte|otro mensaje/i.test(r),r);
r=await turn(caseId,'«la contraseña es Mala-1234»',()=>sendText(line.phone,'la contraseña es Mala-1234'));
check('wrong password is detected',/no abre|no es correcta|rev[ií]sala/i.test(r),r);
r=await turn(caseId,`«contraseña: ${TEST_CERT_PASSWORD}»`,()=>sendText(line.phone,`contraseña: ${TEST_CERT_PASSWORD}`));
check('right password: checked, in the client name, handed to a person',/se abre|a tu nombre/i.test(r)&&(await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{currentState:true}})).currentState==='ESCALATED_HUMAN',r);
const vaultFiles=(await readdir(join(process.env.STORAGE_DIR??'./storage','credentials')).catch(()=>[] as string[])).filter(f=>/^[0-9a-f-]{36}\.bin$/.test(f)).length;
check('certificate and password stored encrypted for the office',vaultFiles>0,`${vaultFiles} encrypted records`);

transcript.push('=== Certificado caducado con nombre engañoso ===');
caseId=await fresh(line);
r=await turn(caseId,'[caducado, enviado como documento.bin / application/octet-stream]',()=>sendMedia(line.phone,'document',certs.expired,'application/octet-stream',{filename:'documento.bin'}));
check('certificate recognised by content despite name and type',/contrase/i.test(r),r);
r=await turn(caseId,`«${TEST_CERT_PASSWORD}»`,()=>sendText(line.phone,TEST_CERT_PASSWORD));
check('expired certificate is detected with its date',/caduc/i.test(r),r);

transcript.push('=== Contraseña primero, certificado de otra persona ===');
caseId=await fresh(line);
await turn(caseId,'«no tengo ordenador, lo hacéis vosotros?»',()=>sendText(line.phone,'Tengo el certificado en el móvil y no tengo ordenador, ¿lo podéis hacer vosotros?'));
r=await turn(caseId,`«la contraseña es ${TEST_CERT_PASSWORD}»`,()=>sendText(line.phone,`la contraseña es ${TEST_CERT_PASSWORD}`));
check('password first: asks for the file',/archivo|\.p12|\.pfx/i.test(r),r);
r=await turn(caseId,'[certificado de otra persona]',()=>sendMedia(line.phone,'document',certs.otherPerson,'application/x-pkcs12',{filename:'cert.pfx'}));
check('certificate of another person is detected',/no est[aá] a tu nombre|otra persona/i.test(r),r);

transcript.push('=== Round 12: Cl@ve screen, certificate and password in one burst ===');
caseId=await fresh(line);
await turn(caseId,'Sí tengo, en el ordenador',()=>sendText(line.phone,'Sí tengo, en el ordenador'));
const claveScreen=await readFile('.runtime/training-media/sede/img-001.png');
r=await turn(caseId,'[captura: elegir Certificado electrónico o Cl@ve PIN] «¿cuál le doy?»',()=>sendMedia(line.phone,'image',claveScreen,'image/png',{caption:'¿cuál le doy?'}));
check('Cl@ve choice screen is answered, not treated as a code',!/no me mandes c[oó]digos|c[oó]digos ni claves/i.test(r)&&/certificado/i.test(r),r);
caseId=await fresh(line);
await turn(caseId,'«no tengo ordenador, hacedlo vosotros»',()=>sendText(line.phone,'Lo tengo en el móvil y no tengo ordenador, ¿lo hacéis vosotros?'));
r=await turn(caseId,'[certificado] + «te lo mando ahora» + «la contraseña es …» (una ráfaga)',async()=>{await sendMedia(line.phone,'document',certs.valid,'application/x-pkcs12',{filename:'certificado.p12'});await sendText(line.phone,'Vale te lo mando ahora');await sendText(line.phone,`La contraseña es ${TEST_CERT_PASSWORD}`);});
check('certificate + password in one burst: checked once, not asked again',/se abre|a tu nombre/i.test(r)&&!/m[aá]ndame (?:por aqu[ií] )?el archivo/i.test(r),r);

const leaked=await db.botApodMessage.count({where:{content:{contains:TEST_CERT_PASSWORD}}});
check('the password never appears in the chat history',leaked===0,`${leaked} messages contain it`);
await db.$disconnect();
console.log('\n'+transcript.join('\n'));
const failed=checks.filter(c=>!c.pass);
console.log(JSON.stringify({passed:checks.length-failed.length,of:checks.length,failed:failed.map(f=>f.name)}));
if(failed.length)process.exitCode=1;
