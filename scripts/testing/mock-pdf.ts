import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
export const MOCK_AIRAM='Airam Ejemplo Simulado';
export function mockDni(number:number):string{const digits=String(number).padStart(8,'0');return digits+'TRWAGMYFPDXBNJZSQVHLCKE'[number%23];}
/** Artificial fixture. Every page visibly identifies it as test data with no legal value. */
export async function makeMockPdf(dni:string,options:{pages?:number;airam?:boolean;negateAllanamiento?:boolean;label?:string}={}):Promise<Buffer>{
  const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('MOCK SETUP TEST - ARTIFICIAL DOCUMENT');pdf.setAuthor('APOD setup test');
  for(let i=0;i<(options.pages??5);i++){
    const page=pdf.addPage([595,842]);
    const lines=[
      'MOCK / DATOS ARTIFICIALES / SIN VALOR LEGAL',
      `Documento generado exclusivamente para comprobar el software. Pagina ${i+1}.`,
      `Cliente ficticio: Persona Simulada. DNI de prueba: ${dni}.`,
      options.airam===false?'Representante ficticio: Otro Ejemplo Simulado.':`Representante ficticio: ${MOCK_AIRAM}.`,
      'Contenido de ejemplo para una prueba controlada del extractor de texto.',
      'El texto siguiente ejercita reglas internas y nunca acredita un poder real.',
      'Se incluyen aqui suficientes palabras para verificar la lectura de todas',
      'las paginas, la identidad de prueba, los representantes y las facultades.',
      'Facultad expresamente incluida para otorgar poder general para pleitos.',
      options.negateAllanamiento?'Se excluye expresamente la facultad de allanamiento.':'Facultad expresamente incluida para allanamiento y para allanarse.',
      'Apartado separado de facultades afirmativas expresamente concedidas.',
      'Facultad expresamente incluida para desistimiento y para desistir.',
      'Facultad expresamente incluida para transaccion y para transigir.',
      'Facultad expresamente incluida para renuncia y para renunciar.',
      'Facultad expresamente incluida para cobro de mandamientos de pago.',
      `Referencia artificial de esta prueba: ${options.label??'setup'}.`,
    ];
    lines.forEach((line,n)=>page.drawText(line,{x:36,y:800-n*24,size:n===0?12:10,font,color:n===0?rgb(.65,0,0):rgb(.1,.1,.1)}));
  }
  return Buffer.from(await pdf.save());
}
