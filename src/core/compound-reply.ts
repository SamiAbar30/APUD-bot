/**
 * Real clients ask two things in one message: "what does it cost and how long until I get paid?",
 * "what is this for, and send it to me by e-mail". The deterministic branches answer whichever
 * intent matched first, which reads as ignoring the rest. This completes such a reply with one
 * short sentence for the part that went unanswered. It never invents a fact: each addition is
 * either an approved statement or a handover to the team that owns the question.
 */
const OFFICE_EMAIL='reclamaciones@litigios.es';
const normalize=(text:string)=>text.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

/** A time the client themselves proposed, echoed back so they know it was read. */
const WHEN=/\b(manana por la manana|manana por la tarde|manana|esta tarde|esta noche|el lunes|el martes|el miercoles|el jueves|el viernes|el sabado|el domingo|el fin de semana)\b/;
const SPOKEN:Record<string,string>={'manana por la manana':'mañana por la mañana','manana por la tarde':'mañana por la tarde',manana:'mañana','esta tarde':'esta tarde','esta noche':'esta noche','el lunes':'el lunes','el martes':'el martes','el miercoles':'el miércoles','el jueves':'el jueves','el viernes':'el viernes','el sabado':'el sábado','el domingo':'el domingo','el fin de semana':'el fin de semana'};

/** What the case is waiting for, so a reply that routes elsewhere still closes with our step. */
export function nextStepSentence(hasDigitalCert:boolean|null):string{
  if(hasDigitalCert===true)return 'Mientras tanto, cuando puedas seguimos con la firma del apoderamiento en la Sede Judicial.';
  if(hasDigitalCert===false)return 'Mientras tanto, cuando te venga bien seguimos con el certificado digital.';
  // An extra question here read as re-asking the triage question the client had already answered.
  return 'Mientras tanto seguimos con el apoderamiento cuando me digas, y si lo prefieres lo tramitamos nosotros por ti.';
}

/** Replies that must stay exactly as they are: stopping, health, and security notices. */
const CLOSED=/dejo de escribirte|llama al 112|no me envies|no debes compartirla|no puedo compartir instrucciones|que te llame|para que la llamen|siento mucho/;

/** The client is stuck or lost, which protocol 1.2 / 2.2 answers with the office taking over. */
const STUCK=/no entiendo|no lo entiendo|no se como|no se que hacer|no puedo|no me deja|no consigo|no me aclaro|me atasco|no se de que|ayudame|puedes ayudarme|no sabria/;
/** …unless the subject is the claim itself, where the certificate is not the answer. */
const CLAIM_SUBJECT=/asnef|reclamaci|deuda|intereses|pagar|pagado|cobro|cobrar|factura|expediente|demanda|contrato|importe/;

export function completeReply(clientText:string,replyText:string,hasDigitalCert?:boolean|null):string{
  const n=normalize(clientText);
  const r=normalize(replyText);
  const additions:string[]=[];
  // An explanation alone leaves a lost client where they were: close with the offer to do it.
  if(STUCK.test(n)&&!CLAIM_SUBJECT.test(n)&&hasDigitalCert!==undefined
    &&!/mandame|me lo mandas|lo hago yo|lo termino yo|te lo hacemos|archivo de tu certificado/.test(r)&&!CLOSED.test(r))
    additions.push(hasDigitalCert===true
      ?'Y si lo prefieres, mándame el archivo de tu certificado y, en otro mensaje, su contraseña, y lo hago yo por ti.'
      :'Y si lo prefieres, en cuanto tengas el certificado me lo mandas por aquí con la contraseña en otro mensaje y lo hago yo por ti.');
  // Asked how long the claim or the payment takes: no invented dates, the team owns that answer.
  if(/cuanto se tarda|cuanto tardan|cuando (?:me )?(?:llega|pagan|paga|cobro|ingresan)|que plazo|en cuanto tiempo/.test(n)
    &&!/plazo|tarda|reclamaciones@/.test(r))
    additions.push(`Los plazos del cobro los lleva el equipo de reclamaciones: escríbeles a ${OFFICE_EMAIL}.`);
  // Asked what it is for and got only the procedure.
  if(/para que (?:te |me |le |nos |eso )?(?:sirve|vale|es)|que es (?:eso|esto) de/.test(n)&&!/represent/.test(r))
    additions.push('Sirve para que nuestros procuradores puedan representarte ante el juzgado en tu reclamación.');
  // Proposed a time: confirm the one they named instead of answering "when you can".
  const when=n.match(WHEN)?.[1];
  if(when&&!r.includes(normalize(SPOKEN[when]??when)))
    additions.push(`Por mí ${SPOKEN[when]??when} perfecto: cuando te pongas, seguimos por aquí.`);
  // Asked us to send it so they can sign at home: say plainly that this one cannot work that way.
  if(/(?:envia|enviad|manda|mandad|pasa|pasad)(?:me|dme|nos)\b[^.!?]{0,30}(?:correo|email|mail|documento|papel)|te (?:lo )?firmo y (?:te )?(?:lo )?(?:envio|mando)/.test(n)
    &&!/no se puede firmar por correo/.test(r))
    additions.push('No se puede firmar por correo: se firma con certificado en la Sede Judicial o en persona en el juzgado.');
  if(/iban a demandar|van a demandar|me van a denunciar|recovery|cobradores|me amenaz/.test(n)&&!/comprometas/.test(r))
    additions.push('Y con ellos no te comprometas a nada: diles que tu reclamación la lleva este despacho.');
  // "How much is all of this" often means the claim, not only the apoderamiento.
  if(/todo esto|en total|en conjunto/.test(n)&&/cuanto (?:cuesta|vale|costaria)/.test(n)&&!/reclamaciones@/.test(r))
    additions.push('Si te refieres al coste de la reclamación en sí, te lo detalla el equipo en reclamaciones@litigios.es.');
  // Asked to be phoned on top of something else: confirm the call was heard.
  if(/que me llam|me pueden llamar|pueden llamarme|podeis llamar|llameme|llamame/.test(n)&&!/llame|telefono/.test(r))
    additions.push('Y pido a una persona del despacho que te llame para verlo contigo.');
  // Asked for news about their case while asking something else.
  if(/hay novedades|alguna novedad|como va (?:mi|el) (?:caso|expediente|reclamacion)/.test(n)&&!/reclamaciones@/.test(r))
    additions.push(`Las novedades de tu expediente te las confirma el equipo en ${OFFICE_EMAIL}.`);
  if(/que coste|cuanto (?:cuesta|vale|costaria)|coste tiene/.test(n)&&!/gratuit|35/.test(r))
    additions.push('Y el apoderamiento es gratuito si lo firmas tú; solo cuesta 35 € si lo gestiona la empresa colaboradora.');
  if(/puedo llamar a \w+|hablar con ellos|escribir vosotros/.test(n)&&!/negoci|con ellos/.test(r))
    additions.push('Y con ellos no negocies tú: cuéntaselo al equipo y te dicen cómo responderles.');
  // A reply that hands the subject to someone else still has to leave our own step visible,
  // otherwise the client is left correctly answered and with nothing to do.
  const defersOurStep=/primero quiero|despues (?:ya )?seguimos|luego seguimos|cuando (?:cobre|me paguen|reciba el dinero)|antes de nada quiero/.test(n);
  const routes=/reclamaciones@|lo traslado|se lo paso|te paso con|para que te llamen|que la llamen/.test(r);
  if(defersOurStep&&!/cuando quieras|sin prisa|no hay prisa/.test(r))
    additions.push('Y sin problema: primero eso y cuando tú digas seguimos con el apoderamiento.');
  if(routes&&!defersOurStep&&hasDigitalCert!==undefined&&!CLOSED.test(r)&&!/certificado|sede judicial|juzgado|firmar|apoderamiento/.test(r)&&!additions.length)
    additions.push(nextStepSentence(hasDigitalCert));
  // Someone telling you about their illness, their job or their family is not asking for a step.
  // Answer the person first; the instruction that follows then reads as help, not as deafness.
  const opensUp=/me recuperare|lo estoy pasando|estoy fatal|estoy sol|no puedo mas|me han despedido|sin trabajo|me voy a ver|mi madre|mi padre|mi hijo|estoy enferm|operacion|me da verguenza/.test(n);
  const prefix=opensUp&&!/siento|entiendo|animo|cuidate|gracias por contarm/.test(r)
    ?'Entiendo, y gracias por contármelo; no hay ninguna prisa con esto. ':'';
  if(!additions.length&&!prefix)return replyText;
  return prefix+[replyText.trim(),...additions.slice(0,2)].join(' ');
}
