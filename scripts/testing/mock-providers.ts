/** Offline provider doubles, used ONLY by the user-authorized setup-data test. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {ConfiguredAdapters} from '../../src/adapters/configured.js';
import type {WhatsAppClient} from '../../src/adapters/whatsapp/whatsapp-client.js';
import type {WhatsAppAccepted} from '../../src/contracts/whatsapp.contract.js';
import type {DocumentProof,NoticeProof,KmaleonExpedienteCandidate} from '../../src/contracts/kmaleon.contract.js';
import type {ApudataOrder} from '../../src/contracts/apudata.contract.js';

type WhatsAppPort=Pick<WhatsAppClient,'sendText'|'sendButtons'|'sendDocument'|'sendDocumentButtons'|'sendTemplate'|'uploadMedia'|'downloadMedia'>;
export const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export class MockProviders {
  readonly documents=new Map<string,Buffer>();
  readonly uploads=new Map<string,DocumentProof>();
  readonly notices=new Map<string,NoticeProof>();
  readonly orders=new Map<string,ApudataOrder>();
  readonly messages:Array<{messageId:string;to:string;kind:string;text:string}>=[];
  readonly identities=new Map<string,string>();
  readonly projects=new Map<string,KmaleonExpedienteCandidate>();
  uploadCalls=0;noticeCalls=0;preapprovalCalls=0;orderCalls=0;
  private async accept(to:string,kind:string,text=''):Promise<WhatsAppAccepted>{
    assert.ok(to.startsWith('999000'),'Mock provider refuses any non-test recipient');
    const messageId='mock-wa-'+randomUUID();this.messages.push({messageId,to,kind,text});
    return {messageId,accepted:true,...{evidenceKind:'MOCK_PROVIDER_NO_EXTERNAL_SEND'}};
  }
  readonly wa:WhatsAppPort={
    sendText:(to,text)=>this.accept(to,'text',text),
    sendButtons:(to,text)=>this.accept(to,'buttons',text),
    sendDocument:(to,_media,_file,caption)=>this.accept(to,'document',caption),
    sendDocumentButtons:(to,_media,text)=>this.accept(to,'document-buttons',text),
    sendTemplate:(to,name)=>this.accept(to,'template',name),
    uploadMedia:async bytes=>{const id=String(100000+this.documents.size);this.documents.set(id,Buffer.from(bytes));return id;},
    downloadMedia:async(mediaId,checks)=>{const source=this.documents.get(mediaId);assert.ok(source,'Mock inbound media must exist');const content=Buffer.from(source);assert.ok((checks?.allowedMimeTypes??['application/pdf']).includes('application/pdf'));if(checks?.expectedSha256)assert.equal(checks.expectedSha256,sha(content));return {content,sha256:sha(content),mimeType:'application/pdf'};},
  };
  readonly adapters:ConfiguredAdapters={
    kmaleon:{
      searchExpedientes:async input=>({items:[...this.projects.values()].filter(project=>input.field==='dni'?project.dni.includes(input.query.toUpperCase()):project.nombre.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())),page:input.page??1,hasMore:false}),
      getExpediente:async projectId=>{const project=this.projects.get(projectId);assert.ok(project,'Mock Kmaleon project must exist');return project;},
      uploadAndVerifyDocument:async input=>{
        this.uploadCalls++;assert.equal(this.identities.get(input.projectId),input.expectedDni,'Mock CRM project identity');
        const previous=this.uploads.get(input.idempotencyKey);if(previous)return previous;
        assert.equal(input.reconcileOnly,false,'An unresolved mock effect must not be replayed');
        const copy=Buffer.from(input.buffer);assert.equal(sha(copy),sha(input.buffer));
        const proof:DocumentProof={verified:true,projectId:input.projectId,annotationId:'mock-upload-'+randomUUID(),documentId:'mock-document-'+randomUUID(),sha256:sha(copy),idempotencyKey:input.idempotencyKey,...{evidenceKind:'MOCK_PROVIDER_IN_MEMORY_READBACK'}};
        this.documents.set(proof.documentId,copy);this.uploads.set(input.idempotencyKey,proof);return proof;
      },
      notifyDayana:async input=>{
        this.noticeCalls++;assert.equal(this.identities.get(input.projectId),input.expectedDni);
        assert.equal(this.uploads.get(input.documentProof.idempotencyKey)?.sha256,input.documentProof.sha256);
        const prior=this.notices.get(input.idempotencyKey);if(prior)return prior;
        const proof:NoticeProof={verified:true,projectId:input.projectId,annotationId:'mock-notice-'+randomUUID(),recipientCode:999,idempotencyKey:input.idempotencyKey,...{evidenceKind:'MOCK_PROVIDER_NO_REAL_NOTICE'}};
        this.notices.set(input.idempotencyKey,proof);return proof;
      },
      getVerifiedAddress:async()=>{throw new Error('MOCK_ADDRESS_NOT_USED_IN_SETUP_TEST');},
    },
    apudata:{
      preapprove:async input=>{this.preapprovalCalls++;return {id:'mock-approval-'+randomUUID(),clientId:input.clientId,preApproved:true,expiresAt:new Date(Date.now()+3600000).toISOString(),evidenceRef:'MOCK_PROVIDER_PREAPPROVAL_NO_REAL_ACCOUNT'};},
      buildPaymentInstruction:(approval,clientId)=>{assert.equal(approval.clientId,clientId);assert.ok(Date.parse(approval.expiresAt)>Date.now());return 'MOCK PAYMENT INSTRUCTIONS ONLY. Amount 35 EUR. No bank account exists and no money is transferred.';},
      createOrder:async input=>{
        this.orderCalls++;assert.equal(input.approval.clientId,input.clientId);assert.match(input.paymentEvidenceRef,/^mock-/);
        const previous=this.orders.get(input.idempotencyKey);if(previous)return previous;
        const order:ApudataOrder={id:'mock-order-'+randomUUID(),clientId:input.clientId,idempotencyKey:input.idempotencyKey,approvalId:input.approval.id,amountCents:3500,currency:'EUR',status:'video_pending',videoUrl:'https://mock-provider.invalid/video/setup-only'};
        this.orders.set(input.idempotencyKey,order);return order;
      },
    },
  };
  wipe(){for(const bytes of this.documents.values())bytes.fill(0);this.documents.clear();}
}
