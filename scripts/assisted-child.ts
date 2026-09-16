/** Internal one-shot child. Secrets enter only through inherited IPC and never leave this process. */
import { createHash } from 'node:crypto';
import { loadConfiguredAdapters } from '../src/adapters/configured.js';
import { validateAssistedInput, type AssistedDraftInput, type AssistedDraftResult } from '../src/core/assisted-session.js';
import { CertInspector } from '../src/core/cert-inspector.js';

let input: AssistedDraftInput | undefined;
let completed = false;
let running = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;
function wipe(): void { input?.pfx.fill(0); input?.password.fill(0); }
function exit(code: number): never {
  completed = true; if (watchdog) clearTimeout(watchdog); wipe();
  // Playwright's exit handler terminates its detached browser process group.
  process.exit(code);
}
function fail(): void {
  if (completed) return; completed = true; wipe();
  if (process.connected && process.send) process.send({ type: 'error' }, () => exit(1)); else exit(1);
  setTimeout(() => exit(1), 250).unref();
}
process.once('SIGTERM', () => exit(1));
process.once('SIGINT', () => exit(1));
process.once('disconnect', () => exit(1));
process.once('uncaughtException', fail);
process.once('unhandledRejection', fail);
if (!process.send || !process.connected) process.exit(1);

async function run(raw: unknown, timeoutMs: unknown): Promise<void> {
  // Capture secret buffers before schema validation so invalid input is also wiped.
  const candidate = raw as Partial<AssistedDraftInput> | null;
  try {
    input = validateAssistedInput(raw);
    if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 300_000) throw new Error('INVALID_DEADLINE');
    watchdog = setTimeout(() => exit(1), Number(timeoutMs));
    const adapters = await loadConfiguredAdapters(process.env);
    if (!adapters.sede) throw new Error('SEDE_NOT_CONFIGURED');
    const certRef = `sha256:${createHash('sha256').update(input.pfx).digest('hex')}`;
    const password = new TextDecoder('utf-8', { fatal: true }).decode(input.password);
    const result = await CertInspector.withCertificate({
      pfx: input.pfx, password, expectedDni: input.expectedDni,
    }, async session => {
      if (!input) throw new Error('INPUT_UNAVAILABLE');
      const report = session.inspection;
      // The inspector calls its callback even for rejected material: check every guard here.
      if (!session.isOpen() || !report.usable || !report.passwordValid || !report.keyMatchesCertificate || !report.identityMatches || report.expired || report.notYetValid ||
          !report.validFrom || !report.validTo || !Number.isFinite(report.validFrom.getTime()) || !Number.isFinite(report.validTo.getTime()) ||
          report.validFrom.getTime() > Date.now() || report.validTo.getTime() <= Date.now() || report.reasons.length !== 0 ||
          report.identityDocumentsFound.length !== 1 || report.keyAlgorithm !== 'RSA' || !report.keyBits || report.keyBits < 2048) {
        throw new Error('CERTIFICATE_REJECTED');
      }
      const certificate = session.material();
      const draft = await adapters.sede!.prepareDraft({
        clientId: input.clientId, expectedDni: input.expectedDni, consent: input.consent,
        certificate, fields: input.fields,
      });
      if (!session.isOpen() || report.validTo.getTime() <= Date.now()) { draft.pdf.fill(0); throw new Error('CERTIFICATE_SESSION_EXPIRED'); }
      const verified: AssistedDraftResult = {
        ...draft, inspection: {
          usable: report.usable, passwordValid: report.passwordValid,
          keyMatchesCertificate: report.keyMatchesCertificate, identityMatches: report.identityMatches,
          expired: report.expired, certRef,
        },
      };
      return verified;
    }, { maxLifetimeMs: Number(timeoutMs), maxPfxBytes: 1024 * 1024 });
    wipe();
    if (!process.connected || !process.send) { result.pdf.fill(0); exit(1); }
    process.send({ type:'result', ...result }, error => { result.pdf.fill(0); exit(error ? 1 : 0); });
  } catch { fail(); }
  finally {
    if (Buffer.isBuffer(candidate?.pfx)) candidate.pfx.fill(0);
    if (Buffer.isBuffer(candidate?.password)) candidate.password.fill(0);
  }
}
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) { fail(); return; }
  if (message.type === 'cancel') exit(1);
  if (message.type !== 'run' || running || !('input' in message) || !('timeoutMs' in message)) { fail(); return; }
  running = true; void run(message.input, message.timeoutMs);
});
process.send!({ type:'ready' }, error => { if (error) exit(1); });
// An orphaned child never waits indefinitely for a secret message.
setTimeout(() => { if (!running) exit(1); }, 10_000).unref();
