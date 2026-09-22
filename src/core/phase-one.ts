import type { BotApodExpediente, Prisma } from '@prisma/client';
import { AppError } from '../infrastructure/security.js';
import { DAY_MS } from './follow-up.js';

export const phaseOneOutcomes = ['CERTIFICATE_READY', 'PAYMENT_REPORTED', 'COURT_REPORTED', 'SELF_COMPLETED_REPORTED', 'PDF_RECEIVED', 'DEADLINE_REACHED'] as const;
export type PhaseOneOutcome = typeof phaseOneOutcomes[number];
export const phaseOneLabels: Record<PhaseOneOutcome, string> = {
  CERTIFICATE_READY: 'Certificado y contraseña comprobados; trámite pendiente de Dayana.',
  PAYMENT_REPORTED: 'El cliente declara haber pagado; Dayana debe comprobar el pago.',
  COURT_REPORTED: 'El cliente declara haber completado el apud en el juzgado.',
  SELF_COMPLETED_REPORTED: 'El cliente declara haber completado el apud por su cuenta.',
  PDF_RECEIVED: 'PDF recibido; Dayana debe revisar el apoderamiento.',
  DEADLINE_REACHED: 'Fin del seguimiento de 30 días; revisar la última respuesta del cliente.',
};
export function phaseOneExpired(c: Pick<BotApodExpediente, 'phaseOneStartedAt'>, now = new Date()): boolean {
  return !!c.phaseOneStartedAt && now.getTime() >= c.phaseOneStartedAt.getTime() + 30 * DAY_MS;
}
/** Caller owns the case lock/transaction. A completed conversation never becomes a legal filing. */
export async function closePhaseOne(tx: Prisma.TransactionClient, c: BotApodExpediente, outcome: PhaseOneOutcome, evidence: Prisma.InputJsonObject, operator = 'SYSTEM_BOT') {
  if (c.phaseOneClosedAt) return;
  const at = new Date();
  const latest = await tx.botApodMessage.findFirst({where:{expedienteId:c.id,role:'user'},orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,createdAt:true}});
  const proof = {...evidence, outcome, legalFilingVerified:false, latestClientMessageId:latest?.id??null, latestClientMessageAt:latest?.createdAt.toISOString()??null};
  const changed = await tx.botApodExpediente.updateMany({where:{id:c.id,version:c.version,phaseOneClosedAt:null},data:{phaseOneClosedAt:at,phaseOneOutcome:outcome,phaseOneEvidence:proof,automationPaused:true,nextReminderAt:null,reminderCycle:{increment:1},version:{increment:1}}});
  if(changed.count!==1) throw new AppError('CASE_CHANGED_RELOAD',409);
  // In-flight/uncertain effects retain their evidence and require reconciliation; never resend.
  await tx.botApodAccion.updateMany({where:{expedienteId:c.id,status:{in:['PENDING','BLOCKED','FAILED']}},data:{status:'CANCELLED',lastError:'PHASE_ONE_CLOSED'}});
  await tx.botApodHumanTask.upsert({where:{dedupeKey:`phase-one:${c.id}`},create:{expedienteId:c.id,dedupeKey:`phase-one:${c.id}`,kind:'PHASE_ONE_COMPLETE',assignedTo:'DAYANA',reason:phaseOneLabels[outcome],evidence:proof},update:{}});
  await tx.botApodAuditLog.create({data:{expedienteId:c.id,event:'PHASE_ONE_CLOSED',operator,metadata:proof}});
}
