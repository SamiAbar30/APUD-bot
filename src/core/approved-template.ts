import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BotApodExpediente } from '@prisma/client';
import { AppError } from '../infrastructure/security.js';
const Config=z.object({reviewed:z.literal(true),reviewEvidenceRef:z.string().min(4),templates:z.record(z.object({name:z.string().regex(/^[a-z0-9_]+$/),language:z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?$/),parameterSources:z.array(z.enum(['nombre','dni'])).max(10)}).strict())}).strict();
export async function approvedTemplate(file:string|undefined,templateId:string,c:BotApodExpediente){
  if(!file)throw new AppError('WHATSAPP_APPROVED_TEMPLATE_REQUIRED');
  const cfg=Config.parse(JSON.parse(await readFile(file,'utf8')));const scopedKey=/^FOLLOWUP_DAY(?:3|7|15)$/.test(templateId)?`${templateId}:${c.stepReached}`:templateId==='ASK_HAS_CERT'&&c.priorConversation?'ASK_HAS_CERT:RETURNING':templateId;const t=cfg.templates[scopedKey];if(!t)throw new AppError('WHATSAPP_TEMPLATE_NOT_APPROVED');
  // Financial details and certificate consent require exact in-window reviewed content.
  if(['APUDATA_PAYMENT_DETAILS','ASSIST_CONSENT_REQUEST','DRAFT_REVIEW_REQUEST'].includes(templateId))throw new AppError('WHATSAPP_CLIENT_REPLY_REQUIRED');
  return {name:t.name,language:t.language,parameters:t.parameterSources.map(key=>c[key]),reviewEvidenceRef:cfg.reviewEvidenceRef};
}
