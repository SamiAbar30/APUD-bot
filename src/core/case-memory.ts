import type {BotApodExpediente} from '@prisma/client';

/**
 * Durable conversational memory for a case.
 *
 * The recent-message window is short and a client may answer days later, so the model also receives
 * a compact statement of what the case already knows. It is built from persisted facts rather than
 * generated, so it can never invent consent, a completed filing or a legal fact: every line here is
 * something the workflow recorded.
 */
export function caseMemory(c: Pick<BotApodExpediente,
  'dni'|'currentState'|'stepReached'|'hasDigitalCert'|'certDevice'|'consentGranted'|'documentApproved'
  |'digitalHelpAttempts'|'certificateHelpAttempts'|'priorConversation'|'pendingQuestion'|'lastInboundAt'>
): string {
  const facts: string[] = [];
  facts.push(/^[XYZ]/i.test(c.dni) ? 'Documento: NIE.' : /^\d{8}[A-Za-z]$/.test(c.dni) ? 'Documento: DNI.' : 'Documento: sin confirmar.');
  facts.push(c.hasDigitalCert === true ? 'Tiene certificado digital.' : c.hasDigitalCert === false ? 'No tiene certificado digital.' : 'Certificado digital: sin confirmar.');
  if (c.certDevice) facts.push(`Certificado en ${c.certDevice === 'MOBILE' ? 'el móvil' : 'el ordenador'}.`);
  facts.push(`Paso guardado: ${c.stepReached}.`);
  if (c.hasDigitalCert === false) {
    facts.push(/^[XYZ]/i.test(c.dni)
      ? 'Vía acordada: cita en su Ayuntamiento (oficina de acreditación FNMT), donde le entregan un documento con enlace y contraseña para descargar el certificado en su ordenador.'
      : 'Vía acordada: obtener el certificado con DNI electrónico o por vídeo identificación de la FNMT.');
  }
  if ((c.certificateHelpAttempts ?? 0) > 0) facts.push(`Intentos de localizar la copia: ${c.certificateHelpAttempts}.`);
  else if ((c.digitalHelpAttempts ?? 0) > 0) facts.push(`Intentos de ayuda con el trámite: ${c.digitalHelpAttempts}.`);
  if (c.consentGranted) facts.push('Consentimiento de asistencia concedido.');
  if (c.documentApproved) facts.push('Documento del apoderamiento aprobado.');
  if (c.pendingQuestion) facts.push(`Última pregunta del despacho: ${c.pendingQuestion}`);
  // Long silences are why this record exists: say it plainly so the reply resumes instead of restarting.
  const days = c.lastInboundAt ? Math.floor((Date.now() - c.lastInboundAt.getTime()) / 86_400_000) : 0;
  if (days >= 1) facts.push(`El cliente llevaba ${days} día${days === 1 ? '' : 's'} sin escribir; retoma donde lo dejasteis, sin volver a presentarte.`);
  else if (c.priorConversation) facts.push('Conversación ya iniciada: no vuelvas a presentarte.');
  return facts.join(' ');
}

/** The question the office actually asked, kept so a returning client is answered in context. */
export function lastQuestionOf(text: string): string | null {
  const questions = text.match(/[^.!?\n]*\?/g);
  const last = questions?.at(-1)?.trim();
  return last && last.length >= 8 && last.length <= 200 ? last : null;
}
