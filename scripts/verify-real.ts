/**
 * Real-input verification runner (no mocks, no synthetic fixtures).
 *
 * Reads `test/fixtures/manifest.json` (see test/fixtures/README.md), which must reference REAL,
 * authorised inputs: sanitised apoderamiento PDFs received from Sede Judicial / courts / the
 * partner, an authorised test certificate (password supplied through the environment variable
 * named in the manifest), the reviewed partido-judicial catalog and at least one real expediente
 * identity. Every file is pinned by SHA-256.
 *
 * Exit code 1 whenever: the manifest is absent or invalid, any pinned hash differs, any password
 * variable is missing, any expectation fails, or any component has no real input at all.
 * There is no "skipped" outcome: a component without real input is reported NOT_VERIFIED and the
 * run fails. Nothing here contacts WhatsApp, Kmaleon, Apudata, Sede, mail or the database.
 *
 * Usage: `npm test` or `npx tsx scripts/verify-real.ts [path/to/manifest.json]`
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { PdfAuditor, type AuditReport } from '../src/core/pdf-auditor.js';
import { CertInspector } from '../src/core/cert-inspector.js';
import { GeoNormalizer } from '../src/core/geo-normalizer.js';
import { evaluateNextStep } from '../src/core/decision-engine.js';
import { DECISION_CONTRACT_FIELDS, assertDecisionContract } from '../src/contracts/decision.contract.js';
import { EventType, type WorkflowEvent } from '../src/domain/fsm/states.js';
import { AuditStatus, type Expediente } from '../src/domain/models/expediente.js';
import { maskIdentityDocument } from '../src/domain/identity/spanish-identity-document.js';
import { RealInputMissingError } from '../src/domain/errors/index.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const dni = z.string().regex(/^(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])$/);

const ManifestSchema = z
  .object({
    version: z.literal(1),
    authorization: z
      .object({
        authorizedBy: z.string().min(1),
        authorizedAt: z.string().datetime({ offset: true }),
        reference: z.string().min(1),
        scope: z.literal('REAL_SANITIZED_INPUTS_FOR_LOCAL_VERIFICATION'),
      })
      .strict(),
    airamFullName: z.string().min(5),
    expedientes: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            dni,
            nombre: z.string().min(1),
            telefono: z.string().min(6),
            kmaleonExpedienteId: z.string().min(1).nullable(),
            identityVerified: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    decisionReplays: z.array(z.object({file:z.string().min(1),sha256:hex64}).strict()).min(1),
    pdfs: z
      .array(
        z
          .object({
            file: z.string().min(1),
            sha256: hex64,
            expectedDni: dni,
            description: z.string().max(300).optional(),
            expected: z
              .object({
                status: z.nativeEnum(AuditStatus),
                isValid: z.boolean(),
                canViabilize: z.boolean(),
                hasAiram: z.boolean(),
                identityMatches: z.boolean(),
                pageCount: z.number().int().min(0),
                missingPowers: z.array(z.string()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
    certificates: z
      .array(
        z
          .object({
            file: z.string().min(1),
            sha256: hex64,
            passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            expectedDni: dni,
            expected: z.object({ usable: z.boolean(), identityMatches: z.boolean(), expired: z.boolean() }).strict(),
          })
          .strict(),
      )
      .min(1),
    geo: z
      .object({
        catalogFile: z.string().min(1),
        catalogSha256: hex64,
        cases: z
          .array(
            z
              .object({
                input: z
                  .object({
                    codigoPostal: z.string().optional(),
                    provincia: z.string().optional(),
                    localidad: z.string().optional(),
                    comunidadAutonoma: z.string().optional(),
                  })
                  .strict(),
                expected: z
                  .object({
                    status: z.enum(['RESOLVED', 'UNRESOLVED']),
                    partidoJudicial: z.string().optional(),
                    provinceIneCode: z.string().regex(/^\d{2}$/).optional(),
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

type Manifest = z.infer<typeof ManifestSchema>;

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

interface ComponentResult {
  status: 'VERIFIED' | 'FAILED' | 'NOT_VERIFIED';
  checks: CheckResult[];
}

const failures: string[] = [];

function check(results: CheckResult[], name: string, ok: boolean, detail: Record<string, unknown> = {}): boolean {
  results.push({ name, ok, ...(Object.keys(detail).length ? { detail } : {}) });
  if (!ok) failures.push(`${name}${detail.reason ? `: ${String(detail.reason)}` : ''}`);
  return ok;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readPinned(baseDir: string, file: string, expectedSha: string): Promise<Buffer> {
  const path = resolve(baseDir, file);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new RealInputMissingError(`Real input file missing: ${path}`, { file, cause: error instanceof Error ? error.message : String(error) });
  }
  const actual = sha256(bytes);
  if (actual !== expectedSha) {
    throw new RealInputMissingError(`Pinned SHA-256 mismatch for ${file}: manifest ${expectedSha.slice(0, 12)}… file ${actual.slice(0, 12)}…`, { file });
  }
  return bytes;
}

function componentStatus(checks: CheckResult[]): ComponentResult['status'] {
  if (checks.length === 0) return 'NOT_VERIFIED';
  return checks.every((c) => c.ok) ? 'VERIFIED' : 'FAILED';
}

// ---------------------------------------------------------------------------------------------
// PDF auditor against real documents
// ---------------------------------------------------------------------------------------------

async function verifyPdfs(manifest: Manifest, baseDir: string): Promise<{ component: ComponentResult; reports: { entry: Manifest['pdfs'][number]; report: AuditReport }[] }> {
  const checks: CheckResult[] = [];
  const reports: { entry: Manifest['pdfs'][number]; report: AuditReport }[] = [];
  for (const entry of manifest.pdfs) {
    const label = `pdf:${entry.file}`;
    let bytes: Buffer;
    try {
      bytes = await readPinned(baseDir, entry.file, entry.sha256);
    } catch (error) {
      check(checks, `${label}:pinned`, false, { reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const { report, details } = await PdfAuditor.auditDetailed(bytes, { expectedDni: entry.expectedDni, airamFullName: manifest.airamFullName });
    reports.push({ entry, report });
    const keys = Object.keys(report).sort();
    const expectedKeys = ['canViabilize', 'extractedText', 'hasAiram', 'identityMatches', 'isValid', 'missingPowers', 'pageCount', 'requiresHumanReview', 'sha256', 'status'];
    check(checks, `${label}:report-shape`, JSON.stringify(keys) === JSON.stringify(expectedKeys), { keys });
    check(checks, `${label}:sha256`, report.sha256 === entry.sha256);
    for (const field of ['status', 'isValid', 'canViabilize', 'hasAiram', 'identityMatches', 'pageCount'] as const) {
      const actual = report[field];
      const expected = entry.expected[field];
      check(checks, `${label}:${field}`, actual === expected, { expected, actual, reasons: details.reasons });
    }
    if (entry.expected.missingPowers) {
      const expected = [...entry.expected.missingPowers].sort();
      const actual = [...report.missingPowers].sort();
      check(checks, `${label}:missingPowers`, JSON.stringify(expected) === JSON.stringify(actual), { expected, actual });
    }
    if (report.status !== AuditStatus.UNREADABLE_OR_CORRUPT) {
      check(checks, `${label}:text-extracted`, report.extractedText.length > 0, { textTokens: details.textTokens });
    }
    check(checks, `${label}:human-review-flag`, report.isValid ? typeof report.requiresHumanReview === 'boolean' : report.requiresHumanReview === true, {
      isValid: report.isValid,
      requiresHumanReview: report.requiresHumanReview,
    });
    check(checks, `${label}:airam-strong-match-only`, !report.hasAiram || details.airamMatch === 'FULL_NAME', { airamMatch: details.airamMatch });
  }
  return { component: { status: componentStatus(checks), checks }, reports };
}

// ---------------------------------------------------------------------------------------------
// Certificate inspector against a real authorised certificate
// ---------------------------------------------------------------------------------------------

async function verifyCertificates(manifest: Manifest, baseDir: string): Promise<ComponentResult> {
  const checks: CheckResult[] = [];
  for (const entry of manifest.certificates) {
    const label = `certificate:${entry.file}`;
    let bytes: Buffer;
    try {
      bytes = await readPinned(baseDir, entry.file, entry.sha256);
    } catch (error) {
      check(checks, `${label}:pinned`, false, { reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const password = process.env[entry.passwordEnv];
    if (typeof password !== 'string' || password.length === 0) {
      bytes.fill(0);
      check(checks, `${label}:password-env`, false, { reason: `environment variable ${entry.passwordEnv} not set; refusing to guess` });
      continue;
    }
    const inspection = await CertInspector.inspect({ pfx: bytes, password, expectedDni: entry.expectedDni }, { maxLifetimeMs: 30_000 });
    check(checks, `${label}:buffer-wiped`, bytes.every((b) => b === 0));
    for (const field of ['usable', 'identityMatches', 'expired'] as const) {
      check(checks, `${label}:${field}`, inspection[field] === entry.expected[field], { expected: entry.expected[field], actual: inspection[field], reasons: inspection.reasons });
    }
    check(checks, `${label}:no-chain-claim`, inspection.chainValidated === false);
    check(checks, `${label}:fingerprint`, !inspection.passwordValid || typeof inspection.fingerprintSha256 === 'string', { fingerprintSha256: inspection.fingerprintSha256 });
    if (inspection.usable) {
      check(checks, `${label}:key-bound`, inspection.keyMatchesCertificate && inspection.keyAlgorithm === 'RSA' && (inspection.keyBits ?? 0) >= 2048, {
        keyAlgorithm: inspection.keyAlgorithm,
        keyBits: inspection.keyBits,
      });
    }
    // Session close semantics with the same real material would require a second read; the
    // buffer-wipe check above already proves consumption.
  }
  return { status: componentStatus(checks), checks };
}

// ---------------------------------------------------------------------------------------------
// Geo normaliser against the reviewed catalog
// ---------------------------------------------------------------------------------------------

async function verifyGeo(manifest: Manifest, baseDir: string): Promise<ComponentResult> {
  const checks: CheckResult[] = [];
  let normalizer: GeoNormalizer;
  try {
    const bytes = await readPinned(baseDir, manifest.geo.catalogFile, manifest.geo.catalogSha256);
    normalizer = GeoNormalizer.fromCatalog(JSON.parse(bytes.toString('utf8')));
    check(checks, 'geo:catalog-loaded', true, { partidos: normalizer.catalog?.partidos.length ?? 0 });
  } catch (error) {
    check(checks, 'geo:catalog-loaded', false, { reason: error instanceof Error ? error.message : String(error) });
    return { status: 'FAILED', checks };
  }
  manifest.geo.cases.forEach((geoCase, index) => {
    const label = `geo:case[${index}]`;
    const result = normalizer.resolve(geoCase.input);
    check(checks, `${label}:status`, result.status === geoCase.expected.status, { expected: geoCase.expected.status, actual: result.status, reasons: result.reasons });
    if (geoCase.expected.partidoJudicial !== undefined) {
      check(checks, `${label}:partido`, result.partidoJudicial?.name === geoCase.expected.partidoJudicial, { expected: geoCase.expected.partidoJudicial, actual: result.partidoJudicial?.name ?? null });
    }
    if (geoCase.expected.provinceIneCode !== undefined) {
      check(checks, `${label}:province`, result.provincia?.ineCode === geoCase.expected.provinceIneCode, { expected: geoCase.expected.provinceIneCode, actual: result.provincia?.ineCode ?? null });
    }
    const again = normalizer.resolve(geoCase.input);
    check(checks, `${label}:deterministic`, JSON.stringify(again) === JSON.stringify(result));
  });
  return { status: componentStatus(checks), checks };
}

// ---------------------------------------------------------------------------------------------
// Decision engine: captured real decisions only
// ---------------------------------------------------------------------------------------------

/** Replays only captured real inputs/decisions; never manufactures state transitions or approvals. */
async function verifyEngine(manifest: Manifest, baseDir: string): Promise<ComponentResult> {
  const checks: CheckResult[]=[];
  const replaySchema=z.object({evidenceRef:z.string().min(5),recordedAt:z.string().datetime({offset:true}),snapshot:z.record(z.unknown()),event:z.object({type:z.nativeEnum(EventType),payload:z.record(z.unknown()).optional()}).strict(),expectedDecision:z.unknown()}).strict();
  for(const [index,entry] of manifest.decisionReplays.entries()){
    const label='engine:recorded-decision:'+index;
    try{
      const bytes=await readPinned(baseDir,entry.file,entry.sha256);
      const replay=replaySchema.parse(JSON.parse(bytes.toString('utf8')));bytes.fill(0);
      const snapshot={...replay.snapshot};
      for(const key of ['apudataApprovalExpiresAt','consentGrantedAt','lastInboundAt'])if(typeof snapshot[key]==='string')snapshot[key]=new Date(snapshot[key] as string);
      const identity=manifest.expedientes.find(e=>e.id===snapshot.id&&e.dni===snapshot.dni);
      if(!identity)throw new Error('Recorded snapshot does not match a real manifest expediente');
      const expected=replay.expectedDecision;assertDecisionContract(expected);
      const actual=evaluateNextStep(snapshot as unknown as Expediente,replay.event as WorkflowEvent,{now:new Date(replay.recordedAt)});
      assertDecisionContract(actual);
      check(checks,label+':contract',Object.keys(actual).length===DECISION_CONTRACT_FIELDS.length);
      check(checks,label+':recorded-result',JSON.stringify(actual)===JSON.stringify(expected),{evidenceRef:replay.evidenceRef});
    }catch{check(checks,label,false,{reason:'Real replay missing, invalid, mismatched or not reproducible'});}
  }
  return {status:componentStatus(checks),checks};
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const manifestPath = resolve(process.argv[2] ?? 'test/fixtures/manifest.json');
  const baseDir = dirname(manifestPath);
  const startedAt = new Date();
  let manifest: Manifest;
  try {
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      throw new RealInputMissingError(`Real inputs manifest absent: ${manifestPath}. No synthetic fixtures are generated; see test/fixtures/README.md.`);
    }
    const parsed = ManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new RealInputMissingError('Manifest does not match the required schema', { issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    manifest = parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof RealInputMissingError ? error.details : {};
    console.error(`FAIL REAL_INPUT_MISSING: ${message}`);
    if (Object.keys(details).length) console.error(JSON.stringify(details, null, 2));
    await writeEvidence({ at: startedAt.toISOString(), overall: 'FAIL', reason: 'REAL_INPUT_MISSING', message, details });
    return 1;
  }

  const pdfs = await verifyPdfs(manifest, baseDir);
  const certificates = await verifyCertificates(manifest, baseDir);
  const geo = await verifyGeo(manifest, baseDir);
  const engine = await verifyEngine(manifest, baseDir);
  const components = { pdfAuditor: pdfs.component, certInspector: certificates, geoNormalizer: geo, decisionEngine: engine };
  const overall = Object.values(components).every((c) => c.status === 'VERIFIED') ? 'PASS' : 'FAIL';

  const evidence = {
    at: startedAt.toISOString(),
    manifest: { path: manifestPath, authorization: manifest.authorization, expedientes: manifest.expedientes.map((e) => ({ id: e.id, dni: maskIdentityDocument(e.dni) })) },
    components,
    overall,
    failures,
    notVerifiedByThisRunner: [
      'live WhatsApp delivery',
      'Kmaleon upload/notice read-back',
      'Apudata partner calls and payments',
      'Sede Judicial draft or submission',
      'legal sufficiency or signature authenticity of any document',
    ],
  };
  await writeEvidence(evidence);
  for (const [name, component] of Object.entries(components)) {
    const failed = component.checks.filter((c) => !c.ok).length;
    console.log(`${component.status.padEnd(12)} ${name} (${component.checks.length} checks, ${failed} failed)`);
  }
  if (failures.length) {
    console.error('Failures:');
    for (const failure of failures) console.error(`  - ${failure}`);
  }
  console.log(`OVERALL ${overall}`);
  return overall === 'PASS' ? 0 : 1;
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  const path = resolve('evidence/real-verification.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`FAIL RUNNER_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
