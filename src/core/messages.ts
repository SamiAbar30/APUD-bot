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
const FNMT_APP='https://play.google.com/store/apps/details?id=es.fnmtrcm.ceres.certificadoDigitalFNMT&hl=en-US';
const deviceButtons:OutgoingGuide['buttons']=[{id:'DEVICE_PC',title:'En el ordenador'},{id:'DEVICE_MOBILE',title:'En el móvil'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}];
const acquiredButtons:OutgoingGuide['buttons']=[{id:'DEVICE_PC',title:'Ya lo tengo en PC'},{id:'DEVICE_MOBILE',title:'Ya lo tengo en móvil'},{id:'NEEDS_ASSISTANCE',title:'Ayuda paso a paso'}];
const revocationText=`El despacho te indicará qué poder debe corregirse y qué datos o facultades faltan. Confirma con el gestor el poder que debe sustituirse antes de revocarlo. Consulta tus poderes en la Sede Judicial (${officialLinks.sede}) y sigue las instrucciones revisadas del despacho. Envíanos el nuevo justificante completo para comprobar la sustitución.`;
type Renderer=(c:BotApodExpediente,consentVersion?:string,variables?:TemplateVariables)=>OutgoingGuide;

export function firstContactText(_c?:BotApodExpediente):string {
  // WhatsApp length: identity, reason, cost and the question, without a paragraph of preamble.
  return 'Hola, soy Dayana, la asistente virtual de LITIGIOS. Te escribo por el apoderamiento apud acta de tu reclamación: es gratuito si lo haces por tu cuenta y te guío yo paso a paso. ¿Tienes certificado digital a tu nombre?';
}

/** A greeting or incomplete answer keeps the actual pending step, without a handoff. */
export function pendingConversationText(c:Pick<BotApodExpediente,'currentState'|'hasDigitalCert'> & {certificateHelpAttempts?:number;dni?:string}):string|null {
  if((c.certificateHelpAttempts??0)>0&&['PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION','MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT'].includes(c.currentState))return 'Seguimos con la copia de tu certificado para ayudarte con el apoderamiento. ¿Has podido localizarla en el dispositivo donde la instalaste?';
  switch(c.currentState){
    case 'INITIAL_TRIAGE':
    case 'WAITING_CERT_RESPONSE': return c.hasDigitalCert?'¿Lo tienes en el móvil o en el ordenador?':'¿Tienes certificado digital a tu nombre?';
    case 'MOBILE_TRIAGE_PC_CHECK': return 'Para continuar con el certificado que tienes en el móvil, ¿dispones de un ordenador donde puedas instalarlo?';
    case 'MOBILE_EXPORT_GUIDE_SENT': return 'El siguiente paso es pasar el certificado del móvil al ordenador siguiendo la guía anterior. Avísame cuando esté instalado o si necesitas ayuda.';
    case 'PC_TUTORIAL_SENT':
    case 'WAITING_PDF_SUBMISSION': return 'Sigue la guía para hacer el apoderamiento desde el ordenador y envíanos el PDF completo cuando termines. Si algún paso te da problemas, cuéntamelo.';
    case 'CERT_ACQUISITION_LINKS_SENT': return /^[XYZ]/i.test(c.dni??'')
      ? 'Seguimos con tu certificado digital: con NIE se pide cita en el Ayuntamiento. ¿Has podido pedir la cita?'
      : 'Seguimos con tu certificado digital. ¿Has empezado con el DNI electrónico o con la vídeo identificación?';
    case 'FALLBACK_OPTIONS': return '¿Prefieres hacerlo por tu cuenta en el juzgado, gratis, o consultar la gestión opcional de pago con la empresa colaboradora?';
    case 'COURT_FALLBACK_GUIDE_SENT': return 'Seguimos con el apoderamiento en el juzgado. Si ya lo has hecho, envíanos el justificante PDF completo para revisarlo; si te falta algún paso, cuéntamelo.';
    default:return null;
  }
}

/** Explicit action templates distinguish questions that share the same FSM state. */
const templates:Record<TemplateId,Renderer>={
  [TemplateId.FALLBACK_OPTIONS]:()=>({text:'Tienes dos formas de terminarlo sin enviarnos nada.\n\nEn el juzgado: pides cita en el decanato de tu ciudad y acudes con tu DNI o NIE; es gratis y lo firmas allí. La empresa colaboradora es la vía opcional y de pago: lo tramita por ti, con una referencia de 35 € que confirmamos antes de contratar. ¿Cuál prefieres?',buttons:[{id:'COURT_APPOINTMENT',title:'Juzgado · gratis'},{id:'APUDATA_REQUEST',title:'Gestión de pago'},help]}),
  [TemplateId.FOLLOWUP_DAY3]:c=>({text:followUpText(c,3),buttons:[help]}),
  [TemplateId.FOLLOWUP_DAY7]:c=>({text:followUpText(c,7),buttons:[help]}),
  [TemplateId.FOLLOWUP_DAY15]:c=>({text:followUpText(c,15),buttons:[help]}),
  [TemplateId.ASK_HAS_CERT]:(c)=>({text:firstContactText(c)}),
  [TemplateId.ASK_CERT_DEVICE]:()=>({text:'¿Lo tienes en el móvil o en el ordenador?',buttons:deviceButtons}),
  [TemplateId.ASK_HAS_PC]:()=>({text:'Desde el móvil no se puede firmar, hace falta un ordenador. ¿Tienes uno a mano?',buttons:[{id:'HAS_PC',title:'Tengo ordenador'},{id:'NO_PC',title:'No tengo ordenador'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}]}),
  // Protocol 2.1 with the team's own wording for the app (used ~37 times in real chats).
  [TemplateId.MOBILE_EXPORT_GUIDE]:()=>({text:'Te recomiendo instalarlo en el ordenador para poder firmarlo. Desde la app Certificado Digital, en el apartado Mis Certificados Instalados, pulsa la flecha azul de la derecha y de ahí compartir copia de seguridad. Te pedirá crear una contraseña para esa copia; apúntala. Luego abres ese archivo en el ordenador para instalarlo. Si te atascas, dime en qué paso y lo vemos.',buttons:[{id:'DEVICE_PC',title:'Ya está en el PC'},{id:'NEEDS_ASSISTANCE',title:'Necesito asistencia'}]}),
  // The client cannot do it alone, so the office does it. Said the way a person would say it,
  // and the yes/no button is what records the client's permission.
  [TemplateId.ASSIST_CONSENT_REQUEST]:()=>({text:'No te preocupes, eso lo hago yo por ti. Necesito el archivo de tu certificado y su contraseña, y lo uso solo para este apoderamiento. ¿Me los mandas por aquí?',buttons:[{id:'CONSENT_YES',title:'Sí, te los mando'},{id:'CONSENT_NO',title:'Prefiero que no'}]}),
  [TemplateId.ASSIST_SEND_CERT_INSTRUCTIONS]:()=>({text:'Genial. Mándame el archivo del certificado, que suele ser .p12 o .pfx, y la contraseña en otro mensaje aparte. Con eso lo preparo y te aviso cuando esté hecho.',buttons:[{id:'CONSENT_NO',title:'Mejor no'},help]}),
  [TemplateId.ASSIST_CERT_PASSWORD_INVALID]:()=>({text:'No hemos podido abrir la copia del certificado con esa contraseña. Compruébala y vuelve a mandármela por aquí, en un mensaje aparte.',buttons:[help]}),
  [TemplateId.ASSIST_CERT_UNUSABLE]:()=>({text:'La copia del certificado aportada no puede utilizarse para esta asistencia. El gestor revisará contigo el formato, la identidad y las opciones para continuar.',buttons:[help]}),
  [TemplateId.ASSIST_CERT_EXPIRED]:()=>({text:'La inspección del certificado indica que está fuera de su período de validez. Consulta con el gestor la renovación o una vía alternativa para el apoderamiento.',buttons:[{id:'COURT_APPOINTMENT',title:'Vía presencial'},help]}),
  [TemplateId.DRAFT_REVIEW_REQUEST]:c=>{
    if(!c.documentId)throw new AppError('DRAFT_DOCUMENT_REQUIRED');
    return {text:'Te enviamos el borrador para revisión. Comprueba tu identidad, los profesionales designados y las facultades solicitadas. Indica si los datos son correctos o si necesita cambios. Tu respuesta confirma la revisión del borrador; el otorgamiento requiere el trámite correspondiente.',attachment:'STORED_DOCUMENT',buttons:[{id:'DRAFT_APPROVED',title:'Revisado y conforme'},{id:'DRAFT_REJECTED',title:'Necesita corrección'}]};
  },
  [TemplateId.PC_TUTORIAL]:()=>({text:`Perfecto. Te paso la guía con los datos de nuestros procuradores: los necesitarás para rellenar el formulario.\n\nHazlo en el ordenador donde tienes el certificado: instala AutoFirma (https://firmaelectronica.gob.es/Home/Descargas.htm) y entra en ${officialLinks.sede} por «Certificado Digital». En la última página de la guía tienes el procurador y el abogado que tienes que añadir. Ve paso a paso y, si alguna pantalla te lía, dime por dónde vas y te ayudo. Cuando termines, mándame el PDF que te descarga la Sede.`,attachment:'TUTORIAL'}),
  [TemplateId.DIGITAL_STEP_HELP]:(c,_version,variables)=>{
    const topic=variables?.helpTopic;
    if(c.hasDigitalCert===null)return {text:`${variables?.guidanceDocumentType==='NIE'?'Entendido, tienes NIE. ':''}Claro, te ayudo a hacerlo paso a paso. Para empezar, ¿tienes un certificado digital a tu nombre?`};
    if(!c.hasDigitalCert){
      if(variables?.guidanceDocumentType==='NIE'||variables?.guidanceDocumentType!=='DNI'&&/^[XYZ]/.test(c.dni))return {text:(c.digitalHelpAttempts??0)<=1
        ?'Pide cita en tu Ayuntamiento, oficina de acreditación de la FNMT, para identificarte con tu NIE. Allí te entregan un documento con un enlace y una contraseña para descargar el certificado en tu ordenador.'
        :'En el Ayuntamiento te entregan un documento con un enlace y una contraseña para descargar el certificado en tu propio ordenador. Cuéntame en qué paso te has quedado.'};
      return {text:(c.digitalHelpAttempts??0)<=1?`Vamos paso a paso con tu certificado: abre la información de la FNMT para solicitarlo con DNIe (${officialLinks.fnmtDnie}) o mediante vídeo identificación (${officialLinks.fnmtVideo}), que tiene su propio coste. ¿Qué vía estás intentando utilizar?`:'Seguimos con la solicitud del certificado. Dime en qué paso te detienes y el texto del error, sin incluir códigos ni datos personales, para indicarte cómo continuar.'};
    }
    if(topic==='DOWNLOAD')return {text:'Si ya firmaste el apoderamiento, vuelve a la Sede Judicial y consulta tus apoderamientos vigentes en calidad de poderdante. Abre el poder y busca la descarga del justificante completo. ¿Consigues ver el apoderamiento en la consulta?'};
    if(topic==='AUTOFIRMA')return {text:'Comprueba que AutoFirma está instalado en el mismo ordenador donde tienes el certificado; puedes descargarlo desde https://firmaelectronica.gob.es/Home/Descargas.htm. Abre AutoFirma y vuelve al paso de firma del apoderamiento. ¿Qué mensaje aparece al intentar firmar?'};
    if(c.certDevice==='MOBILE')return {text:'Vamos a localizar la copia del certificado en la aplicación donde lo instalaste: busca la opción de copia de seguridad o exportación. Esa copia permite instalarlo en el ordenador. ¿Qué aplicación utilizaste para obtener el certificado?'};
    return {text:(c.digitalHelpAttempts??0)<=1?`Claro, vamos paso a paso: desde el ordenador donde tienes el certificado, abre ${officialLinks.sede} y entra por «Certificado Digital». ¿Consigues acceder al Área del ciudadano?`:'Dentro del Área del ciudadano, abre «Apoderamiento apud acta», inicia un nuevo apoderamiento y elige «En calidad de poderdante», siguiendo la guía enviada. ¿En qué pantalla o mensaje te quedas?'};
  },
  [TemplateId.CERTIFICATE_COPY_HELP]:(c,_version,variables)=>{
    // The device is already known from the case: asking "PC or mobile?" again is the repetition
    // the manager reported on 18 Sep.
    // "No computer" is recorded as a mobile-branch state rather than a field on the case.
    const mobileBranch=['MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT','MOBILE_ASSIST_CONSENT_REQUESTED'].includes(c.currentState);
    const onMobile=c.certDevice==='MOBILE'||variables?.helpTopic==='COPY_MOBILE'||mobileBranch;
    const attempts=c.certificateHelpAttempts??0;
    if(attempts<=1)return {text:onMobile
      // Protocol 2.2.1: on mobile the copy exists so the office can use it, so ask for it here.
      ?'Vamos a sacar una copia de tu certificado y así lo resolvemos. Abre en el móvil la aplicación donde lo obtuviste, busca «copia de seguridad» o «exportar» y mándame el archivo por aquí; la contraseña, en otro mensaje.'
      :'Vamos a por una copia de tu certificado y lo resolvemos. ¿La tienes en el ordenador o en una aplicación del móvil?'};
    if(attempts===2)return {text:`${onMobile?'Abre la aplicación del certificado en el móvil y busca «copia de seguridad» o «exportar».':'Busca la copia del certificado en Descargas o en la aplicación donde lo obtuviste.'} Suele ser un archivo .p12 o .pfx.`};
    return {text:'Si no aparece, revisa la opción de copia de seguridad o exportación de esa aplicación y ponle una contraseña al archivo. Después mándame ese archivo por aquí y la contraseña en otro mensaje, y hago yo el apoderamiento.'};
  },
  // The two routes differ in what the client needs at hand, so say that before asking them to choose.
  // The team's own list of ways to get the certificate (script interno, placeholders
  // OPCIONES_CONSEGUIR_CERTIFICADO). Cl@ve activation is left out: it cannot sign the apud acta.
  [TemplateId.CERT_ACQUISITION_LINKS_DNI]:()=>({text:`Te comento las opciones para conseguir el certificado digital:\n\n1- En el Ayuntamiento, de forma presencial.\n2- Desde el móvil con tu DNI electrónico, en la app de la FNMT (opción 3 de la app).\n3- Desde el móvil con la app de la FNMT, con un coste de 3,62 €.\n4- Con una empresa con la que trabajamos, que te hace el apoderamiento completo (35 €).\n\nApp de la FNMT: ${FNMT_APP}\n\nCon Cl@ve PIN no se puede firmar el apoderamiento. Dime cuál prefieres y te explico.`,buttons:acquiredButtons}),
  // Dayana's protocol (18 Sep): the Ayuntamiento hands over a document with a link and a password
  // that installs the certificate on the client's own computer. We never ask for an FNMT code.
  [TemplateId.CERT_ACQUISITION_LINKS_NIE]:()=>({text:`Con NIE lo más sencillo es pedirlo en tu Ayuntamiento, de forma presencial (no hace falta ir a la policía). Pides cita, vas con tu NIE y allí te entregan un documento con un enlace y una contraseña para descargar el certificado en tu ordenador.\n\nAntes, baja la app de la FNMT y marca la opción 2: ${FNMT_APP}`,buttons:acquiredButtons}),
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
  [TemplateId.SECURITY_ANSWER]:()=>({text:'La contraseña solo se usa para preparar tu apoderamiento y nada más. Mándamela por aquí, en un mensaje aparte del archivo del certificado.'}),
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
  const rendered=templates[selected as TemplateId](c,consentVersion,variables);
  // The brain may answer what the client just asked before the step's approved message, so a
  // question is never ignored because a workflow step fired. The lead was checked like any reply.
  const lead=typeof variables?.leadText==='string'?variables.leadText.trim():'';
  const guide=lead&&selected!==TemplateId.CONVERSATION_REPLY?{...rendered,text:`${lead}\n\n${rendered.text}`}:rendered;
  return {...guide,...(guide.buttons?{buttons:guide.buttons.map(button=>({...button}))}:{})};
}
