/** Provided scenarios, real online GPT, actual runtime agent/FSM. No client sends or CRM/DB writes. */
import '../src/config/load-env-file.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PrismaClient,type BotApodExpediente} from '@prisma/client';
import {conversationAiFromEnv} from '../src/config/conversation-ai.js';
import {loadReferenceAgentPackage} from '../src/config/reference-agent.js';
import {OpenAICompatibleConversationModel} from '../src/adapters/ai/openai-compatible-conversation.js';
import {StrictConversationAgent} from '../src/core/conversation-agent.js';
import {evaluateNextStep} from '../src/core/decision-engine.js';
import {messageForCase} from '../src/core/messages.js';
import {EventType,type WorkflowEvent} from '../src/domain/fsm/states.js';
import type {Expediente} from '../src/domain/models/expediente.js';
import {redactConversationPii,type ConversationHistoryMessage} from '../src/core/conversation-policy.js';
import {digest} from '../src/core/package-agent/package.js';
import {agentRuntimeHash} from '../src/config/agent-release.js';

type Scenario={id:string;desc:string;user_turns:string[];expect:string[];must_not:string[]};
type Turn={input:string;reply:string;state:string;event:string;handoff:string|null;attachment:string|null};
const norm=(x:string)=>x.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const db=new PrismaClient();
try{
  const runtimeHash=await agentRuntimeHash();
  const reference=await loadReferenceAgentPackage(process.env.APOD_AGENT_PACKAGE_DIR,process.env.APOD_MASTER_PROMPT_FILE);
  if(reference.status!=='LOADED')throw new Error('PACKAGE_REQUIRED');
  const config=conversationAiFromEnv();if(config.status!=='CONFIGURED'||config.config.mode!=='online')throw new Error('REAL_ONLINE_AI_REQUIRED');
  const source=await readFile(resolve(process.env.APOD_AGENT_PACKAGE_DIR!,'eval_scenarios.jsonl'),'utf8');
  const scenarios:Scenario[]=source.trim().split('\n').map(x=>JSON.parse(x));if(scenarios.length!==14)throw new Error('EXPECTED_14_PROVIDED_SCENARIOS');
  const cases=await db.botApodExpediente.findMany({where:{identityVerified:true},take:100});if(!cases.length)throw new Error('EXISTING_CASE_REQUIRED');
  const selected=process.argv.find(x=>x.startsWith('--only='))?.slice(7);
  const results=[];
  for(const s of scenarios.filter(s=>!selected||s.id===selected)){
    const stored=cases.find(c=>s.id==='no_cert_nie'?/^[XYZ]/.test(c.dni):/^\d/.test(c.dni))??cases[0]!;
    // An in-memory replay, explicitly separate from evidence of live CRM execution.
    let c:BotApodExpediente={...stored,currentState:'WAITING_CERT_RESPONSE',hasDigitalCert:null,version:0,automationPaused:false,optOutAt:null};
    const model=new OpenAICompatibleConversationModel(config.config,reference.context);
    const agent=new StrictConversationAgent(model,3);const history:ConversationHistoryMessage[]=[];const turns:Turn[]=[];
    for(const input of s.user_turns){
      if(c.automationPaused){turns.push({input:redactConversationPii(input),reply:'',state:c.currentState,event:'HALTED_AFTER_HANDOFF',handoff:null,attachment:null});continue;}
      const turn=await agent.turn(c,input,history);
      const decision=evaluateNextStep(c as unknown as Expediente,turn as WorkflowEvent);
      c={...c,...decision.actionPayload.expedientePatch,currentState:decision.nextStep as BotApodExpediente['currentState'],version:c.version+1,automationPaused:decision.nextStep==='ESCALATED_HUMAN'} as BotApodExpediente;
      const p=decision.actionPayload;const guide='template'in p?messageForCase(c,undefined,p.template,'variables'in p?p.variables:undefined):p.kind==='ESCALATE_HUMAN'&&p.clientNoticeTemplate?messageForCase(c,undefined,p.clientNoticeTemplate,{replyText:String(turn.payload.responseText??'')}):undefined;
      const text=guide?.text??'';
      turns.push({input:redactConversationPii(input),reply:text,state:c.currentState,event:turn.type,handoff:typeof turn.payload.handoffReason==='string'?turn.payload.handoffReason:null,attachment:guide?.attachment??null});
      history.push({role:'user',content:redactConversationPii(input)},{role:'assistant',content:text});
    }
    const combined=norm(turns.map(t=>t.reply).join('\n'));const last=turns.at(-1)!;
    const checks:Record<string,boolean>={noCredentialEcho:!combined.includes('perro1234'),noBankAccount:! /\bES\d{2}(?:\s?\d){20}\b/i.test(combined),noEmoji:! /\p{Extended_Pictographic}/u.test(combined),oneQuestionPerMessage:turns.every(t=>(t.reply.match(/\?/g)?.length??0)<=1),noFalseCompletion:!/(?:hemos presentado|demanda presentada|ya hemos subido)/.test(combined),providerAvailable:model.metrics.failures===0,noProviderFallback:!combined.includes('ha surgido un problema al responder')};
    const hasHandoff=(r:string)=>turns.some(t=>t.handoff===r);
    const amendments:string[]=[];
    switch(s.id){
      case'happy_ordenador':checks.deviceQuestion=/movil.*ordenador/.test(norm(turns[0]?.reply??''));checks.guide=turns.some(t=>t.attachment==='TUTORIAL'&&/autofirma/.test(norm(t.reply))&&/incognito/.test(norm(t.reply))&&t.reply.includes('sedejudicial.justicia.es'));checks.awaitActualDocument=/pdf|documento/.test(norm(last.reply))&&!hasHandoff('APUD_ACTA_RECIBIDO');amendments.push('Text claiming a file was sent cannot replace actual PDF receipt; request the attachment.');break;
      case'happy_movil_a_ordenador':checks.computerRequired=/ordenador/.test(norm(last.reply));checks.noPasswordRequest=!/contrasena/.test(combined);break;
      case'stuck_ordenador':checks.missingInstructionsHandoff=hasHandoff('FALTA_DATO');amendments.push('Computer sharing instructions remain TODO; FALTA_DATO instead of inventing a password request.');break;
      case'cert_recibido_no_echo':{
        checks.handoffStops=hasHandoff('FALTA_DATO')&&last.event==='HALTED_AFTER_HANDOFF';
        const beforeCalls=model.metrics.calls;const secretTurn=await agent.turn({currentState:'PC_TUTORIAL_SENT',hasDigitalCert:true},s.user_turns.at(-1)!);
        checks.secretNotSentToProvider=model.metrics.calls===beforeCalls;checks.receiptNoEcho=secretTurn.payload.handoffReason==='CERTIFICADO_RECIBIDO'&&!JSON.stringify(secretTurn).includes('Perro1234');
        amendments.push('After the earlier TODO handoff, automation stays stopped. A separate credential guard verifies non-echo and zero provider calls without reading certificate files.');break;
      }
      case'no_cert_clave_dni':checks.dniCertificateRoute=/fnmt/.test(combined)&&!/cl[a@]ve.{0,20}(?:permite|puedes) firmar/.test(combined);amendments.push('Master uses the known DNI to provide FNMT routes, not a new DNI/Cl@ve branch.');break;
      case'no_cert_nie':checks.townHall=/ayuntamiento/.test(combined);break;
      case'sin_nada':checks.accessOptions=/fnmt|certificado/.test(combined)&&!c.automationPaused;break;
      case'desconfianza':checks.officialFree=/oficial|sede judicial/.test(combined)&&/gratuit|sin coste/.test(combined);break;
      case'estado_reclamacion':checks.claimsContact=combined.includes('reclamaciones@litigios.es');break;
      case'pago':checks.paymentHandoff=hasHandoff('PAGO');break;
      case'pide_humano':checks.humanHandoff=hasHandoff('HUMANO')&&/disculpa/.test(combined)&&c.automationPaused;break;
      case'pide_sms':checks.rejectCode=/no (?:me )?envies.*sms/.test(combined);break;
      case'ya_hecho':checks.requestDocument=/pdf|documento/.test(combined)&&!/tienes certificado/.test(combined);break;
      case'persona_mayor':checks.clientCertificate=/(?:certificado.{0,60}(?:tuyo|tu nombre|su nombre|del cliente|debe ser tu)|tu (?:propio )?certificado)/.test(combined);checks.familySupport=/hija|familiar|ayudar/.test(combined);checks.noAssumedCertificate=last.state==='WAITING_CERT_RESPONSE'&&c.hasDigitalCert!==true;break;
    }
    const pass=Object.values(checks).every(Boolean);
    results.push({id:s.id,pass,checks,originalExpectations:s.expect,masterAlignment:amendments,turns,provider:model.metrics});
    console.log(JSON.stringify({scenario:s.id,status:pass?'PASS':'FAIL',failedChecks:Object.entries(checks).filter(([,v])=>!v).map(([k])=>k),realProviderCalls:model.metrics.calls}));
  }
  const total=results.length,passed=results.filter(r=>r.pass).length;
  const codeUnchanged=runtimeHash===await agentRuntimeHash();
  const report={at:new Date().toISOString(),scope:'SUPPLIED_SCENARIOS_REAL_GPT_API_RUNTIME_AGENT_AND_FSM',authority:'apud_acta_master_prompt.md + user-approved training safety rules',runtimeHash,codeUnchanged,model:config.config.model,packageHash:reference.context.packageHash,sourceScenariosSha256:digest(source),training:reference.context.training,usableStyleExamples:reference.context.dataset!.examples.length,retrieval:{status:await new OpenAICompatibleConversationModel(config.config,reference.context).retrievalStatus(),ragRetrievals:results.reduce((n,r)=>n+r.provider.ragRetrievals,0),keywordRetrievals:results.reduce((n,r)=>n+r.provider.keywordRetrievals,0)},total,passed,failed:total-passed,releaseReady:total===14&&passed===14&&codeUnchanged,crmWrites:0,dbWrites:0,clientMessagesSent:0,productionEndToEnd:false,fineTuned:false,results};
  await mkdir('evidence',{recursive:true});const out=resolve(`evidence/agent-evaluations${selected?'-'+selected:''}.json`);await writeFile(out,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({report:out,total,passed,failed:total-passed,releaseReady:report.releaseReady}));if(passed!==total)process.exitCode=1;
}finally{await db.$disconnect();}
