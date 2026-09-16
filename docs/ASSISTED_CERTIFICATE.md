# Isolated assisted certificate sessions

The operator API calls `runAssistedDraft` from `src/core/assisted-session.ts`. This is a one-shot operation with certificate and password buffers held only in RAM. It does not submit, sign or revoke a power.

```ts
import { runAssistedDraft } from './core/assisted-session.js';

// pfx and password must already be buffers from the authenticated, nonlogged multipart request.
const result = await runAssistedDraft({
  pfx, password, expectedDni, clientId,
  consent: { granted: true, clientId, dni: expectedDni,
    scope: 'SEDE_DRAFT_ONLY', expiresAt, evidenceRef },
  fields, // Server-selected case/address values, not unrestricted request data.
}, 180_000, abortSignal);
```

The exact result is:

```ts
{
  status: 'DRAFT_REQUIRES_HUMAN_SUBMISSION',
  pdf: Buffer,
  sha256: string,
  recipeId: string,
  inspection: {
    usable: true, passwordValid: true, keyMatchesCertificate: true,
    identityMatches: true, expired: false,
    certRef: string // 'sha256:' + SHA256 of the received certificate archive
  }
}
```

The function owns and zeroes the supplied certificate and password buffers on every return path, including validation, configuration and child-process startup failures. The caller must not attempt to reuse them. A result is delivered only after the child exits with code zero and the parent independently verifies PDF magic, size, SHA256 and certificate reference. No private keys, certificate subjects, password, PFX or extraction text are included in inspection metadata. The PDF still needs client review and the normal human document approval process.

Before calling, the operator route must authenticate the operator, bind the stored explicit consent to the current client/DNI and case version, read the approved geographic data, hold the case lock, and prepare the intended domain transitions. The certificate upload, password field and resulting draft must never enter request logs, Redis, BullMQ, event payloads or the outbox. Return errors by the static `AssistedSessionError.code` only. Cancellation can be bound to request disconnection through the third `AbortSignal` argument. A timeout is an uncertain external draft outcome and must not automatically trigger a new Sede operation.

`OUTBOUND_ENABLED=true` and a reviewed, enabled `SEDE_RECIPE_FILE` are required. Only the Sede configuration and a small OS/browser environment allowlist are inherited. Unrelated integration secrets, `NODE_OPTIONS`, debug logging and tracing variables are excluded. The child is invoked with an internal script path and no user values in arguments; sensitive buffers cross Node's advanced IPC serialization only. stdout and stderr are ignored. The child watchdog is bounded to five minutes; the default parent limit is three minutes. Both compiled `.js` and development `.ts` entrypoints are supported.

The normal cancellation path asks the child to exit, which runs Playwright's installed browser process-group cleanup. If the child does not exit within 1.5 seconds, the parent enumerates only PID/parent-PID pairs and terminates current descendants before forcefully terminating its own child. It never reads process arguments or environments. A five-second reap deadline reports `ASSISTED_CHILD_TERMINATION_UNCONFIRMED` if termination cannot be observed. PID enumeration fallback is POSIX-specific; deployment is macOS/Linux. External OS kills or a stalled kernel are outside the process's ability to prove cleanup.

Node and Chromium may temporarily hold immutable strings and additional copies of certificate material. Buffer zeroization and child termination shorten their lifetime; they cannot prove RAM/swap erasure or undo copies retained by OS diagnostics. The transport does not write credentials to files. Use a restricted host without process/core dumps for certificate-assisted operation. Real certificate identity/key/date validation and Sede draft behavior require real authorized inputs; no synthetic or mock verification is used.

The child uses the actual static `CertInspector.withCertificate({pfx,password,expectedDni}, callback, options)` API. Its callback can run for rejected certificates, so the child explicitly checks every report flag, the finite current validity window, zero rejection reasons, exactly one subject identity, an RSA key of at least 2048 bits, and an open session before accessing `session.material()` or contacting Sede. It rechecks the session and certificate expiry after draft generation. Returned inspection booleans come from that validated report. Trust-store chain validation and revocation checking are not performed by the inspector; authenticated Sede acceptance and subsequent human review remain separate evidence.
