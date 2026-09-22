import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Prisma,type BotApodRegistration,type BotApodExpediente} from '@prisma/client';
import {RegistrationIntentSchema,SigningApprovalSchema,ReceiptEvidenceSchema,registrationIntentHash,type RegistrationIntent} from '../contracts/apud-v2.contract.js';
import {AppError} from '../infrastructure/security.js';
import {CredentialVault} from '../infrastructure/credential-vault.js';
import {json,type WorkflowService} from './workflow-service.js';
import {runAssistedDraft} from './assisted-session.js';
import {auditRegistrationPdf} from './apud-v2-pdf.js';
import {normalizeForMatch} from '../domain/text/normalize.js';
import {EventType} from '../domain/fsm/states.js';
import type {SedeDraftRecipe} from '../adapters/sede-judicial/sede-playwright.js';

const terminal=new Set(['CANCELLED','REGISTERED_OBSERVED']);
type LockSignal={aborted:boolean};
export function requireApudV2(flow:WorkflowService):void {
  if(flow.env.APUD_VERSION!==2)throw new AppError('APUD_V2_DISABLED',404);
  if(flow.env.DATA_MODE!=='real')throw new AppError('APUD_V2_REQUIRES_REAL_DATA',409);
}
function assertLock(signal:LockSignal):void {if(signal.aborted)throw new AppError('V2_CASE_LOCK_LOST',409);}
function intentOf(row:BotApodRegistration):RegistrationIntent {
  const intent=RegistrationIntentSchema.parse(row.intent);
  if(intent.caseId!==row.expedienteId||registrationIntentHash(intent)!==row.intentHash)throw new AppError('V2_IMMUTABLE_INTENT_MISMATCH',409);
  return intent;
}
function assertCase(c:BotApodExpediente,intent:RegistrationIntent):void {
  if(!c.identityVerified||c.dni!==intent.grantor.dni||normalizeForMatch(c.nombre)!==normalizeForMatch(intent.grantor.name)||c.id!==intent.caseId)throw new AppError('V2_CASE_IDENTITY_MISMATCH',409);
}
function freshConsent(intent:RegistrationIntent):void {
  const now=Date.now();if(Date.parse(intent.consent.grantedAt)>now||Date.parse(intent.consent.expiresAt)<=now)throw new AppError('V2_FRESH_SCOPED_CONSENT_REQUIRED',409);
}
function sourceObservation(sourceUrl:string,observedAt:string,after:Date):void {
  const url=new URL(sourceUrl),at=Date.parse(observedAt);
  if(url.origin!=='https://sedejudicial.justicia.es'||url.username||url.password||url.hash||!Number.isFinite(at)||at<after.getTime()||at>Date.now()+60000)throw new AppError('V2_OFFICIAL_OBSERVATION_REQUIRED',409);
}
function selectionFields(intent:RegistrationIntent,c:BotApodExpediente):Record<string,string>{
  if(!c.direccion||!c.codigoPostal||!c.localidad||!c.provincia||!c.comunidadAutonoma)throw new AppError('V2_VERIFIED_ADDRESS_REQUIRED',409);
  const fields:Record<string,string>={dni:intent.grantor.dni,nombre:intent.grantor.name,appearingAs:intent.appearingAs,scopeKind:intent.scope.kind,scopeDescription:intent.scope.description,validFrom:intent.validFrom,validUntil:intent.validUntil,direccion:c.direccion,codigoPostal:c.codigoPostal,localidad:c.localidad,provincia:c.provincia,comunidadAutonoma:c.comunidadAutonoma};
  intent.professionals.forEach((p,i)=>{fields[`professional${i}Dni`]=p.dni;fields[`professional${i}Role`]=p.role;fields[`professional${i}College`]=p.college;fields[`professional${i}RegistrationNumber`]=p.registrationNumber;});
  intent.faculties.forEach((p,i)=>{fields[`faculty${i}Code`]=p.code;});
  intent.exclusions.forEach((p,i)=>{fields[`exclusion${i}Code`]=p.code;});
  return fields;
}

/** Durable v2 ledger. It never pretends the draft browser can execute a legal signature. */
export class ApudV2RegistrationService {
  constructor(private readonly flow:WorkflowService){}
  private async audit(tx:Prisma.TransactionClient,row:BotApodRegistration,event:string,operator:string,evidence:unknown){
    await tx.botApodAuditLog.create({data:{expedienteId:row.expedienteId,event,operator,metadata:json({registrationId:row.id,intentHash:row.intentHash,...evidence as Record<string,unknown>})}});
  }
  private async task(tx:Prisma.TransactionClient,row:BotApodRegistration,kind:string,reason:string,evidence:unknown){
    await tx.botApodHumanTask.upsert({where:{dedupeKey:`${kind}:${row.id}:${row.version}`},create:{expedienteId:row.expedienteId,dedupeKey:`${kind}:${row.id}:${row.version}`,kind,assignedTo:'DAYANA',reason,evidence:json({registrationId:row.id,intentHash:row.intentHash,...evidence as Record<string,unknown>})},update:{}});
  }
  private async change(tx:Prisma.TransactionClient,row:BotApodRegistration,data:Prisma.BotApodRegistrationUpdateManyMutationInput){
    const changed=await tx.botApodRegistration.updateMany({where:{id:row.id,version:row.version,status:row.status},data:{...data,version:{increment:1}}});
    if(changed.count!==1)throw new AppError('V2_REGISTRATION_CHANGED_RELOAD',409);
    return tx.botApodRegistration.findUniqueOrThrow({where:{id:row.id}});
  }
  private async locked<T>(caseId:string,registrationId:string,version:number,fn:(row:BotApodRegistration,intent:RegistrationIntent,c:BotApodExpediente,signal:LockSignal)=>Promise<T>):Promise<T>{
    requireApudV2(this.flow);
    return this.flow.locked(caseId,async signal=>{
      assertLock(signal);const [row,c]=await Promise.all([this.flow.db.botApodRegistration.findUnique({where:{id:registrationId}}),this.flow.load(caseId)]);
      if(!row||row.expedienteId!==caseId)throw new AppError('V2_REGISTRATION_NOT_FOUND',404);
      if(row.version!==version)throw new AppError('V2_REGISTRATION_CHANGED_RELOAD',409);
      const intent=intentOf(row);assertCase(c,intent);return fn(row,intent,c,signal);
    });
  }
  private async consent(intent:RegistrationIntent,c:BotApodExpediente){
    freshConsent(intent);
    const latest=await this.flow.load(c.id);assertCase(latest,intent);
    if(latest.optOutAt)throw new AppError('V2_CONSENT_WITHDRAWN',409);
    const withdrawal=await this.flow.db.botApodAuditLog.findFirst({where:{expedienteId:c.id,event:EventType.CLIENT_CONSENT_DENIED,createdAt:{gte:new Date(intent.consent.grantedAt)}},select:{id:true}});
    if(withdrawal)throw new AppError('V2_CONSENT_WITHDRAWN',409);
    const denied=await this.flow.db.botApodInbox.findFirst({where:{expedienteId:intent.caseId,eventType:{in:[EventType.CLIENT_CONSENT_DENIED,EventType.CLIENT_OPT_OUT]},createdAt:{gte:new Date(intent.consent.grantedAt)}},select:{id:true}});
    if(denied)throw new AppError('V2_CONSENT_WITHDRAWN',409);
  }
  async create(raw:unknown,operatorId:string,caseVersion:number){
    requireApudV2(this.flow);const intent=RegistrationIntentSchema.parse(raw);freshConsent(intent);
    return this.flow.locked(intent.caseId,async signal=>{
      const c=await this.flow.load(intent.caseId);assertLock(signal);assertCase(c,intent);
      if(c.version!==caseVersion)throw new AppError('CASE_CHANGED_RELOAD',409);await this.consent(intent,c);
      return this.flow.db.$transaction(async tx=>{
        assertLock(signal);
        if(await tx.botApodRegistration.findFirst({where:{expedienteId:c.id,status:{notIn:[...terminal]}}}))throw new AppError('V2_OPEN_REGISTRATION_EXISTS',409);
        const row=await tx.botApodRegistration.create({data:{expedienteId:c.id,intent:json(intent),intentHash:registrationIntentHash(intent)}});
        const changed=await tx.botApodExpediente.updateMany({where:{id:c.id,version:c.version},data:{automationPaused:true,nextReminderAt:null,version:{increment:1}}});
        if(changed.count!==1)throw new AppError('CASE_CHANGED_RELOAD',409);
        await this.audit(tx,row,'V2_REGISTRATION_CREATED',operatorId,{selectionEvidenceRef:intent.selectionEvidenceRef,consentEvidenceRef:intent.consent.evidenceRef});
        await this.task(tx,row,'V2_PREPARATION','Preparar y revisar el apoderamiento. La firma y presentación siguen pendientes.',{});return row;
      });
    });
  }
  /** Use the verified phase-one pair without exposing it to the browser or collecting it again. */
  async prepareStored(caseId:string,id:string,version:number,abortSignal?:AbortSignal){
    requireApudV2(this.flow);
    const c=await this.flow.load(caseId);
    const proof=c.phaseOneEvidence as Record<string,unknown>|null;
    if(!c.phaseOneClosedAt||c.phaseOneOutcome!=='CERTIFICATE_READY'||!proof||proof.passwordValidated!==true||proof.identityValidated!==true||typeof proof.ref!=='string'||typeof proof.certificateSha256!=='string')throw new AppError('V2_VERIFIED_STORED_CERTIFICATE_REQUIRED',409);
    const pair=await new CredentialVault(this.flow.storage.root,this.flow.env.APUD_CREDENTIAL_KEY).read(caseId,proof.ref,proof.certificateSha256);
    try{return await this.prepare(caseId,id,version,pair.certificate,pair.password,abortSignal);}
    finally{pair.certificate.fill(0);pair.password.fill(0);}
  }
  async prepare(caseId:string,id:string,version:number,pfx:Buffer,password:Buffer,abortSignal?:AbortSignal){
    try{return await this.locked(caseId,id,version,async(row,intent,c,signal)=>{
      if(row.status!=='PREPARATION_REQUIRED')throw new AppError('V2_PREPARATION_NOT_ALLOWED',409);
      await this.consent(intent,c);
      if(!this.flow.env.SEDE_RECIPE_FILE)throw new AppError('V2_REVIEWED_DRAFT_RECIPE_REQUIRED',409);
      const fields=selectionFields(intent,c);
      const raw=JSON.parse(await readFile(this.flow.env.SEDE_RECIPE_FILE,'utf8')) as {recipe?:SedeDraftRecipe};const recipe=raw.recipe;
      // No inferred checkboxes: every selected value must have an explicit reviewed binding.
      const consumed=new Set(recipe?.steps.flatMap(step=>step.kind==='fill'||step.kind==='select'?[step.field]:[])??[]);
      if(!recipe?.reviewedDraftOnly||Object.keys(fields).some(field=>!consumed.has(field)))throw new AppError('V2_RECIPE_SELECTION_BINDINGS_INCOMPLETE',409);
      if(!await this.flow.db.botApodAuditLog.findFirst({where:{expedienteId:caseId,event:'OPERATOR_VERIFIED_ADDRESS'},select:{id:true}}))throw new AppError('V2_ADDRESS_PROVENANCE_REQUIRED',409);
      const controller=new AbortController();let checking=false;
      const monitor=setInterval(()=>{
        if(checking||controller.signal.aborted)return;checking=true;
        void this.consent(intent,c).catch(()=>controller.abort()).finally(()=>{checking=false;});
        if(signal.aborted)controller.abort();
      },500);monitor.unref();
      let draft:Awaited<ReturnType<typeof runAssistedDraft>>|undefined;
      try {
        draft=await runAssistedDraft({pfx,password,expectedDni:intent.grantor.dni,clientId:caseId,consent:{granted:true,clientId:caseId,dni:intent.grantor.dni,scope:'SEDE_DRAFT_ONLY',expiresAt:intent.consent.expiresAt,evidenceRef:intent.consent.evidenceRef},fields},180000,abortSignal?AbortSignal.any([abortSignal,controller.signal]):controller.signal);
        assertLock(signal);await this.consent(intent,c);
        const audit=await auditRegistrationPdf(draft.pdf,intent,'DRAFT');
        const saved=await this.flow.storage.save(draft.pdf);const result=draft;
        return await this.flow.db.$transaction(async tx=>{
          assertLock(signal);await this.consent(intent,c);
          const doc=await tx.botApodDocumento.upsert({where:{expedienteId_sha256Hash:{expedienteId:caseId,sha256Hash:saved.sha256}},create:{expedienteId:caseId,documentType:'BORRADOR_SEDE',s3OrLocalPath:saved.path,sha256Hash:saved.sha256,pageCount:audit.pageCount,identityMatches:true,rawAuditJson:json({registrationId:id,intentHash:row.intentHash,recipeId:result.recipeId,status:'DRAFT_NOT_SUBMITTED',...audit})},update:{}});
          if(doc.documentType!=='BORRADOR_SEDE')throw new AppError('V2_DOCUMENT_TYPE_CONFLICT',409);
          const updated=await this.change(tx,row,{status:'DRAFT_REVIEW_REQUIRED',draftDocumentId:doc.id,certificateFingerprint:result.inspection.certificateFingerprint});
          await this.audit(tx,updated,'V2_DRAFT_PREPARED','ISOLATED_CERTIFICATE_SESSION',{documentId:doc.id,sha256:doc.sha256Hash,recipeId:result.recipeId,certificateFingerprint:result.inspection.certificateFingerprint});
          await this.task(tx,updated,'V2_DRAFT_REVIEW','Revisar el borrador con el cliente: identidad, profesionales, facultades, exclusiones y vigencia.',{documentId:doc.id,sha256:doc.sha256Hash});return updated;
        });
      }finally{clearInterval(monitor);controller.abort();draft?.pdf.fill(0);}
    });}finally{pfx.fill(0);password.fill(0);}
  }
  async approve(caseId:string,id:string,version:number,raw:unknown){
    const approval=SigningApprovalSchema.parse(raw);
    return this.locked(caseId,id,version,async(row,intent,c,signal)=>{
      if(!['DRAFT_REVIEW_REQUIRED','REAPPROVAL_REQUIRED'].includes(row.status)||!row.draftDocumentId)throw new AppError('V2_DRAFT_REVIEW_REQUIRED',409);
      await this.consent(intent,c);
      const doc=await this.flow.db.botApodDocumento.findUniqueOrThrow({where:{id:row.draftDocumentId}});
      if(doc.expedienteId!==caseId||doc.documentType!=='BORRADOR_SEDE'||doc.sha256Hash!==approval.draftSha256||row.intentHash!==approval.intentHash||row.certificateFingerprint!==approval.certificateFingerprint)throw new AppError('V2_APPROVAL_BINDING_MISMATCH',409);
      if(Date.parse(approval.expiresAt)<=Date.now()||Date.parse(approval.expiresAt)>Date.parse(intent.consent.expiresAt))throw new AppError('V2_APPROVAL_EXPIRY_INVALID',409);
      return this.flow.db.$transaction(async tx=>{
        assertLock(signal);const updated=await this.change(tx,row,{status:'READY_FOR_PERSONAL_SIGNING',approval:json({...approval,approvedAt:new Date().toISOString()})});
        await this.audit(tx,updated,'V2_EXACT_DRAFT_APPROVED',approval.operatorId,{draftDocumentId:doc.id,sha256:doc.sha256Hash,evidenceRef:approval.evidenceRef,certificateValidationEvidenceRef:approval.certificateValidationEvidenceRef});return updated;
      });
    });
  }
  async signingHandoff(caseId:string,id:string,version:number,operatorId:string,evidenceRef:string){
    return this.locked(caseId,id,version,async(row,intent,c,signal)=>{
      if(row.status!=='READY_FOR_PERSONAL_SIGNING')throw new AppError('V2_FRESH_SIGNING_APPROVAL_REQUIRED',409);
      await this.consent(intent,c);const approval=SigningApprovalSchema.parse(row.approval&&typeof row.approval==='object'?Object.fromEntries(Object.entries(row.approval).filter(([key])=>key!=='approvedAt')):row.approval);
      if(Date.parse(approval.expiresAt)<=Date.now()||approval.intentHash!==row.intentHash||approval.certificateFingerprint!==row.certificateFingerprint)throw new AppError('V2_SIGNING_APPROVAL_EXPIRED_OR_CHANGED',409);
      const doc=await this.flow.db.botApodDocumento.findUniqueOrThrow({where:{id:row.draftDocumentId!}});
      if(doc.sha256Hash!==approval.draftSha256)throw new AppError('V2_DRAFT_CHANGED',409);
      return this.flow.db.$transaction(async tx=>{
        assertLock(signal);const updated=await this.change(tx,row,{status:'SUBMISSION_UNCERTAIN',attemptId:randomUUID()});
        await this.audit(tx,updated,'V2_PERSONAL_SIGNING_HANDOFF',operatorId,{evidenceRef,attemptId:updated.attemptId,draftSha256:doc.sha256Hash,automatedSignatureExecuted:false});
        await this.task(tx,updated,'V2_SIGNING_RECONCILIATION','El cliente debe firmar personalmente el borrador aprobado. Comprobar el registro y guardar el justificante antes de repetir cualquier presentación.',{attemptId:updated.attemptId,draftDocumentId:doc.id});return updated;
      });
    });
  }
  async reconcileAbsent(caseId:string,id:string,version:number,input:{attemptId:string;operatorId:string;evidenceRef:string;sourceUrl:string;observedAt:string;completeOfficialLookupNoMatch:true}){
    return this.locked(caseId,id,version,async(row,_intent,_c,signal)=>{
      if(row.status!=='SUBMISSION_UNCERTAIN'||row.attemptId!==input.attemptId)throw new AppError('V2_ATTEMPT_RECONCILIATION_REQUIRED',409);
      sourceObservation(input.sourceUrl,input.observedAt,row.updatedAt);
      return this.flow.db.$transaction(async tx=>{
        assertLock(signal);await this.audit(tx,row,'V2_NO_REGISTRATION_OBSERVED',input.operatorId,input);
        return this.change(tx,row,{status:'REAPPROVAL_REQUIRED',approval:Prisma.DbNull,attemptId:null});
      });
    });
  }
  async receiveReceipt(caseId:string,id:string,version:number,attemptId:string,bytes:Buffer,raw:unknown){
    const evidence=ReceiptEvidenceSchema.parse(raw);
    return this.locked(caseId,id,version,async(row,intent,_c,signal)=>{
      if(row.status!=='SUBMISSION_UNCERTAIN'||row.attemptId!==attemptId||!row.draftDocumentId)throw new AppError('V2_ATTEMPT_RECONCILIATION_REQUIRED',409);
      sourceObservation(evidence.sourceUrl,evidence.observedAt,row.updatedAt);
      const draft=await this.flow.db.botApodDocumento.findUniqueOrThrow({where:{id:row.draftDocumentId}});
      if(evidence.intentHash!==row.intentHash||evidence.draftSha256!==draft.sha256Hash)throw new AppError('V2_RECEIPT_INTENT_MISMATCH',409);
      const audit=await auditRegistrationPdf(bytes,intent,'RECEIPT',evidence.registrationReference);
      if(audit.sha256!==evidence.receiptSha256||audit.sha256===draft.sha256Hash)throw new AppError('V2_RECEIPT_HASH_MISMATCH',409);
      const saved=await this.flow.storage.save(bytes);
      return this.flow.db.$transaction(async tx=>{
        assertLock(signal);
        const doc=await tx.botApodDocumento.upsert({where:{expedienteId_sha256Hash:{expedienteId:caseId,sha256Hash:saved.sha256}},create:{expedienteId:caseId,documentType:'V2_REGISTRATION_RECEIPT',s3OrLocalPath:saved.path,sha256Hash:saved.sha256,pageCount:audit.pageCount,identityMatches:true,rawAuditJson:json({registrationId:id,intentHash:row.intentHash,attemptId,status:'REGISTRATION_OBSERVED_BY_OPERATOR',evidence,...audit})},update:{}});
        if(doc.documentType!=='V2_REGISTRATION_RECEIPT')throw new AppError('V2_DOCUMENT_TYPE_CONFLICT',409);
        const updated=await this.change(tx,row,{status:'REGISTERED_OBSERVED',receiptDocumentId:doc.id,registrationReference:evidence.registrationReference});
        await this.audit(tx,updated,'V2_RECEIPT_STORED',evidence.operatorId,{documentId:doc.id,sha256:saved.sha256,attemptId,evidence});
        await this.task(tx,updated,'V2_REGISTERED_RECEIPT_REVIEW','Justificante guardado y registro comprobado por el operador. Dayana debe revisar el resultado e incorporarlo al expediente.',{documentId:doc.id,sha256:saved.sha256,registrationReference:evidence.registrationReference});
        await tx.botApodHumanTask.updateMany({where:{expedienteId:caseId,kind:'V2_SIGNING_RECONCILIATION',status:'OPEN',evidence:{path:['registrationId'],equals:id}},data:{status:'RESOLVED',resolvedAt:new Date(),resolvedBy:evidence.operatorId,resolutionRef:evidence.evidenceRef}});
        return updated;
      });
    });
  }
  async cancel(caseId:string,id:string,version:number,operatorId:string,evidenceRef:string){
    return this.locked(caseId,id,version,async(row,_intent,_c,signal)=>{
      if(row.status==='SUBMISSION_UNCERTAIN'||terminal.has(row.status))throw new AppError('V2_CANNOT_CANCEL_UNRECONCILED_OR_CLOSED',409);
      return this.flow.db.$transaction(async tx=>{assertLock(signal);const updated=await this.change(tx,row,{status:'CANCELLED',approval:Prisma.DbNull});await this.audit(tx,updated,'V2_REGISTRATION_CANCELLED',operatorId,{evidenceRef});return updated;});
    });
  }
}
