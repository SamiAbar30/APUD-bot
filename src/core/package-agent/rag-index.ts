import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {digest,keywordRank,type AgentPackage,type Example} from './package.js';

export const RAG_EMBEDDING_MODEL='text-embedding-3-small';
export const RAG_INDEX_DIR='.runtime/rag';
const BATCH=256;

/**
 * What gets embedded: the client's words only. On held-out real exchanges, adding the
 * preceding office message made retrieval worse (evidence/retrieval-evaluation.json).
 */
export function embeddingText(client:string):string{
  return `Cliente: ${client.replace(/\s+/g,' ').trim().slice(0,700)}`;
}

export interface Embedder{readonly model:string;embed(texts:readonly string[]):Promise<{vectors:Float32Array[];tokens:number}>}

/** OpenAI-compatible /embeddings client. Vectors are L2-normalised so a dot product is cosine similarity. */
export class OpenAIEmbedder implements Embedder{
  constructor(private readonly baseUrl:string,private readonly apiKey:string,readonly model=RAG_EMBEDDING_MODEL,private readonly timeoutMs=8000){}
  async embed(texts:readonly string[]){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await fetch(`${this.baseUrl.replace(/\/+$/,'')}/embeddings`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.apiKey}`},body:JSON.stringify({model:this.model,input:texts}),signal:controller.signal,redirect:'error'});
      if(!response.ok)throw new Error(`EMBEDDINGS_HTTP_${response.status}`);
      const body=await response.json() as {data?:Array<{index:number;embedding:number[]}>;usage?:{total_tokens?:number}};
      const rows=[...(body.data??[])].sort((a,b)=>a.index-b.index);
      if(rows.length!==texts.length)throw new Error('EMBEDDINGS_COUNT_MISMATCH');
      return {vectors:rows.map(r=>normalise(Float32Array.from(r.embedding))),tokens:body.usage?.total_tokens??0};
    }finally{clearTimeout(timer);}
  }
}

function normalise(v:Float32Array):Float32Array{
  let sum=0;for(const x of v)sum+=x*x;const n=Math.sqrt(sum)||1;
  for(let i=0;i<v.length;i++)v[i]!/=n;return v;
}

type Meta={model:string;packageHash:string;textsDigest:string;count:number;dims:number;builtAt:string};
export type RagLoad={status:'LOADED';index:RagIndex}|{status:'MISSING'|'STALE';index:null};

export class RagIndex{
  private constructor(readonly meta:Meta,private readonly vectors:Float32Array){}

  static texts(pkg:AgentPackage):string[]{return pkg.examples.map(e=>embeddingText(e.user));}
  private static paths(dir:string,model:string){const base=resolve(dir,`examples-${model}`);return {meta:`${base}.json`,vectors:`${base}.f32`};}

  static async build(pkg:AgentPackage,embedder:Embedder,dir=RAG_INDEX_DIR){
    const texts=RagIndex.texts(pkg);let dims=0;let tokens=0;let vectors=new Float32Array(0);
    for(let start=0;start<texts.length;start+=BATCH){
      const batch=await embedder.embed(texts.slice(start,start+BATCH));tokens+=batch.tokens;
      if(!dims){dims=batch.vectors[0]!.length;vectors=new Float32Array(texts.length*dims);}
      batch.vectors.forEach((v,i)=>vectors.set(v,(start+i)*dims));
    }
    const meta:Meta={model:embedder.model,packageHash:pkg.hash,textsDigest:digest(texts.join('\0')),count:texts.length,dims,builtAt:new Date().toISOString()};
    const paths=RagIndex.paths(dir,embedder.model);
    await mkdir(resolve(dir),{recursive:true});
    await writeFile(paths.vectors,Buffer.from(vectors.buffer),{mode:0o600});
    await writeFile(paths.meta,JSON.stringify(meta,null,2),{mode:0o600});
    return {index:new RagIndex(meta,vectors),tokens};
  }

  /** An index built from a different package or example set is STALE and never used. */
  static async load(pkg:AgentPackage,model=RAG_EMBEDDING_MODEL,dir=RAG_INDEX_DIR):Promise<RagLoad>{
    const paths=RagIndex.paths(dir,model);
    let meta:Meta;let bytes:Buffer;
    try{meta=JSON.parse(await readFile(paths.meta,'utf8'));bytes=await readFile(paths.vectors);}catch{return {status:'MISSING',index:null};}
    const texts=RagIndex.texts(pkg);
    if(meta.model!==model||meta.packageHash!==pkg.hash||meta.count!==texts.length||meta.textsDigest!==digest(texts.join('\0'))||bytes.length!==meta.count*meta.dims*4)return {status:'STALE',index:null};
    const vectors=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length));
    return {status:'LOADED',index:new RagIndex(meta,vectors)};
  }

  vector(i:number):Float32Array{return this.vectors.subarray(i*this.meta.dims,(i+1)*this.meta.dims);}

  /** Example indices ordered by cosine similarity to `query`. */
  rank(query:Float32Array,limit:number,exclude?:(index:number)=>boolean):number[]{
    const {count,dims}=this.meta;const scores:Array<[number,number]>=[];
    for(let i=0;i<count;i++){
      if(exclude?.(i))continue;
      let s=0;const o=i*dims;for(let d=0;d<dims;d++)s+=this.vectors[o+d]!*query[d]!;
      scores.push([s,i]);
    }
    return scores.sort((a,b)=>b[0]-a[0]).slice(0,limit).map(x=>x[1]);
  }
}

/** Pick `limit` distinct replies from ranked example indices. */
export function distinctExamples(examples:readonly Example[],ranked:readonly number[],limit:number):Example[]{
  const seen=new Set<string>();const out:Example[]=[];
  for(const i of ranked){const e=examples[i]!;if(seen.has(e.assistant))continue;seen.add(e.assistant);out.push(e);if(out.length===limit)break;}
  return out;
}

export type RetrievalMethod='RAG'|'KEYWORD';

/**
 * Meaning-based few-shot retrieval with a keyword fallback: a missing/stale
 * index or a failed embedding call never blocks a client reply.
 */
export class ExampleRetriever{
  readonly metrics={rag:0,keywordFallback:0};
  private loaded?:Promise<RagLoad>;
  constructor(private readonly pkg:AgentPackage,private readonly embedder:Embedder|null){}

  status():Promise<RagLoad['status']|'DISABLED'>{return this.embedder?this.load().then(r=>r.status):Promise.resolve('DISABLED');}
  private load(){return this.loaded??=RagIndex.load(this.pkg,this.embedder!.model);}

  async examples(clientText:string,limit=5):Promise<{examples:Example[];method:RetrievalMethod}>{
    if(this.embedder){
      const rag=await this.load();
      if(rag.status==='LOADED'){
        try{
          const {vectors:[query]}=await this.embedder.embed([embeddingText(clientText)]);
          this.metrics.rag++;
          return {examples:distinctExamples(this.pkg.examples,rag.index.rank(query!,limit*4),limit),method:'RAG'};
        }catch{/* fall through to keyword retrieval */}
      }
    }
    this.metrics.keywordFallback++;
    return {examples:keywordRank(this.pkg.examples,clientText,limit),method:'KEYWORD'};
  }
}
