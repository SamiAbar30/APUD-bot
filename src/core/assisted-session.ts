import { fork, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {dirname,resolve} from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_CERT_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const MAX_DRAFT_BYTES = 20 * 1024 * 1024;
const buffer = z.custom<Buffer>((value: unknown) => Buffer.isBuffer(value), { fatal: true });
export const AssistedDraftInputSchema = z.object({
  pfx: buffer.refine(value => value.length > 0 && value.length <= MAX_CERT_BYTES),
  password: buffer.refine(value => value.length <= MAX_PASSWORD_BYTES),
  expectedDni: z.string().regex(/^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/),
  clientId: z.string().min(1).max(160),
  consent: z.object({
    granted: z.literal(true), clientId: z.string().min(1).max(160),
    dni: z.string().min(1).max(20), scope: z.literal('SEDE_DRAFT_ONLY'),
    expiresAt: z.string().datetime({ offset: true }), evidenceRef: z.string().min(1).max(500),
  }).strict(),
  fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/), z.string().max(2000))
    .refine(value => Object.keys(value).length <= 80),
}).strict();
export type AssistedDraftInput = z.infer<typeof AssistedDraftInputSchema>;
export interface AssistedCertificateInspection {
  usable: true; passwordValid: true; keyMatchesCertificate: true;
  identityMatches: true; expired: false; certRef: string; certificateFingerprint:string;
}
export interface AssistedDraftResult {
  status: 'DRAFT_REQUIRES_HUMAN_SUBMISSION'; pdf: Buffer; sha256: string;
  recipeId: string; inspection: AssistedCertificateInspection;
}
const ResultSchema = z.object({
  type: z.literal('result'), status: z.literal('DRAFT_REQUIRES_HUMAN_SUBMISSION'),
  pdf: buffer.refine(value => value.length > 0 && value.length <= MAX_DRAFT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), recipeId: z.string().min(1).max(200),
  inspection: z.object({
    usable:z.literal(true), passwordValid:z.literal(true), keyMatchesCertificate:z.literal(true),
    identityMatches:z.literal(true), expired:z.literal(false), certRef:z.string().regex(/^sha256:[a-f0-9]{64}$/), certificateFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();
export class AssistedSessionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AssistedSessionError'; }
}
function wipe(value: unknown): void { if (Buffer.isBuffer(value)) value.fill(0); }
export function validateAssistedInput(input: unknown): AssistedDraftInput {
  const parsed = AssistedDraftInputSchema.safeParse(input);
  if (!parsed.success) throw new AssistedSessionError('ASSISTED_INPUT_INVALID');
  const value = parsed.data;
  if (value.consent.clientId !== value.clientId || value.consent.dni !== value.expectedDni || Date.parse(value.consent.expiresAt) <= Date.now()) {
    throw new AssistedSessionError('ASSISTED_SCOPED_CONSENT_REQUIRED');
  }
  if (Object.keys(value.fields).some(key => /password|passphrase|pfx|p12|secret|token|privatekey/i.test(key))) {
    throw new AssistedSessionError('ASSISTED_SECRET_FIELD_REJECTED');
  }
  return value;
}
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Exclude NODE_OPTIONS, debugger/tracing settings and credentials for unrelated integrations.
  for (const key of ['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH','NODE_ENV','OUTBOUND_ENABLED','SERVICE_MODE','DATA_MODE','SEDE_ENABLED','SEDE_RECIPE_FILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if(env.SEDE_RECIPE_FILE)env.SEDE_RECIPE_FILE=resolve(process.env.ENV_FILE?dirname(resolve(process.env.ENV_FILE)):process.cwd(),env.SEDE_RECIPE_FILE);
  return env;
}
/** Collect only descendant PIDs; no command lines or process environments are inspected. */
async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  return new Promise(resolve => execFile('/bin/ps', ['-A','-o','pid=,ppid='], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) { resolve([]); return; }
    const pairs = stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 2);
    const descendants = new Set([rootPid]); let grew = true;
    while (grew) { grew = false; for (const [pid, ppid] of pairs) if (pid && ppid && descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); grew = true; } }
    descendants.delete(rootPid); resolve([...descendants].reverse());
  }));
}
async function forceTerminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // Playwright launches a separate browser group. Discover current descendants before hard-killing.
  const pids = await descendantPids(child.pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  try { child.kill('SIGKILL'); } catch { /* Exit event settles the request. */ }
}
/**
 * Owns and wipes caller pfx/password buffers on every exit path. The returned PDF is a draft.
 * Never persist this input, put it in queues, or log it. Success waits for child termination.
 */
export async function runAssistedDraft(input: AssistedDraftInput, timeoutMs = 180_000, signal?: AbortSignal): Promise<AssistedDraftResult> {
  try {
    const checked = validateAssistedInput(input);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new AssistedSessionError('ASSISTED_TIMEOUT_INVALID');
    if (signal?.aborted) throw new AssistedSessionError('ASSISTED_CANCELLED');
    if (process.env.SERVICE_MODE !== 'live' || process.env.SEDE_ENABLED !== 'true' || process.env.DATA_MODE==='mock' || process.env.OUTBOUND_ENABLED !== 'true' || !process.env.SEDE_RECIPE_FILE) throw new AssistedSessionError('ASSISTED_SEDE_NOT_CONFIGURED_OR_ENABLED');
    const expectedCertRef = `sha256:${createHash('sha256').update(checked.pfx).digest('hex')}`;
    return await new Promise<AssistedDraftResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        const development = import.meta.url.endsWith('.ts');
        const path = fileURLToPath(new URL(`../../scripts/assisted-child.${development ? 'ts' : 'js'}`, import.meta.url));
        child = fork(path, [], { execArgv: development ? ['--import','tsx'] : [], env: childEnvironment(), stdio: ['ignore','ignore','ignore','ipc'], serialization: 'advanced' });
      } catch { reject(new AssistedSessionError('ASSISTED_CHILD_SPAWN_FAILED')); return; }
      let settled = false; let sent = false; let failure: AssistedSessionError | undefined;
      let result: AssistedDraftResult | undefined;
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      let reapDeadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: AssistedSessionError) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); if (hardKill) clearTimeout(hardKill); if (reapDeadline) clearTimeout(reapDeadline);
        signal?.removeEventListener('abort', abort);
        if (error) { wipe(result?.pdf); reject(error); } else if (result) resolve(result); else reject(new AssistedSessionError('ASSISTED_CHILD_RESULT_MISSING'));
      };
      const cancel = (code: string) => {
        if (settled || failure) return; failure = new AssistedSessionError(code);
        // Normal process.exit runs Playwright's registered browser-group cleanup handler.
        try { if (child.connected) child.send({ type: 'cancel' }, () => undefined); } catch { /* SIGTERM below. */ }
        try { child.kill('SIGTERM'); } catch { /* Forced fallback below. */ }
        hardKill = setTimeout(() => { void forceTerminate(child); }, 1500);
        reapDeadline = setTimeout(() => finish(new AssistedSessionError('ASSISTED_CHILD_TERMINATION_UNCONFIRMED')), 5000);
      };
      const abort = () => cancel('ASSISTED_CANCELLED');
      const deadline = setTimeout(() => cancel('ASSISTED_TIMED_OUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.on('message', (message: unknown) => {
        if (settled || failure) {
          if (message && typeof message === 'object' && 'pdf' in message) wipe(message.pdf);
          return;
        }
        if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
          if (sent) { cancel('ASSISTED_CHILD_PROTOCOL_INVALID'); return; }
          sent = true;
          try { child.send({ type: 'run', input: checked, timeoutMs }, error => { if (error) cancel('ASSISTED_CHILD_TRANSFER_FAILED'); }); }
          catch { cancel('ASSISTED_CHILD_TRANSFER_FAILED'); }
          return;
        }
        if (message && typeof message === 'object' && 'type' in message && message.type === 'error') {
          cancel('ASSISTED_CERTIFICATE_OR_DRAFT_REJECTED'); return;
        }
        const parsed = ResultSchema.safeParse(message);
        if (!sent || result || !parsed.success) {
          if (message && typeof message === 'object' && 'pdf' in message) wipe(message.pdf);
          cancel('ASSISTED_CHILD_RESULT_INVALID'); return;
        }
        const value = parsed.data;
        if (value.pdf.subarray(0,5).toString() !== '%PDF-' || createHash('sha256').update(value.pdf).digest('hex') !== value.sha256 || value.inspection.certRef !== expectedCertRef) {
          wipe(value.pdf); cancel('ASSISTED_CHILD_RESULT_INTEGRITY_FAILED'); return;
        }
        const { type: _type, ...draft } = value; result = draft;
      });
      child.once('error', () => { void forceTerminate(child); finish(new AssistedSessionError('ASSISTED_CHILD_PROCESS_FAILED')); });
      child.once('exit', (code, exitSignal) => {
        if (failure) { finish(failure); return; }
        if (code !== 0 || exitSignal) finish(new AssistedSessionError('ASSISTED_CHILD_EXIT_FAILED')); else finish();
      });
    });
  } finally { wipe(input?.pfx); wipe(input?.password); }
}
