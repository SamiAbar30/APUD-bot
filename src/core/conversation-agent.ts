import type { BotApodExpediente } from '@prisma/client';
import { EventType } from '../domain/fsm/states.js';
import { firstContactText, pendingConversationText } from './messages.js';
import {
  allowedConversationOptions,
  classifyClientText,
  boundedConversationHistory,
  requiresDeterministicHandoff,
  validateModelClassification,
  validateModelReply,
  type ConversationReply,
  type ConversationClassification,
  type ConversationHistoryMessage,
} from './conversation-policy.js';
import {
  approvedRolloutReply,
  classifyRolloutInput,
  rolloutInstruction,
  ConversationPhaseSchema,
  type ConversationPhase,
  type ConversationRolloutClassification,
} from './conversation-rollout.js';

/** Adapter boundary for an optional structured-output conversation provider. */
export interface ConversationModel {
  classify(input: {
    phase: ConversationPhase;
    instruction: string;
    state: string;
    hasDigitalCert: boolean | null;
    allowedOptions: readonly string[];
    text: string;
    history?: readonly ConversationHistoryMessage[];
  }): Promise<unknown>;
  reply?(input: {
    phase: ConversationPhase;
    instruction: string;
    state: string;
    hasDigitalCert: boolean | null;
    text: string;
    history?: readonly ConversationHistoryMessage[];
  }): Promise<unknown>;
}

/**
 * Runs the local bounded policy first. A model is optional: it may propose a
 * structured workflow option or a bounded support reply, and each result is
 * validated before the workflow or outbox can use it.
 */
export class StrictConversationAgent {
  private readonly phase: ConversationPhase;

  constructor(private readonly model?: ConversationModel, phase: ConversationPhase = 3) {
    this.phase = ConversationPhaseSchema.parse(phase);
  }

  get rolloutPhase(): ConversationPhase {
    return this.phase;
  }

  classifyRollout(text: string): ConversationRolloutClassification {
    return classifyRolloutInput(this.phase, text);
  }

  approvedRolloutReply(responseId: ConversationRolloutClassification['responseId']): string | null {
    return approvedRolloutReply(responseId);
  }

  async classify(
    expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>,
    text: string,
    history: readonly ConversationHistoryMessage[] = [],
  ): Promise<ConversationClassification> {
    const local = classifyClientText(expediente, text);
    const deviceEvidence=(choice:ConversationClassification):ConversationClassification=>{
      if(choice.kind!=='OPTION'||!['DEVICE_PC','DEVICE_MOBILE'].includes(choice.optionId)||expediente.hasDigitalCert===true)return choice;
      const n=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      // Owning a computer (including a relative's computer) is not proof of a certificate.
      if(!/\bsi\b|(?:tengo|dispongo|instalado|esta|esta instalado).{0,30}certificado|certificado.{0,40}(?:ordenador|pc|movil)|ya (?:lo )?tengo en/.test(n)||/\bno tengo\b/.test(n))return {kind:'HUMAN_REVIEW',reason:'UNSUPPORTED_TEXT'};
      return choice;
    };
    if (requiresDeterministicHandoff(text)) return local.kind === 'HUMAN_REVIEW' ? local : { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
    if (local.kind === 'OPTION' || !this.model) return deviceEvidence(local);
    // Prompt-injection attempts and button-only confirmations are hard gates.
    // They must never be handed to a model that could reinterpret them as a
    // valid workflow option.
    if (local.reason !== 'UNSUPPORTED_TEXT') return local;
    try {
      const proposed = await this.model.classify({
        phase: this.phase,
        instruction: rolloutInstruction(this.phase),
        state: String(expediente.currentState),
        hasDigitalCert: expediente.hasDigitalCert,
        allowedOptions: allowedConversationOptions(expediente),
        text,
        history: boundedConversationHistory(history),
      });
      return deviceEvidence(validateModelClassification(expediente, proposed));
    } catch {
      return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
    }
  }

  /**
   * Answer ordinary client questions without turning free text into a
   * workflow command. A configured provider supplies the wording; the local
   * replies keep the demo responsive while no provider is configured.
   */
  async respond(
    expediente: Pick<BotApodExpediente, 'currentState' | 'hasDigitalCert'>,
    text: string,
    history: readonly ConversationHistoryMessage[] = [],
  ): Promise<ConversationReply> {
    const rollout = this.classifyRollout(text);
    const local = classifyClientText(expediente, text);
    if (requiresDeterministicHandoff(text) || (local.kind === 'HUMAN_REVIEW' && (local.reason === 'PROMPT_INJECTION' || local.reason === 'BUTTON_REQUIRED'))) {
      return { text: PROFESSIONAL_HANDOFF, requiresHumanReview: true };
    }
    if(local.kind==='HUMAN_REVIEW'&&local.reason==='AMBIGUOUS_TEXT'){
      const pending=pendingConversationText(expediente);
      if(pending)return {text:`Para orientarte necesito aclarar tu respuesta. ${pending}`,requiresHumanReview:false};
      return {text:PROFESSIONAL_HANDOFF,requiresHumanReview:true};
    }
    const fixed = this.phase<3&&(rollout.responseId === 'SECURITY_ANSWER' || rollout.kind === 'GREETING')
      ? this.approvedRolloutReply(rollout.responseId)
      : null;
    if (fixed) return { text: fixed, requiresHumanReview: false };

    if (this.model?.reply) {
      try {
        const proposed = await this.model.reply({
          phase: this.phase,
          instruction: rolloutInstruction(this.phase),
          state: String(expediente.currentState),
          hasDigitalCert: expediente.hasDigitalCert,
          text,
          history: boundedConversationHistory(history),
        });
        const validated = validateModelReply(proposed);
        if (validated) return validated;
      } catch {
        // A provider failure falls through to the reviewed local reply.
      }
    }

    return this.model?{text:'Ha surgido un problema al responder. Te paso con una persona del despacho para que te ayude.',requiresHumanReview:true,handoffReason:'HUMANO'}:localSupportReply(text);
  }

  /** Shared by the durable webhook worker and the real-provider evaluator. */
  async turn(expediente:Pick<BotApodExpediente,'currentState'|'hasDigitalCert'>,text:string,history:readonly ConversationHistoryMessage[]=[],introduced=history.some(m=>m.role==='assistant'&&/LITIGIOS/i.test(m.content)&&/apoderamiento apud acta/i.test(m.content))):Promise<{type:EventType;payload:Record<string,unknown>}>{
    const n=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    let reply:ConversationReply|undefined;
    if(this.phase===3&&!requiresDeterministicHandoff(text)){
      const pending=pendingConversationText(expediente);
      if(this.classifyRollout(text).kind==='GREETING'){
        const isOpening=!introduced&&['INITIAL_TRIAGE','WAITING_CERT_RESPONSE'].includes(expediente.currentState)&&expediente.hasDigitalCert!==true;
        if(isOpening||pending)reply={text:isOpening?firstContactText():`Hola. ${pending}`,requiresHumanReview:false};
      }else if(pending&&(/^\s*[a-z]\s*$/i.test(text)||/^(?:i said yes|he dicho que si|ya te he dicho que si)[.!\s]*$/.test(n)&&expediente.currentState==='MOBILE_EXPORT_GUIDE_SENT')){
        reply={text:pending,requiresHumanReview:false};
      }
    }
    if(/\b(?:sms|codigo de (?:seguridad|verificacion)|pin bancario)\b/.test(n)&&!requiresDeterministicHandoff(text))reply={text:'No me envíes códigos SMS, PIN ni claves bancarias. Para el apoderamiento no necesito esos códigos.',requiresHumanReview:false};
    if(requiresDeterministicHandoff(text)||text==='[CONTENIDO_SENSIBLE_OMITIDO]')reply={text:'Recibido, gracias. Por seguridad, no compartas más credenciales por aquí. Te paso con una persona del despacho.',requiresHumanReview:true,handoffReason:/contrase|password|CONTENIDO_SENSIBLE/i.test(text)?'CERTIFICADO_RECIBIDO':'HUMANO'};
    if(!reply&&/quiero hablar con|persona de verdad|humano|estoy harto|falleci|tutor legal|menor de edad/.test(n))reply={text:'Disculpa. Te paso con una persona del equipo para que te ayude.',requiresHumanReview:true,handoffReason:'HUMANO'};
    if(!reply&&/a que cuenta|iban|transferencia|factura/.test(n))reply={text:'Para revisar el pago te paso con una persona del equipo.',requiresHumanReview:true,handoffReason:'PAGO'};
    if(!reply&&['PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION'].includes(expediente.currentState)&&/no puedo|no me deja|me ayudas|puedes ayudar|(?:me da|hay|aparece) (?:un )?error/.test(n))reply={text:'Te ayudo con eso. Para indicarte cómo compartir el certificado desde el ordenador necesito que lo revise el equipo.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    if(!reply){
      const choice=await this.classify(expediente,text,history);
      if(choice.kind==='OPTION'){
        if(choice.optionId==='NEEDS_ASSISTANCE'&&['PC_TUTORIAL_SENT','WAITING_PDF_SUBMISSION'].includes(expediente.currentState))reply={text:'Te ayudo con eso. Para indicarte cómo compartir el certificado desde el ordenador necesito que lo revise el equipo.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
        else return {type:choice.eventType,payload:{conversationOption:choice.optionId,conversationConfidence:choice.confidence}};
      }else reply=await this.respond(expediente,text,history);
    }
    return {type:EventType.CLIENT_SMALL_TALK,payload:{responseId:'CONVERSATION_REPLY',rolloutPhase:this.phase,rolloutKind:'WORKFLOW_REQUEST',responseText:reply!.text,requiresHumanReview:reply!.requiresHumanReview,...(reply!.requiresHumanReview?{handoffReason:reply!.handoffReason??'HUMANO',handoffMarker:`[[HANDOFF:${reply!.handoffReason??'HUMANO'}]]`}:{})}};
  }
}

const PROFESSIONAL_HANDOFF = 'Gracias por escribir. Quiero ayudarte, pero necesito que un profesional del despacho revise esta consulta. Un gestor se pondrá en contacto contigo para indicarte cómo continuar.';

function localSupportReply(text: string): ConversationReply {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/hablar con (una )?persona|hablar con el gestor|gestor|humano|agente|profesional/.test(normalized)) {
    return { text: PROFESSIONAL_HANDOFF, requiresHumanReview: true };
  }
  if (/no entiendo|no lo entiendo|no se|duda|explica|como funciona|que tengo que hacer|ayuda|ayudar/.test(normalized)) {
    return {
      text: 'Claro. Puedo ayudarte paso a paso con el apoderamiento apud acta. Dime qué parte no entiendes y te la explico; si hace falta, un gestor del despacho se pondrá en contacto contigo.',
      requiresHumanReview: false,
    };
  }
  if (/quien eres|quienes sois|de que despacho|que despacho|tu nombre/.test(normalized)) {
    return {
      text: 'Soy Dayana, la asistente virtual de LITIGIOS. Puedo orientarte con los pasos del apoderamiento apud acta; la revisión de los poderes corresponde al equipo del despacho.',
      requiresHumanReview: false,
    };
  }
  if (/apoderamiento|apud acta/.test(normalized)) {
    return {
      text: 'Puedo orientarte con los pasos del apoderamiento apud acta que correspondan a tu expediente. Las dudas sobre su alcance jurídico las revisa un profesional del despacho.',
      requiresHumanReview: false,
    };
  }
  if (/certificado|cl@ve|dnie|ordenador|movil|telefono/.test(normalized)) {
    return {
      text: 'Puedo orientarte sobre el certificado digital y el dispositivo que vas a utilizar. Cuéntame qué tienes disponible y te indicaré el siguiente paso aprobado para tu expediente.',
      requiresHumanReview: false,
    };
  }
  if (/expediente|reclamacion|empresa|datos|caso/.test(normalized)) {
    return {
      text: 'Estoy siguiendo la información de tu expediente en el despacho. Puedo aclararte el siguiente paso del apoderamiento; no envíes contraseñas, claves ni datos sensibles por este chat.',
      requiresHumanReview: false,
    };
  }
  if (/gracias|perfecto|vale|ok|de acuerdo/.test(normalized)) {
    return { text: 'De acuerdo. Cuando estés preparado, dime qué necesitas y continuamos paso a paso.', requiresHumanReview: false };
  }
  return { text: PROFESSIONAL_HANDOFF, requiresHumanReview: true };
}
