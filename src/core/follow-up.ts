import type { ApodState, BotApodExpediente } from '@prisma/client';
import { TemplateId } from '../domain/fsm/actions.js';

export const REMINDER_DAYS = [3, 7, 15] as const;
export const DAY_MS = 86_400_000;
export const FOLLOW_UP_STATES = new Set<ApodState>(['MOBILE_ASSIST_PROCESSING','WAITING_CERT_RESPONSE','MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT','MOBILE_ASSIST_CONSENT_REQUESTED','PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION','CERT_ACQUISITION_LINKS_SENT','FALLBACK_OPTIONS','COURT_FALLBACK_GUIDE_SENT','WAITING_REVOCATION_REISSUE','REVOCATION_GUIDE_SENT']);
export function stepFor(c:Pick<BotApodExpediente,'currentState'|'dni'|'hasDigitalCert'> & Partial<Pick<BotApodExpediente,'stepReached'|'certificateHelpAttempts'>>):string {
  if((c.certificateHelpAttempts??0)>0&&['PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION','MOBILE_TRIAGE_PC_CHECK','MOBILE_EXPORT_GUIDE_SENT'].includes(c.currentState))return 'LOCALIZAR_COPIA_CERTIFICADO';
  switch(c.currentState){
    case 'CERT_ACQUISITION_LINKS_SENT':return /^[XYZ]/.test(c.dni)?'ENVIAR_AYUNTAMIENTO_NIE':'ENVIAR_LINKS_DNI';
    case 'PC_TUTORIAL_SENT':case 'WAITING_PDF_SUBMISSION':return 'ENVIAR_PDF_ORDENADOR';
    case 'MOBILE_EXPORT_GUIDE_SENT':return 'INSTALAR_EN_PC_DESDE_MOVIL';
    case 'MOBILE_ASSIST_PROCESSING':return c.stepReached==='ASISTENCIA_SEGURA'?'ASISTENCIA_SEGURA':'SOLICITUD_CERTIFICADO_PASSWORD';
    case 'WAITING_CERT_RESPONSE':return c.hasDigitalCert?'CONSULTAR_DISPOSITIVO':'CONSULTAR_CERTIFICADO';
    default:return c.currentState;
  }
}
export function canFollowUp(c:Pick<BotApodExpediente,'currentState'|'stepReached'>):boolean{return FOLLOW_UP_STATES.has(c.currentState)&&c.stepReached!=='ASISTENCIA_SEGURA';}
export function nextFollowUp(anchor:Date,lastDay:number):Date|null {
  const day=[...REMINDER_DAYS,30].find(value=>value>lastDay);
  return day?new Date(anchor.getTime()+day*DAY_MS):null;
}
export function followUpTemplate(day:number):TemplateId {
  if(day===3)return TemplateId.FOLLOWUP_DAY3;
  if(day===7)return TemplateId.FOLLOWUP_DAY7;
  if(day===15)return TemplateId.FOLLOWUP_DAY15;
  throw new Error('INVALID_FOLLOW_UP_DAY');
}
export function followUpText(c:BotApodExpediente,day:number):string {
  const name=c.nombre.trim().split(/\s+/).slice(0,2).join(' ');
  const intro=`Hola ${name}, `;
  const later=day>3;
  switch(c.stepReached){
    case 'LOCALIZAR_COPIA_CERTIFICADO':return intro+'¿has podido localizar la copia de tu certificado para que podamos ayudarte con el apoderamiento? Si te has atascado, dime en qué paso.';
    case 'ENVIAR_LINKS_DNI':return intro+(later?'seguimos pendientes de tu certificado digital. Si te resulta complejo, cuéntanos dónde te has atascado y revisamos las alternativas.':'¿pudiste solicitar el certificado digital con los enlaces que te enviamos?');
    case 'ENVIAR_AYUNTAMIENTO_NIE':return intro+(later?'¿te dieron fecha para la cita de acreditación del certificado?':'¿pudiste consultar la cita para acreditar tu identidad en la oficina o Ayuntamiento habilitado?');
    case 'ENVIAR_PDF_ORDENADOR':return intro+(later?'¿pudiste descargar el justificante PDF del apud acta? Si te has atascado en algún paso del tutorial, dime cuál.':'¿has podido avanzar con el apud acta siguiendo el tutorial que te facilitamos?');
    case 'INSTALAR_EN_PC_DESDE_MOVIL':return intro+(later?'si no logras instalar el certificado en el ordenador, podemos revisar contigo la asistencia del despacho o las otras opciones.':'¿conseguiste instalar tu certificado en el ordenador?');
    case 'SOLICITUD_CERTIFICADO_PASSWORD':return intro+'¿pudiste revisar con el despacho cómo facilitar el certificado por el canal seguro? No envíes contraseñas por este chat.';
    case 'CONSULTAR_CERTIFICADO':return intro+'quedamos pendientes de saber si dispones de certificado digital para orientarte con el apoderamiento.';
    case 'CONSULTAR_DISPOSITIVO':return intro+'¿en qué dispositivo tienes instalado el certificado digital?';
    case 'MOBILE_TRIAGE_PC_CHECK':return intro+'¿dispones de un ordenador para continuar desde el paso en el que nos quedamos?';
    case 'MOBILE_ASSIST_CONSENT_REQUESTED':return intro+'¿pudiste revisar la información de asistencia del despacho? Si tienes alguna duda, la aclaramos antes de continuar.';
    case 'FALLBACK_OPTIONS':return intro+'¿prefieres consultar la vía presencial en el juzgado o el proveedor de videoidentificación?';
    case 'COURT_FALLBACK_GUIDE_SENT':return intro+'¿pudiste consultar la cita para el apoderamiento presencial?';
    case 'REVOCATION_GUIDE_SENT':case 'WAITING_REVOCATION_REISSUE':return intro+'¿pudiste revisar con el gestor las correcciones pendientes del apoderamiento?';
    default:return intro+'seguimos disponibles para ayudarte con el paso pendiente del apoderamiento. ¿En qué punto necesitas ayuda?';
  }
}
