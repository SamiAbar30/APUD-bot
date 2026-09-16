/**
 * Retrieval quality on held-out real conversations: RAG vs the previous keyword matcher.
 *
 * About 10% of the package's real client->staff exchanges (stable hash) are removed from the
 * candidate pool. For each one, both retrievers pick examples from the client's text exactly as
 * production does, and we measure how close the
 * retrieved staff replies are to what staff really answered. Real data and real embeddings only.
 */
import '../src/config/load-env-file.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
import {AgentPackage,digest,keywordRank,type Example} from '../src/core/package-agent/package.js';
import {OpenAIEmbedder,RagIndex,distinctExamples,RAG_EMBEDDING_MODEL,RAG_INDEX_DIR} from '../src/core/package-agent/rag-index.js';

const LIMIT=5;
const dir=process.env.APOD_AGENT_PACKAGE_DIR;if(!dir)throw new Error('APOD_AGENT_PACKAGE_DIR_REQUIRED');
const ai=conversationAiFromEnv();if(ai.status!=='CONFIGURED'||ai.config.mode!=='online')throw new Error('REAL_ONLINE_AI_REQUIRED');
const pkg=await AgentPackage.load(dir);
const rag=await RagIndex.load(pkg);if(rag.status!=='LOADED')throw new Error(`RAG_INDEX_${rag.status}: run npm run rag:build`);
const embedder=new OpenAIEmbedder(ai.config.baseUrl,ai.config.apiKey,RAG_EMBEDDING_MODEL,60_000);

// Staff replies are embedded once (cached) so retrieved replies can be compared with the real one.
const replies=[...new Set(pkg.examples.map(e=>e.assistant))];
const cacheFile=resolve(RAG_INDEX_DIR,`replies-${RAG_EMBEDDING_MODEL}.f32`);const cacheMeta=cacheFile+'.json';const repliesDigest=digest(replies.join('\0'));
let replyVectors:Float32Array[]=[];
try{
  const meta=JSON.parse(await readFile(cacheMeta,'utf8'));const bytes=await readFile(cacheFile);
  if(meta.digest===repliesDigest){const all=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length));replyVectors=replies.map((_,i)=>all.subarray(i*meta.dims,(i+1)*meta.dims));}
}catch{/* built below */}
if(!replyVectors.length){
  for(let i=0;i<replies.length;i+=256)replyVectors.push(...(await embedder.embed(replies.slice(i,i+256))).vectors);
  const dims=replyVectors[0]!.length;const all=new Float32Array(replies.length*dims);replyVectors.forEach((v,i)=>all.set(v,i*dims));
  await mkdir(resolve(RAG_INDEX_DIR),{recursive:true});await writeFile(cacheFile,Buffer.from(all.buffer),{mode:0o600});await writeFile(cacheMeta,JSON.stringify({digest:repliesDigest,dims}),{mode:0o600});
}
const replyVector=new Map(replies.map((r,i)=>[r,replyVectors[i]!]));
const cosine=(a:Float32Array,b:Float32Array)=>{let s=0;for(let i=0;i<a.length;i++)s+=a[i]!*b[i]!;return s;};
const words=(s:string)=>new Set(s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').match(/[a-z]{3,}/g)??[]);
const jaccard=(a:string,b:string)=>{const x=words(a),y=words(b);if(!x.size||!y.size)return 0;let n=0;for(const w of x)if(y.has(w))n++;return n/(x.size+y.size-n);};

const heldOut=new Set(pkg.examples.map((e,i)=>[i,digest(e.user+'\0'+e.assistant)] as const).filter(([,h])=>parseInt(h.slice(0,2),16)%10===0).map(([i])=>i));
const exclude=(i:number)=>heldOut.has(i);
type Score={top1Meaning:number;best5Meaning:number;top1Words:number;empty:boolean};
const score=(real:Example,picked:Example[]):Score=>{
  if(!picked.length)return {top1Meaning:0,best5Meaning:0,top1Words:0,empty:true};
  const target=replyVector.get(real.assistant)!;
  return {top1Meaning:cosine(target,replyVector.get(picked[0]!.assistant)!),best5Meaning:Math.max(...picked.map(p=>cosine(target,replyVector.get(p.assistant)!))),top1Words:jaccard(real.assistant,picked[0]!.assistant),empty:false};
};
const rows:Array<{rag:Score;keyword:Score}>=[];
for(const i of heldOut){
  const real=pkg.examples[i]!;
  const ragPicked=distinctExamples(pkg.examples,rag.index.rank(rag.index.vector(i),LIMIT*4,exclude),LIMIT);
  const keywordPicked=keywordRank(pkg.examples,real.user,LIMIT,exclude);
  rows.push({rag:score(real,ragPicked),keyword:score(real,keywordPicked)});
}
const mean=(pick:(r:typeof rows[number])=>number)=>Number((rows.reduce((n,r)=>n+pick(r),0)/rows.length).toFixed(4));
const summary=(k:'rag'|'keyword')=>({top1Meaning:mean(r=>r[k].top1Meaning),best5Meaning:mean(r=>r[k].best5Meaning),top1Words:mean(r=>r[k].top1Words),noExamplesFound:rows.filter(r=>r[k].empty).length});
const ragSummary=summary('rag'),keywordSummary=summary('keyword');
const wins=rows.filter(r=>r.rag.best5Meaning>r.keyword.best5Meaning).length,losses=rows.filter(r=>r.rag.best5Meaning<r.keyword.best5Meaning).length;
const pass=ragSummary.top1Meaning>keywordSummary.top1Meaning&&ragSummary.best5Meaning>keywordSummary.best5Meaning&&ragSummary.top1Words>keywordSummary.top1Words;
const report={at:new Date().toISOString(),status:pass?'PASS':'FAIL',criterion:'RAG beats keyword on all three means',scope:'HELD_OUT_REAL_PACKAGE_EXCHANGES_REAL_EMBEDDINGS',embeddingModel:RAG_EMBEDDING_MODEL,packageHash:pkg.hash,examples:pkg.examples.length,heldOut:rows.length,rag:ragSummary,keyword:keywordSummary,best5MeaningWins:{rag:wins,keyword:losses,ties:rows.length-wins-losses},
  note:'Meaning scores use the same embedding model as RAG and may favour it; the word-overlap score is independent of embeddings.'};
await mkdir('evidence',{recursive:true});await writeFile('evidence/retrieval-evaluation.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));
if(!pass)process.exitCode=1;
