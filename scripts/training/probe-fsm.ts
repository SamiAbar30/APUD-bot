import '../../src/config/load-env-file.js';
import {PrismaClient} from '@prisma/client';
import {evaluateNextStep} from '../../src/core/decision-engine.js';
const db=new PrismaClient();
const c=await db.botApodExpediente.findUniqueOrThrow({where:{telefono:'34600000101'}});
for(const payload of [{responseId:'CONVERSATION_REPLY',rolloutPhase:3,rolloutKind:'WORKFLOW_REQUEST',responseText:'Hola, sigo aquí.',requiresHumanReview:false},{responseId:'CONVERSATION_REPLY',rolloutPhase:3,rolloutKind:'WORKFLOW_REQUEST',responseText:'x',requiresHumanReview:true,handoffReason:'HUMANO'}]){
  try{const d=evaluateNextStep(c as never,{type:'CLIENT_SMALL_TALK',payload} as never);console.log(d.nextStep,d.actionRequired,d.auditTrailSummary);}catch(e){console.log('THROW',(e as Error).message);}
}
await db.$disconnect();
