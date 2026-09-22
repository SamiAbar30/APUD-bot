import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {RegistrationIntent} from '../contracts/apud-v2.contract.js';
import {findIdentityDocumentsInText,normalizeIdentityDocument} from '../domain/identity/spanish-identity-document.js';
import {normalizeForMatch} from '../domain/text/normalize.js';
import {matchesFullName} from './pdf-auditor.js';
import {AppError} from '../infrastructure/security.js';

/** Structural evidence only. No fixed page-count or universal-faculty assumptions. */
export async function auditRegistrationPdf(bytes:Buffer,intent:RegistrationIntent,kind:'DRAFT'|'RECEIPT',registrationReference?:string){
  if(bytes.length===0||bytes.length>30_000_000||bytes.subarray(0,5).toString()!=='%PDF-')throw new AppError('V2_PDF_INVALID',400);
  const structure=await PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false});
  if(structure.isEncrypted||structure.getPageCount()<1||structure.getPageCount()>60)throw new AppError('V2_PDF_UNSUPPORTED',400);
  const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,verbosity:0});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const work=(async()=>{
      const pdf=await task.promise;
      if(pdf.numPages!==structure.getPageCount())throw new AppError('V2_PDF_STRUCTURE_MISMATCH',400);
      const text:string[]=[];
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
        const page=await pdf.getPage(pageNumber);const content=await page.getTextContent();
        text.push(content.items.map(item=>'str'in item?item.str:'').join(' '));page.cleanup();
      }
      const raw=text.join('\n');const normalized=normalizeForMatch(raw);
      if(normalized.split(/\s+/).length<40)throw new AppError('V2_PDF_TEXT_LAYER_REQUIRED',400);
      const found=new Set(findIdentityDocumentsInText(raw).map(normalizeIdentityDocument));
      if(!found.has(intent.grantor.dni)||!matchesFullName(normalized,intent.grantor.name))throw new AppError('V2_PDF_GRANTOR_MISMATCH',400);
      if(intent.professionals.some(person=>!found.has(person.dni)||!matchesFullName(normalized,person.name)))throw new AppError('V2_PDF_PROFESSIONAL_MISMATCH',400);
      if(!/apoderamiento|apud\s+acta/.test(normalized))throw new AppError('V2_PDF_NOT_APODERAMIENTO',400);
      if(kind==='RECEIPT'){
        if(/\bborrador\b/.test(normalized))throw new AppError('V2_DRAFT_IS_NOT_RECEIPT',400);
        if(!registrationReference||!normalized.includes(normalizeForMatch(registrationReference)))throw new AppError('V2_RECEIPT_REFERENCE_MISMATCH',400);
      }
      // Names and identity occurrence cannot establish their legal role or authentic registration.
      return {sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:pdf.numPages,identityTextMatches:true,professionalsTextMatch:true,requiresHumanVerification:true};
    })();
    return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{void task.destroy().catch(()=>undefined);reject(new AppError('V2_PDF_AUDIT_TIMEOUT',400));},15000);})]);
  } finally {if(timer)clearTimeout(timer);await task.destroy().catch(()=>undefined);}
}
