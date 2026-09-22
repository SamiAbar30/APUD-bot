import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {WorkflowService} from '../core/workflow-service.js';
import {closePhaseOne,phaseOneExpired} from '../core/phase-one.js';
import {CertInspector} from '../core/cert-inspector.js';
import {CredentialVault} from '../infrastructure/credential-vault.js';
import {AppError} from '../infrastructure/security.js';

const params=z.object({id:z.string().uuid()});
const metadata=z.object({version:z.number().int().nonnegative(),operatorId:z.string().trim().min(3).max(100),evidenceRef:z.string().trim().min(5).max(200)}).strict();
/** Authenticated platform intake. Never interprets a chat mention as possession of credentials. */
export async function phaseOneRoutes(api:FastifyInstance,flow:WorkflowService){
  api.post('/cases/:id/phase-one/outcome',async request=>{
    if(flow.env.APUD_VERSION!==1)throw new AppError('APUD_V1_REQUIRED',409);
    const {id}=params.parse(request.params);
    const input=metadata.extend({outcome:z.enum(['PAYMENT_REPORTED','COURT_REPORTED','SELF_COMPLETED_REPORTED']),clientReportConfirmed:z.literal(true)}).parse(request.body);
    return flow.locked(id,async signal=>{
      const c=await flow.load(id);if(signal.aborted||c.version!==input.version)throw new AppError('CASE_CHANGED_RELOAD',409);
      if(!c.identityVerified||c.optOutAt||c.phaseOneClosedAt||phaseOneExpired(c))throw new AppError('PHASE_ONE_NOT_ACTIVE',409);
      await flow.db.$transaction(tx=>closePhaseOne(tx,c,input.outcome,{evidenceRef:input.evidenceRef,clientReportConfirmed:true},input.operatorId));
      return {status:'PHASE_ONE_CLOSED',outcome:input.outcome,legalFilingVerified:false};
    });
  });
  api.post('/cases/:id/phase-one/certificate',async request=>{
    if(flow.env.APUD_VERSION!==1)throw new AppError('APUD_V1_REQUIRED',409);
    if(!flow.env.APUD_CREDENTIAL_KEY)throw new AppError('CREDENTIAL_VAULT_KEY_REQUIRED',503);
    const {id}=params.parse(request.params);let pfx:Buffer|undefined,password:Buffer|undefined,input:unknown;
    try{
      for await(const part of request.parts({limits:{files:2,fileSize:1024*1024,fields:1,parts:3,fieldSize:4096}})){
        if(part.type==='file'){
          if(part.fieldname==='certificate'&&!pfx&&/\.(p12|pfx)$/i.test(part.filename))pfx=await part.toBuffer();
          else if(part.fieldname==='password'&&!password){password=await part.toBuffer();if(password.length>4096)throw new AppError('PASSWORD_TOO_LONG',400);}
          else throw new AppError('CERTIFICATE_AND_PASSWORD_REQUIRED',400);
          if(part.file.truncated)throw new AppError('CERTIFICATE_TOO_LARGE',413);
        }else if(part.fieldname==='metadata'&&input===undefined){try{input=JSON.parse(String(part.value));}catch{throw new AppError('INVALID_METADATA',400);}}
        else throw new AppError('UNEXPECTED_CREDENTIAL_FIELD',400);
      }
      const info=metadata.extend({consentConfirmed:z.literal(true),consentEvidenceRef:z.string().trim().min(5).max(200)}).parse(input);
      if(!pfx||!password)throw new AppError('CERTIFICATE_AND_PASSWORD_REQUIRED',400);
      const certificate=pfx,pass=password;
      return await flow.locked(id,async signal=>{
        const c=await flow.load(id);if(signal.aborted||c.version!==info.version)throw new AppError('CASE_CHANGED_RELOAD',409);
        if(!c.identityVerified||c.optOutAt||c.phaseOneClosedAt||phaseOneExpired(c))throw new AppError('PHASE_ONE_NOT_ACTIVE',409);
        // Inspection consumes its buffer; retain the original only until encrypted storage succeeds.
        const inspection=await CertInspector.inspect({pfx:Buffer.from(certificate),password:pass.toString('utf8'),expectedDni:c.dni});
        if(!inspection.usable||!inspection.passwordValid||!inspection.identityMatches)throw new AppError('CERTIFICATE_PASSWORD_OR_IDENTITY_INVALID',400);
        if(signal.aborted)throw new AppError('LOCK_LOST',409);
        const stored=await new CredentialVault(flow.storage.root,flow.env.APUD_CREDENTIAL_KEY).save(id,certificate,pass);
        await flow.db.$transaction(async tx=>{
          const fresh=await tx.botApodExpediente.findUniqueOrThrow({where:{id}});
          if(signal.aborted||fresh.version!==info.version||fresh.optOutAt||fresh.phaseOneClosedAt||phaseOneExpired(fresh))throw new AppError('CASE_CHANGED_RELOAD',409);
          await closePhaseOne(tx,fresh,'CERTIFICATE_READY',{...stored,fingerprintSha256:inspection.fingerprintSha256,passwordValidated:true,identityValidated:true,chainValidated:inspection.chainValidated,evidenceRef:info.evidenceRef,consentEvidenceRef:info.consentEvidenceRef},info.operatorId);
        });
        return {status:'PHASE_ONE_CLOSED',outcome:'CERTIFICATE_READY',legalFilingVerified:false};
      });
    }finally{pfx?.fill(0);password?.fill(0);}
  });
}
