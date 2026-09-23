#!/usr/bin/env node
/** Create a local-only APOD environment for the WCE WhatsApp emulator. */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';

const project = resolve(new URL('..', import.meta.url).pathname);
const sourcePath = resolve(project, '.env');
const targetPath = resolve(project, '.env.wce');
const source = parse(await readFile(sourcePath, 'utf8'));
const previous = await readFile(targetPath, 'utf8').then(parse).catch(() => ({}));
const required = (key) => {
  const value = source[key];
  if (!value?.trim()) throw new Error(`WCE_REQUIRES_LOCAL_${key}`);
  return value;
};
const appSecret = previous.WA_APP_SECRET || `wce-${randomBytes(24).toString('hex')}`;
const verifyToken = previous.WA_VERIFY_TOKEN || `wce-${randomBytes(24).toString('hex')}`;
const values = {
  NODE_ENV: 'development', SERVICE_MODE: 'live', DATA_MODE: 'real', HOST: '127.0.0.1', PORT: '4720',
  POSTGRES_PASSWORD: required('POSTGRES_PASSWORD'), DATABASE_URL: required('DATABASE_URL'), REDIS_URL: required('REDIS_URL'),
  QUEUE_PREFIX: 'apod-wce', OPERATOR_TOKEN: required('OPERATOR_TOKEN'), LOG_LEVEL: 'info', STORAGE_DIR: './storage',
  MAX_DOCUMENT_BYTES: '15000000', OUTBOUND_ENABLED: 'true', WORKERS_ENABLED: 'true', DEMO_DATA_ENABLED: 'true',
  // The first number is the demo chat the manager sees; the rest are training lines the emulator
  // accepts but never shows on screen.
  DEMO_WHATSAPP_RECIPIENTS: ['34663094035', ...(source.TRAINING_PHONES || '34600000101,34600000102,34600000103,34600000104,34600000105,34600000106,34600000107,34600000108').split(',').map(p => p.trim()).filter(Boolean)].join(','), WHATSAPP_ENABLED: 'true', WHATSAPP_TRANSPORT: 'emulator',
  WA_GRAPH_VERSION: 'v23.0', WA_API_BASE_URL: 'http://127.0.0.1:3001/send-to-emulator',
  WA_ACCESS_TOKEN: 'wce-local-access-token', WA_PHONE_NUMBER_ID: '999000000000', WA_BUSINESS_ACCOUNT_ID: 'wce-local-business',
  WA_APP_SECRET: appSecret, WA_VERIFY_TOKEN: verifyToken, WA_TEMPLATE_CONFIG_FILE: '',
  // Keep the conversation provider opt-in. When the operator later supplies
  // an approved Luna-compatible endpoint in .env, the WCE demo can exercise
  // the same provider without changing this script. Empty values remain the
  // safe local-policy-only default.
  CONVERSATION_PHASE: source.CONVERSATION_PHASE || '3', CONVERSATION_AI_PROVIDER: source.CONVERSATION_AI_PROVIDER || 'none', CONVERSATION_MODEL: source.CONVERSATION_MODEL || '',
  // The simulator answers as soon as the tester stops typing. Production keeps the 60s default,
  // where the wait is what lets a burst of client messages be read as one turn.
  CONVERSATION_QUIET_MS: source.CONVERSATION_QUIET_MS || '1000',
  CONVERSATION_BRAIN: source.CONVERSATION_BRAIN || 'on', BRAIN_MODEL: source.BRAIN_MODEL || '', BRAIN_REASONING_EFFORT: source.BRAIN_REASONING_EFFORT || '',
  GEMINI_API_KEY: source.GEMINI_API_KEY || '', ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY || '', APOD_AGENT_PACKAGE_DIR: source.APOD_AGENT_PACKAGE_DIR || '',
  APOD_MASTER_PROMPT_FILE:source.APOD_MASTER_PROMPT_FILE||'docs/source/apud_acta_master_prompt.md',APOD_AGENT_EVAL_REPORT:source.APOD_AGENT_EVAL_REPORT||'evidence/agent-evaluations.json',
  AI_MODE: source.AI_MODE || 'online', LOCAL_AI_BASE_URL: source.LOCAL_AI_BASE_URL || 'http://127.0.0.1:11434/v1', LOCAL_AI_MODEL: source.LOCAL_AI_MODEL || '', LOCAL_AI_API_KEY: source.LOCAL_AI_API_KEY || '',
  DAYANA_USER_ID: source.DAYANA_USER_ID || '', KMALEON_POLLER_ENABLED: 'false', KMALEON_POLL_INTERVAL_MS: source.KMALEON_POLL_INTERVAL_MS || '60000', REMINDERS_ENABLED: source.REMINDERS_ENABLED || 'true',
  AI_BASE_URL: source.AI_BASE_URL || '', AI_API_KEY: source.AI_API_KEY || '', AI_MODEL: source.AI_MODEL || '',
  AI_TIMEOUT_MS: source.AI_TIMEOUT_MS || '60000', AI_REDACT_PII: source.AI_REDACT_PII || 'true', AI_STREAM: source.AI_STREAM || 'true', AI_SIN_TEMPERATURE: source.AI_SIN_TEMPERATURE || source.AI_SIN_TEMPERATURA || 'true',
  KMALEON_ENABLED: 'false', KMALEON_CONFIG_FILE: '', KMALEON_BASE_URL: '', KMALEON_CLIENT_ID: '', KMALEON_CLIENT_SECRET: '', KMALEON_AUTH_STATE: '', KMALEON_REDIRECT_URI: '',
  APUDATA_ENABLED: 'false', APUDATA_CONFIG_FILE: '', APUDATA_BASE_URL: '', APUDATA_ACCESS_TOKEN: '', APUDATA_ACCOUNT_ID: '', APUDATA_PAYMENT_IBAN: '', APUDATA_PAYMENT_EVIDENCE_REF: '', APUDATA_CALLBACK_SECRET: '', APUDATA_CALLBACK_PROTOCOL_REVIEWED: 'false',
  SEDE_ENABLED: 'false', SEDE_RECIPE_FILE: '', AIRAM_FULL_NAME: source.AIRAM_FULL_NAME || '', REPRESENTATIVES_FILE: source.REPRESENTATIVES_FILE || '', TUTORIAL_FILE: source.TUTORIAL_FILE || '', CONSENT_VERSION: source.CONSENT_VERSION || 'DEMO-SIMULADOR', CONSENT_TEXT_FILE: '', REVOCATION_GUIDE_FILE: source.REVOCATION_GUIDE_FILE || '', REVOCATION_SCREENSHOTS_FILE: source.REVOCATION_SCREENSHOTS_FILE || '', GEO_CATALOG_FILE: '', PUBLIC_BASE_URL: 'http://127.0.0.1:4720', CARMEN_USER_ID: '', DEMO_DATA_PROVENANCE: 'WCE_LOCAL_ONLY',
};

// The WCE demo must be able to show the PC tutorial without pretending that
// the source package is production-approved. Generate a local-only roster
// from its already reviewed placeholder list when no roster was configured in
// .env. The generated file is ignored, mode 600, and is never used by Meta.
let demoMaterialsGenerated = false;
const referenceDir = source.APOD_AGENT_PACKAGE_DIR?.trim();
if (referenceDir && !values.REPRESENTATIVES_FILE && !values.TUTORIAL_FILE) {
  try {
    const placeholders = JSON.parse(await readFile(join(referenceDir, 'placeholders.json'), 'utf8'));
    const rosterText = placeholders?.LISTA_PROCURADORES_ABOGADOS?.value;
    const representatives = [];
    if (typeof rosterText === 'string') {
      const procuratorPattern = /-Nombre:\s*([^\n]+)\n-Num Colegiado:\s*([^\n]+)\n-Colegio:\s*([^\n]+)/g;
      for (const match of rosterText.matchAll(procuratorPattern)) {
        representatives.push({ fullName: match[1].trim(), role: 'PROCURADOR', registration: match[2].trim(), college: match[3].trim() });
      }
      const attorneys = rosterText.match(/Abogados:\s*([\s\S]+)$/i)?.[1] ?? '';
      for (const item of attorneys.split(/\s*,\s*/)) {
        const match = item.trim().match(/^(.+?)\s+(\d+)\s+(.+)$/);
        if (match) representatives.push({ fullName: match[1].trim(), role: 'ABOGADO', registration: match[2].trim(), college: match[3].trim() });
      }
    }
    const airam = representatives.find((representative) => representative.role === 'PROCURADOR' && /\bairam\b/i.test(representative.fullName));
    const tutorialPath = join(referenceDir, 'docs', 'guia_cliente_apud_acta.pdf');
    const tutorial = await readFile(tutorialPath);
    if (airam && representatives.length > 0 && tutorial.length > 0) {
      const rosterPath = resolve(project, '.runtime', 'wce-demo-representatives.json');
      await mkdir(resolve(project, '.runtime'), { recursive: true, mode: 0o700 });
      await writeFile(rosterPath, JSON.stringify({
        approvedBy: 'WCE_LOCAL_DEMO_SOURCE_AGENT',
        approvedAt: new Date().toISOString(),
        representatives,
      }), { mode: 0o600 });
      await chmod(rosterPath, 0o600);
      values.AIRAM_FULL_NAME = airam.fullName;
      values.REPRESENTATIVES_FILE = rosterPath;
      values.TUTORIAL_FILE = tutorialPath;
      demoMaterialsGenerated = true;
    }
    tutorial.fill(0);
  } catch {
    // Missing or malformed reference materials leave the action blocked
    // instead of inventing a tutorial or a professional roster.
  }
}
await mkdir(project, { recursive: true, mode: 0o700 });
const lines = ['# Generated local-only WCE environment; never use this file for Meta production.'];
for (const [key, value] of Object.entries(values)) lines.push(`${key}=${value}`);
await writeFile(targetPath, `${lines.join('\n')}\n`, { mode: 0o600 });
await chmod(targetPath, 0o600);
console.log(JSON.stringify({ environmentFile: targetPath, transport: 'emulator', recipient: '34663094035', externalMetaCalls: false, demoMaterialsGenerated, secretsPrinted: false }));
