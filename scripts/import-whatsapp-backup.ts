/**
 * Import real client conversations from a decrypted WhatsApp message database into the
 * training package's conversation format.
 *
 * Only two-way one-to-one chats are read (no groups, broadcasts, status or newsletters), and only
 * chats where the office actually did client support. Every turn is redacted before it is written:
 * phone numbers, DNI/NIE, e-mail, IBAN, card-like numbers, URLs, contact and staff names. Messages
 * that look like credentials are dropped entirely. The decrypted database is never copied and the
 * output contains no phone number, name or chat identifier — chats are keyed by a salted hash.
 *
 * Usage: tsx scripts/import-whatsapp-backup.ts <msgstore.db> <out.jsonl>
 */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

const [dbPath,outPath]=process.argv.slice(2);
if(!dbPath||!outPath){console.error('Usage: tsx scripts/import-whatsapp-backup.ts <msgstore.db> <out.jsonl>');process.exit(2);}

/** The office replied about a case: proof this chat is client support, not staff or supplier chat. */
const SUPPORT=/apoderamiento|apud ?acta|certificado digital|reclamaci|expediente|micropr[eé]stamo|juzgado|demanda|procurador|sede judicial|autofirma|justicia|documentaci[oó]n/i;
const CERT_FILE=/\.(?:p12|pfx)\b/i;
const CREDENTIAL=/(?:contrase\S*|password|passphrase|\bpin\b|\botp\b|token|clave|c[oó]digo)\s*(?:de \w+\s*)?(?:es|son|:|=)\s*\S{3,}/i;
/** A secret-looking token (mixed letters and digits) anywhere near credential wording. */
const SECRET_NEARBY=/(?:contrase\S*|password|passphrase|\bpin\b|\botp\b|token|clave|c[oó]digo)/i;
const SECRET_TOKEN=/(?=\S*\d)(?=\S*[A-Za-z])[A-Za-z0-9!@#$%^&*+._-]{6,}/;
const STAFF=/\b(?:dayana|morera de la nuez|daniel|carmen|sami)\b/gi;

/**
 * The backup carries no address book, so personal names are learned from the text itself:
 * whatever follows a greeting, a self-introduction or a handoff is treated as a name and then
 * masked everywhere. Brands, places and role words are never collected.
 */
const NAME_CUES=[
  /\b(?:hola|buenos d[ií]as|buenas tardes|buenas noches|estimad[oa]s?|sr\.?|sra\.?|do[nñ]a?)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/gi,
  /\b(?:me llamo|mi nombre es|soy|habla|le atiende)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/g,
  /\b(?:aviso a|se lo paso a|hablar? con|pregunta por|te atiende|mi compa[nñ]er[ao])\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/gi,
];
const NOT_A_NAME=new Set(['hola','buenas','buenos','gracias','todo','que','como','para','por','con','una','uno','los','las','del','sede','justicia','judicial','apud','acta','clave','autofirma','fnmt','dni','nie','whatsapp','litigios','mykredit','moneyman','wandoo','vivus','cashper','zaplo','creditea','madrid','barcelona','valencia','sevilla','bilbao','zaragoza','malaga','murcia','espana','españa','enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre','abogado','abogada','gestor','gestora','procurador','procuradora','cliente','clienta','compañera','compañero','equipo','despacho','banco','correo','email','certificado','expediente','contrato','reclamacion','documento','ordenador','movil','telefono','usted','ustedes','ella','ellos','nada','algo','esto','eso','este','esta','pues','vale','perfecto','disculpe','perdon','señor','señora','muchas','tarde','tardes','dias','noches']);
const plain=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

const salt=createHash('sha256').update(dbPath+'|apod-import-v1').digest();
const chatKey=(jid:string)=>createHash('sha256').update(salt).update(jid).digest('hex').slice(0,16);

function collectNames(text:string,into:Set<string>):void{
  for(const cue of NAME_CUES){cue.lastIndex=0;
    for(const match of text.matchAll(cue)){
      const name=match[1]!;
      if(name.length>=3&&!NOT_A_NAME.has(plain(name)))into.add(name);
    }
  }
}

function redact(text:string,names:readonly string[]):string{
  let value=text
    .replace(/https?:\/\/\S+|www\.\S+/gi,'<URL>')
    .replace(/[\w.+-]+\s*@[\s,.]*[\w.-]+\.\w{2,}/g,'<EMAIL>')
    .replace(/\bES\s?\d{2}(?:[ -]?\d){12,22}\b/gi,'<IBAN>')
    .replace(/\b[XYZ][ -]?\d{7}[ -]?[A-Z]\b|\b\d{8}[ -]?[A-Z]\b/gi,'<ID>')
    .replace(/\b(?:\+?(?:00)?34[ .-]?)?[6789](?:[ .-]?\d){8}\b/g,'<PHONE>')
    .replace(/\b\d{13,19}\b/g,'<CARD>')
    // Any long digit run left over (phone glued to text, reference numbers) is not worth keeping.
    .replace(/\d{8,}/g,'<NUMBER>')
    .replace(STAFF,'<PERSON>');
  for(const name of names)value=value.replace(new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\p{L}\\d])`,'giu'),'<PERSON>');
  // Greetings carry the client's name: "Hola Juan", "Buenas tardes Sr. García".
  value=value.replace(/\b(hola|buenos d[ií]as|buenas tardes|buenas noches|estimad[oa]|sr\.?|sra\.?|d\.|d[oñ]a)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+)?)/gi,(_m,greet:string)=>`${greet} <PERSON>`);
  // Self-introductions: "me llamo Juan", "soy María López".
  value=value.replace(/\b(me llamo|mi nombre es|soy)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+)?)\b/g,(_m,lead:string)=>`${lead} <PERSON>`);
  return value.replace(/[ \t]+/g,' ').replace(/\s+([,.!?])/g,'$1').trim();
}

const db=new DatabaseSync(dbPath,{readOnly:true});
type Row={chat:number;jid:string;name:string|null;from_me:number;text:string};
const rows=db.prepare(`
  SELECT m.chat_row_id AS chat, j.user || '@' || j.server AS jid, c.subject AS name, m.from_me AS from_me, m.text_data AS text
  FROM message m
  JOIN chat c ON c._id = m.chat_row_id
  JOIN jid j ON j._id = c.jid_row_id
  WHERE j.server IN ('s.whatsapp.net','lid') AND m.message_type = 0
    AND m.text_data IS NOT NULL AND length(m.text_data) > 0
  ORDER BY m.chat_row_id, m.sort_id, m._id
`).all() as unknown as Row[];
db.close();

type Turn={role:'assistant'|'user';content:string};
const chats=new Map<number,{jid:string;name:string|null;turns:Turn[];support:boolean;office:number;client:number}>();
for(const row of rows){
  let chat=chats.get(row.chat);
  if(!chat){chat={jid:row.jid,name:row.name,turns:[],support:false,office:0,client:0};chats.set(row.chat,chat);}
  const role=row.from_me?'assistant':'user';
  if(role==='assistant'){chat.office++;if(SUPPORT.test(row.text))chat.support=true;}else chat.client++;
  const last=chat.turns.at(-1);
  // Consecutive messages from the same side are one turn: clients send several short lines.
  if(last?.role===role)last.content+=`\n${row.text}`;else chat.turns.push({role,content:row.text});
}

// Pass one: learn the names used in these conversations.
const learned=new Set<string>();
for(const chat of chats.values())for(const turn of chat.turns)collectNames(turn.content,learned);
const wordCounts=new Map<string,number>();
for(const chat of chats.values())for(const turn of chat.turns)
  for(const word of turn.content.match(/[\p{L}]{3,}/gu)??[])wordCounts.set(word,(wordCounts.get(word)??0)+1);
const occurrences=(word:string)=>wordCounts.get(word)??0;
// A real name is written capitalised almost everywhere; ordinary words are not.
const learnedNames=[...learned].filter(name=>{
  if(name.length<4)return false;
  const capitalised=occurrences(name[0]!.toUpperCase()+name.slice(1).toLowerCase());
  const lower=occurrences(name.toLowerCase());
  return capitalised>=2&&capitalised/(capitalised+lower)>=0.8;
});

const stats={learnedNames:learnedNames.length,chats:chats.size,kept:0,skippedNotSupport:0,skippedTooShort:0,turns:0,droppedCredentialTurns:0};
const out:string[]=[];
for(const chat of chats.values()){
  if(chat.office<2||chat.client<2||chat.turns.length<4){stats.skippedTooShort++;continue;}
  if(!chat.support){stats.skippedNotSupport++;continue;}
  const names=[...learnedNames,...(chat.name??'').split(/[\s,._-]+/).filter(part=>/^[\p{L}]{3,}$/u.test(part))];
  const turns:Turn[]=[];
  for(const turn of chat.turns){
    if(CREDENTIAL.test(turn.content)||CERT_FILE.test(turn.content)||(SECRET_NEARBY.test(turn.content)&&SECRET_TOKEN.test(turn.content))){stats.droppedCredentialTurns++;continue;}
    const content=redact(turn.content,names);
    if(!content)continue;
    const last=turns.at(-1);
    if(last?.role===turn.role)last.content+=`\n${content}`;else turns.push({role:turn.role,content});
  }
  if(turns.length<4)  {stats.skippedTooShort++;continue;}
  stats.kept++;stats.turns+=turns.length;
  out.push(JSON.stringify({chat_id:chatKey(chat.jid),source:'phone_backup',turns}));
}
await writeFile(outPath,out.join('\n')+'\n',{mode:0o600});
console.log(JSON.stringify({output:outPath,...stats},null,1));
