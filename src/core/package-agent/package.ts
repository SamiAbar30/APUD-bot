import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const nodeSchema=z.object({say:z.union([z.string(),z.array(z.string())]).optional(),next:z.string().optional(),on:z.record(z.string()).optional(),on_event:z.record(z.string()).optional(),handoff:z.string().optional(),end:z.boolean().optional()}).passthrough();
const flowSchema=z.object({name:z.string(),version:z.number(),start:z.string(),handoff_reasons:z.array(z.string()),nodes:z.record(nodeSchema),global_intents:z.record(z.object({say:z.string().optional(),goto:z.string().optional(),return:z.boolean().optional(),if_persists:z.string().optional()}).passthrough())}).passthrough();
export type AgentFlow=z.infer<typeof flowSchema>;
export type Example={user:string;assistant:string;source:string};
export const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export class AgentPackage {
  private constructor(readonly directory:string,readonly rawPrompt:string,readonly placeholders:Record<string,{value:string;status?:string}>,readonly flow:AgentFlow,readonly examples:Example[],readonly hash:string,readonly guideHash:string,readonly corpusCounts:Record<string,number>){ }
  static async load(directory:string){
    // Deliberate allowlist: never enumerate client exports or open certificate files.
    const files=['system_prompt.md','placeholders.json','flow.json','training/sft_pairs.jsonl','training/conversations.jsonl','training/rare_cases.jsonl','eval_scenarios.jsonl'];
    const contents=await Promise.all(files.map(f=>readFile(resolve(directory,f),'utf8')));
    const [prompt,values,flowText]=contents as [string,string,string,...string[]];
    const placeholders=z.record(z.object({value:z.string(),status:z.string().optional()}).passthrough()).parse(Object.fromEntries(Object.entries(JSON.parse(values)).filter(([k])=>!k.startsWith('_'))));
    const flow=flowSchema.parse(JSON.parse(flowText));
    if(!flow.nodes[flow.start])throw new Error('PACKAGE_START_MISSING');
    for(const n of Object.values(flow.nodes))for(const target of [n.next,...Object.values(n.on??{}),...Object.values(n.on_event??{})].filter(Boolean))if(!flow.nodes[target!])throw new Error('PACKAGE_TARGET_MISSING');
    const examples:Example[]=[];const counts:Record<string,number>={};const seen=new Set<string>();
    for(let i=3;i<=5;i++){
      const rows=contents[i]!.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));counts[files[i]!]=rows.length;
      for(const row of rows){
        const turns=row.messages??row.turns??[];
        for(let j=i===3?Math.max(1,turns.length-1):1;j<turns.length;j++){
          const a=turns[j],u=turns[j-1];
          if(a.role!=='assistant'||u.role!=='user'||typeof a.content!=='string'||typeof u.content!=='string')continue;
          // Historical system messages are never promoted to instructions. Older
          // identity, payment and credential templates cannot override the new flow.
          if(a.content.length>800||u.content.length>700||/Dayana|mi nombre|contrase|clave|cl@ve|PIN|SMS|\bIBAN\b|\b\d{4,}\b|https?:|\[.*\]|\p{Extended_Pictographic}/iu.test(a.content))continue;
          if(/contrase|password|\bPIN\b|\.(?:p12|pfx)|\[.*\]/iu.test(u.content))continue;
          const key=u.content+'\0'+a.content;if(seen.has(key))continue;seen.add(key);
          examples.push({user:u.content,assistant:a.content,source:files[i]!});
        }
      }
    }
    const guidePath=resolve(directory,placeholders.PDF_GUIA_CLIENTE?.value??'');
    if(guidePath!==resolve(directory,'docs/guia_cliente_apud_acta.pdf'))throw new Error('PACKAGE_GUIDE_PATH_NOT_APPROVED');
    const guide=await readFile(guidePath);if(!guide.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('PACKAGE_GUIDE_NOT_PDF');
    const guideHash=digest(guide);guide.fill(0);
    return new AgentPackage(resolve(directory),prompt,placeholders,flow,examples,digest(contents.join('\0')+'\0'+guideHash),guideHash,counts);
  }
  substitute(source:string,date=new Date()):string{
    return source.replace(/\{\{([A-Z_]+)\}\}/g,(_all,key:string)=>{
      if(key==='SALUDO')return Number(new Intl.DateTimeFormat('es-ES',{hour:'numeric',hourCycle:'h23',timeZone:'Europe/Madrid'}).format(date))<14?'Buenos días':'Buenas tardes';
      const p=this.placeholders[key];return !p||p.status==='TODO'?'TODO':p.value;
    });
  }
  systemPrompt(date=new Date()){return this.substitute(this.rawPrompt,date);}
  todos(){return Object.entries(this.placeholders).filter(([,p])=>p.status==='TODO'||p.value==='TODO').map(([k])=>k);}
  async guide(){const bytes=await readFile(resolve(this.directory,'docs/guia_cliente_apud_acta.pdf'));if(digest(bytes)!==this.guideHash){bytes.fill(0);throw new Error('PACKAGE_GUIDE_CHANGED');}return bytes;}
  fewShot(text:string,limit=3){return keywordRank(this.examples,text,limit);}
}

/** Word-overlap ranking: the pre-RAG retriever, kept as the fallback and as the evaluation baseline. */
export function keywordRank(examples:readonly Example[],text:string,limit:number,exclude?:(index:number)=>boolean):Example[]{
  const tokens=(s:string)=>new Set(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z]{3,}/g)??[]);
  const query=tokens(text);const seen=new Set<string>();
  return examples.map((e,i)=>({e,i,score:[...tokens(e.user)].filter(t=>query.has(t)).length})).filter(x=>x.score>0&&!exclude?.(x.i)).sort((a,b)=>b.score-a.score).filter(({e})=>{if(seen.has(e.assistant))return false;seen.add(e.assistant);return true;}).slice(0,limit).map(x=>x.e);
}
