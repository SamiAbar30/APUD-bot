import {requiresDeterministicHandoff} from './conversation-policy.js';
import {conversationYield} from './conversation-guidance.js';

export const CONVERSATION_QUIET_MS = 60_000;
const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

/** Keep corrections and short continuations together, but split explicit new subjects.
 * Unknown substantial subjects stay separate rather than silently losing a question.
 * Security, consent buttons and attachments are always independent inbox events.
 */
function topic(text:string):string|null {
  const n=normalize(text);
  if(conversationYield(text))return null;
  if(/\b(?:precio|coste|cuesta|pagar|pago|gratis|gratuito|price|cost|pay|free|euros?)\b|€/.test(n))return 'cost';
  if(/\b(?:estado|novedades|cobrar|cobro|indemnizacion|sentencia|reclamacion|lawsuit|claim|compensation)\b/.test(n))return 'claim';
  if(/\b(?:cita|horario|direccion|appointment|address)\b/.test(n))return 'appointment';
  if(/\b(?:dni|nie|dnie|certificado|certificate|fnmt|ordenador|pc|movil|mobile|autofirma|apud|apoderamiento|pdf|justificante|firmar|firma|descargar)\b/.test(n))return 'power';
  if(/^(?:hola|hello|hi|buenos dias|buenas tardes|vale|ok|si|no|yes|nope)[.!\s]*$/.test(n)||/ayuda|por ?favor|help|no puedo|no entiendo|no me deja|terminar|finish|salir de esto/.test(n)||/^(?:y |pero |es que |porque |and |but )/.test(n))return null;
  return 'unknown';
}

export function relatedConversationText(group:readonly string[],next:string):boolean {
  if(requiresDeterministicHandoff(next)||group.some(requiresDeterministicHandoff))return false;
  if(/\b(?:otra cosa|otro tema|por otro lado|cambiando de tema|by the way|another question|unrelated)\b/.test(normalize(next)))return false;
  const nextTopic=topic(next);
  const previous=group.map(topic).filter((t):t is string=>t!==null);
  if(nextTopic===null)return true;
  if(previous.length===0)return nextTopic!=='unknown';
  return nextTopic!=='unknown'&&previous.every(t=>t===nextTopic);
}
