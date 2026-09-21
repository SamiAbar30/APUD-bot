1. **File:** `src/core/conversation-agent.ts:151`.
   **Exact string:** `Para orientarte necesito aclarar tu respuesta. ${pending}`
   **Defect:** Facts: none in the literal prefix; `${pending}` is defined outside the three audited files, so its facts cannot be certified here. Throughout this audit, “unapproved” means absent from the user's exhaustive allowance, not proven false; Spanish negation and object pronouns before an action verb count as a verb-led opening. Promises: none in the prefix. Tone: starts with a purpose clause, not the main verb; appending an unrestricted pending reply can exceed two short sentences plus one question. Regex: this branch depends on the external classifier's `AMBIGUOUS_TEXT`; no local regex establishes its scope.
   **Corrected Spanish string:** `Aclárame tu respuesta. ¿Qué opción quieres elegir?`

2. **File:** `src/core/conversation-agent.ts:174`.
   **Exact string:** `Te ayudo a continuar. ¿En qué paso te has quedado?`
   **Defect:** Facts: none beyond ordinary conversational assistance. Promises: no date, legal outcome, appointment or completed escalation. Tone: compliant action opening, one short sentence and one question, no emojis. Regex: the negative guard at line 173 checks isolated words such as `persona`, `gestor` and `demanda`, not an actual request for human help; their absence can replace a legitimate review response with this continuation prompt. This is a conditional fallback when `${pending}` is unavailable, not an unconditional reply.
   **Corrected Spanish string:** `Indica dónde necesitas ayuda. ¿En qué paso te has quedado?`

3. **File:** `src/core/conversation-agent.ts:178`.
   **Exact string:** `Vamos paso a paso con el apoderamiento. ¿En qué paso te has quedado?`
   **Defect:** Facts: none outside the allowance. Promises: none of the prohibited kinds. Tone: compliant verb opening, one short sentence and one question, no emojis. Regex: `/juzgado|decanato|empresa colaboradora|proveedor de pago/i` examines the model reply rather than client intent and matches even a negated or quoted mention; it can replace an answer that merely mentions the court with this unrelated troubleshooting prompt. The digital-state guard limits when this happens but does not disambiguate the mention.
   **Corrected Spanish string:** `Indica qué necesitas sobre el apoderamiento. ¿En qué paso te has quedado?`

4. **File:** `src/core/conversation-agent.ts:190`.
   **Exact string:** `Puedo ayudarte con el apoderamiento. ${pending}`
   **Defect:** Facts: no unsupported fact in the prefix; imported `${pending}` is outside scope. Promises: none in the prefix. Tone: verb opening and no emojis, but no bound on the combined sentence or question count. Regex: `/hablar con|humano|gestor|profesional/i` at line 188 changes whether this fallback runs without checking that those words request assistance; a description of somebody's profession can change the response.
   **Corrected Spanish string:** `Indica qué necesitas sobre el apoderamiento. ¿En qué paso estás?`

5. **File:** `src/core/conversation-agent.ts:208`.
   **Exact string:** `Hola. ${pending}`
   **Defect:** Facts and promises: none in `Hola`; imported pending content is outside scope. Tone: greeting filler precedes the verb and adds a sentence without a combined length check. Regex: greeting classification is external; the adjacent `/^\s*[a-z]\s*$/i` also returns a pending reply for any single ASCII letter, not just a confirmed option, and its first alternative is not restricted to `MOBILE_EXPORT_GUIDE_SENT`.
   **Corrected Spanish string:** `Dime qué necesitas sobre el apoderamiento.`

6. **File:** `src/core/conversation-agent.ts:219`.
   **Exact string:** `Entendido, dejo de escribirte sobre este trámite. Si más adelante quieres retomarlo, escríbenos por aquí y seguimos.`
   **Defect:** Facts: claims messaging has stopped; this branch only constructs a reply and a human-review flag. Promises: commits to stopping and later resuming contact, without resulting-state evidence in scope. Tone: `Entendido` is filler before the action; otherwise two sentences, no emoji or question. Regex: bare `baja`, `parar` and `cancelar` match unrelated medical leave, stopping an error or cancelling an appointment; `no quiero seguir` can mean only the current certificate route. The later SMS branch can also overwrite this acknowledgement.
   **Corrected Spanish string:** `Indica si quieres dejar de recibir mensajes sobre este trámite.`

7. **File:** `src/core/conversation-agent.ts:220`.
   **Exact string:** `No me envíes códigos SMS, PIN ni claves bancarias. Para el apoderamiento no necesito esos códigos.`
   **Defect:** Facts: refusing receipt is approved, but “no necesito esos códigos” can blur not sharing a PIN with the approved need to use one's own DNIe PIN. Promises: none. Tone: compliant negative imperative, two short sentences, no emojis. Regex: any occurrence of `sms`, `codigo de seguridad`, `codigo de verificacion` or `pin bancario` triggers the warning, even a notification-delivery question; no disclosure/request intent is required, and this branch does not require `!reply`.
   **Corrected Spanish string:** `No envíes contraseñas, datos bancarios ni códigos SMS. Usa el PIN del DNIe solo tú, sin compartirlo.`

8. **File:** `src/core/conversation-agent.ts:224`.
   **Exact string:** `No necesito tu contraseña y no debes compartirla por WhatsApp, tampoco con nosotros. Paso tu caso a una persona del despacho para seguir por el canal seguro.`
   **Defect:** Facts: the existence and security of another channel are not approved facts. Promises: `Paso tu caso` presents escalation as happening; continuation through a secure channel is promised, while the code only requests human review. Tone: action opening and two sentences, but unnecessarily long. Regex: `/contrase|password|clave|CONTENIDO_SENSIBLE/i` selects this wording inside the external handoff gate and treats any `clave` mention, or even the generic redaction marker, as a password disclosure.
   **Corrected Spanish string:** `No compartas contraseñas, datos bancarios ni códigos SMS. Consulta con el despacho cómo continuar.`

9. **File:** `src/core/conversation-agent.ts:225,355` (`INJECTION_REFUSAL`, also returned at line 142).
   **Exact string:** `No puedo compartir instrucciones internas ni datos de otros clientes. Un compañero del despacho revisa tu caso y continúa contigo por aquí con el apoderamiento apud acta.`
   **Defect:** Facts: the internal-information policy and assigned colleague/channel are outside the supplied factual allowance. Promises: claims a colleague is reviewing and will continue in this chat; a human-review flag does not establish either. Tone: action opening, two sentences and no emojis; the second is long. Regex: handoff and injection detection are imported and not audited; locally, the negative result of the broad `sharedSecret` regex chooses this wording without establishing an actual internal-information request.
   **Corrected Spanish string:** `Consulta con el despacho cómo continuar con el apoderamiento. No envíes contraseñas, datos bancarios ni códigos SMS.`

10. **File:** `src/core/conversation-agent.ts:227`.
    **Exact string:** `Disculpa. Te paso con una persona del equipo para que te ayude.`
    **Defect:** Facts: a live transfer to a person is not established. Promises: `Te paso` implies completed or immediate escalation. Tone: verb opening, two short sentences and no emojis; `Disculpa` adds an unnecessary apology. Regex: `/quiero hablar con|persona de verdad|humano|falleci|tutor legal|menor de edad/` does not require a request for a staff member; `quiero hablar con` accepts any interlocutor and `falleci` can match a general account of bereavement.
    **Corrected Spanish string:** `Consulta con el despacho si necesitas atención de una persona.`

11. **File:** `src/core/conversation-agent.ts:230`.
    **Exact string:** `Nunca damos datos bancarios por WhatsApp, así que desconfía de quien te los pida por aquí. Paso tu consulta a una persona del equipo y te escribe por este mismo chat; mientras tanto no hagas ningún pago.`
    **Defect:** Facts: never supplying bank details is different from the approved prohibition on asking for them; channel policy, suspicion of others and blanket advice not to pay are unapproved. Promises: immediate escalation and a reply in this chat. Tone: adverb opening and two long, compound sentences. Regex: bare `transferencia` and `factura` treat ordinary payment-status or invoice questions as banking-security incidents; the IBAN exception only excludes `iban a`, not other unrelated text.
    **Corrected Spanish string:** `No envíes datos bancarios, contraseñas ni códigos SMS. Consulta cualquier duda sobre pagos con el despacho.`

12. **File:** `src/core/conversation-agent.ts:233`.
    **Exact string:** `El apoderamiento apud acta es el permiso para que nuestros procuradores te representen ante el juzgado en tu reclamación. Es gratuito si lo haces tú en la Sede Judicial y sin él la reclamación no puede avanzar.`
    **Defect:** Facts: the definition, the firm's procuradores and the assertion that the claim cannot advance are not approved. Promises: categorical legal-progress consequence, though no date or successful outcome is promised. Tone: noun opening and two long sentences. Regex: `/para que ... (?:sirve|vale|es)|...|por que (?:necesito|hace falta|tengo que)/` lacks a required apoderamiento subject for most alternatives; it can answer a question about an unrelated document or requirement.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. Consulta su alcance jurídico con el despacho.`

13. **File:** `src/core/conversation-agent.ts:237` (`hasDigitalCert === true`).
    **Exact string:** `Son dos pasos: entras en la Sede Judicial con tu certificado desde un ordenador y firmas el apoderamiento; luego nos envías el PDF. Si prefieres, también puedes hacerlo en el juzgado.`
    **Defect:** Facts: compulsory desktop/certificate use for signing, an exactly two-step process and sending a PDF to the firm are outside the allowance. Promises: no date, appointment, outcome or completed escalation. Tone: starts with a verb, but the first sentence is long and bundles several tasks. Regex: `/no entiendo ... que tengo que hacer|que tengo que hacer ...|no se que tengo que hacer|estoy perdid/` has no procedure subject and can misread unrelated confusion or being physically lost.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. ¿Qué vía prefieres?`

14. **File:** `src/core/conversation-agent.ts:238` (`hasDigitalCert !== true`).
    **Exact string:** `Son dos pasos: primero consigues el certificado digital de la FNMT, con tu DNI electrónico o por vídeo identificación, y después firmas el apoderamiento en la Sede Judicial. Si lo prefieres, puedes firmarlo gratis en el juzgado pidiendo cita en el decanato.`
    **Defect:** Facts: an exactly two-step certificate-before-signing process and the decanato appointment requirement are unapproved; DNIe guidance omits its PIN, and the universal route omits the approved NIE/Ayuntamiento distinction. Promises: recommends an appointment procedure, but does not claim an appointment is booked. Tone: verb opening, two sentences, first excessively long. Regex: the same unscoped confusion trigger as line 237.
    **Corrected Spanish string:** `Solicita el certificado FNMT con DNIe y PIN o por vídeo identificación. ¿Tienes NIE para indicarte la vía del Ayuntamiento?`

15. **File:** `src/core/conversation-agent.ts:241` (certificate-present rendered variant).
    **Exact string:** `Perfecto, lo hacemos cuando te venga bien, no hay prisa. Cuando estés delante del ordenador entramos en la Sede Judicial y firmamos el apoderamiento; son unos diez minutos.`
    **Defect:** Facts: absence of urgency, desktop requirement and a ten-minute duration are unapproved. Promises: assisted signing at the client's chosen time and a duration estimate; not a booked appointment. Tone: filler opening and a long second sentence. Regex: `/estoy trabajando|trabajo de \d|de \d{1,2} a \d{1,2}|manana por la manana|por la tarde|a partir de las|cuando salga de trabajar|el fin de semana/` accepts any time range or afternoon/weekend mention, including another event. The date suffix in `compound-reply.ts:29` can turn it into an explicit contact promise.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. ¿Necesitas aclarar algún paso?`

16. **File:** `src/core/conversation-agent.ts:241` (certificate-absent rendered variant).
    **Exact string:** `Perfecto, lo hacemos cuando te venga bien, no hay prisa. Cuando tengas un rato tranquilo seguimos con el certificado digital; son unos diez minutos.`
    **Defect:** Facts: no urgency and a ten-minute certificate process are unapproved. Promises: future joint continuation plus the duration estimate; a named-date suffix can add a contact commitment. Tone: filler opening, two sentences, no emojis. Regex: the same unscoped availability/time-range pattern as the other variant at line 241.
    **Corrected Spanish string:** `Indica qué necesitas para solicitar el certificado FNMT. ¿Tienes DNIe con PIN o NIE?`

17. **File:** `src/core/conversation-agent.ts:244`.
    **Exact string:** `Siento mucho que estés pasando por esto y lo primero es que te cuides; si te encuentras mal, llama al 112 o acude a tu médico. El trámite no tiene ninguna prisa: se lo paso a una persona del despacho para que lo lleve contigo con calma.`
    **Defect:** Facts: medical triage advice, emergency number and absence of procedural urgency are outside the approved facts. Promises: immediate escalation and personal handling; “ninguna prisa” is an unsupported timing assurance. Tone: verb opening but two very long sentences. Regex: bare `operacion`, `ingresad`, `hospital` or `enferm` can describe a bank operation, received funds or somebody else's circumstances. Earlier `baja` can select the stop-contact reply before `baja medica` reaches this branch.
    **Corrected Spanish string:** `Siento que estés pasando por un momento difícil. Consulta con el despacho cómo continuar.`

18. **File:** `src/core/conversation-agent.ts:247`.
    **Exact string:** `El apoderamiento es gratuito si lo firmas tú. Si prefieres que lo gestione la empresa colaboradora, son 35 € y te paso con una persona del despacho para darte de alta.`
    **Defect:** Facts: self-signing is described as free without limiting it to the approved Sede Judicial/juzgado routes; enrolment through a staff member is not approved. Promises: `te paso` implies escalation and registration will follow. Tone: noun opening and a long second sentence. Regex: `pagarlo`, `lo pago`, `puedo pagar` and `quiero que lo gestion` do not identify the managed service; negation such as inability to pay can contain a positive substring.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o en el juzgado. Elige, si lo prefieres, la gestión opcional de la empresa colaboradora por 35 €.`

19. **File:** `src/core/conversation-agent.ts:250`.
    **Exact string:** `El apoderamiento no se puede firmar por correo: se firma con certificado en la Sede Judicial o en persona en el juzgado, y ahí es gratuito. Si te viene mejor, pide cita en el decanato de tu juzgado y lo firmas allí.`
    **Defect:** Facts: a categorical ban on signing by email, the Sede certificate requirement and the decanato appointment procedure are outside the allowance. Promises: implies the prescribed appointment leads to signing, without confirming a booking. Tone: noun opening and long sentences. Regex: the send/email/document expression at line 249 does not require apoderamiento and can catch a request for a different document; `lo firmo y os lo` also lacks an identified object.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. ¿Te refieres a este trámite?`

20. **File:** `src/core/conversation-agent.ts:253`.
    **Exact string:** `Perfecto, si ya está hecho no lo repitas. Lo compruebo con el despacho y te confirmamos por aquí que ha llegado bien.`
    **Defect:** Facts: assumes the unspecified action/document is complete and should not be repeated. Promises: a check is presented as underway and successful receipt will be confirmed in this chat. Tone: filler opening, two sentences, no emojis. Regex: `/ya ... (?:envie|enviado|mande|mandado|firme|firmado|hice|hecho|pedido)|acabo de (?:enviar|mandar|firmar)|ya lo tengo hecho/` lacks an object and can describe an unrelated request or signature; it is not receipt evidence.
    **Corrected Spanish string:** `Indica qué trámite has completado. Consulta con el despacho si consta recibido.`

21. **File:** `src/core/conversation-agent.ts:267`.
    **Exact string:** `Claro, se lo paso a una persona del despacho para que te llame y lo veáis por teléfono. Si mientras tanto quieres adelantarlo por aquí, seguimos cuando te venga bien.`
    **Defect:** Facts: an available callback arrangement is not approved. Promises: escalation and a telephone callback; no scheduled appointment is actually established. Tone: filler opening and a long first sentence. Regex: `que me llam`, `necesito hablar con alguien` and `un telefono` need not request a staff callback; the first also matches negated requests to be called, and the last can describe owning a telephone.
    **Corrected Spanish string:** `Consulta con el despacho si puedes hablar por teléfono. ¿Necesitas aclarar algo del apoderamiento?`

22. **File:** `src/core/conversation-agent.ts:270`.
    **Exact string:** `Entiendo lo que te dijeron. El apoderamiento tienes que firmarlo tú, con certificado en la Sede Judicial o en persona en el juzgado, y el documento que salga lo recibimos nosotros. Se lo paso a una persona del despacho para confirmarte cómo quedó tu caso.`
    **Defect:** Facts: automatic receipt by the firm and the explicit Sede certificate requirement are unapproved. Promises: immediate escalation and confirmation of case status. Tone: verb opening but three declarative sentences, including a long middle sentence. Regex: the court-reported-speech alternatives at line 269 require no apoderamiento subject; a report about another court matter selects this reply.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. Consulta con el despacho qué consta en tu caso.`

23. **File:** `src/core/conversation-agent.ts:273`.
    **Exact string:** `Sin moverte de casa tienes dos salidas: la vídeo identificación de la FNMT para sacar el certificado, o que lo gestione la empresa colaboradora por 35 €. ¿Cuál prefieres?`
    **Defect:** Facts: guarantees both complete routes require no travel and presents certificate acquisition and managed apoderamiento as interchangeable, exhaustive alternatives; neither is in the allowance. Promises: no date or escalation, but an unsupported convenience guarantee. Tone: prepositional opening and one overly long sentence plus a question. Regex: `no tengo tiempo (?:para|de) (?:ir|acudir|desplaz|pedir cita)` and bare `no puedo ir`, `hacedlo vosotros` and `no puedo desplaz` do not identify this procedure.
    **Corrected Spanish string:** `Solicita el certificado FNMT por vídeo identificación si eliges esa vía. Puedes optar por la gestión del apud acta de la empresa colaboradora por 35 €.`

24. **File:** `src/core/conversation-agent.ts:277`.
    **Exact string:** `Esa contraseña la elegiste tú al instalar el certificado y nadie puede recuperarla, tampoco nosotros. Te paso con una persona del despacho para verlo contigo; si prefieres no complicarte, el apoderamiento se puede firmar gratis en el juzgado.`
    **Defect:** Facts: password origin and universal irrecoverability are unapproved; the NIE route explicitly includes a password supplied in an Ayuntamiento document, so origin cannot be assumed. Promises: immediate human transfer. Tone: demonstrative opening, two long sentences and patronising “no complicarte”. Regex: `/no me acuerdo de (?:la |cual)|...|contrasena del certificado/` can match forgetting an unrelated thing or any mention of a certificate password, rather than loss of that password. Earlier handoff may intercept some inputs, so this is a local trigger risk, not an asserted end-to-end result.
    **Corrected Spanish string:** `No compartas la contraseña. Consulta con el despacho cómo continuar o firma tú el apud acta gratis en el juzgado.`

25. **File:** `src/core/conversation-agent.ts:279`.
    **Exact string:** `El certificado digital es personal y gratuito, no depende de tu trabajo ni de la Seguridad Social ni de Cl@ve. Se saca de dos formas: con el DNI electrónico y su PIN, o por vídeo identificación de la FNMT desde casa.`
    **Defect:** Facts: certificate price, personal status, independence from employment/Seguridad Social/Cl@ve, home completion and exactly two routes are unapproved. The exhaustive account omits NIE holders' approved Ayuntamiento accreditation route and its document with link and password. Promises: no date, appointment or completed escalation. Tone: noun opening and two long sentences. Regex: `seguridad social`, `sin contrato` and `cl@ve` can describe unrelated employment or login issues; `hasDigitalCert !== true` is not topic evidence.
    **Corrected Spanish string:** `Indica si tienes DNIe o NIE, sin enviar el número. Con NIE, acude a tu Ayuntamiento, oficina de acreditación FNMT: te entregan un documento con enlace y contraseña.`

26. **File:** `src/core/conversation-agent.ts:282`.
    **Exact string:** `Entiendo, ahí se ha atascado. Se lo paso a una persona del despacho para que te guíe en ese punto concreto. Si prefieres no seguir peleándote con esto, puedes firmarlo gratis en el juzgado pidiendo cita en el decanato.`
    **Defect:** Facts: a decanato appointment requirement is not approved. Promises: immediate escalation and specific human guidance; no appointment has been booked. Tone: three sentences and “seguir peleándote” add avoidable frustration. Regex: `describesBlocker` includes bare `no ... funciona`, `se ... queda` and `me da error`; an earlier help-attempt counter does not establish that a newly mentioned failure concerns the certificate/apoderamiento. `no tengo el codigo` should not lead to requesting an FNMT code.
    **Corrected Spanish string:** `Describe dónde te has quedado, sin enviar contraseñas ni códigos. Puedes firmar tú el apud acta gratis en el juzgado.`

27. **File:** `src/core/conversation-agent.ts:289`.
    **Exact string:** `Siento mucho la espera y entiendo tu enfado. Aviso ahora al equipo que lleva tu reclamación para que revise tu caso y te escriba por aquí.`
    **Defect:** Facts: assumes this frustration concerns a claim handled by this team. Promises: `Aviso ahora` states an immediate escalation and promises a chat response. Tone: verb opening, two sentences, second long. Regex: `estoy hart`, `llevo ... meses/semanas` and `es una verguenza` need no claim subject; the `asksToContinue` exclusion also uses unbounded words such as `acabar` and `seguir`, so unrelated wording can enable or suppress this reply.
    **Corrected Spanish string:** `Siento la espera. Consulta con el despacho qué información necesitas sobre tu caso.`

28. **File:** `src/core/conversation-agent.ts:291`.
    **Exact string:** `Escribe a reclamaciones@litigios.es para consultar el estado de tu reclamación. Siento la espera; no tengo una fecha de cobro confirmada.`
    **Defect:** Facts: the email address and its role are not approved. Promises: explicitly avoids a payment date; no outcome or escalation promise. Tone: verb opening, two short sentences, no emojis. Regex: `asksAboutMoney` includes `mi dinero` and `cuando ... llega/paga/ingresan`, which can concern another payment or delivery; it does not require a claim subject.
    **Corrected Spanish string:** `Consulta el estado de tu reclamación con el despacho. No puedo confirmar una fecha de cobro.`

29. **File:** `src/core/conversation-agent.ts:293`.
    **Exact string:** `No, no necesito tu contraseña y no debes compartirla por aquí. Podemos seguir con el apoderamiento sin que nos envíes ninguna clave.`
    **Defect:** Facts: no prohibited request; non-sharing is approved. Promises: no date, legal outcome, appointment or completed escalation. Tone: remove the standalone `No,` filler; otherwise two short sentences and no emojis. Regex: the `necesitas`/`hace falta` alternatives plus `/contrase|clave|password/` can match discussion of what a third party needs or “clave” in another sense, without proving the client is asking whether the bot needs a password.
    **Corrected Spanish string:** `No compartas contraseñas, datos bancarios ni códigos SMS. No necesito que me envíes ninguna clave.`

30. **File:** `src/core/conversation-agent.ts:295`.
    **Exact string:** `Soy Dayana, la asistente virtual de LITIGIOS, el despacho de abogados que lleva tu reclamación. Puedes confirmar este mensaje con la oficina en reclamaciones@litigios.es antes de seguir.`
    **Defect:** Facts: persona name, business identity, existing representation, email address and its verification function are not on the approved list. Promises: no dated or legal-outcome promise, but contact verification is asserted as available. Tone: verb opening, two sentences; the identity sentence is long. Regex: unanchored `quien eres`/`quienes sois` and `para quien trabajas` also match quoted or reported identity questions.
    **Corrected Spanish string:** `Confirma la identidad del interlocutor mediante un contacto que ya conozcas. No envíes contraseñas, datos bancarios ni códigos SMS.`

31. **File:** `src/core/conversation-agent.ts:297`.
    **Exact string:** `No, no lo envíes por este chat: es un documento personal y aquí no está protegido. Si prefieres que lo hagamos nosotros, te pediremos permiso antes y el despacho te indicará el canal seguro.`
    **Defect:** Facts: unspecified document ownership, lack of chat protection, the firm's ability to act, consent procedure and a secure channel are unapproved. Promises: permission request and later secure-channel instructions are presented as certain; no completed transfer is shown. Tone: filler opening and long sentences. Regex: `(te|os) lo ...`, `es personal` and `es ... documento personal` do not identify the certificate; having a certificate in case state does not establish the referent.
    **Corrected Spanish string:** `Aclara a qué documento te refieres, sin enviarlo. No compartas contraseñas, datos bancarios ni códigos SMS.`

32. **File:** `src/core/conversation-agent.ts:299`.
    **Exact string:** `Entendido, sin esa aplicación no podemos sacar la copia desde el móvil. Puedes hacer el apoderamiento gratis en el juzgado o lo tramita por ti la empresa colaboradora; ¿cuál prefieres?`
    **Defect:** Facts: impossibility of obtaining a copy without an unnamed app is not approved. Managed service should be clearly optional and identified as 35 €. Promises: `lo tramita por ti` can sound like arranged processing rather than an available option. Tone: filler opening; two statements and one question fit the numerical cap, but the second is crowded. Regex: `no tengo ... app`, `sin ... aplicacion` and `no uso ... app` match any application; the case certificate flag does not identify which app.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en el juzgado. Puedes elegir la gestión opcional de la empresa colaboradora por 35 €; ¿qué prefieres?`

33. **File:** `src/core/conversation-agent.ts:308`.
    **Exact string:** `Dime solo si tienes DNI electrónico, su PIN y un lector o móvil compatible; no me envíes el PIN. Con el certificado podrás hacer después el apud acta gratis por tu cuenta en la Sede Judicial.`
    **Defect:** Facts: reader/compatible-phone requirements are outside the allowance. The string asks only whether the client has a PIN and explicitly prohibits sending it; it does not request an FNMT code or the PIN itself. Promises: no date, appointment, legal outcome or completed escalation. Tone: verb opening, two rather long sentences. Regex: `/\b(?:la |opcion |opción )?(primera|segunda|1|2)\b/` plus preference words and `/1\)/`, `/2\)/` in prior text do not establish that the numbered choices actually mean DNIe/video identification; any earlier numbered list can be misinterpreted.
    **Corrected Spanish string:** `Confirma solo si tienes DNIe y su PIN, sin enviarme el PIN. Puedes firmar tú el apud acta gratis en la Sede Judicial.`

34. **File:** `src/core/conversation-agent.ts:309,314`.
    **Exact string:** `Perfecto, vía vídeo identificación. Abre ${officialLinks.fnmtVideo} y solicita el certificado desde casa; el coste lo indica la propia FNMT.`
    **Defect:** Facts: the URL value, home completion and FNMT pricing/presentation claim are not supplied approved facts; `officialLinks` is imported and not verified in this scope. Promises: no date, legal outcome, appointment or escalation. Tone: filler opening followed by an instruction and price aside. Regex: line 309 inherits the unbound numbered-list interpretation at lines 302–306; line 314 accepts `por video` or `desde casa` without an explicit FNMT route choice, including negations and unrelated remote activity.
    **Corrected Spanish string:** `Solicita el certificado FNMT por vídeo identificación si eliges esa vía. No envíes contraseñas ni códigos.`

35. **File:** `src/core/conversation-agent.ts:310`.
    **Exact string:** `Aclárame qué significa «la primera»: ¿te refieres a que ya tienes certificado digital a tu nombre?`
    **Defect:** Facts: no fact is asserted, but certificate ownership is introduced without support from the ordinal answer. Promises: none. Tone: verb opening, one question, no emojis; the leading question can bias the clarification. Regex: the ordinal matcher accepts `segunda` and `2` too, yet this string always says “la primera”; preference words can concern another numbered choice. A missing `1)`/`2)` pair does not prove a certificate question was pending.
    **Corrected Spanish string:** `Aclara la opción que quieres elegir. ¿A qué te refieres?`

36. **File:** `src/core/conversation-agent.ts:313`.
    **Exact string:** `Perfecto, vía DNI electrónico. Abre ${officialLinks.fnmtDnie} y sigue los pasos con tu lector o móvil compatible; necesitarás el PIN del DNI.`
    **Defect:** Facts: imported URL and reader/compatible-phone requirements are not approved; using DNIe plus PIN is approved. Promises: none of the prohibited kinds. Tone: filler opening and a long second sentence. Regex: `/\bdnie\b|dni electronico|con el dni|lector/` does not require positive selection; `lector` can describe a different reader and negated possession still matches. State and certificate guards do not resolve that ambiguity.
    **Corrected Spanish string:** `Solicita el certificado FNMT con DNIe y PIN si eliges esa vía. No compartas el PIN.`

37. **File:** `src/core/conversation-agent.ts:316`.
    **Exact string:** `Con DNI hay dos vías: si tienes DNI electrónico con PIN y un lector o móvil compatible, esa es gratuita; si no los tienes, la vídeo identificación de la FNMT es lo más rápido, con su coste propio. ¿Cuál te encaja?`
    **Defect:** Facts: reader/device requirements, a free DNIe certificate route, a paid video route and “lo más rápido” are unapproved; do not transfer the approved free apud acta price to certificate acquisition. Promises: comparative speed assurance, though no exact date. Tone: prepositional opening and a very long sentence. Regex: `/tengo (?:el )?dni|dni espanol|solo tengo dni|tengo documento espanol/` can match negated possession or discussion of another person's document; the state guard alone does not prove route selection.
    **Corrected Spanish string:** `Solicita el certificado FNMT con DNIe y PIN o por vídeo identificación. ¿Qué vía prefieres?`

38. **File:** `src/core/conversation-agent.ts:318`.
    **Exact string:** `Vamos paso a paso: el certificado digital sirve para identificarte y firmar por internet. ¿Recuerdas si tienes uno a tu nombre?`
    **Defect:** Facts: certificate function and ownership requirements are outside the supplied approved facts. Promises: none. Tone: verb opening, one sentence plus one question, no emojis. Regex: generic `no entiendo`, `no tengo ni idea` and `soy mayor` need no certificate subject; the three permitted states and lack of a confirmed certificate do not make an unrelated confusion/age statement a certificate question.
    **Corrected Spanish string:** `Indica si ya tienes un certificado digital de la FNMT.`

39. **File:** `src/core/conversation-agent.ts:321`.
    **Exact string:** `Elige con tu ${relative}: por internet en la Sede Judicial con un certificado a tu nombre, o en el juzgado sin certificado. El apud acta es gratis si lo haces por tu cuenta y os guío paso a paso.`
    **Defect:** Facts: active involvement of the named relative, personal certificate requirements and absence of a certificate requirement at court are outside the allowance. Promises: guided assistance to both people is asserted, but no date, legal outcome or completed escalation. Tone: verb opening and no emojis, but a long first sentence. Regex: `/\bmi (hij[oa]|niet[oa]|sobrin[oa]|marido|mujer|yerno|nuera|herman[oa]|vecin[oa])\b/` treats any mention of that person as an offer of help; capture alternatives produce hijo/hija, nieto/nieta, sobrino/sobrina, marido/mujer, yerno/nuera, hermano/hermana and vecino/vecina, all with the same risk.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado. ¿Qué necesitas aclarar?`

40. **File:** `src/core/conversation-agent.ts:323`.
    **Exact string:** `Si no consigues el certificado, no te quedas sin opciones: puedes otorgar el apoderamiento presencialmente en el juzgado, que es gratuito, o usar una empresa colaboradora de pago. ¿Te explico la vía del juzgado?`
    **Defect:** Facts: the alternatives are approved, but the managed route omits its approved 35 € price and explicit optional nature. Promises: no date, outcome, appointment or completed escalation. Tone: conditional opening and an overlong sentence plus one question. Regex: `no voy a poder`, `no se si podre` and `si no puedo ... hacer` need no certificate subject; the allowed states do not rule out unrelated inability.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en el juzgado o elige la gestión opcional de la empresa colaboradora por 35 €. ¿Qué vía prefieres?`

41. **File:** `src/core/conversation-agent.ts:325`.
    **Exact string:** `Entiendo la duda: puedes confirmar este mensaje con la oficina por un contacto que ya conozcas. El apoderamiento por tu cuenta es gratuito en la Sede Judicial (${officialLinks.sede}) y nunca te pediremos claves ni datos bancarios.`
    **Defect:** Facts: an office's ability to authenticate the message and the imported URL are not in the approved list; free self-signing and refusing secrets/bank data are approved. Promises: no date, legal outcome, appointment or escalation. Tone: verb opening, two sentences, second long. Regex: `/estafa|timo|fraude|es seguro|es fiable|no me fio|me fio|scam|suplanta/` has no topic/word-boundary safeguards; `timo` occurs inside the accent-normalized `ultimo`, while unrelated fraud reports can receive reassurance about this bot.
    **Corrected Spanish string:** `Confirma la identidad del interlocutor mediante un contacto que ya conozcas. No envíes contraseñas, datos bancarios ni códigos SMS.`

42. **File:** `src/core/conversation-agent.ts:349`.
    **Exact string:** `Perdona la insistencia. Si no puedes seguir desde el móvil, podemos hacerlo de otra forma: presencialmente en el juzgado, que es gratis, o lo tramita por ti la empresa colaboradora. ¿Cuál prefieres?`
    **Defect:** Facts: repeated text does not establish a mobile problem; the partner option omits its approved 35 € price and optional status. Promises: `lo tramita por ti` can imply arranged processing. Tone: verb opening, two statements plus one question meet the numeric cap, but the second statement is too long. Regex: no client-topic regex selects this fallback; normalized equality or substring containment between messages triggers it, even for repeated security or human-review replies. It can therefore add unrelated alternatives and drop the original review flag.
    **Corrected Spanish string:** `Aclara qué necesitas que explique de otra manera. ¿Qué parte sigue sin quedar clara?`

43. **File:** `src/core/conversation-agent.ts:356` (`PROFESSIONAL_HANDOFF`; used at lines 145,152,361,396).
    **Exact string:** `Gracias por escribir. Quiero ayudarte, pero necesito que un profesional del despacho revise esta consulta. Un gestor se pondrá en contacto contigo para indicarte cómo continuar.`
    **Defect:** Facts: a guaranteed staff-contact workflow is not approved. Promises: a gestor will contact the client; a review flag is not evidence of assigned or completed escalation. Tone: non-verb courtesy opening and three declarative sentences. Regex: `/hablar con (una )?persona|hablar con el gestor|gestor|humano|agente|profesional/` at line 360 accepts professions and third-party references, without actual contact intent. Other uses are imported handoff/button/ambiguity decisions or an unmatched-input fallback, not proof that staff will contact the client.
    **Corrected Spanish string:** `Consulta con el despacho cómo continuar. No puedo confirmar que una persona haya recibido tu consulta.`

44. **File:** `src/core/conversation-agent.ts:365`.
    **Exact string:** `Claro. Puedo ayudarte paso a paso con el apoderamiento apud acta. Dime qué parte no entiendes y te la explico; si hace falta, un gestor del despacho se pondrá en contacto contigo.`
    **Defect:** Facts: the conditional callback workflow is unapproved. Promises: staff contact if considered necessary. Tone: filler opening and three declarative sentences; the last is long. Regex: `/no entiendo|no lo entiendo|no se|duda|explica|como funciona|que tengo que hacer|ayuda|ayudar/` is not topic-bound; `no se` also matches the start of other phrases and `ayuda` can describe unrelated assistance.
    **Corrected Spanish string:** `Indica qué parte del apoderamiento necesitas aclarar. ¿En qué paso estás?`

45. **File:** `src/core/conversation-agent.ts:371`.
    **Exact string:** `Soy Dayana, la asistente virtual de LITIGIOS. Puedo orientarte con los pasos del apoderamiento apud acta; la revisión de los poderes corresponde al equipo del despacho.`
    **Defect:** Facts: assistant/company identity and the team's legal-review responsibility are not approved. Promises: no date, legal outcome, appointment or completed escalation. Tone: verb opening, two sentences, second long. Regex: `/quien eres|quienes sois|de que despacho|que despacho|tu nombre/` can match quoted identity questions or a mention of a name, rather than a current identity request.
    **Corrected Spanish string:** `Confirma la identidad del interlocutor mediante un contacto que ya conozcas. ¿Qué necesitas aclarar sobre el apoderamiento?`

46. **File:** `src/core/conversation-agent.ts:377`.
    **Exact string:** `Puedo orientarte con los pasos del apoderamiento apud acta que correspondan a tu expediente. Las dudas sobre su alcance jurídico las revisa un profesional del despacho.`
    **Defect:** Facts: asserts case-specific guidance and an established professional-review responsibility beyond the approved facts. Promises: “las revisa” can imply an existing review arrangement, but does not explicitly confirm a particular completed escalation. Tone: verb opening, two sentences, no emojis. Regex: `/apoderamiento|apud acta/` matches any occurrence, including negation or quoted text, without checking the actual request.
    **Corrected Spanish string:** `Consulta el alcance jurídico del apoderamiento con el despacho. ¿Qué necesitas aclarar del trámite?`

47. **File:** `src/core/conversation-agent.ts:383`.
    **Exact string:** `Puedo orientarte sobre el certificado digital y el dispositivo que vas a utilizar. Cuéntame qué tienes disponible y te indicaré el siguiente paso aprobado para tu expediente.`
    **Defect:** Facts: a case-specific “approved” next step is not established by the approved facts. Promises: next-step advice is promised, though not a date, legal outcome, appointment or completed escalation. Tone: verb opening and two sentences, but exposes internal approval language and uses a broad question-by-instruction. Regex: `/certificado|cl@ve|dnie|ordenador|movil|telefono/` accepts unrelated phone/computer subjects; it does not require a certificate question.
    **Corrected Spanish string:** `Indica qué necesitas sobre el certificado FNMT. No envíes contraseñas ni códigos.`

48. **File:** `src/core/conversation-agent.ts:389`.
    **Exact string:** `Estoy siguiendo la información de tu expediente en el despacho. Puedo aclararte el siguiente paso del apoderamiento; no envíes contraseñas, claves ni datos sensibles por este chat.`
    **Defect:** Facts: active monitoring/access to the client's case is not approved or evidenced in this string's branch. Promises: implies ongoing case attention, without a date or explicit completed escalation. Tone: verb opening, two sentences, second rather long. Regex: `/expediente|reclamacion|empresa|datos|caso/` is very broad; `caso` occurs within `acaso`, and `empresa`/`datos` need not refer to this claim.
    **Corrected Spanish string:** `Indica qué necesitas aclarar sobre el apoderamiento. No envíes contraseñas, datos bancarios ni códigos SMS.`

49. **File:** `src/core/conversation-agent.ts:394`.
    **Exact string:** `De acuerdo. Cuando estés preparado, dime qué necesitas y continuamos paso a paso.`
    **Defect:** Facts: none outside the allowance. Promises: ordinary conversational continuation only, with no date, outcome, appointment or completed escalation. Tone: filler opening and a conditional clause before the instruction. Regex: `/gracias|perfecto|vale|ok|de acuerdo/` has no word boundaries or full-message check; substrings such as `vale` in `equivalente` or `ok` in an unrelated name can trigger agreement wording. Earlier local-support branches can pre-empt some inputs, so these are pattern-level risks.
    **Corrected Spanish string:** `Dime qué necesitas para continuar.`

50. **File:** `src/core/topic-routing.ts:12` (`WAITING_FOR_REPLY`; returned at line 59 and `src/core/conversation-agent.ts:274`).
    **Exact string:** `Ya veo que escribiste y todavía no te han contestado; no hace falta que lo repitas. Lo traslado al equipo que lleva tu reclamación para que te respondan por aquí.`
    **Defect:** Facts: assumes prior contact with this firm, no response and no need to repeat a request. Promises: completed/immediate escalation and a response in this chat. Tone: adverb opening and two compound sentences. Regex: `wroteAndWaits` pairs an unbounded writing/waiting expression with any `nadie`, `todavia`, `aun no` or similar term anywhere in the message; they need not concern the same event or recipient. `llevo ... dias/semanas/meses` does not establish that the client wrote at all.
    **Corrected Spanish string:** `Consulta con el despacho si consta tu consulta pendiente. No puedo confirmar que se haya trasladado a una persona.`

51. **File:** `src/core/topic-routing.ts:58`.
    **Exact string:** `El apoderamiento es gratuito si lo firmas tú, en la Sede Judicial o en el juzgado. Solo tiene coste si prefieres que lo gestione la empresa colaboradora, que son 35 €.`
    **Defect:** Facts: free self-signing and optional 35 € management are approved; “Solo tiene coste” overstates an exhaustive cost rule beyond those two approved offers. Promises: none. Tone: noun opening, two sentences, no emojis. Regex: `asksCost` (`cuanto cuesta/vale/costaria`, `precio`, `honorarios`, etc.) overrides every supplied outside topic, so a claim-fee question receives the apoderamiento price. `ABOUT_WORKFLOW` contains unbounded `cita` (also inside `solicitar`) and other generic keywords; `ASKS_US_TO_SEND` suppresses routing for any object, which can also send unrelated messages down workflow paths. Fixing the string alone cannot fix this scope error.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o en el juzgado. Puedes elegir la gestión opcional de la empresa colaboradora por 35 €.`

52. **File:** `src/core/topic-routing.ts:65` (currently unreachable cost variant).
    **Exact string:** `El apoderamiento es gratuito si lo haces por tu cuenta. Los plazos y el cobro los lleva el equipo de reclamaciones: escríbeles a ${OFFICE_EMAIL}.`
    **Defect:** Facts: unrestricted self-service gratuity omits the Sede Judicial/juzgado condition; department responsibilities and `OFFICE_EMAIL = reclamaciones@litigios.es` are unapproved. Promises: no date or payment outcome, but staff responsibility is asserted. Tone: noun opening, two sentences. Regex: `asksCost` already returns at line 58, so this `asksCost ?` arm cannot currently fire; do not count it as a reproduced client reply. If made reachable, it would retain the unscoped cost-topic problem.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o en el juzgado. Consulta los plazos de tu reclamación con el despacho.`

53. **File:** `src/core/topic-routing.ts:66`.
    **Exact string:** `El estado de tu reclamación y los plazos los lleva el equipo de reclamaciones. Escríbeles a ${OFFICE_EMAIL} y te confirman cómo va.`
    **Defect:** Facts: team ownership and the interpolated email address are unapproved. Promises: staff will confirm status; no particular date or successful legal result is promised. Tone: noun opening and two sentences. Regex: `CLAIM_STATUS` at line 31 includes `mi dinero`, `me deben`, `cuando ... llega`, `no he recibido respuesta/nada`, `hay novedades` and `alguna novedad`; these can concern another payment, delivery, unanswered message or unrelated news. The workflow/send exclusions do not establish a claim subject.
    **Corrected Spanish string:** `Consulta el estado y los plazos de tu reclamación con el despacho. No puedo confirmar una fecha de cobro.`

54. **File:** `src/core/topic-routing.ts:70` (already-sent/paid variant).
    **Exact string:** `Entiendo, y si ya lo enviaste o ya lo pagaste no tienes que repetirlo. Pásame la fecha o el justificante y lo traslado al equipo de reclamaciones para que revisen por qué les consta pendiente.`
    **Defect:** Facts: says payment/submission need not be repeated without knowing its status and asserts that it is recorded as pending. The requested date is not a promised date; requesting a justificante without excluding bank data risks soliciting prohibited bank information. Promises: “lo traslado” promises escalation after receipt of information and review as assured, without evidence of a transfer. Tone: verb opening but two long sentences. Regex: `CHARGES` includes bare `recibo` (also a verb) and `deuda`; `alreadySent` identifies neither recipient nor object, so an unrelated past payment/submission can choose this variant.
    **Corrected Spanish string:** `Consulta con el despacho si consta lo que ya enviaste o pagaste. No envíes datos bancarios, contraseñas ni códigos SMS.`

55. **File:** `src/core/topic-routing.ts:71` (other charges variant).
    **Exact string:** `Entiendo, y eso hay que revisarlo con el equipo que lleva tu reclamación. Escríbeles a ${OFFICE_EMAIL} con lo que te han pedido y lo comprueban.`
    **Defect:** Facts: team responsibility and the email address are not approved; the open-ended request to send what was requested may include bank data. Promises: “lo comprueban” guarantees follow-up, though no date or completed escalation. Tone: verb opening and two sentences, with filler “Entiendo, y”. Regex: `/me ... cobrar|que me cobr|me reclaman|factura|recibo|deuda|.../` at line 33 does not distinguish claim fees from unrelated bills or the ordinary verb `recibo`.
    **Corrected Spanish string:** `Consulta el concepto del cobro con el despacho. No envíes datos bancarios, contraseñas ni códigos SMS.`

56. **File:** `src/core/topic-routing.ts:73`.
    **Exact string:** `Para que te expliquen bien esa comunicación, reenvíala a ${OFFICE_EMAIL} y el equipo te dice qué significa.`
    **Defect:** Facts: the address and the team's interpretation service are unapproved. An unrestricted forwarding request does not exclude passwords, bank data or SMS codes contained in a communication. Promises: the team will explain it. Tone: purpose-clause opening and one long sentence. Regex: `COMMUNICATIONS` at line 36 needs only a receiving/sending/explaining term near `correo`, `carta`, `mail`, etc.; it can match unrelated correspondence or affirmative understanding, not a request for explanation.
    **Corrected Spanish string:** `Describe qué necesitas aclarar de la comunicación, sin reenviar datos bancarios, contraseñas ni códigos SMS.`

57. **File:** `src/core/topic-routing.ts:78` (contracts/claim/interest/total variant).
    **Exact string:** `Eso lo revisa el equipo de reclamaciones: envíales los contratos a ${OFFICE_EMAIL} y te dicen qué se puede reclamar y por cuánto.`
    **Defect:** Facts: department competence, contact address, contract submission and case valuation are outside the approved list. Unrestricted contracts may contain bank data. Promises: a legal eligibility/amount assessment will be provided; this is not a guaranteed court outcome, but remains an unapproved legal-service promise. Tone: demonstrative opening and one long sentence. Regex: `CLAIM_SCOPE` at line 34 contains bare service questions and `tengo dos contratos`; the variant test `/contrato|reclamar|intereses|total/` does not establish a request to send contracts or calculate a claim.
    **Corrected Spanish string:** `Consulta qué se puede reclamar y por qué importe con el despacho. No envíes datos bancarios, contraseñas ni códigos SMS.`

58. **File:** `src/core/topic-routing.ts:79` (other claim-scope variant).
    **Exact string:** `El despacho lleva reclamaciones de este tipo. Para confirmarte que la tuya está entre las que gestionamos y cómo va, escribe a ${OFFICE_EMAIL}.`
    **Defect:** Facts: the firm's practice area, possibility of existing representation and the address are not approved. Promises: implies writing will obtain confirmation that the claim is handled and its status; no specific outcome or date. Tone: noun opening and a long second sentence. Regex: `/llevais (?:la|mi|vosotros)|os encargais|sois ... que llev|gestionais (?:la|mi)/` can concern another service and contains no required claim object.
    **Corrected Spanish string:** `Consulta con el despacho si gestiona tu reclamación y cuál es su estado.`

59. **File:** `src/core/topic-routing.ts:81`.
    **Exact string:** `No te preocupes, no hace falta que lo busques tú solo. Escribe a ${OFFICE_EMAIL} contándoles qué documento te falta y lo revisan contigo.`
    **Defect:** Facts: assures document-search help and provides an unapproved email address. Promises: staff will review the missing document together with the client. Tone: negative verb opening and two sentences, but reassurance adds little. Regex: `DOCUMENTS` at line 38 includes `el contrato no` and missing `documento/papeles/contrato` without an identified procedure; it can classify any contract problem as a missing-file problem.
    **Corrected Spanish string:** `Indica qué documento te falta, sin enviar datos bancarios, contraseñas ni códigos SMS.`

60. **File:** `src/core/topic-routing.ts:83`.
    **Exact string:** `No te comprometas a nada con ellos ni hagas ningún pago: diles que tu reclamación la lleva este despacho y que se dirijan a nosotros. Lo traslado al equipo para que te confirme cómo actuar.`
    **Defect:** Facts: blanket non-payment/non-commitment advice, the firm's existing representation and a third-party contact procedure are unapproved. Promises: completed/immediate escalation and instructions on how to act. Tone: negative verb opening but a very long first sentence. Regex: `OTHER_COMPANY` at line 39 includes `no me deja entrar`, `no puedo entrar en`, `otra ... empresa`, `recovery` and any call `de/del`; a login failure or unrelated caller can therefore receive consequential debt advice. No debt/claim relationship is required.
    **Corrected Spanish string:** `Consulta con el despacho cómo responder a esa comunicación. No envíes datos bancarios, contraseñas ni códigos SMS.`

61. **File:** `src/core/compound-reply.ts:32`.
    **Exact string:** `Los plazos del cobro los lleva el equipo de reclamaciones: escríbeles a ${OFFICE_EMAIL}.`
    **Defect:** Facts: department responsibility and `OFFICE_EMAIL = reclamaciones@litigios.es` are not approved. Promises: no exact date, outcome, appointment or completed escalation. Tone: noun opening; although this suffix is one sentence, the assembled reply may exceed the allowed total. Regex: `/cuanto se tarda|cuanto tardan|cuando ... llega/pagan/paga/cobro/ingresan|que plazo|en cuanto tiempo/` lacks a claim/payment subject and can append claim advice to a certificate-duration question. The reply-text exclusion `/plazo|tarda|reclamaciones@/` suppresses additions based on mere substrings, not whether the question was answered.
    **Corrected Spanish string:** `Consulta los plazos de tu reclamación con el despacho.`

62. **File:** `src/core/compound-reply.ts:35`.
    **Exact string:** `Sirve para que nuestros procuradores puedan representarte ante el juzgado en tu reclamación.`
    **Defect:** Facts: the representation definition, existence of the firm's procuradores and case relationship are not approved facts. Promises: describes a legal function/relationship, not a guaranteed judgment, date or completed escalation. Tone: verb opening, one sentence, no emojis; the composed length still needs checking. Regex: `/para que ... sirve/vale/es|que es (?:eso|esto) de/` does not identify the apoderamiento; `/represent/` in the base reply is not evidence that a purpose question was answered.
    **Corrected Spanish string:** `Consulta el alcance jurídico del apoderamiento con el despacho.`

63. **File:** `src/core/compound-reply.ts:39` (all `SPOKEN` variants at line 13).
    **Exact string:** `Por mí ${SPOKEN[when]??when} perfecto: te escribo y lo hacemos.`
    **Defect:** Facts: available staff/bot scheduling and future joint completion are unapproved. Promises: explicit contact and joint action at the named time, amounting to an appointment-like commitment without scheduling evidence. Tone: prepositional opening and filler `perfecto`. Regex: `WHEN` accepts any mention of tomorrow, tonight, an afternoon, weekday or weekend, including negated availability, deadlines and third-party plans. The rendered choices are `mañana por la mañana`, `mañana por la tarde`, `mañana`, `esta tarde`, `esta noche`, `el lunes`, `el martes`, `el miércoles`, `el jueves`, `el viernes`, `el sábado`, `el domingo`, `el fin de semana`; all share this defect. Absence of the same words in the reply does not establish an unanswered scheduling request.
    **Corrected Spanish string:** `Consulta la disponibilidad con el despacho si necesitas acordar una cita.`

64. **File:** `src/core/compound-reply.ts:43`.
    **Exact string:** `No se puede firmar por correo: se firma con certificado en la Sede Judicial o en persona en el juzgado.`
    **Defect:** Facts: categorical inability to sign by email and an explicit certificate requirement for Sede signing are not stated in the approved facts. Promises: none of the prohibited kinds. Tone: negative verb opening, one sentence, no emojis; it still consumes the assembled reply's sentence allowance. Regex: the sending/email/document pattern at line 41 has no apoderamiento subject and can append this to a request for an unrelated document. `/no se puede firmar por correo/` recognizes only one exact wording, so equivalent base answers can receive a redundant suffix.
    **Corrected Spanish string:** `Firma tú el apud acta gratis en la Sede Judicial o presencialmente en el juzgado.`

65. **File:** `src/core/compound-reply.ts:45`.
    **Exact string:** `Y con ellos no te comprometas a nada: diles que tu reclamación la lleva este despacho.`
    **Defect:** Facts: blanket legal/financial advice and asserted representation are unapproved. Promises: no date or completed escalation, but the firm-client relationship is presented as settled. Tone: conjunction/prepositional opening, not verb first. Regex: `/iban a demandar|van a demandar|me van a denunciar|recovery|cobradores|me amenaz/` can concern another matter, quotation, negation or unrelated recovery process. `/comprometas/` in the existing reply is not a semantic check that the topic was answered.
    **Corrected Spanish string:** `Consulta con el despacho cómo responder a esa situación.`

66. **File:** `src/core/compound-reply.ts:48`.
    **Exact string:** `Si te refieres al coste de la reclamación en sí, te lo detalla el equipo en reclamaciones@litigios.es.`
    **Defect:** Facts: the email address, team responsibility and fee-information service are not approved. Promises: the team will supply a cost breakdown, without a confirmed date or completed escalation. Tone: conditional opening and one sentence. Regex: `/todo esto|en total|en conjunto/` plus `/cuanto (?:cuesta|vale|costaria)/` accepts total-cost questions about any subject, including the approved managed service itself; the conditional wording softens but does not fix unrelated appending. `/reclamaciones@/` only checks an address fragment.
    **Corrected Spanish string:** `Consulta el coste de la reclamación con el despacho si tu pregunta se refiere a ella.`

67. **File:** `src/core/conversation-agent.ts:229`.
    **Exact string:** `Sobre si te conviene seguir pagando esos plazos, no te lo puedo decir yo: te lo confirma el equipo que lleva tu reclamación y se lo paso ahora con lo que me cuentas.`
    **Defect:** Facts: asserts this team handles the client's claim and can decide whether payments should continue; neither is approved. Promises: immediate escalation via “se lo paso ahora” and a future answer about a legal/financial decision. Tone: prepositional opening and a single very long sentence. Regex: `/sigo pagando|puedo (?:seguir )?pagando|lo que (?:yo )?debo a|debo a \w+|dejo de pagar|sigo con los plazos|plazos acordados/` is not tied to the claim; `debo a` can describe owing gratitude or an obligation, and instalments may concern something else.
    **Corrected Spanish string:** `Consulta con el despacho si tu duda se refiere a pagos relacionados con la reclamación. No envíes datos bancarios.`

68. **File:** `src/core/conversation-agent.ts:259`.
    **Exact string:** `Apunto el teléfono y se lo paso al despacho para que la llamen. Les digo que se identifiquen como Litigios al llamar, así sabrá que la llamada es nuestra y no de un desconocido.`
    **Defect:** Facts: assumes a supplied phone number, a female recipient, company identity and a caller-identification procedure; spoken self-identification is presented as proof of authenticity. Promises: records the number, completes a referral, instructs colleagues and promises a callback, with no evidence of those actions in scope. Tone: verb opening but a long second sentence. Regex: `/que (?:la|le|lo|me) llamen|que (?:la|le|lo|me) llamaran|que la llame|dire que la llam/` does not require a number, an affirmative request or a particular recipient; negated/quoted requests can match.
    **Corrected Spanish string:** `Consulta con el despacho si puedes acordar una llamada. Confirma la identidad del interlocutor mediante un contacto que ya conozcas.`

69. **File:** `src/core/conversation-agent.ts:262`.
    **Exact string:** `Perfecto, sin prisa. Lo dejo apuntado y cuando lo tengas seguimos por aquí desde donde lo dejamos.`
    **Defect:** Facts: absence of urgency and a saved reminder/progress state are unapproved. Promises: recordkeeping is presented as completed and continuity in this chat as assured; the time suffix can add a concrete promised contact date. Tone: filler opening, two sentences, no emojis. Regex: `/manana (?:mismo|lo|la|te|os|se)|lo tiene manana|en cuanto (?:pueda|salga|llegue|termine)|por el trabajo|estoy en el trabajo|si no iria ahora/` accepts generic availability/work references and plans about unrelated tasks, without establishing what will be completed.
    **Corrected Spanish string:** `Indica qué paso quieres retomar cuando vuelvas a escribir.`

70. **File:** `src/core/conversation-agent.ts:265`.
    **Exact string:** `A ellos no tienes que contestarles tú: reenvía ese correo a reclamaciones@litigios.es y el equipo se encarga. Lo que sí depende de ti es el apoderamiento, y en eso te guío yo.`
    **Defect:** Facts: exemption from answering a third party, existence/content of an email, the contact address, staff responsibility and allocation of case obligations are not approved. Unrestricted forwarding can request passwords, bank data or codes contained in the message. Promises: the team will handle the third-party communication and the bot will guide the client; no actual escalation is evidenced. Tone: prepositional opening and two long sentences. Regex: `/procedo a ignorar|los ignoro|les ignoro|no les contesto|no les hago caso/` identifies neither the third party nor a legal communication; it can concern unrelated contacts or quoted intentions.
    **Corrected Spanish string:** `Consulta con el despacho si debes responder a esa comunicación. No reenvíes contraseñas, datos bancarios ni códigos SMS.`

71. **File:** `src/core/compound-reply.ts:51`.
    **Exact string:** `Y pido a una persona del despacho que te llame para verlo contigo.`
    **Defect:** Facts: assumes a callback-request mechanism and available staff follow-up beyond the approved facts. Promises: a callback request is presented as being made; this string-building function performs no escalation or scheduling. Tone: conjunction opening, one sentence, no emojis; the suffix can exceed the finished reply's sentence allowance. Regex: `/que me llam|me pueden llamar|pueden llamarme|podeis llamar|llameme|llamame/` can match negated, quoted or third-party wording. The reply exclusion `/llame|telefono/` tests words, not whether a callback was actually addressed.
    **Corrected Spanish string:** `Consulta con el despacho si puedes acordar una llamada.`

72. **File:** `src/core/compound-reply.ts:54`.
    **Exact string:** `Las novedades de tu expediente te las confirma el equipo en ${OFFICE_EMAIL}.`
    **Defect:** Facts: department responsibility, access to case updates and the email address are not approved. Promises: the team will confirm updates; no date or successful legal outcome is specified. Tone: noun opening and one sentence, with the same final-length risk as other suffixes. Regex: `/hay novedades|alguna novedad|como va (?:mi|el) (?:caso|expediente|reclamacion)/` treats generic news as a case update request; `!/reclamaciones@/` checks only an address fragment, not whether the subject was answered.
    **Corrected Spanish string:** `Consulta con el despacho si hay novedades sobre tu reclamación.`

73. **File:** `src/core/compound-reply.ts:17` (`nextStepSentence`, certificate present).
    **Exact string:** `Mientras tanto, cuando puedas seguimos con la firma del apoderamiento en la Sede Judicial.`
    **Defect:** Facts: presumes Sede signing is the selected next step, while the boolean certificate flag does not establish route selection. Promises: ordinary future joint assistance, with no named date, appointment or completed escalation. Tone: two introductory clauses before the verb; one sentence, no emojis. Regex: the `routes` expression at line 57 detects address/transfer phrases in the reply, not a client request to resume signing; absence of `/certificado|sede judicial|juzgado|firmar|apoderamiento/` does not establish a missing workflow question. A response to an unrelated issue can therefore gain this signing prompt.
    **Corrected Spanish string:** `Indica si quieres continuar con el apoderamiento.`

74. **File:** `src/core/compound-reply.ts:18` (`nextStepSentence`, certificate absent).
    **Exact string:** `Mientras tanto, cuando te venga bien seguimos con el certificado digital.`
    **Defect:** Facts: presumes certificate acquisition is the agreed next action, despite the approved free in-person route and optional managed service. Promises: future joint continuation, not a particular date or confirmed appointment/escalation. Tone: introductory clauses precede the verb; one short sentence, no emojis. Regex: the same reply-text `routes` and negative workflow-word checks at lines 57–58 can append this to an unrelated handoff; `hasDigitalCert === false` is not consent to a certificate route.
    **Corrected Spanish string:** `Indica si quieres continuar con la solicitud del certificado FNMT.`

75. **File:** `src/core/compound-reply.ts:19` (`nextStepSentence`, certificate unknown).
    **Exact string:** `Mientras tanto, para seguir con el apoderamiento me basta con saber si tienes certificado digital a tu nombre.`
    **Defect:** Facts: claims knowing certificate ownership is sufficient to continue and introduces a personal-ownership condition outside the supplied allowance. Promises: implied sufficiency of that answer, without a date, legal outcome or completed escalation. Tone: long introductory clause before the verb; one sentence, no emojis. Regex: the shared routes check selects this from the base reply's words rather than client intent. `CLOSED` at line 23 only exempts certain exact security/health/stop phrases from this next-step suffix; it does not disable the earlier date, callback or other suffix rules.
    **Corrected Spanish string:** `Indica si ya tienes certificado FNMT y quieres continuar con el apoderamiento.`

76. **File:** `src/core/compound-reply.ts:16–61`, applied at `src/core/conversation-agent.ts:345` (shared assembly defect affecting the preceding reply strings).
    **Exact string:** `[replyText.trim(),...additions.slice(0,2)].join(' ')` — the source expression assembling the final client-facing string, rather than an additional literal.
    **Defect:** Facts/promises: suffixes can introduce the unapproved claims, legal advice and time commitments identified in items 61–66 and 71–72 into an otherwise acceptable base reply, including a security or handoff message. Tone: limiting additions to two does not limit the finished reply to two short sentences plus one question; a two-sentence base can become four declarative sentences. The audited literals contain no emojis, but imported/interpolated content is outside this audit and the assembly does not enforce the rule. Regex: the earlier suffixes are selected independently by the broad patterns above, without topic binding, negation/quotation handling or an overall question count; the additional next-step suffix uses the reply-word/state checks described in items 73–75. Corrections must be complete replacements or conditionally composed within the total limit, not blindly appended. This is a static source audit; illustrative regex risks are not claimed as executed tests or live-client outcomes.
    **Corrected Spanish string:** `Indica qué necesitas aclarar sobre el apoderamiento. Consulta los plazos de tu reclamación con el despacho.` — suitable only when those two subjects are actually present; otherwise use the relevant corrected reply above without unrelated suffixes.
    **Audited snapshot (SHA-256):** `conversation-agent.ts` = `934bcf8e27452965b0dd3dc1b69035b0730f08f23d7f19317263e5fb7e001bb9`; `topic-routing.ts` = `3bc08025f761c3c06928838f332cf37e630b66277429c019bd960c9696782bdd`; `compound-reply.ts` = `5a454c7a8cf7f73841df77896c990f39adb508e5216f582f757f59ab01932b2e`. Concurrent source edits encountered during drafting were incorporated; only this audit document was written by this audit.
