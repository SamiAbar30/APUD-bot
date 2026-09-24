import type { BotApodExpediente } from '@prisma/client';
import { EventType } from '../domain/fsm/states.js';
import { firstContactText, pendingConversationText } from './messages.js';
import { EventType as Events } from '../domain/fsm/states.js';
const OPTION_EVENT_HAS_CERT=Events.CLIENT_HAS_CERT;
import { officialLinks } from './guides.js';
import { outsideWorkflowTopic, outsideTopicReply, wroteAndWaits, sentUsSomething, WAITING_FOR_REPLY, RECEIVED_IT } from './topic-routing.js';
import { completeReply } from './compound-reply.js';
import type { ConversationBrain, BrainCase } from './conversation-brain.js';
import { CONVERSATION_INTENTS, CONVERSATION_INTENT_GUIDE, replyForIntent, type ConversationIntent } from './conversation-intent.js';
import { DIGITAL_GUIDANCE_STATES, conversationYield, declaredDocumentType, guidanceRequest, isConversationQuestion, reviewedConversationReply, type CaseContext } from './conversation-guidance.js';
import {
  allowedConversationOptions,
  classifyClientText,
  boundedConversationHistory,
  redactConversationPii,
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
    helpProgress?: {digitalAttempts:number;certificateAttempts:number};
    caseMemory?: string;
  }): Promise<unknown>;
  reply?(input: {
    phase: ConversationPhase;
    instruction: string;
    state: string;
    hasDigitalCert: boolean | null;
    text: string;
    history?: readonly ConversationHistoryMessage[];
    helpProgress?: {digitalAttempts:number;certificateAttempts:number};
    caseMemory?: string;
  }): Promise<unknown>;
  /** Reads meaning from the conversation and returns one approved intent label. */
  intent?(input: {
    phase: ConversationPhase;
    instruction: string;
    state: string;
    hasDigitalCert: boolean | null;
    text: string;
    history?: readonly ConversationHistoryMessage[];
    caseMemory?: string;
    intents: readonly string[];
    guide: Record<string, string>;
  }): Promise<unknown>;
}

/**
 * Runs the local bounded policy first. A model is optional: it may propose a
 * structured workflow option or a bounded support reply, and each result is
 * validated before the workflow or outbox can use it.
 */
export class StrictConversationAgent {
  /** Durable case memory for the current turn, set by the workflow before it calls the agent. */
  memory?: string;
  private readonly phase: ConversationPhase;

  constructor(private readonly model?: ConversationModel, phase: ConversationPhase = 3, private readonly brain?: ConversationBrain) {
    this.phase = ConversationPhaseSchema.parse(phase);
  }

  /** The brain reads a burst of messages together, whatever each one is about. */
  get readsWholeBursts(): boolean {
    return Boolean(this.brain) && this.phase === 3;
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
    expediente: CaseContext,
    text: string,
    history: readonly ConversationHistoryMessage[] = [],
    memory: string | undefined = this.memory,
  ): Promise<ConversationClassification> {
    const local = classifyClientText(expediente, text);
    const deviceEvidence=(choice:ConversationClassification):ConversationClassification=>{
      if(choice.kind!=='OPTION')return choice;
      const n=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      if(['COURT_APPOINTMENT','APUDATA_REQUEST'].includes(choice.optionId)&&!/^(?:juzgado|via presencial|apudata|gestion de pago|servicio de pago)[.!\s]*$|\b(?:quiero|prefiero|elijo|voy a|i want|i prefer|i choose)\b.*(?:juzgado|presencial|court|empresa|company|pago|pagar|apudata)/.test(n))return {kind:'HUMAN_REVIEW',reason:'UNSUPPORTED_TEXT'};
      if(!['DEVICE_PC','DEVICE_MOBILE'].includes(choice.optionId)||expediente.hasDigitalCert===true)return choice;
      // Owning a computer (including a relative's computer) is not proof of a certificate.
      if(!/\bsi\b|(?:tengo|dispongo|instalado|esta|esta instalado).{0,30}certificado|certificado.{0,40}(?:ordenador|pc|movil)|ya (?:lo )?tengo en/.test(n)||/\bno tengo\b/.test(n))return {kind:'HUMAN_REVIEW',reason:'UNSUPPORTED_TEXT'};
      // The device itself must be named. Otherwise "sí, tengo certificado" could be read as a
      // device answer and send a desktop client down the mobile branch (round 7 regression).
      const namesDevice=choice.optionId==='DEVICE_MOBILE'
        ?/\bmovil\b|\btelefono\b|\bmobil\b|\bapp\b|aplicacion|iphone|android/.test(n)
        :/\bordenador\b|\bpc\b|portatil|sobremesa|escritorio|computador/.test(n);
      if(!namesDevice)return {kind:'OPTION',optionId:'HAS_CERT_YES',eventType:OPTION_EVENT_HAS_CERT,confidence:'NORMALIZED'};
      return choice;
    };
    if (requiresDeterministicHandoff(text)) return local.kind === 'HUMAN_REVIEW' ? local : { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
    // A question about a route is not a request to take it, even if the model
    // or a keyword matcher finds "pagar", "juzgado", or "certificado".
    if (isConversationQuestion(text) || reviewedConversationReply(expediente, text)) return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
    // "You already sent me all that and I still cannot do it" is a request for a person, not a
    // workflow option: the triage question would send the client back to the start.
    if (/aparte de lo explicativo|me mandasteis todo|ya me lo (?:enviasteis|mandasteis)|no se como hacerlo/
      .test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()))
      return { kind: 'HUMAN_REVIEW', reason: 'UNSUPPORTED_TEXT' };
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
        ...(memory?{caseMemory:memory}:{}),
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
    expediente: CaseContext,
    text: string,
    history: readonly ConversationHistoryMessage[] = [],
    memory: string | undefined = this.memory,
  ): Promise<ConversationReply> {
    const rollout = this.classifyRollout(text);
    const local = classifyClientText(expediente, text);
    // An override attempt gets an explicit refusal; a generic handoff leaves the client guessing.
    if (local.kind === 'HUMAN_REVIEW' && local.reason === 'PROMPT_INJECTION') {
      return { text: INJECTION_REFUSAL, requiresHumanReview: true };
    }
    if (requiresDeterministicHandoff(text) || (local.kind === 'HUMAN_REVIEW' && local.reason === 'BUTTON_REQUIRED')) {
      return { text: PROFESSIONAL_HANDOFF, requiresHumanReview: true };
    }
    const reviewed = this.phase === 3 ? reviewedConversationReply(expediente, text) : null;
    if (reviewed) return reviewed;
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
          helpProgress:{digitalAttempts:expediente.digitalHelpAttempts??0,certificateAttempts:expediente.certificateHelpAttempts??0},
          ...(memory?{caseMemory:memory}:{}),
        });
        const validated = validateModelReply(proposed);
        if (validated) {
          if(validated.requiresHumanReview&&DIGITAL_GUIDANCE_STATES.has(expediente.currentState)&&!/\b(?:abogado|gestor|humano|persona|plazo legal|prescripcion|demanda|falleci|tutor|menor)\b/i.test(text)){
            return {text:pendingConversationText(expediente)??'Te ayudo a continuar. ¿En qué paso te has quedado?',requiresHumanReview:false};
          }
          // Only the FSM can offer alternatives after exhausting guided attempts.
          if(DIGITAL_GUIDANCE_STATES.has(expediente.currentState)&&/juzgado|decanato|empresa colaboradora|proveedor de pago/i.test(validated.text)){
            return {text:pendingConversationText(expediente)??'Vamos paso a paso con el apoderamiento. ¿En qué paso te has quedado?',requiresHumanReview:false};
          }
          return validated;
        }
      } catch {
        // A provider failure falls through to the reviewed local reply.
      }
    }

    const localReply=localSupportReply(text);
    if(!localReply.requiresHumanReview||/hablar con|humano|gestor|profesional/i.test(text))return localReply;
    const pending=pendingConversationText(expediente);
    return pending?{text:`Puedo ayudarte con el apoderamiento. ${pending}`,requiresHumanReview:false}:localReply;
  }

  /** Shared by the durable webhook worker and the real-provider evaluator. */
  async turn(expediente:CaseContext,text:string,history:readonly ConversationHistoryMessage[]=[],introduced=history.some(m=>m.role==='assistant'&&/LITIGIOS/i.test(m.content)&&/apoderamiento apud acta/i.test(m.content)),memory:string|undefined=this.memory):Promise<{type:EventType;payload:Record<string,unknown>}>{
    const guidanceDocumentType=declaredDocumentType(text)??history.filter(m=>m.role==='user').map(m=>declaredDocumentType(m.content)).filter(Boolean).at(-1);
    const result=await this.decideTurn(expediente,text,history,introduced,memory);
    return guidanceDocumentType?{...result,payload:{...result.payload,guidanceDocumentType}}:result;
  }

  /**
   * What the client means, read from the conversation. Only a confident label from the approved
   * list is accepted; anything else leaves the turn to the workflow rather than to a guess.
   */
  private async readIntent(
    expediente: CaseContext,
    text: string,
    history: readonly ConversationHistoryMessage[],
    memory: string | undefined,
  ): Promise<ConversationIntent | null> {
    if (!this.model?.intent) return null;
    try {
      const proposed = await this.model.intent({
        phase: this.phase,
        instruction: rolloutInstruction(this.phase),
        state: String(expediente.currentState),
        hasDigitalCert: expediente.hasDigitalCert,
        text,
        history: boundedConversationHistory(history),
        ...(memory ? { caseMemory: memory } : {}),
        intents: CONVERSATION_INTENTS,
        guide: CONVERSATION_INTENT_GUIDE,
      }) as { intent?: unknown; confidence?: unknown } | null;
      const label = typeof proposed?.intent === 'string' ? proposed.intent : '';
      const confident = proposed?.confidence !== 'LOW';
      return confident && (CONVERSATION_INTENTS as readonly string[]).includes(label) ? label as ConversationIntent : null;
    } catch {
      return null;
    }
  }

  private async decideTurn(expediente:CaseContext,text:string,history:readonly ConversationHistoryMessage[],introduced:boolean,memory:string|undefined=this.memory):Promise<{type:EventType;payload:Record<string,unknown>}>{
    const n=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    // The brain reads the conversation and decides. Only messages that must never depend on a
    // model stay below: a delivered secret, an injection attempt, a stop request, an offered code.
    // The branches below are also the fallback when the model cannot be reached.
    // A certificate check result: fixed wording, never through a model (certificate and password stay out).
    const checked=/^\[CERTIFICADO:([A-Z_]+)(?::(\d{4}-\d{2}-\d{2}))?\]$/.exec(text.trim());
    if(checked)return certificateReply(checked[1]!,checked[2],passwordWasRequested(expediente,history),history);
        // A stop word inside a question ("si lo dejo, ¿me cobráis algo?") is a question, not a stop request.
    const stopWithQuestion=/\?/.test(text)&&!requiresDeterministicHandoff(text.replace(/\b(?:stop|parar|cancelar|no me escribas|no quiero seguir)\b/gi,' '));
    if(this.brain&&this.phase===3&&(!requiresDeterministicHandoff(text)||stopWithQuestion)&&text!=='[CONTENIDO_SENSIBLE_OMITIDO]'&&!/\b(?:sms|codigo de (?:seguridad|verificacion)|pin bancario)\b/.test(n)){
      const decided=await this.brain.decide(expediente as BrainCase,text,history,memory);
      if(decided)return decided;
    }
    let reply:ConversationReply|undefined;
    const yielded=this.phase===3&&!requiresDeterministicHandoff(text)?conversationYield(text)??undefined:undefined;
    if(this.phase===3&&!requiresDeterministicHandoff(text)){
      const pending=pendingConversationText(expediente);
      if(this.classifyRollout(text).kind==='GREETING'){
        const isOpening=!introduced&&['INITIAL_TRIAGE','WAITING_CERT_RESPONSE'].includes(expediente.currentState)&&expediente.hasDigitalCert!==true;
        if(isOpening||pending)reply={text:isOpening?firstContactText():`Hola. ${pending}`,requiresHumanReview:false};
      }else if(pending&&(/^\s*[a-z]\s*$/i.test(text)||/^(?:i said yes|he dicho que si|ya te he dicho que si)[.!\s]*$/.test(n)&&expediente.currentState==='MOBILE_EXPORT_GUIDE_SENT')){
        reply={text:pending,requiresHumanReview:false};
      }
    }
    // Refusing to share the certificate is a routing decision, not a dead end (manager test 18 Sep):
    // it must reach the court / partner alternatives instead of repeating file-search instructions.
    if(/no (?:te |os )?(?:lo |la )?(?:quiero|voy a|pienso) (?:enviar|mandar|pasar|compartir|dar)|no (?:lo|la) (?:envio|mando|comparto|doy)|prefiero no (?:enviar|mandar|compartir|dar)|no me fio de (?:enviar|mandar|compartir)|no quiero (?:compartir|dar|enviar) (?:mi|el|la) (?:certificad\S*|contrase\S*|clave)|no pienso (?:enviarlo|darla|pasarla)|no te doy (?:mi|la) contrase/.test(n)
      &&/certificad|archivo|copia|contrase|clave|\bp12\b|\bpfx\b|lo\b/.test(n))
      return {type:EventType.CLIENT_CONSENT_DENIED,payload:{conversationOption:'CONSENT_NO',conversationConfidence:'NORMALIZED'}};
    // "No quiero hacerlo, te mando el certificado y lo haces tú" has to MOVE the case into the
    // assisted branch. Answering with text alone left the state untouched, so the next turn served
    // the tutorial again and the client repeated themselves four times (manager test 22 Sep).
    // Clients switch to English mid-thread, so both languages are matched here.
    if(/(?:te|os) (?:lo |la |el )?(?:env[ií]o|envio|mando|paso|doy)[^.!?]{0,40}(?:certificad|contrase)|(?:certificad|contrase)[^.!?]{0,40}(?:te|os) (?:lo |la )?(?:env[ií]o|mando|paso)|hazlo tu|lo haces tu|hacedlo vosotros|quiero que lo hagas tu|do it for me|you do it|take my certificad|i (?:will )?(?:send|give) (?:you )?(?:the |my )?certificad|i gave you (?:the |my )?certificad|send (?:you )?(?:the |my )?certificate/.test(n))
      return {type:EventType.CLIENT_REQUESTS_ASSISTANCE,payload:{conversationOption:'NEEDS_ASSISTANCE',conversationConfidence:'NORMALIZED',takeoverRequested:true}};
    // "Dejad de escribirme" must be honoured and acknowledged, never answered with a security notice.
    if(/\b(?:stop|parar|cancelar|baja)\b|no me escrib|dejad de escribir|dejen de escribir|no quiero seguir|no me interesa|borra(?:d|r) mis datos/.test(n))reply={text:'Entendido, dejo de escribirte sobre este trámite. Si más adelante quieres retomarlo, escríbenos por aquí y seguimos.',requiresHumanReview:true,handoffReason:'HUMANO'};
    if(/\b(?:sms|codigo de (?:seguridad|verificacion)|pin bancario)\b/.test(n)&&!requiresDeterministicHandoff(text))reply={text:'No me envíes códigos SMS, PIN ni claves bancarias. El PIN de tu DNI electrónico lo usas solo tú en tu equipo, nunca por aquí.',requiresHumanReview:false};
    if(!reply&&(requiresDeterministicHandoff(text)||text==='[CONTENIDO_SENSIBLE_OMITIDO]')){
      // Only a message that actually carries the secret counts as the handover. Merely saying the
      // word ("dime cuál es mi contraseña") must not close the case, or the bot goes silent on a
      // client who never sent anything.
      const deliveredSecret=/REDACTADA|CONTENIDO_SENSIBLE/i.test(text)||redactConversationPii(text)!==text;
      const asksUsForTheirs=/dime (?:cual es )?mi (?:contrase|clave)|cual es mi (?:contrase|clave)|no se mi (?:contrase|clave)|me (?:la |lo )?puedes decir/i.test(text);
      // A redacted value is only the certificate password if the office asked for it: otherwise it
      // is usually an SMS or FNMT code, and "recibido, lo gestionamos" would accept a code we never
      // use (training round 6).
      const passwordRequested=['MOBILE_ASSIST_CONSENT_REQUESTED','MOBILE_ASSIST_PROCESSING'].includes(String(expediente.currentState))
        ||history.filter(m=>m.role==='assistant').slice(-4).some(m=>/contrase[ñn]a/i.test(m.content)&&/(?:m[aá]nda|env[ií]a|pasa)(?:me|nos)|me (?:los|la|lo) mandas|mensaje aparte|en otro mensaje/i.test(m.content))
        ||history.filter(m=>m.role==='user').slice(-3).some(m=>/te (?:lo |la )?(?:mando|env[ií]o|paso)|certificad|\.p12|\.pfx|archivo/i.test(m.content));
      reply=deliveredSecret&&!asksUsForTheirs&&!passwordRequested
        ?{text:'Por seguridad, no me mandes códigos ni claves por aquí: no los necesito y no los uso. Si era la contraseña de tu certificado, solo hace falta si lo hacemos nosotros; dime y te explico cómo.',requiresHumanReview:false}
        :deliveredSecret&&!asksUsForTheirs
        // The client sent the certificate password: the office works with it, so acknowledge and
        // hand the case to a person instead of lecturing the client.
        ?{text:'Recibido, gracias. Lo gestionamos y te aviso en cuanto esté hecho.',requiresHumanReview:true,handoffReason:'CERTIFICADO_RECIBIDO'}
        :asksUsForTheirs
        ?{text:'Esa contraseña la pusiste tú al guardar el certificado, así que no la tenemos nosotros. Si no la recuerdas, se puede volver a solicitar el certificado; dime y te ayudo con eso.',requiresHumanReview:false}
        :{text:'No puedo compartir instrucciones internas ni datos de otros clientes. Un compañero del despacho revisa tu caso y continúa contigo por aquí con el apoderamiento apud acta.',requiresHumanReview:true,handoffReason:'HUMANO'};
    }
    if(!reply&&/falleci|fallecimiento|murio|se nos fue|su perdida|luto/.test(n))reply={text:'Siento mucho vuestra pérdida, de verdad. El trámite puede esperar lo que haga falta: se lo paso a una persona del despacho para que lo lleve contigo cuando estés.',requiresHumanReview:true,handoffReason:'HUMANO'};
    if(!reply&&/quiero hablar con|persona de verdad|humano|tutor legal|menor de edad/.test(n))reply={text:'Disculpa. Te paso con una persona del equipo para que te ayude.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // Checking we are who we say we are, or doubting there is a relationship at all: prove it with
    // the document they signed, not with reassurance.
    if(!reply&&/dos numeros distintos|no le encuentro en linkedin|no te encuentro en|quien es usted|quien eres|sois de verdad|como se que sois|no tengo relacion|no os conozco|no recuerdo haber firmado/.test(n))
      reply={text:'Te escribimos desde el despacho que lleva tu reclamación y nunca te pediremos dinero ni datos bancarios por aquí. Si no recuerdas la relación, el equipo te envía copia del contrato que firmaste con nosotros: llama al número de la oficina que ya tengas o dime y te llamamos.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // Asking for real help, not another explanation: the office takes it over (protocol 1.2).
    if(!reply&&/necesito (?:algo de )?ayuda|no se como hacerlo|no puedo hacerlo|aparte de lo explicativo|hacedlo vosotros|eso ya vosotros|no tengo acceso para/.test(n)&&!/me quereis cobrar|me cobran|me han cobrado|nos cobrais|factura|la deuda|me deben/.test(n))
      reply={text:takeoverOffer(expediente,'Claro, te lo hacemos nosotros.'),requiresHumanReview:true,handoffReason:'CERTIFICADO_RECIBIDO'};
    if(!reply&&/sigo pagando|puedo (?:seguir )?pagando|lo que (?:yo )?debo a|debo a \w+|dejo de pagar|sigo con los plazos|plazos acordados/.test(n))
      reply={text:'Sobre si te conviene seguir pagando esos plazos, no te lo puedo decir yo: te lo confirma el equipo que lleva tu reclamación y se lo paso ahora con lo que me cuentas.',requiresHumanReview:true,handoffReason:'PAGO'};
    if(!reply&&/a que cuenta|\biban\b(?!\s+a\b)|numero de cuenta|cuenta bancaria|transferencia/.test(n))reply={text:'Nunca damos datos bancarios por WhatsApp, así que desconfía de quien te los pida por aquí. Paso tu consulta a una persona del equipo y te escribe por este mismo chat; mientras tanto no hagas ningún pago.',requiresHumanReview:true,handoffReason:'PAGO'};
    // "¿Para qué sirve?" deserves the purpose, not another instruction.
    if(!reply&&/para que (?:te |me |le |nos |eso )?(?:sirve|vale|es)|que es (?:el |un |eso del )?(?:apoderamiento|apud)|por que (?:necesito|hace falta|tengo que)/.test(n))
      reply={text:'El apoderamiento apud acta es el permiso para que nuestros procuradores te representen ante el juzgado en tu reclamación. Es gratuito si lo haces tú en la Sede Judicial y sin él la reclamación no puede avanzar.',requiresHumanReview:false};
    // "No entiendo qué tengo que hacer": give the whole path in two steps, not one more question.
    if(!reply&&/no entiendo (?:entonces )?que tengo que hacer|que tengo que hacer (?:entonces|ahora)|no se que tengo que hacer|estoy perdid/.test(n))
      reply={text:expediente.hasDigitalCert===true
        ?'Son dos pasos: entras en la Sede Judicial con tu certificado desde un ordenador y firmas el apoderamiento; luego nos envías el PDF. Si prefieres, también puedes hacerlo en el juzgado.'
        :'Son dos pasos: primero consigues el certificado digital de la FNMT, con tu DNI electrónico o por vídeo identificación, y después firmas el apoderamiento en la Sede Judicial. Si lo prefieres, puedes firmarlo gratis en el juzgado pidiendo cita en el decanato.',requiresHumanReview:false};
    // Availability is an answer, not noise: acknowledge it without promising a time.
    if(!reply&&/estoy trabajando|trabajo de \d|de \d{1,2} a \d{1,2}|manana por la manana|por la tarde|a partir de las|cuando salga de trabajar|el fin de semana/.test(n))
      reply={text:`Perfecto, lo hacemos cuando te venga bien, no hay prisa. ${expediente.hasDigitalCert===true?'Cuando estés delante del ordenador entramos en la Sede Judicial y firmamos el apoderamiento.':'Cuando tengas un rato tranquilo seguimos con el certificado digital.'}`,requiresHumanReview:false};
    if(!reply&&/donde (?:te |le |la |lo |se )?(?:la |lo )?(?:envio|mando|paso|pongo|tengo que enviar|voy a enviar)|a donde (?:la |lo )?(?:envio|mando)|where do i send|donde os la mando/.test(n)&&/contrase|clave|certificad|password|archivo/.test(n))
      reply={text:'Aquí mismo, por este chat. Mándame el archivo del certificado y, en un mensaje aparte, su contraseña; con eso lo preparo yo.',requiresHumanReview:false};
    if(!reply&&/do i (?:have to|need to|should i)? ?send|shall i send|te lo (?:envio|mando|paso) (?:ahora|ya)|se lo (?:envio|mando)|lo envio ahora|i send it t+o? you/.test(n)&&!/no (?:lo )?tengo/.test(n))
      reply={text:'Sí, mándamelo ahora por aquí y la contraseña en otro mensaje. Con eso me encargo yo del apoderamiento.',requiresHumanReview:false};
    // Someone telling you about a death, an illness or a child is not asking for the next step.
    // The model answers these with the tutorial, so the office answers them here instead.
    if(!reply&&/me recuperare|lo estoy pasando|estoy fatal|estoy sol|no puedo mas|me han despedido|me voy a ver a mi hijo|desbastado|destrozad|mi hijo esta|mi madre esta|mi padre esta/.test(n)&&!/\?/.test(text))
      reply={text:'Siento mucho lo que me cuentas, y gracias por contármelo. Esto no corre ninguna prisa: cuando estés, seguimos, y si prefieres me mandas tu certificado con su contraseña y lo tramito yo sin que tengas que ocuparte.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // Health and vulnerability come before the workflow: never answer this with the next task.
    if(!reply&&/ansiedad|depresi|enferm|hospital|ingresad|baja medica|operacion|me encuentro mal|no estoy bien de salud/.test(n))
      reply={text:'Siento mucho que estés pasando por esto y lo primero es que te cuides; si te encuentras mal, llama al 112 o acude a tu médico. El trámite no tiene ninguna prisa: se lo paso a una persona del despacho para que lo lleve contigo con calma.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // The client wants to pay: the price is an approved fact, so answer it before anything else.
    if(!reply&&/quiero pagar|prefiero pagar|pagarlo|lo pago|como (?:lo )?pago|intentare pagar|voy a pagar|puedo pagar|quiero que lo gestion/.test(n)&&!/no puedo pagar|no puedo seguir pagando|no lo puedo pagar|sin intereses|decirles|a ellos|les voy a pagar|la deuda|el prestamo|la cuota|el acuerdo/.test(n))
      reply={text:'El apoderamiento es gratuito si lo firmas tú. Si prefieres que lo gestione la empresa colaboradora, son 35 € y te paso con una persona del despacho para darte de alta.',requiresHumanReview:true,handoffReason:'PAGO'};
    // Signing by e-mail is not possible here; say why and give the two routes that are.
    if(!reply&&/(?:envia|enviad|manda|mandad|pasa|pasad)(?:me|dme|nos)\b[^.!?]{0,30}(?:correo|email|mail|documento|papel)|te (?:lo )?firmo y (?:te )?(?:lo )?(?:envio|mando)|lo firmo y os lo/.test(n))
      reply={text:'El apoderamiento no se puede firmar por correo: se firma con certificado en la Sede Judicial o en persona en el juzgado, y ahí es gratuito. Si te viene mejor, pide cita en el decanato de tu juzgado y lo firmas allí.',requiresHumanReview:false};
    // The client says they already did it: acknowledge it, never ask for the same thing again.
    if(!reply&&/ya (?:os |te )?(?:lo |la )?(?:he )?(?:envie|enviado|mande|mandado|firme|firmado|hice|hecho|pedido)|acabo de (?:enviar|mandar|firmar)|ya lo tengo hecho/.test(n))
      reply={text:'Perfecto, si ya está hecho no lo repitas. Lo compruebo con el despacho y te confirmamos por aquí que ha llegado bien.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    // A phone number plus a request to call: arrange it and say the call will identify itself,
    // because the client just explained they do not answer unknown numbers.
    if(!reply&&/que (?:la|le|lo|me) llamen|que (?:la|le|lo|me) llamaran|que la llame|dire que la llam/.test(n))
      reply={text:'Apunto el teléfono y se lo paso al despacho para que la llamen. Les digo que se identifiquen como Litigios al llamar, así sabrá que la llamada es nuestra y no de un desconocido.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // They say it was already done with a colleague: check it instead of restarting the workflow.
    if(!reply&&/lo (?:habia|avia|hab[ií]a) (?:hecho|echo)|ya lo hice (?:por telefono|con)|con una companera|con un companero|por telefono con/.test(n))
      reply={text:'Perfecto, lo compruebo con el despacho y te confirmo por aquí si ya consta hecho. Si faltara algo, te lo digo y lo terminamos sin que tengas que repetir nada.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    // They tell us when it will be done: take note, do not repeat the instructions now.
    if(!reply&&/not now|not right now|later|in a bit|no puedo responder|no puedo atender|luego te contesto|ahora no puedo|ahora no|mas tarde|luego lo hago|manana (?:mismo|lo|la|te|os|se)|lo tiene manana|en cuanto (?:pueda|salga|llegue|termine)|por el trabajo|estoy en el trabajo|si no iria ahora/.test(n))
      reply={text:'Perfecto, sin prisa. Lo dejo apuntado y cuando lo tengas seguimos por aquí desde donde lo dejamos.',requiresHumanReview:false};
    // They received a letter from the lender and plan to ignore it: confirm who answers what.
    if(!reply&&/procedo a ignorar|los ignoro|les ignoro|no les contesto|no les hago caso/.test(n))
      reply={text:'A ellos no tienes que contestarles tú: reenvía ese correo a reclamaciones@litigios.es y el equipo se encarga. Lo que sí depende de ti es el apoderamiento, y en eso te guío yo.',requiresHumanReview:false};
    if(!reply&&/que me llam|\bq me llam|llameme|llamame|me pueden llamar|me puede llamar|puede llamarme|podria llamar|pueden llamarme|podeis llamar|cuando puedas llame|prefiero (?:que me llamen|una llamada)|necesito (?:hablar|contactar) con alguien|un telefono/.test(n))
      reply={text:'Claro, se lo paso a una persona del despacho para que te llame y lo veáis por teléfono. Si mientras tanto quieres adelantarlo por aquí, seguimos cuando te venga bien.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // The client reports what the court told them: confirm who does what instead of re-asking.
    if(!reply&&/me dijeron en el juzgado|en el juzgado me dijeron|me han dicho en el juzgado|el juzgado (?:me )?dice/.test(n))
      reply={text:'Entiendo lo que te dijeron. El apoderamiento tienes que firmarlo tú, con certificado en la Sede Judicial o en persona en el juzgado, y el documento que salga lo recibimos nosotros. Se lo paso a una persona del despacho para confirmarte cómo quedó tu caso.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // No time to go anywhere: give the two routes that need no trip, do not insist on the visit.
    if(!reply&&/no tengo tiempo (?:para|de) (?:ir|acudir|desplaz|pedir cita)|no puedo ir|prefiero que (?:lo |la )?(?:hagais|hagan|activen|gestioneis)|hacedlo vosotros|no puedo desplaz/.test(n))
      reply=/prefiero que (?:lo |la )?(?:hagais|hagan|activen|gestioneis)|hacedlo vosotros/.test(n)
        // They want us to do it: that is the office's own route, and it needs their certificate
        // file and its password.
        ?{text:expediente.hasDigitalCert===true
          ?'Claro, te lo hacemos nosotros. Envíame por aquí el archivo de tu certificado y, en otro mensaje, su contraseña, y lo preparo yo.'
          :'Claro, te lo hacemos nosotros en cuanto tengas el certificado: cuando lo tengas, me envías el archivo por aquí y la contraseña en otro mensaje. Si no quieres sacarlo, lo gestiona la empresa colaboradora por 35 €.',requiresHumanReview:true,handoffReason:'CERTIFICADO_RECIBIDO'}
        :{text:'Sin moverte de casa tienes dos salidas: la vídeo identificación de la FNMT para sacar el certificado, o que lo gestione la empresa colaboradora por 35 €. ¿Cuál prefieres?',requiresHumanReview:false};
    if(!reply&&sentUsSomething(text)&&!/ya se realizo|ya se ha presentado|esta presentada|se presento|\?/.test(n))reply={text:RECEIVED_IT,requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    if(!reply&&wroteAndWaits(text))reply={text:WAITING_FOR_REPLY,requiresHumanReview:true,handoffReason:'HUMANO'};
    // Lost the password of their own certificate: it cannot be recovered, so say so and move on.
    if(!reply&&/no me acuerdo de (?:la |cual)|no recuerdo la contrase|olvide la contrase|perdi la contrase|contrasena del certificado/.test(n))
      reply={text:'Esa contraseña la elegiste tú al instalar el certificado y no puede recuperarla nadie, tampoco nosotros: habría que solicitar el certificado otra vez. En cuanto lo tengas me lo mandas con su contraseña en otro mensaje y lo tramito yo, o si lo prefieres lo firmas gratis en el juzgado.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    if(!reply&&/trabajo negro|no trabajo con empresa|sin contrato|seguridad social|cl@ve|clave pin|clave permanente/.test(n)&&expediente.hasDigitalCert!==true)
      reply={text:'El certificado digital es personal y gratuito, no depende de tu trabajo ni de la Seguridad Social ni de Cl@ve. Se saca de dos formas: con el DNI electrónico y su PIN, o por vídeo identificación de la FNMT desde casa.',requiresHumanReview:false};
    if(!reply&&/como (?:te )?(?:lo |la )?firmo|como se firma|como lo hago|como se hace eso/.test(n))
      reply={text:expediente.hasDigitalCert===true
        ?'Desde el ordenador donde tengas el certificado, entras en la Sede Judicial, eliges el apoderamiento apud acta y firmas con el certificado. Si lo prefieres, mándame el archivo del certificado y, en otro mensaje, su contraseña, y lo hago yo por ti.'
        :'Primero el certificado digital: se saca en la FNMT con tu DNI electrónico o por vídeo identificación desde casa. Cuando lo tengas me lo mandas con su contraseña en otro mensaje y firmo yo el apoderamiento, o lo firmas tú gratis en el juzgado.',requiresHumanReview:false};
    const claimSide=/me quereis cobrar|me cobran|me han cobrado|no he pagado|factura|la deuda|intereses|reclamaci|fallo vuestro|expediente|demanda|impagad|se cumple el|explicar los correos|los correos|el correo/.test(n);
    if(!reply&&/no entiendo|no me aclaro/.test(n)&&!claimSide&&!/no se de que|que certificado|que es (?:un |el )?certificado/.test(n)&&expediente.hasDigitalCert===true&&!/copia|contrase/.test(n))
      reply={text:'Te lo simplifico: con tu certificado entras en la Sede Judicial desde el ordenador y firmas el apoderamiento; no hay que rellenar nada más. Si te atascas en algún punto, dime cuál y lo vemos.',requiresHumanReview:false};
    if(!reply&&/una hoja|en un papel|a mano|en blanco|lo firmo y ya/.test(n))
      reply={text:'En papel no vale: el apoderamiento apud acta se firma electrónicamente en la Sede Judicial con tu certificado, o en persona ante el juzgado con tu DNI. Dime cuál de las dos te viene mejor.',requiresHumanReview:false};
    if(!reply&&/en spam|en la carpeta de spam|no me llego|no me ha llegado|reenviame|me lo reenvia|volver a mandarme/.test(n))
      reply={text:'Sin problema, te lo volvemos a mandar. Desde aquí no puedo confirmarte si ese correo es nuestro: reenvíalo a reclamaciones@litigios.es y te lo confirman ellos.',requiresHumanReview:true,handoffReason:'FALTA_DATO'};
    if(!reply&&/cuanto (?:suele )?tarda|que suele tardar|cuanto se tarda|cuanto tiempo lleva/.test(n))
      reply={text:'Firmar el apoderamiento se hace en el momento, en cuanto tengas el certificado; lo que tarde el certificado depende de la FNMT. Los plazos de la reclamación te los confirma el equipo en reclamaciones@litigios.es.',requiresHumanReview:false};
    // Negotiating with the lender is never the client's job alone.
    if(!reply&&/puedo llamar a \w+|no podeis escribir vosotros|hablar con ellos|les digo que|negociar con ellos/.test(n))
      reply={text:'No negocies tú con ellos ni te comprometas a pagar nada por tu cuenta: eso lo lleva el equipo de reclamaciones. Cuéntaselo a reclamaciones@litigios.es y te dicen cómo responderles.',requiresHumanReview:true,handoffReason:'HUMANO'};
    const otherTopic=!reply?outsideWorkflowTopic(text):null;
    if(otherTopic)reply=outsideTopicReply(otherTopic,text);
    // They are willing but do not know how to get the file out: show the export, then the send.
    if(!reply&&/no se como (?:mandarte|enviarte|exportar|sacar|pasarte)|como te lo (?:mando|envio|paso)|como lo exporto|como saco (?:el|la|una) (?:certificado|copia)|donde esta el archivo|no se cual es el archivo/.test(n))
      reply={text:'Te explico cómo sacarlo: abre la aplicación donde instalaste el certificado, busca «exportar» o «copia de seguridad», te pedirá ponerle una contraseña al archivo y se guardará como .p12 o .pfx. Mándame ese archivo por aquí junto con la contraseña que le hayas puesto y yo hago el apoderamiento.',requiresHumanReview:false};
    const describesBlocker=/solo (?:me )?(?:aparece|sale)|no (?:me )?(?:deja|aparece|sale|funciona|carga|abre)|no tengo el codigo|no encuentro (?:la opcion|el boton|donde)|se (?:cierra|bloquea|queda)|me da error|sale (?:un )?error|no me lo permite/.test(n);
    // Protocol 1.2 / 2.2: the moment the client is stuck, the office offers to do it. This used to
    // wait for a previous help attempt, so most stuck clients never heard the offer at all.
    if(!reply&&describesBlocker&&!/otras? (?:dos )?(?:compan|empresa)|compania|prestamo|entrar en \w+$|autofirma|sede judicial|navegador|chrome|firefox|java/.test(n))
      // The offer goes out on the first hiccup, but one failed step is not yet a case for a
      // person: escalate only once we have already tried to help.
      reply=(expediente.digitalHelpAttempts??0)>=1||(expediente.certificateHelpAttempts??0)>=1
        ?{text:takeoverOffer(expediente,'Entiendo, ahí se ha atascado.'),requiresHumanReview:true,handoffReason:'FALTA_DATO'}
        :{text:takeoverOffer(expediente,'Entiendo, ahí se ha atascado.'),requiresHumanReview:false};
    // The message is about the claim, a charge or a letter: answer that, do not pivot to the
    // certificate. Measured on real messages, this was the largest single failure.
    // A frustrated client needs the office to take the next step, not another task.
    const asksToContinue=/ayuda|ayudame|terminar|acabar|finalizar|seguir|continuar|que hago|como sigo|que mas hay que hacer/.test(n);
    const frustrated=/estoy hart|llevo (?:meses|semanas|mucho tiempo)|nadie me (?:dice|contesta|responde)|es una verguenza|indignad/.test(n);
    const asksAboutMoney=/mi dinero|cuando (?:me )?(?:llega|pagan|paga|cobro|ingresan|devuelven)|cuanto falta para cobrar|cuando cobro|estado de mi reclamacion/.test(n);
    if(!reply&&!asksToContinue&&frustrated&&!asksAboutMoney)reply={text:'Siento mucho la espera y entiendo tu enfado. Aviso ahora al equipo que lleva tu reclamación para que revise tu caso y te escriba por aquí.',requiresHumanReview:true,handoffReason:'HUMANO'};
    // Money and timing belong to the claims team; the bot must not invent dates.
    if(!reply&&asksAboutMoney)reply={text:'Escribe a reclamaciones@litigios.es para consultar el estado de tu reclamación. Siento la espera; no tengo una fecha de cobro confirmada.',requiresHumanReview:false};
    // Asking whether we need the password: yes, it is what lets the office do the apoderamiento.
    if(!reply&&/(?:la |lo )?necesitas(?: tu)?\b|hace falta (?:mi |la |tu )?(?:contrase\S*|clave)|necesitas (?:mi |la )?(?:contrase\S*|clave)|quieres (?:mi |la )?(?:contrase\S*|clave)/.test(n)&&/contrase|clave|password/.test(n))reply={text:'Sí, necesito el archivo de tu certificado y su contraseña para hacer el apoderamiento por ti. Mándame el archivo por aquí y la contraseña en otro mensaje.',requiresHumanReview:false};
    // Identity questions deserve verifiable detail, not the pending workflow question.
    if(!reply&&/quien(?:es)? sois|qui[eé]n eres|de qu[eé] despacho|qu[eé] despacho|sois de verdad|como se que sois|quien me escribe|para quien trabajas/.test(n))reply={text:'Soy Dayana, la asistente virtual de LITIGIOS, el despacho de abogados que lleva tu reclamación. Puedes confirmar este mensaje con la oficina en reclamaciones@litigios.es antes de seguir.',requiresHumanReview:false};
    // The client offers to send the certificate: take it, and ask for the password with it.
    if(!reply&&/(?:te|os) lo (?:env[ií]o|mando|paso)|quieres que (?:te )?lo (?:env[ií]e|mande)|dices que te lo (?:env[ií]e|mande)|es (?:un )?documento personal|es personal/.test(n)&&expediente.hasDigitalCert===true)reply={text:'Sí, envíamelo por aquí y la contraseña en otro mensaje; me encargo yo del apoderamiento. Lo usamos solo para este trámite.',requiresHumanReview:false};
    // The client says the certificate app is not installed: stop telling them to open it.
    if(!reply&&/no tengo (?:la |esa )?(?:aplicacion|app)|sin (?:la )?(?:aplicacion|app)|no (?:me )?aparece (?:la )?(?:aplicacion|app)|no uso (?:esa )?(?:aplicacion|app)/.test(n)&&expediente.hasDigitalCert===true)reply={text:'Entendido, sin esa aplicación no podemos sacar la copia desde el móvil. Puedes hacer el apoderamiento gratis en el juzgado o lo tramita por ti la empresa colaboradora; ¿cuál prefieres?',requiresHumanReview:false};
    // "La primera" only means something next to the options we actually listed.
    const lastOffice=[...history].reverse().find(m=>m.role==='assistant')?.content??'';
    const ordinal=/\b(?:la |opcion |opción )?(primera|segunda|1|2)\b/.exec(n.replace(/\bla 1\b/,'la primera').replace(/\bla 2\b/,'la segunda'));
    if(!reply&&ordinal&&/creo que|prefiero|me quedo con|elijo|mejor/.test(n)){
      const first=/1\)/.test(lastOffice),second=/2\)/.test(lastOffice);
      if(first&&second){
        const wantsFirst=/primera|\b1\b/.test(ordinal[1]!);
        reply={text:wantsFirst
          ?'Dime solo si tienes DNI electrónico, su PIN y un lector o móvil compatible; no me envíes el PIN. Con el certificado podrás hacer después el apud acta gratis por tu cuenta en la Sede Judicial.'
          :`Perfecto, vía vídeo identificación. Abre ${officialLinks.fnmtVideo} y solicita el certificado desde casa; el coste lo indica la propia FNMT.`,requiresHumanReview:false};
      }else reply={text:'Aclárame qué significa «la primera»: ¿te refieres a que ya tienes certificado digital a tu nombre?',requiresHumanReview:false};
    }
    // The route is chosen first and only then does the client get that route's link.
    if(!reply&&/\bdnie\b|dni electronico|con el dni|lector/.test(n)&&['CERT_ACQUISITION_LINKS_SENT','WAITING_CERT_RESPONSE'].includes(expediente.currentState)&&expediente.hasDigitalCert!==true)reply={text:`Perfecto, vía DNI electrónico. Abre ${officialLinks.fnmtDnie} y sigue los pasos con tu lector o móvil compatible; necesitarás el PIN del DNI.`,requiresHumanReview:false};
    if(!reply&&/video ?identificacion|videoidentificacion|por video|desde casa/.test(n)&&['CERT_ACQUISITION_LINKS_SENT','WAITING_CERT_RESPONSE'].includes(expediente.currentState)&&expediente.hasDigitalCert!==true)reply={text:`Perfecto, vía vídeo identificación. Abre ${officialLinks.fnmtVideo} y solicita el certificado desde casa; el coste lo indica la propia FNMT.`,requiresHumanReview:false};
    // Having a DNI is not the same as having DNIe, a reader and a PIN: recommend the workable route.
    if(!reply&&/tengo (?:el )?dni|dni espanol|solo tengo dni|tengo documento espanol/.test(n)&&expediente.currentState==='CERT_ACQUISITION_LINKS_SENT')reply={text:'Con DNI hay dos vías: si tienes DNI electrónico con PIN y un lector o móvil compatible, esa es gratuita; si no los tienes, la vídeo identificación de la FNMT es lo más rápido, con su coste propio. ¿Cuál te encaja?',requiresHumanReview:false};
    // "I don't understand" needs a plain-words explanation, not the same question again.
    if(!reply&&/no entiendo|no lo entiendo|no me entero|no se que es|no tengo ni idea|que es (?:un |el )?certificado|no soy de ordenadores|soy mayor/.test(n)&&expediente.hasDigitalCert!==true||/no se de que (?:certificado|sertificado|me habla)|que certificado es|no se cual certificado/.test(n))reply={text:'El certificado digital es un archivo que te identifica por internet, como un DNI digital, y sirve para firmar el apoderamiento sin moverte. Se consigue gratis en la FNMT con el DNI electrónico o por vídeo identificación. ¿Recuerdas si tienes uno a tu nombre?',requiresHumanReview:false};
    // A relative may operate the computer, but the certificate must belong to the client.
    const relative=/\bmi (hij[oa]|niet[oa]|sobrin[oa]|marido|mujer|yerno|nuera|herman[oa]|vecin[oa])\b/.exec(n)?.[1];
    if(!reply&&relative&&expediente.hasDigitalCert!==true)reply={text:`Elige con tu ${relative}: por internet en la Sede Judicial con un certificado a tu nombre, o en el juzgado sin certificado. El apud acta es gratis si lo haces por tu cuenta y os guío paso a paso.`,requiresHumanReview:false};
    // "And if I cannot get it?" must be answered with the real alternatives, not a vague nudge.
    if(!reply&&/(?:y )?si no puedo (?:conseguir|obtener|sacar|hacer)|no puedo conseguir|no voy a poder|no se si podre|imposible conseguir/.test(n)&&['WAITING_CERT_RESPONSE','CERT_ACQUISITION_LINKS_SENT','FALLBACK_OPTIONS','INITIAL_TRIAGE'].includes(expediente.currentState))reply={text:'Si no consigues el certificado, no te quedas sin opciones: puedes otorgar el apoderamiento presencialmente en el juzgado, que es gratuito, o usar una empresa colaboradora de pago. ¿Te explico la vía del juzgado?',requiresHumanReview:false};
    // A client asking whether this is a scam needs an answer, not the pending workflow question.
    // Fear of a scam is answered with proof they can check, and with the way out: we do it for them.
    // When the same message already offers the certificate, name the step instead of reassuring again.
    if(!reply&&/estafa|timo|fraude|es seguro|es fiable|no me fio|me fio|scam|suplanta/.test(n))reply={text:/contrase|certificad/.test(n)
      ?`Tranquilo, y gracias por la confianza. Mándame el archivo del certificado y, en otro mensaje, su contraseña, y yo hago el apoderamiento; nunca te pediremos dinero ni datos bancarios por aquí.`
      :`Entiendo la duda: puedes confirmar este mensaje con la oficina por un contacto que ya conozcas. El apoderamiento por tu cuenta es gratuito en la Sede Judicial (${officialLinks.sede}) y nunca te pediremos datos bancarios ni dinero. Si lo prefieres, lo tramitamos nosotros y tú no tienes que hacer nada.`,requiresHumanReview:false};
    const copyLocated=/i (?:have|found|got) (?:it|the certificat\w*|my certificat\w*)|already have it|got it now|i(?:'| )?ll send it|i send it to you|i will send (?:it|you)|te lo (?:envio|mando|paso) ahora|voy a (?:enviartelo|mandartelo)|ya (?:lo |la )?(?:tengo|tenia|encontre|he encontrado|localice|he localizado)|lo tengo (?:localizado|descargado|guardado|aqui)|ya (?:esta|lo tengo) (?:descargado|localizado|guardado)|esta descargado|estaba en (?:mis |la |el )?(?:documentos|carpeta|descargas|archivos)|lo (?:encontre|he encontrado)|descargado en (?:mi|el) movil|i (?:have|found) (?:the file|the copy)/.test(n);
    if(!reply&&(expediente.certificateHelpAttempts??0)>0&&(copyLocated||expediente.certificateHelpAttempts===2&&/^(?:si|yes)[.!\s]*$/.test(n)))
      return {type:EventType.CLIENT_REQUESTS_ASSISTANCE,payload:{copyLocated:true}};
    if(!reply&&(expediente.certificateHelpAttempts??0)>0){
      if(/^(?:en (?:el |mi )?|on (?:my |the )?)?(?:movil|mobile|phone|ordenador|pc)[.!\s]*$/.test(n))return {type:EventType.CLIENT_REQUESTS_ASSISTANCE,payload:{helpTopic:/movil|mobile|phone/.test(n)?'COPY_MOBILE':'COPY_PC'}};
      if(/^(?:no|nope)[.!\s]*$/.test(n))return {type:EventType.CLIENT_EXPORT_FAILED,payload:{}};
    }
    if(!reply&&this.phase===3){
      const intent=await this.readIntent(expediente,text,history,memory);
      if(intent)reply=replyForIntent(intent,expediente)??undefined;
    }
    if(!reply)reply=yielded;
    if(!reply&&this.phase===3){const guidance=guidanceRequest(expediente,text);if(guidance)return guidance;}
    if(!reply&&this.phase===3)reply=reviewedConversationReply(expediente,text)??undefined;
    if(!reply){
      const choice=await this.classify(expediente,text,history,memory);
      if(choice.kind==='OPTION'){
        return {type:choice.eventType,payload:{conversationOption:choice.optionId,conversationConfidence:choice.confidence}};
      }else reply=await this.respond(expediente,text,history,memory);
    }
    const flatten=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9? ]/g,' ').replace(/\s+/g,' ').trim();
    const lastOfficeMessage=[...history].reverse().find(m=>m.role==='assistant')?.content;
    const previous=lastOfficeMessage?flatten(lastOfficeMessage):'';
    if(reply)reply={...reply,text:completeReply(text,reply.text,expediente.hasDigitalCert)};
    const candidate=reply?flatten(reply.text):'';
    const repeated=Boolean(previous&&candidate&&(previous===candidate||previous.includes(candidate)||candidate.includes(previous)));
    // "Vale" twice means the client is leaving it for later, not asking for alternatives. The
    // office answers the first one and then lets them go; anything else reads as nagging, and the
    // apology itself was being repeated too (live test 22 Sep).
    const bareAck=(value:string)=>/^(?:vale+|ok|okey|okay|de acuerdo|bien|entendido|perfecto|gracias|genial)[.! ]*$/
      .test(value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim());
    const previousClientTurn=[...history].reverse().find(m=>m.role==='user')?.content??'';
    const acknowledgedAlready=bareAck(text)&&bareAck(previousClientTurn);
    if(acknowledgedAlready)
      return {type:EventType.CLIENT_SMALL_TALK,payload:{responseId:'CONVERSATION_REPLY',rolloutPhase:this.phase,rolloutKind:'WORKFLOW_REQUEST',silent:true,requiresHumanReview:false}};
    if(reply&&repeated){
      reply={text:'Perdona la insistencia. Si no puedes seguir desde el móvil, podemos hacerlo de otra forma: presencialmente en el juzgado, que es gratis, o lo tramita por ti la empresa colaboradora. ¿Cuál prefieres?',requiresHumanReview:false};
    }
    return {type:EventType.CLIENT_SMALL_TALK,payload:{responseId:'CONVERSATION_REPLY',rolloutPhase:this.phase,rolloutKind:'WORKFLOW_REQUEST',responseText:reply!.text,requiresHumanReview:reply!.requiresHumanReview,...(reply!.requiresHumanReview?{handoffReason:reply!.handoffReason??'HUMANO',handoffMarker:`[[HANDOFF:${reply!.handoffReason??'HUMANO'}]]`}:{})}};
  }
}

/**
 * Protocol 1.2.1 / 2.2.1: when the client cannot finish it alone, the office does it and asks for
 * the certificate file, with the password in a separate message. One place writes this offer so
 * every stuck path says the same thing.
 */
function takeoverOffer(c:{hasDigitalCert:boolean|null},lead:string):string{
  return c.hasDigitalCert===true
    ? `${lead} No te pelees más: mándame por aquí el archivo de tu certificado y, en otro mensaje, su contraseña, y lo hago yo por ti.`
    : `${lead} En cuanto tengas el certificado, me mandas el archivo por aquí y la contraseña en otro mensaje, y lo hago yo. Si lo prefieres, puedes firmarlo gratis en el juzgado pidiendo cita en el decanato.`;
}

/** The office asked for the certificate and its password, or the client said they were sending it. */
function passwordWasRequested(expediente:CaseContext,history:readonly ConversationHistoryMessage[]):boolean{
  return ['MOBILE_ASSIST_CONSENT_REQUESTED','MOBILE_ASSIST_PROCESSING'].includes(String(expediente.currentState))
    ||history.filter(m=>m.role==='assistant').slice(-4).some(m=>/contrase[ñn]a/i.test(m.content)&&/(?:m[aá]nda|env[ií]a|pasa)(?:me|nos)|me (?:los|la|lo) mandas|mensaje aparte|en otro mensaje/i.test(m.content))
    ||history.filter(m=>m.role==='user').slice(-3).some(m=>/te (?:lo |la )?(?:mando|env[ií]o|paso)|certificad|\.p12|\.pfx|archivo|\[CERTIFICADO:/i.test(m.content));
}

/** What the client hears after the office checked their certificate and password. */
function certificateReply(check:string,validTo:string|undefined,requested:boolean,history:readonly ConversationHistoryMessage[]=[]):{type:EventType;payload:Record<string,unknown>}{
  const saidBefore=(fragment:string)=>history.filter(m=>m.role==='assistant').slice(-3).some(m=>m.content.includes(fragment));
  const say=(text:string,handoff?:string)=>({type:EventType.CLIENT_SMALL_TALK,payload:{responseId:'CONVERSATION_REPLY',rolloutPhase:3,rolloutKind:'WORKFLOW_REQUEST',responseText:text,requiresHumanReview:Boolean(handoff),certificateCheck:check,...(handoff?{handoffReason:handoff,handoffMarker:`[[HANDOFF:${handoff}]]`}:{})}});
  const date=validTo?validTo.split('-').reverse().join('/'):'';
  switch(check){
    case 'OK':return say('Recibido, gracias. He comprobado que el certificado se abre con esa contraseña y está a tu nombre. Lo gestionamos y te aviso en cuanto esté hecho.','CERTIFICADO_RECIBIDO');
    case 'WAITING_PASSWORD':return say('Recibido el archivo del certificado, gracias. Ahora mándame su contraseña en un mensaje aparte.');
    case 'WAITING_CERTIFICATE':return requested
      ?say('Gracias. Ahora mándame por aquí el archivo del certificado (suele terminar en .p12 o .pfx).')
      :say('Por seguridad, no me mandes códigos ni claves por aquí: no los necesito y no los uso. Si era la contraseña de tu certificado, solo hace falta si lo hacemos nosotros; dime y te explico cómo.');
    case 'PASSWORD_INVALID':return saidBefore('no abre el archivo del certificado')
      // Twice wrong: the useful next step is a new copy with a new password, not the same sentence.
      ?say('Sigue sin abrirse con esa contraseña. Tiene que ser la que pusiste al sacar la copia de seguridad en la app. Si no la recuerdas, saca una copia nueva con una contraseña nueva y me mandas las dos cosas otra vez.')
      :say('Esa contraseña no abre el archivo del certificado. Revísala (distingue mayúsculas y minúsculas) y mándamela otra vez en un mensaje aparte.');
    case 'EXPIRED':return say(`El certificado que me has mandado caducó${date?` el ${date}`:''}, así que ya no sirve para firmar. Hay que sacar uno nuevo; si quieres te explico cómo.`);
    case 'OTHER_PERSON':return say('Ese certificado no está a tu nombre, y el apoderamiento solo se puede firmar con uno tuyo. ¿Tienes alguno a tu nombre?');
    default:return say('No he podido usar ese archivo del certificado. Se lo paso a una compañera del equipo para que lo revise contigo.','FALTA_DATO');
  }
}

const INJECTION_REFUSAL = 'No puedo compartir instrucciones internas ni datos de otros clientes. Un compañero del despacho revisa tu caso y continúa contigo por aquí con el apoderamiento apud acta.';
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
