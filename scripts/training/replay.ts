/**
 * Replays a real conversation's client messages, word for word, against the live bot on a training
 * line, and prints what the bot answers now. Default script: the manager's test of 23 Sep
 * ("WhatsApp UI Emulator con comentarios"), where the rule-based bot looped.
 *
 * Usage: ENV_FILE=.env.wce npx tsx scripts/training/replay.ts [file-with-one-message-per-line]
 */
import '../../src/config/load-env-file.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {PrismaClient} from '@prisma/client';
import {seedTrainingLines,resetLine,clearQueueFor,sendText,officeReplies} from './lines.js';

const MANAGER_23_SEP=[
  'Hola, no se si tengo certificado digital. donde puedo mirar',
  'no se',
  'me muestras una foto de como luce la aplicacion ?',
  'es que no se en donde mirar',
  'yo creo que lo tengo en el movil pero no se cual es la aplicacion del certificado digital',
  'y si encuentro la aplicacion que tengo que hacer ?',
  'me das paso a paso ? ya encontré la aplicación',
  'prefiero hacerlo desde el movil',
  'vale, ya lo tengo en un ordenador . Ahora que hago ?',
  'no puedo compartir contigo mi certificado prefiero hacerlo yo',
  'ya tengo el certificado en el ordenador . AHora que hago',
  'ordenador',
  'quieres que pinche en esos enlaces ?',
  'no, es que prefiero hacerlo yo',
  'ya entre en la sede. Ahora que hago ?',
  'no',
  'creo que no comprendes lo que necesito. Necesito asistencia',
  'no puedo compartir mi certificado',
];

const file=process.argv[2];
const script=file?(await readFile(file,'utf8')).split('\n').map(l=>l.trim()).filter(Boolean):MANAGER_23_SEP;
const db=new PrismaClient();
const line=(await seedTrainingLines(db)).find(l=>l.document==='DNI')!;
await clearQueueFor([line.caseId]);
const {caseId,started}=await resetLine(db,line.phone);
const out:string[]=[];
for(const text of await officeReplies(db,caseId,new Date(started.getTime()-1),{firstWithinMs:60_000,settleMs:2_000}))out.push(`DESPACHO: ${text}`);
for(const text of script){
  const before=new Date();
  await sendText(line.phone,text);
  out.push(`CLIENTE: ${text}`);
  const replies=await officeReplies(db,caseId,before);
  for(const reply of replies)out.push(`DESPACHO: ${reply}`);
  if(!replies.length)out.push('DESPACHO: (sin respuesta)');
  const c=await db.botApodExpediente.findUniqueOrThrow({where:{id:caseId},select:{currentState:true}});
  if(c.currentState==='ESCALATED_HUMAN'){out.push('— caso pasado a una persona del equipo; el resto de mensajes los atiende ella —');break;}
}
await db.$disconnect();
await mkdir('evidence/training',{recursive:true});
const target=`evidence/training/replay-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.txt`;
await writeFile(target,out.join('\n\n'),{mode:0o600});
console.log(out.join('\n\n'));
console.log(`\n[saved ${target}]`);
