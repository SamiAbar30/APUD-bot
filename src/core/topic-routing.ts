/**
 * Which conversation is the client actually having?
 *
 * Measured on real client messages: most "money" turns are about the claim (when will I be paid,
 * what does the lender charge me), and most "confusion" turns are about e-mails and invoices. The
 * bot used to pivot every one of them back to the certificate, which is why those categories scored
 * worst. A message outside the apoderamiento gets acknowledged and routed to the people who own it.
 */
export type OutsideTopic='CLAIM_STATUS'|'CHARGES'|'COMMUNICATIONS'|'OTHER_COMPANY'|'DOCUMENTS'|'CLAIM_SCOPE'|'CLAIM_DETAIL';

const OFFICE_EMAIL='reclamaciones@litigios.es';
export const RECEIVED_IT='Gracias, lo recojo y se lo paso al equipo que lleva tu reclamación para que confirme que ha llegado bien.';

/** Told us they have already sent something: acknowledge it instead of asking for it again. */
export function sentUsSomething(text:string):boolean{
  const n=normalizeFor(text);
  return /te he dejado|os he (?:mandado|enviado|pasado)|he pasado (?:todos )?(?:los|las)|ya os (?:mande|envie)|la captura|el justificante|los archivos de|adjunto/.test(n)&&!/no (?:os |te )?(?:he|lo)/.test(n);
}

export const WAITING_FOR_REPLY='Ya veo que escribiste y todavía no te han contestado; no hace falta que lo repitas. Lo traslado al equipo que lleva tu reclamación para que te respondan por aquí.';

/** Told us they already wrote and are still waiting: repeating the address is the complaint itself. */
export function wroteAndWaits(text:string):boolean{
  const n=normalizeFor(text);
  return /(?:ya )?(?:os |les |te )?(?:he )?(?:escrito|escribi|envie el email|envie el correo|mande el email|mande el correo|envie un correo|solicite informacion|pedi informacion|la solicitud que les hice|llevo (?:mas de )?\w+ (?:dias|semanas|meses))/.test(n)
    &&/nadie|todavia|aun no|sin respuesta|no me han|no me contest|no he recibido|que me respondan|necesito (?:por favor )?que/.test(n)
    ||/nadie me ha (?:contactado|llamado|escrito|dicho nada)/.test(n);
}

const normalizeFor=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const SUBJECTS:Array<[RegExp,string]>=[
  [/asnef/,'lo de ASNEF'],[/intereses/,'los intereses'],[/demanda|denunci/,'la demanda'],
  [/importe|cuanto|cantidad/,'el importe'],[/plazos?|cuota/,'los plazos'],[/factura/,'la factura'],
  [/contrato/,'el contrato'],[/porcentaje|honorarios/,'el porcentaje'],[/(?:los|el|un|mis|unos) acuerdos?\b/,'los acuerdos'],
];
/** The thing they actually asked about, for an opening that shows it was read. */
export function subjectOf(n:string):string|null{return SUBJECTS.find(([test])=>test.test(n))?.[1]??null;}

const normalize=(text:string)=>text.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

/** Wording that means the client is asking about this procedure, which keeps the workflow answer. */
const ABOUT_WORKFLOW=/apoderamiento|apud|\bacta\b|poder notarial|certificado|firm(?:ar|arlo|arla|o|a|e|amos)\b|autofirma|sede judicial|cita|ayuntamiento|fnmt|dnie|decanato|(?:hacerlo|hacerla|ir|acudir|voy)[^.!?]{0,20}juzgado/;

const ASKS_US_TO_SEND=/envia(?:me|dme)|mandame|manda(?:d)?me|pasame/;

const TOPICS:Array<{topic:OutsideTopic;test:RegExp}>=[
  // Their money: when it arrives, how much they will get, a transfer they are waiting for.
  {topic:'CLAIM_STATUS',test:/cuando (?:me )?(?:llega|pagan|paga|ingresan|transfieren|devuelven|cobro)|recibir el dinero|mi dinero|cobrar lo de|indemnizacion|cuanto (?:me )?(?:dan|toca|devuelven)|estado de (?:mi|la) (?:reclamacion|demanda)|se tarda en (?:reclamar|cobrar|recibir)|resumen de (?:las )?actuaciones|estado del expediente|ya se realizo la reclamacion|ya se ha presentado|esta presentada|se presento la demanda|me deben|que me transfieran|sigo sin (?:cobrar|recibir)|no he recibido (?:respuesta|nada|el dinero)|hay novedades|alguna novedad|las companias (?:con|me) respond|se han efectuado los pagos|como va (?:mi|el) (?:caso|expediente)/},
  // Money they are being asked for: invoices, fees, debts, "you want to charge me more".
  {topic:'CHARGES',test:/me (?:quereis |quieren |van a )?cobrar|que me cobr|me reclaman|factura|recibo|deuda|me dicen que les debo|tengo que pagarles|me han cobrado|cuanto cuesta todo|cuanto costaria todo/},
  {topic:'CLAIM_SCOPE',test:/llevais (?:la|mi|vosotros)|os encargais|sois (?:los|las) que llev|gestionais (?:la|mi)|intereses abusivos|puedo reclamar|se puede reclamar|revisar (?:mi|el) contrato|copia de los contratos|mandar(?:le)? (?:los|las) contratos|cuanto seria el total|el total del dinero|tengo dos contratos|trabajais (?:solo )?con|solo trabajais|tambien (?:con )?prestamos|que tipo de (?:casos|reclamaciones)/},
  // Letters and e-mails they received and do not understand.
  {topic:'COMMUNICATIONS',test:/(?:explicar|entiendo|entender|recibido|llegado|mandado|enviado)[^.!?]{0,40}\b(?:correo|correos|email|e-mail|mail|carta|burofax|notificacion)\b|\b(?:correo|correos|email|mail|carta|burofax)\b[^.!?]{0,40}(?:no entiendo|que significa|de que (?:se )?trata)/},
  // Pressure from the lender or a collections firm.
  {topic:'DOCUMENTS',test:/no puedo conseguir el de|no consigo el de|no me lo dan|no (?:lo )?encuentro el contrato|no tengo el contrato|el contrato no|me piden (?:el )?contrato|no encuentro (?:los |el )?(?:documento|papeles|contrato)/},
  {topic:'CLAIM_DETAIL',test:/asnef|demanda|denunci|prestamo|credito|tarjeta|revolving|interes(?:es)?|deuda|cuota|ingres(?:an|ais|o)|abonar|abono|importe|cuanto (?:dinero |me )?(?:se )?reclam|me reclaman|me reclama\b|quien me reclama|como (?:lo )?(?:pago|abono)|(?:los|el|un|mis|unos) acuerdos?\b|porcentaje|honorarios|salgo de|disposicion judicial|no puedo (?:seguir )?pagar|no he pagado|se cumple el dia|escribir vosotros|llamar a \w+ y decir/},
  {topic:'OTHER_COMPANY',test:/no me deja entrar|no puedo entrar en|otra(?:s)? (?:dos )?(?:compan|empresa)|recovery|cobradores|no paran de (?:llamar|acosar)|me acosan|me llaman (?:todos los dias|constantemente)|van a demandar|me amenazan|me (?:han )?llam(?:aron|ado|o) (?:de|del)\b|otro despacho|despacho juridico/},
];

/** Returns the topic only when the message is clearly not about the apoderamiento itself. */
export function outsideWorkflowTopic(text:string):OutsideTopic|null{
  const n=normalize(text);
  if(ABOUT_WORKFLOW.test(n))return null;
  if(ASKS_US_TO_SEND.test(n))return null;
  return TOPICS.find(({test})=>test.test(n))?.topic??null;
}

/**
 * Acknowledge the real subject and hand it to the people who own it. No pressure back onto the
 * procedure: a client asking about their money is not refusing to sign anything.
 */
export function outsideTopicReply(topic:OutsideTopic,text=''):{text:string;requiresHumanReview:boolean;handoffReason?:string}{
  const n=normalize(text);
  const asksCost=/cuanto (?:cuesta|vale|costaria)|que coste|precio|honorarios|cuanto (?:me )?cobrais/.test(n);
  // The firm's approved facts: doing it yourself is free, the managed route is optional at 35 EUR.
  if(asksCost)return {text:'El apoderamiento es gratuito si lo firmas tú, en la Sede Judicial o en el juzgado. Solo tiene coste si prefieres que lo gestione la empresa colaboradora, que son 35 €.',requiresHumanReview:false};
  if(wroteAndWaits(text))return {text:WAITING_FOR_REPLY,requiresHumanReview:true,handoffReason:'HUMANO'};
  const gaveDate=/\b\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(n);
  const alreadySent=/ya (?:os |te |les )?(?:lo |la )?(?:he )?(?:envie|envié|enviado|mande|mandado|pase|pasado|pague|pagado)|acabo de (?:enviar|volver a enviar|mandar|pagar)/.test(n);
  switch(topic){
    case 'CLAIM_STATUS':
      // Clients often ask the cost and the timing in one breath; answer both, invent no dates.
      return {text:asksCost
        ? `El apoderamiento es gratuito si lo haces por tu cuenta. Los plazos y el cobro los lleva el equipo de reclamaciones: escríbeles a ${OFFICE_EMAIL}.`
        : `El estado de tu reclamación y los plazos los lleva el equipo de reclamaciones. Escríbeles a ${OFFICE_EMAIL} y te confirman cómo va.`,requiresHumanReview:false};
    case 'CHARGES':
      if(/facturacion/.test(n))return {text:`Para facturación escribe también a ${OFFICE_EMAIL} indicando que es para facturación, y lo dirigen a quien lo lleva.`,requiresHumanReview:false};
      // When the client says they already sent it, saying "send it" again is what makes them angry.
      return {text:alreadySent
        ? (gaveDate
          ? `Entiendo, y con la fecha que me das es suficiente: no lo repitas. Lo traslado al equipo de reclamaciones para que revisen por qué les consta pendiente y te responden por aquí.`
          : `Entiendo, y si ya lo enviaste o ya lo pagaste no tienes que repetirlo. Pásame la fecha o el justificante y lo traslado al equipo de reclamaciones para que revisen por qué les consta pendiente.`)
        : `Entiendo, y eso hay que revisarlo con el equipo que lleva tu reclamación. Escríbeles a ${OFFICE_EMAIL} con lo que te han pedido y lo comprueban.`,requiresHumanReview:true,handoffReason:'PAGO'};
    case 'COMMUNICATIONS':
      return {text:`Para que te expliquen bien esa comunicación, reenvíala a ${OFFICE_EMAIL} y el equipo te dice qué significa.`,requiresHumanReview:false};
    case 'CLAIM_SCOPE':
      // Sending contracts and asking what they are owed is the claims team's work, and it is
      // useful to say where the documents go instead of only naming a department.
      return {text:/contrato|reclamar|intereses|total/.test(n)
        ? `Eso lo revisa el equipo de reclamaciones: envíales los contratos a ${OFFICE_EMAIL} y te dicen qué se puede reclamar y por cuánto.`
        : `Para confirmarte si tu caso entra, lo mejor es que el equipo vea el contrato: mándaselo a ${OFFICE_EMAIL} y te lo dicen enseguida.`,requiresHumanReview:false};
    case 'CLAIM_DETAIL':
      // Amounts deserve the reason we will not guess; everything else just needs the right desk.
      {
        const about=subjectOf(n);
        return {text:/cuanto|importe|cantidad|porcentaje|honorarios/.test(n)
          ? `Sobre ${about??'eso'}, no quiero darte una cifra que no sea exacta: lo lleva el equipo de reclamaciones. Escríbeles a ${OFFICE_EMAIL} con tu caso y te lo detallan.`
          : `Sobre ${about??'eso'}, quien tiene tu expediente delante es el equipo de reclamaciones. Escríbeles a ${OFFICE_EMAIL} y te lo explican.`,requiresHumanReview:false};
      }
    case 'DOCUMENTS':
      return {text:`No te preocupes, no hace falta que lo busques tú solo. Escribe a ${OFFICE_EMAIL} contándoles qué documento te falta y lo revisan contigo.`,requiresHumanReview:false};
    case 'OTHER_COMPANY':
      return {text:'No te comprometas a nada con ellos ni hagas ningún pago: diles que tu reclamación la lleva este despacho y que se dirijan a nosotros. Lo traslado al equipo para que te confirme cómo actuar.',requiresHumanReview:true,handoffReason:'HUMANO'};
  }
}
