import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentPackage, digest } from '../core/package-agent/package.js';

export interface ReferenceAgentContext {
  packageName:string;packageVersion:number|string|null;safePrompt:string;
  masterPrompt?:string;packageHash?:string;dataset?:AgentPackage;
  flowLabels:readonly string[];globalIntents:readonly string[];todoPlaceholders:readonly string[];
  training:{conversations:number;sftPairs:number;rareCases:number;redactions:Readonly<Record<string,number>>};
}
export type ReferenceAgentLoad=
  |{status:'DISABLED';context:null;reason:'PATH_NOT_CONFIGURED'}
  |{status:'MISSING';context:null;reason:'PACKAGE_NOT_FOUND'}
  |{status:'INVALID';context:null;reason:'PACKAGE_INVALID'}
  |{status:'LOADED';context:ReferenceAgentContext;reason:''};

/** Loads the exact substituted prompt and scrubbed examples, never raw exports or certificates. */
export async function loadReferenceAgentPackage(directory?:string,masterFile?:string):Promise<ReferenceAgentLoad>{
  if(!directory?.trim())return {status:'DISABLED',context:null,reason:'PATH_NOT_CONFIGURED'};
  try{
    const dataset=await AgentPackage.load(directory);
    const masterPrompt=await readFile(masterFile??resolve('docs/source/apud_acta_master_prompt.md'),'utf8');
    return {status:'LOADED',reason:'',context:{
      packageName:dataset.flow.name,packageVersion:dataset.flow.version,safePrompt:dataset.systemPrompt(),masterPrompt,dataset,packageHash:digest(dataset.hash+'\0'+masterPrompt),
      flowLabels:Object.entries(dataset.flow.nodes).map(([id,n])=>`${id}: ${n.label??id}`),globalIntents:Object.keys(dataset.flow.global_intents),todoPlaceholders:dataset.todos(),
      training:{conversations:dataset.corpusCounts['training/conversations.jsonl']??0,sftPairs:dataset.corpusCounts['training/sft_pairs.jsonl']??0,rareCases:dataset.corpusCounts['training/rare_cases.jsonl']??0,redactions:{}},
    }};
  }catch(error){return error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'?{status:'MISSING',context:null,reason:'PACKAGE_NOT_FOUND'}:{status:'INVALID',context:null,reason:'PACKAGE_INVALID'};}
}
