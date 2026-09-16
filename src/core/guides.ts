import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '../infrastructure/security.js';
export const officialLinks = {
  sede: 'https://sedejudicial.justicia.es/-/apoderamiento-apud-acta',
  fnmtVideo: 'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion',
  fnmtDnie: 'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-con-dnie',
  fnmtOffice: 'https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software/acreditar-identidad',
};
const field=z.string().trim().min(1).max(200).refine(v=>!/[\u0000-\u001f\u007f]/.test(v),'Control characters are not permitted');
export const RepresentativesSchema=z.object({
  approvedBy:field,approvedAt:z.string().datetime({offset:true}),
  representatives:z.array(z.object({fullName:field.refine(v=>v.length>=5),role:z.enum(['ABOGADO','PROCURADOR']),college:field.refine(v=>v.length>=2),registration:field}).strict()).min(1).max(200),
}).strict();
export type ApprovedRepresentatives=z.infer<typeof RepresentativesSchema>;
export type InstructionClient={nombre:string;dni:string};
const clientSchema=z.object({nombre:field,dni:field});
const normalizedName=(name:string)=>name.normalize('NFC').trim().replace(/\s+/g,' ').toLocaleUpperCase('es-ES');

/** Loads the named reviewed roster; never infers missing professional details. */
export async function loadApprovedRepresentatives(file?:string,airam?:string):Promise<ApprovedRepresentatives>{
  if(!file||!airam?.trim())throw new AppError('REPRESENTATIVES_NOT_CONFIGURED');
  const info=await stat(file);if(!info.isFile()||info.size>256*1024)throw new AppError('REPRESENTATIVES_FILE_INVALID');
  const bytes=await readFile(file);if(bytes.length>256*1024)throw new AppError('REPRESENTATIVES_FILE_INVALID');
  const roster=RepresentativesSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(!roster.representatives.some(r=>r.role==='PROCURADOR'&&normalizedName(r.fullName)===normalizedName(airam)))throw new AppError('AIRAM_MISSING_FROM_ROSTER');
  return roster;
}

async function checklistPdf(client:InstructionClient,roster:ApprovedRepresentatives,kind:'COURT'|'TUTORIAL'):Promise<Buffer>{
  const identity=clientSchema.parse(client);
  const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize:[number,number]=[595.28,841.89];let page=pdf.addPage(pageSize);let y=792;
  const line=(text:string,title=false)=>{
    const face=title?bold:font;const size=title?13:10;const advance=title?23:17;
    try{face.encodeText(text);}catch{throw new AppError('INSTRUCTIONAL_PDF_FONT_UNSUPPORTED');}
    const draw=(value:string)=>{if(y<55){page=pdf.addPage(pageSize);y=792;}page.drawText(value,{x:45,y,size,font:face,color:rgb(.1,.15,.2)});y-=advance;};
    let pending='';
    for(const word of text.split(/\s+/)){
      if(face.widthOfTextAtSize(word,size)>505){if(pending){draw(pending);pending='';}let part='';for(const character of word){if(part&&face.widthOfTextAtSize(part+character,size)>505){draw(part);part='';}part+=character;}pending=part;continue;}
      const candidate=pending?`${pending} ${word}`:word;
      if(pending&&face.widthOfTextAtSize(candidate,size)>505){draw(pending);pending=word;}else pending=candidate;
    }
    if(pending)draw(pending);
  };
  line(kind==='COURT'?'LISTA PARA SOLICITAR APODERAMIENTO APUD ACTA':'LISTADO DEL DESPACHO PARA EL TUTORIAL',true);
  line(`Cliente: ${identity.nombre}`);line(`DNI/NIE: ${identity.dni}`);
  line('Documento de instrucciones del despacho. No constituye un poder otorgado.');y-=12;
  line('Profesionales designados',true);
  for(const r of roster.representatives)line(`${r.role}: ${r.fullName}. Colegio: ${r.college}. Número: ${r.registration}.`);
  line(`Listado aprobado por: ${roster.approvedBy}. Fecha: ${roster.approvedAt}.`);y-=12;
  line('Comprobaciones para la solicitud',true);
  for(const instruction of [
    'Confirmar la identidad del otorgante y los datos completos de todos los profesionales.',
    'Revisar el poder general para pleitos y las facultades solicitadas por el despacho.',
    'Revisar las facultades especiales de renuncia, transacción, desistimiento y allanamiento según la solicitud aprobada.',
    'Revisar el cobro y percepción de cantidades y mandamientos de pago cuando proceda conforme a la solicitud aprobada.',
    'Comprobar la vigencia y las facultades efectivamente concedidas en el justificante.',
    'Enviar al despacho el PDF original completo con todas sus páginas para revisión.',
  ])line(`- ${instruction}`);
  if(kind==='COURT')line('Confirma con la oficina judicial sus requisitos y si necesitas cita.');
  line('El despacho revisará el documento recibido antes de incorporarlo como definitivo.');
  pdf.setTitle('Instrucciones del despacho para apoderamiento apud acta');
  return Buffer.from(await pdf.save());
}

export async function courtChecklist(client:InstructionClient,file?:string,airam?:string):Promise<Buffer>{
  return checklistPdf(client,await loadApprovedRepresentatives(file,airam),'COURT');
}

/** Reads an existing operator-configured PDF; does not manufacture tutorial evidence. */
export async function reviewedGuidePdf(file?:string):Promise<Buffer>{
  if(!file)throw new AppError('REVIEWED_GUIDE_NOT_CONFIGURED');
  const info=await stat(file);if(!info.isFile()||info.size>20*1024*1024)throw new AppError('REVIEWED_GUIDE_FILE_INVALID');
  const bytes=await readFile(file);if(!bytes.length||bytes.length>20*1024*1024)throw new AppError('REVIEWED_GUIDE_FILE_INVALID');
  let pdf:PDFDocument;try{pdf=await PDFDocument.load(bytes,{updateMetadata:false});}catch{throw new AppError('REVIEWED_GUIDE_PDF_INVALID');}
  if(pdf.getPageCount()<1||pdf.getPageCount()>300)throw new AppError('REVIEWED_GUIDE_PAGE_LIMIT');
  return bytes;
}

/** Appends an instructional roster to the actual configured tutorial; all work stays in RAM. */
export async function tutorialWithRoster(client:InstructionClient,tutorialFile?:string,representativesFile?:string,airam?:string):Promise<Buffer>{
  const roster=await loadApprovedRepresentatives(representativesFile,airam);
  const tutorial=await PDFDocument.load(await reviewedGuidePdf(tutorialFile),{updateMetadata:false});
  const instructions=await PDFDocument.load(await checklistPdf(client,roster,'TUTORIAL'));
  for(const page of await tutorial.copyPages(instructions,instructions.getPageIndices()))tutorial.addPage(page);
  tutorial.setTitle('Tutorial apud acta con listado de profesionales del despacho');
  const combined=Buffer.from(await tutorial.save());
  if(combined.length>25*1024*1024)throw new AppError('TUTORIAL_BUNDLE_TOO_LARGE');
  return combined;
}
