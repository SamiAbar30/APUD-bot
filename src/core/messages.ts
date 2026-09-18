import { ApodState, type BotApodExpediente } from '@prisma/client';
import { followUpText } from './follow-up.js';
import { officialLinks } from './guides.js';
import { AppError } from '../infrastructure/security.js';
import { TemplateId, type TemplateVariables } from '../domain/fsm/actions.js';
import type { ReplyButtonId } from '../contracts/whatsapp.contract.js';
import { PARTNER_COST } from './conversation-guidance.js';

export interface OutgoingGuide {
  text:string;
  buttons?:{id:ReplyButtonId;title:string}[];
  attachment?:'TUTORIAL'|'COURT_CHECKLIST'|'STORED_DOCUMENT'|'REVOCATION_GUIDE'|'REVOCATION_SCREENSHOTS';
  /** Executor must resolve these from reviewed provider evidence before sending. */
  requiresVerifiedContent?:'APUDATA_PAYMENT_DETAILS'|'APUDATA_VIDEO_INSTRUCTIONS';
}
const help={id:'HUMAN_HELP',title:'Ayuda del gestor'} as const;
const deviceButtons:OutgoingGuide['buttons']=[{id:'DEVICE_PC',title:'En el ordenador'},{id:'DEVICE_MOBILE',title:'En el móvil'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}];
const acquiredButtons:OutgoingGuide['buttons']=[{id:'DEVICE_PC',title:'Ya lo tengo en PC'},{id:'DEVICE_MOBILE',title:'Ya lo tengo en móvil'},{id:'NEEDS_ASSISTANCE',title:'Ayuda paso a paso'}];
const revocationText=`El despacho te indicará qué poder debe corregirse y qué datos o facultades faltan. Confirma con el gestor el poder que debe sustituirse antes de revocarlo. Consulta tus poderes en la Sede Judicial (${officialLinks.sede}) y sigue las instrucciones revisadas del despacho. Envíanos el nuevo justificante completo para comprobar la sustitución.`;
type Renderer=(c:BotApodExpediente,consentVersion?:string,variables?:TemplateVariables)=>OutgoingGuide;

export function firstContactText(_c?:BotApodExpediente):string {
  return 'Hola, soy Dayana, la asistente virtual de LITIGIOS, el despacho de abogados. Te ayudaré paso a paso a hacer el apoderamiento apud acta para representarte en la reclamación; otorgarlo en la Sede Judicial es gratuito si lo haces por tu cuenta. ¿Tienes certificado digital a tu nombre?';
}

/** A greeting or incomplete answer keeps the actual pending step, without a handoff. */
export function pendingConversationText(c:Pick<BotApodExpediente,'currentState'|'hasDigitalCert'> & {certificateHelpAttempts?:number}):string|null {
  if((c.certificateHelpAttempts??0)>0&&['PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION','MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT'].includes(c.currentState))return 'Seguimos con la copia de tu certificado para ayudarte con el apoderamiento. ¿Has podido localizarla en el dispositivo donde la instalaste?';
  switch(c.currentState){
    case 'INITIAL_TRIAGE':
    case 'WAITING_CERT_RESPONSE': return c.hasDigitalCert?'¿Lo tienes en el móvil o en el ordenador?':'¿Tienes certificado digital a tu nombre?';
    case 'MOBILE_TRIAGE_PC_CHECK': return 'Para continuar con el certificado que tienes en el móvil, ¿dispones de un ordenador donde puedas instalarlo?';
    case 'MOBILE_EXPORT_GUIDE_SENT': return 'El siguiente paso es pasar el certificado del móvil al ordenador siguiendo la guía anterior. Avísame cuando esté instalado o si necesitas ayuda.';
    case 'PC_TUTORIAL_SENT':
    case 'WAITING_PDF_SUBMISSION': return 'Sigue la guía para hacer el apoderamiento desde el ordenador y envíanos el PDF completo cuando termines. Si algún paso te da problemas, cuéntamelo.';
    case 'CERT_ACQUISITION_LINKS_SENT': return 'Seguimos con la obtención del certificado digital. ¿En qué paso de la solicitud te has quedado?';
    case 'FALLBACK_OPTIONS': return '¿Prefieres hacerlo por tu cuenta en el juzgado, gratis, o consultar la gestión opcional de pago con la empresa colaboradora?';
    case 'COURT_FALLBACK_GUIDE_SENT': return 'Seguimos con el apoderamiento en el juzgado. Si ya lo has hecho, envíanos el justificante PDF completo para revisarlo; si te falta algún paso, cuéntamelo.';
    default:return null;
  }
}

/** Explicit action templates distinguish questions that share the same FSM state. */
const templates:Record<TemplateId,Renderer>={
  [TemplateId.FALLBACK_OPTIONS]:()=>({text:`Puedes hacer el apoderamiento por tu cuenta en el juzgado, gratis. ${PARTNER_COST} ¿Cuál prefieres?`,buttons:[{id:'COURT_APPOINTMENT',title:'Juzgado · gratis'},{id:'APUDATA_REQUEST',title:'Gestión de pago'},help]}),
  [TemplateId.FOLLOWUP_DAY3]:c=>({text:followUpText(c,3),buttons:[help]}),
  [TemplateId.FOLLOWUP_DAY7]:c=>({text:followUpText(c,7),buttons:[help]}),
  [TemplateId.FOLLOWUP_DAY15]:c=>({text:followUpText(c,15),buttons:[help]}),
  [TemplateId.ASK_HAS_CERT]:(c)=>({text:firstContactText(c)}),
  [TemplateId.ASK_CERT_DEVICE]:()=>({text:'¿Lo tienes en el móvil o en el ordenador?',buttons:deviceButtons}),
  [TemplateId.ASK_HAS_PC]:()=>({text:'Para firmar el apoderamiento necesitas el certificado en un ordenador; desde el móvil no se puede firmar. ¿Tienes un ordenador donde puedas instalarlo?',buttons:[{id:'HAS_PC',title:'Tengo ordenador'},{id:'NO_PC',title:'No tengo ordenador'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}]}),
  [TemplateId.MOBILE_EXPORT_GUIDE]:()=>({text:'Utiliza la opción de copia de seguridad o exportación de tu aplicación de certificado. Protege la copia con su contraseña e instálala en tu ordenador siguiendo las instrucciones de la aplicación. Conserva ambos de forma segura. Si necesitas ayuda, el gestor te indicará cómo continuar.',buttons:[{id:'DEVICE_PC',title:'Ya está en el PC'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}]}),
  [TemplateId.ASSIST_CONSENT_REQUEST]:(_c,consentVersion)=>{
    if(!consentVersion?.trim())throw new AppError('CONSENT_TEXT_NOT_APPROVED');
    return {text:`Podemos ayudarte a preparar el borrador del apoderamiento bajo revisión del despacho. El uso del certificado debe estar limitado a este trámite y a tu consentimiento expreso (${consentVersion}). La preparación asistida no supone por sí sola otorgar o revocar poderes. El gestor te indicará el canal autorizado para el certificado. ¿Autorizas esta asistencia?`,buttons:[{id:'CONSENT_YES',title:'Autorizo asistencia'},{id:'CONSENT_NO',title:'No autorizo'}]};
  },
  [TemplateId.ASSIST_SEND_CERT_INSTRUCTIONS]:()=>({text:'El gestor te facilitará el canal seguro para la sesión de asistencia. Utilízalo para aportar tu copia del certificado y su contraseña. La sesión se limitará a preparar el borrador que deberás revisar.',buttons:[{id:'CONSENT_NO',title:'Retirar permiso'},help]}),
  [TemplateId.ASSIST_CERT_PASSWORD_INVALID]:()=>({text:'No hemos podido abrir la copia del certificado con la contraseña facilitada. Comprueba la contraseña y vuelve a aportarla exclusivamente en el canal seguro de asistencia indicado por el gestor.',buttons:[help]}),
  [TemplateId.ASSIST_CERT_UNUSABLE]:()=>({text:'La copia del certificado aportada no puede utilizarse para esta asistencia. El gestor revisará contigo el formato, la identidad y las opciones para continuar.',buttons:[help]}),
  [TemplateId.ASSIST_CERT_EXPIRED]:()=>({text:'La inspección del certificado indica que está fuera de su período de validez. Consulta con el gestor la renovación o una vía alternativa para el apoderamiento.',buttons:[{id:'COURT_APPOINTMENT',title:'Vía presencial'},help]}),
  [TemplateId.DRAFT_REVIEW_REQUEST]:c=>{
    if(!c.documentId)throw new AppError('DRAFT_DOCUMENT_REQUIRED');
    return {text:'Te enviamos el borrador para revisión. Comprueba tu identidad, los profesionales designados y las facultades solicitadas. Indica si los datos son correctos o si necesita cambios. Tu respuesta confirma la revisión del borrador; el otorgamiento requiere el trámite correspondiente.',attachment:'STORED_DOCUMENT',buttons:[{id:'DRAFT_APPROVED',title:'Revisado y conforme'},{id:'DRAFT_REJECTED',title:'Necesita corrección'}]};
  },
  [TemplateId.PC_TUTORIAL]:()=>({text:`Perfecto, te paso la guía y el listado de procuradores y abogados. Necesitas AutoFirma instalado en el ordenador: https://firmaelectronica.gob.es/Home/Descargas.htm\n\nAbre ${officialLinks.sede} en modo incógnito y entra por Certificado Digital. Cuando termines, envíanos el PDF completo para revisarlo.`,attachment:'TUTORIAL'}),
  [TemplateId.DIGITAL_STEP_HELP]:(c,_version,variables)=>{
    const topic=variables?.helpTopic;
    if(c.hasDigitalCert===null)return {text:`${variables?.guidanceDocumentType==='NIE'?'Entendido, tienes NIE. ':''}Claro, te ayudo a hacerlo paso a paso. Para empezar, ¿tienes un certificado digital a tu nombre?`};
    if(!c.hasDigitalCert){
      if(variables?.guidanceDocumentType==='NIE'||variables?.guidanceDocumentType!=='DNI'&&/^[XYZ]/.test(c.dni))return {text:`Entendido, tienes NIE. Te ayudo con esa vía.\n\nVamos con el certificado FNMT: primero revisa la solicitud y la acreditación de identidad en ${officialLinks.fnmtOffice}; la oficina debe estar habilitada. ¿Ya tienes el código de solicitud para acreditar tu identidad?`};
      return {text:(c.digitalHelpAttempts??0)<=1?`Vamos paso a paso con tu certificado: abre la información de la FNMT para solicitarlo con DNIe (${officialLinks.fnmtDnie}) o mediante vídeo identificación (${officialLinks.fnmtVideo}), que tiene su propio coste. ¿Qué vía estás intentando utilizar?`:'Seguimos con la solicitud del certificado. Dime en qué paso te detienes y el texto del error, sin incluir códigos ni datos personales, para indicarte cómo continuar.'};
    }
    if(topic==='DOWNLOAD')return {text:'Si ya firmaste el apoderamiento, vuelve a la Sede Judicial y consulta tus apoderamientos vigentes en calidad de poderdante. Abre el poder y busca la descarga del justificante completo. ¿Consigues ver el apoderamiento en la consulta?'};
    if(topic==='AUTOFIRMA')return {text:'Comprueba que AutoFirma está instalado en el mismo ordenador donde tienes el certificado; puedes descargarlo desde https://firmaelectronica.gob.es/Home/Descargas.htm. Abre AutoFirma y vuelve al paso de firma del apoderamiento. ¿Qué mensaje aparece al intentar firmar?'};
    if(c.certDevice==='MOBILE')return {text:'Vamos a localizar la copia del certificado en la aplicación donde lo instalaste: busca la opción de copia de seguridad o exportación. Esa copia permite instalarlo en el ordenador. ¿Qué aplicación utilizaste para obtener el certificado?'};
    return {text:(c.digitalHelpAttempts??0)<=1?`Claro, vamos paso a paso: desde el ordenador donde tienes el certificado, abre ${officialLinks.sede} y entra por «Certificado Digital». ¿Consigues acceder al Área del ciudadano?`:'Dentro del Área del ciudadano, abre «Apoderamiento apud acta», inicia un nuevo apoderamiento y elige «En calidad de poderdante», siguiendo la guía enviada. ¿En qué pantalla o mensaje te quedas?'};
  },
  [TemplateId.CERTIFICATE_COPY_HELP]:(c,_version,variables)=>({text:(c.certificateHelpAttempts??0)<=1?'Si no consigues terminarlo, podemos ayudarte con una copia de tu certificado. Primero vamos a localizarla: ¿lo tienes instalado en el ordenador o en una aplicación del móvil?':(c.certificateHelpAttempts??0)===2?`${variables?.helpTopic==='COPY_MOBILE'?'En el móvil, abre la aplicación donde obtuviste el certificado y busca la copia de seguridad o exportación.':'Busca la copia del certificado en Descargas o en la aplicación donde lo obtuviste.'} Suele ser un archivo .p12 o .pfx; no envíes la contraseña por este chat. ¿Has encontrado ese archivo?`:'Si no encuentras el archivo, revisa la opción de copia de seguridad o exportación de la aplicación del certificado y protege la copia con una contraseña que conservarás tú. ¿Qué aplicación estás usando para localizar esa opción?'}),
  [TemplateId.CERT_ACQUISITION_LINKS_DNI]:()=>({text:`Primero vamos a obtener tu certificado digital: con DNI puedes consultar la vía con DNIe (${officialLinks.fnmtDnie}) o la vídeo identificación de la FNMT (${officialLinks.fnmtVideo}), que tiene un coste propio indicado en su web. Después te guiaré para hacer el apoderamiento en la Sede Judicial. ¿Qué vía para obtener el certificado prefieres?`,buttons:acquiredButtons}),
  [TemplateId.CERT_ACQUISITION_LINKS_NIE]:()=>({text:`Con NIE puedes consultar en tu Ayuntamiento una oficina habilitada para acreditar tu identidad y obtener el certificado FNMT: ${officialLinks.fnmtOffice}. Confirma qué documentos necesitas y si debes pedir cita. Cuando tengas el certificado, me comentas.`,buttons:acquiredButtons}),
  [TemplateId.CERT_ACQUISITION_LINKS_UNKNOWN_ID]:()=>({text:'Necesitamos que el gestor confirme tu documento de identidad para indicarte una vía de obtención del certificado adecuada a tu caso.',buttons:[help]}),
  [TemplateId.COURT_POWER_CHECKLIST]:()=>({text:'De acuerdo, puedes hacer el apoderamiento por tu cuenta en el juzgado, de forma gratuita. Lleva tu documento de identidad y la lista adjunta de procuradores, abogados y facultades; confirma con la oficina si necesitas cita. Cuando lo tengas, envíanos el justificante PDF completo para revisarlo.',attachment:'COURT_CHECKLIST'}),
  [TemplateId.APUDATA_NOT_ELIGIBLE_COURT_FALLBACK]:()=>({text:'El proveedor no ha confirmado la admisión de tu documentación. El gestor te ayudará a continuar por la vía presencial. Lleva tu identificación y la lista adjunta a la oficina judicial, previa consulta de sus requisitos y cita.',attachment:'COURT_CHECKLIST'}),
  [TemplateId.APUDATA_PAYMENT_DETAILS]:c=>{
    if(!c.apudataPreApproved)throw new AppError('PREAPPROVAL_REQUIRED');
    return {text:'La admisión está preaprobada. Utiliza exclusivamente las instrucciones de pago verificadas para tu referencia.',requiresVerifiedContent:'APUDATA_PAYMENT_DETAILS'};
  },
  [TemplateId.APUDATA_VIDEO_INSTRUCTIONS]:c=>{
    if(!c.apudataOrderId)throw new AppError('APUDATA_ORDER_REQUIRED');
    return {text:'Tu solicitud dispone de una referencia del proveedor. Utiliza el enlace verificado correspondiente a esa referencia y sigue sus instrucciones para la identificación.',requiresVerifiedContent:'APUDATA_VIDEO_INSTRUCTIONS'};
  },
  [TemplateId.PDF_UNREADABLE_RESEND]:()=>({text:'No hemos podido leer correctamente el archivo recibido. Descarga de nuevo el justificante y envíanos el PDF original completo, con todas sus páginas. El gestor puede ayudarte si el problema continúa.',buttons:[help]}),
  [TemplateId.PDF_REJECTED_RESEND]:()=>({text:'El documento recibido necesita correcciones antes de continuar. Consulta con el gestor los puntos pendientes y envía el PDF completo que corresponda a tu apoderamiento.',buttons:[help]}),
  [TemplateId.PDF_NO_AIRAM_REDO]:()=>({text:'La revisión automática no ha podido confirmar al procurador Airam con los datos completos del listado aprobado. El gestor debe comprobar esta incidencia y confirmar las correcciones necesarias antes de que prepares otro poder.',buttons:[help]}),
  [TemplateId.PROVISIONAL_FILED_REVOKE_AND_REISSUE]:c=>{
    if(!c.isProvisionalFiled)throw new AppError('PROVISIONAL_FILING_NOT_VERIFIED');
    return {text:`El despacho ha incorporado el documento como provisional y mantiene pendiente su corrección. ${revocationText}`,buttons:[{id:'REVOKED',title:'Revocación realizada'},help]};
  },
  [TemplateId.REVOCATION_GUIDE]:()=>({text:revocationText,attachment:'REVOCATION_GUIDE',buttons:[{id:'REVOKED',title:'Revocación realizada'},help]}),
  [TemplateId.REVOCATION_SCREENSHOTS]:()=>({text:'Te facilitamos las capturas revisadas por el despacho para localizar las opciones de consulta y revocación. Confirma con el gestor cuál es el poder que debe sustituirse antes de realizar el trámite.',attachment:'REVOCATION_SCREENSHOTS',buttons:[help]}),
  [TemplateId.REISSUE_INSTRUCTIONS]:()=>({text:`Para preparar el nuevo apoderamiento, consulta el listado de profesionales y las correcciones confirmadas por el gestor. Accede a ${officialLinks.sede} y comprueba todos los datos y facultades antes del otorgamiento. Envíanos el nuevo justificante PDF completo.`,attachment:'TUTORIAL'}),
  [TemplateId.COMPLETION_NOTICE]:c=>{
    if(c.currentState!==ApodState.HANDOFF_DAYANA&&c.currentState!==ApodState.COMPLETED)throw new AppError('COMPLETION_NOT_VERIFIED');
    return {text:'Tu apoderamiento ha sido revisado e incorporado a tu expediente. Dayana tiene la revisión y el despacho continuará la tramitación. Te informaremos de las novedades del expediente.'};
  },
  [TemplateId.REMINDER_PENDING_STEP]:()=>({text:'Tu apoderamiento tiene un paso pendiente. Revisa las últimas instrucciones del despacho. Si ya dispones del justificante, envía el PDF completo; si necesitas ayuda, indícaselo al gestor.',buttons:[help]}),
  [TemplateId.HUMAN_HANDOFF_NOTICE]:()=>({text:'Tu caso requiere la revisión de una persona del despacho. El gestor comprobará la información pendiente y te indicará cómo continuar.',buttons:[help]}),
  [TemplateId.PHASE1_GREETING]:()=>({text:'¡Hola! ¿Cómo va tu día y qué te trae por aquí? 😊'}),
  [TemplateId.PHASE1_HELP]:()=>({text:'¡Gracias por escribir! Todavía estoy aprendiendo. Pronto podré gestionar el proceso completo; por ahora estoy conociéndote 😊'}),
  [TemplateId.PHASE2_ACK]:()=>({text:'Entendido, gracias por contármelo 👍'}),
  [TemplateId.PHASE2_DEFER]:()=>({text:'Entendido. Te acompañaré cuando el flujo esté activo; ahora solo estoy conociendo el contexto.'}),
  [TemplateId.PHASE3_GREETING]:c=>({text:c.currentState===ApodState.WAITING_CERT_RESPONSE?(c.hasDigitalCert?'Hola, ¿tienes el certificado en el móvil o en el ordenador?':'Hola, ¿tienes certificado digital para que podamos continuar?'):'Hola, seguimos con el paso donde lo dejamos. ¿Qué necesitas que te aclare?'}),
  [TemplateId.CONVERSATION_REPLY]:(_c,_consentVersion,variables)=>{
    const text=typeof variables?.replyText==='string'?variables.replyText.trim():'';
    if(!text)throw new AppError('CONVERSATION_REPLY_TEXT_REQUIRED');
    return {text};
  },
  [TemplateId.SECURITY_ANSWER]:()=>({text:'La contraseña solo se utiliza para preparar el apoderamiento en el canal seguro autorizado por el despacho. No la envíes por este chat; si tienes dudas, pide al gestor que te atienda.'}),
};

function templateForState(c:BotApodExpediente):TemplateId {
  switch(c.currentState){
    case ApodState.INITIAL_TRIAGE:return TemplateId.ASK_HAS_CERT;
    case ApodState.WAITING_CERT_RESPONSE:return c.hasDigitalCert===true?TemplateId.ASK_CERT_DEVICE:TemplateId.ASK_HAS_CERT;
    case ApodState.MOBILE_TRIAGE_PC_CHECK:return TemplateId.ASK_HAS_PC;
    case ApodState.MOBILE_EXPORT_GUIDE_SENT:return TemplateId.MOBILE_EXPORT_GUIDE;
    case ApodState.MOBILE_ASSIST_CONSENT_REQUESTED:return TemplateId.ASSIST_CONSENT_REQUEST;
    case ApodState.MOBILE_ASSIST_PROCESSING:return TemplateId.ASSIST_SEND_CERT_INSTRUCTIONS;
    case ApodState.PC_TUTORIAL_SENT:return TemplateId.PC_TUTORIAL;
    case ApodState.CERT_ACQUISITION_LINKS_SENT:return /^[XYZ]/.test(c.dni)?TemplateId.CERT_ACQUISITION_LINKS_NIE:/^\d{8}[A-Z]$/.test(c.dni)?TemplateId.CERT_ACQUISITION_LINKS_DNI:TemplateId.CERT_ACQUISITION_LINKS_UNKNOWN_ID;
    case ApodState.FALLBACK_OPTIONS:return TemplateId.FALLBACK_OPTIONS;
    case ApodState.COURT_FALLBACK_GUIDE_SENT:return TemplateId.COURT_POWER_CHECKLIST;
    case ApodState.PROVISIONAL_VIABILIZED:return TemplateId.PROVISIONAL_FILED_REVOKE_AND_REISSUE;
    case ApodState.REVOCATION_GUIDE_SENT:return TemplateId.REVOCATION_GUIDE;
    case ApodState.WAITING_REVOCATION_REISSUE:return TemplateId.REISSUE_INSTRUCTIONS;
    case ApodState.APUDATA_WAITING_PAYMENT:return TemplateId.APUDATA_PAYMENT_DETAILS;
    case ApodState.APUDATA_VIDEO_IN_PROGRESS:return TemplateId.APUDATA_VIDEO_INSTRUCTIONS;
    case ApodState.HANDOFF_DAYANA:case ApodState.COMPLETED:return TemplateId.COMPLETION_NOTICE;
    case ApodState.ESCALATED_HUMAN:return TemplateId.HUMAN_HANDOFF_NOTICE;
    case ApodState.WAITING_PDF_SUBMISSION:return TemplateId.REMINDER_PENDING_STEP;
    default:throw new AppError('NO_APPROVED_MESSAGE_FOR_STATE');
  }
}

export function messageForCase(c:BotApodExpediente,consentVersion?:string,template?:string,variables?:TemplateVariables):OutgoingGuide {
  const selected=template??templateForState(c);
  if(!Object.hasOwn(templates,selected))throw new AppError('UNKNOWN_MESSAGE_TEMPLATE');
  const guide=templates[selected as TemplateId](c,consentVersion,variables);
  return {...guide,...(guide.buttons?{buttons:guide.buttons.map(button=>({...button}))}:{})};
}
