import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {WorkflowService} from '../core/workflow-service.js';
import {ApudV2RegistrationService,requireApudV2} from '../core/apud-v2-registration.js';
import {RegistrationIntentSchema,ReceiptEvidenceSchema,SigningApprovalSchema} from '../contracts/apud-v2.contract.js';
import {AppError} from '../infrastructure/security.js';

const caseParams=z.object({id:z.string().uuid()});
const params=caseParams.extend({registrationId:z.string().uuid()});
const version=z.number().int().nonnegative();
const operator=z.object({version,operatorId:z.string().trim().min(3).max(100),evidenceRef:z.string().trim().min(5).max(300)}).strict();

/** Registered inside the existing authenticated operator API; never available in v1. */
export async function apudV2Routes(api:FastifyInstance,flow:WorkflowService){
  const service=new ApudV2RegistrationService(flow);
  api.get('/apud-v2/capabilities',async()=>{
    requireApudV2(flow);
    return {version:2,preparation:'REVIEWED_RECIPE_REQUIRED',signature:'PERSONAL_SIGNER_REQUIRED',automatedSigningEnabled:false,receiptVerification:'STRUCTURAL_CHECKS_AND_OPERATOR_OFFICIAL_LOOKUP',notification:'PLATFORM_DAYANA_TASK',liveEndToEndVerified:false};
  });
  api.get('/cases/:id/registrations',async request=>{
    requireApudV2(flow);const {id}=caseParams.parse(request.params);await flow.load(id);
    return flow.db.botApodRegistration.findMany({where:{expedienteId:id},orderBy:{createdAt:'desc'},take:100});
  });
  api.post('/cases/:id/registrations',async(request,reply)=>{
    requireApudV2(flow);const {id}=caseParams.parse(request.params);
    const input=z.object({caseVersion:version,operatorId:z.string().trim().min(3).max(100),intent:RegistrationIntentSchema}).strict().parse(request.body);
    if(input.intent.caseId!==id)throw new AppError('V2_CASE_IDENTITY_MISMATCH',409);
    return reply.code(201).send(await service.create(input.intent,input.operatorId,input.caseVersion));
  });
  api.post('/cases/:id/registrations/:registrationId/prepare',async(request,reply)=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);
    let certificate:Buffer|undefined,password:Buffer|undefined,observedVersion:number|undefined;
    const disconnected=new AbortController();const abort=()=>disconnected.abort();const close=()=>{if(!reply.raw.writableEnded)abort();};
    request.raw.once('aborted',abort);reply.raw.once('close',close);
    try {
      for await(const part of request.parts({limits:{files:2,fileSize:1024*1024,fields:1,parts:3}})){
        if(part.type==='file'){
          if(part.fieldname==='certificate'&&!certificate&&/\.(p12|pfx)$/i.test(part.filename))certificate=await part.toBuffer();
          else if(part.fieldname==='password'&&!password){password=await part.toBuffer();if(password.length>1024)throw new AppError('PASSWORD_TOO_LONG',400);}
          else throw new AppError('V2_CERTIFICATE_PASSWORD_REQUIRED',400);
          if(part.file.truncated)throw new AppError('V2_FILE_TOO_LARGE',413);
        }else if(part.fieldname==='version'&&observedVersion===undefined)observedVersion=z.coerce.number().int().nonnegative().parse(part.value);
        else throw new AppError('V2_UNEXPECTED_FIELD',400);
      }
      if(!certificate||!password||observedVersion===undefined)throw new AppError('V2_CERTIFICATE_PASSWORD_VERSION_REQUIRED',400);
      return reply.code(201).send(await service.prepare(id,registrationId,observedVersion,certificate,password,disconnected.signal));
    }finally{certificate?.fill(0);password?.fill(0);request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',close);}
  });
  api.post('/cases/:id/registrations/:registrationId/approve',async request=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);
    const input=z.object({version,approval:SigningApprovalSchema}).strict().parse(request.body);
    return service.approve(id,registrationId,input.version,input.approval);
  });
  api.post('/cases/:id/registrations/:registrationId/signing-handoff',async request=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);const input=operator.parse(request.body);
    return service.signingHandoff(id,registrationId,input.version,input.operatorId,input.evidenceRef);
  });
  api.post('/cases/:id/registrations/:registrationId/sign',async()=>{
    requireApudV2(flow);throw new AppError('V2_REVIEWED_LIVE_SIGNING_ADAPTER_UNAVAILABLE',501);
  });
  api.post('/cases/:id/registrations/:registrationId/reconcile-absent',async request=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);
    const input=operator.extend({attemptId:z.string().uuid(),sourceUrl:z.string().url(),observedAt:z.string().datetime({offset:true}),completeOfficialLookupNoMatch:z.literal(true)}).strict().parse(request.body);
    return service.reconcileAbsent(id,registrationId,input.version,input);
  });
  api.post('/cases/:id/registrations/:registrationId/receipt',async(request,reply)=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);
    let bytes:Buffer|undefined,metadata:unknown;
    try {
      for await(const part of request.parts({limits:{files:1,fileSize:flow.env.MAX_DOCUMENT_BYTES,fields:1,parts:2,fieldSize:8192}})){
        if(part.type==='file'){
          if(bytes||part.fieldname!=='receipt'||part.mimetype!=='application/pdf'||!part.filename.toLowerCase().endsWith('.pdf'))throw new AppError('V2_RECEIPT_PDF_REQUIRED',400);
          bytes=await part.toBuffer();if(part.file.truncated)throw new AppError('V2_FILE_TOO_LARGE',413);
        }else if(part.fieldname==='metadata'&&metadata===undefined){try{metadata=JSON.parse(String(part.value));}catch{throw new AppError('V2_RECEIPT_METADATA_INVALID',400);}}
        else throw new AppError('V2_UNEXPECTED_FIELD',400);
      }
      const input=z.object({version,attemptId:z.string().uuid(),evidence:ReceiptEvidenceSchema}).strict().parse(metadata);
      if(!bytes)throw new AppError('V2_RECEIPT_PDF_REQUIRED',400);
      return reply.code(201).send(await service.receiveReceipt(id,registrationId,input.version,input.attemptId,bytes,input.evidence));
    }finally{bytes?.fill(0);}
  });
  api.post('/cases/:id/registrations/:registrationId/cancel',async request=>{
    requireApudV2(flow);const {id,registrationId}=params.parse(request.params);const input=operator.parse(request.body);
    return service.cancel(id,registrationId,input.version,input.operatorId,input.evidenceRef);
  });
}
