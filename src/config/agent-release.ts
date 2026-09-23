import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {digest} from '../core/package-agent/package.js';

/** An evaluation belongs to these exact runtime policies, not just a model name. */
export async function agentRuntimeHash(){
  const paths=['src/core/conversation-agent.ts','src/core/conversation-batching.ts','src/core/debounce-buffer.ts','src/config/env.ts','src/core/conversation-policy.ts','src/core/conversation-guidance.ts','src/core/messages.ts','src/core/follow-up.ts','prisma/schema.prisma','src/core/package-agent/package.ts','src/core/package-agent/rag-index.ts','src/config/reference-agent.ts','src/adapters/ai/openai-compatible-conversation.ts','src/domain/fsm/state-machine.ts','src/core/workflow-service.ts','src/api/server.ts','scripts/eval-agent.ts'];
  // The brain and its playbook decide live replies, so changing either must invalidate old evaluations.
  paths.push('src/core/conversation-brain.ts','src/adapters/ai/openai-brain.ts','src/config/brain.ts',process.env.BRAIN_PLAYBOOK_FILE??'config/brain/playbook.md');
  paths.push('src/core/compound-reply.ts','src/core/topic-routing.ts','src/core/case-memory.ts','src/core/phase-one.ts','src/core/phase-one-intent.ts','src/core/automation.ts','src/queue/action-executor.ts');
  return digest((await Promise.all(paths.map(p=>readFile(resolve(p),'utf8')))).join('\0'));
}
export async function requireAgentEvaluations(reportFile:string|undefined,packageHash:string,model:string){
  if(!reportFile)throw new Error('AGENT_EVALUATION_REPORT_REQUIRED');
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  if(report.packageHash!==packageHash||report.model!==model||report.runtimeHash!==await agentRuntimeHash()||report.total!==14||report.passed!==14||report.releaseReady!==true||!Array.isArray(report.results)||report.results.length!==14||report.results.some((r:{pass?:boolean})=>r.pass!==true))throw new Error('AGENT_EVALUATIONS_MUST_PASS_BEFORE_LIVE');
}
