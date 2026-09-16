/**
 * In-memory PKCS#12 certificate inspector with callback-scoped, time-bounded use.
 *
 * Guarantees
 *   - No file writes, no logging, no persistence of the password or the PFX bytes.
 *   - Parsing verifies the PKCS#12 MAC (password), pairs the private key with the end-entity
 *     certificate (modulus comparison + sign/verify round trip), checks the validity window and
 *     binds the subject to the expected DNI/NIE (serialNumber `IDCES-…` and CN patterns).
 *   - The PFX buffer and derived buffers are zero-filled when the callback finishes, throws, or
 *     the bounded lifetime elapses; the forge key object is scrubbed best-effort.
 *
 * Documented limitation: JavaScript strings are immutable. The password and the binary string
 * forge needs (`pfx.toString('binary')`) cannot be zeroised; the runtime may keep copies until
 * garbage collection. Run assisted-certificate jobs in short-lived, isolated processes.
 *
 * Not performed: chain validation against a trust store (`chainValidated` is always false).
 * Issuer fields are informational only.
 */

import forge from 'node-forge';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CertificateInspectionError,
  CertificateSessionClosedError,
  InvalidArgumentError,
  TimeoutError,
} from '../domain/errors/index.js';
import {
  findIdentityDocumentsInText,
  identityDocumentsEqual,
  maskIdentityDocument,
  normalizeIdentityDocument,
  parseSpanishIdentityDocument,
} from '../domain/identity/spanish-identity-document.js';

export interface CertificateMaterial {
  /** PKCS#12 bytes. WIPED (zero-filled) by the inspector when the session closes. */
  pfx: Buffer;
  password: string;
  expectedDni: string;
}

export interface CertInspectorOptions {
  /** Upper bound for the callback; the session closes and material is wiped afterwards. */
  maxLifetimeMs?: number;
  maxPfxBytes?: number;
  now?: Date;
}

export enum CertificateRejectionReason {
  EMPTY_PFX = 'EMPTY_PFX',
  PFX_TOO_LARGE = 'PFX_TOO_LARGE',
  NOT_PKCS12 = 'NOT_PKCS12',
  PASSWORD_INVALID = 'PASSWORD_INVALID',
  NO_CERTIFICATE = 'NO_CERTIFICATE',
  NO_PRIVATE_KEY = 'NO_PRIVATE_KEY',
  KEY_NOT_RSA = 'KEY_NOT_RSA',
  KEY_CERT_MISMATCH = 'KEY_CERT_MISMATCH',
  MULTIPLE_CREDENTIALS = 'MULTIPLE_CREDENTIALS',
  PASSWORD_PROTECTION_REQUIRED = 'PASSWORD_PROTECTION_REQUIRED',
  KEY_TOO_WEAK = 'KEY_TOO_WEAK',
  IDENTITY_AMBIGUOUS = 'IDENTITY_AMBIGUOUS',
  EXPIRED = 'EXPIRED',
  NOT_YET_VALID = 'NOT_YET_VALID',
  EXPECTED_IDENTITY_INVALID = 'EXPECTED_IDENTITY_INVALID',
  IDENTITY_NOT_IN_SUBJECT = 'IDENTITY_NOT_IN_SUBJECT',
  IDENTITY_MISMATCH = 'IDENTITY_MISMATCH',
}

export interface CertificateInspection {
  usable: boolean;
  passwordValid: boolean;
  keyMatchesCertificate: boolean;
  identityMatches: boolean;
  expired: boolean;
  notYetValid: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  daysUntilExpiry: number | null;
  subject: { commonName: string | null; serialNumber: string | null; givenName: string | null; surname: string | null; organization: string | null };
  issuer: { commonName: string | null; organization: string | null };
  /** Masked identity documents found in the subject (`*****78Z`). */
  identityDocumentsFound: string[];
  /** SHA-256 of the end-entity certificate DER (safe public identifier). */
  fingerprintSha256: string | null;
  keyAlgorithm: 'RSA' | 'UNSUPPORTED' | null;
  keyBits: number | null;
  keyUsage: { digitalSignature: boolean; nonRepudiation: boolean } | null;
  /** Always false: no trust-store chain validation is performed here. */
  chainValidated: false;
  reasons: CertificateRejectionReason[];
}

export interface CertificateSession {
  readonly certRef: string;
  readonly inspection: CertificateInspection;
  isOpen(): boolean;
  /** Material for a client-certificate consumer. Throws when closed or not usable. */
  material(): { pfx: Buffer; passphrase: string };
}

export const CERT_INSPECTOR_DEFAULTS = Object.freeze({
  MAX_LIFETIME_MS: 120_000,
  MAX_LIFETIME_CAP_MS: 600_000,
  MAX_PFX_BYTES: 65_536,
});

const OID = Object.freeze({
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  serialNumber: '2.5.4.5',
  organization: '2.5.4.10',
  givenName: '2.5.4.42',
});

type Scrubbable = { data?: number[]; t?: number };

function attributeValues(entity: { attributes: forge.pki.CertificateField[] }): Map<string, string> {
  const map = new Map<string, string>();
  for (const attribute of entity.attributes) {
    const type = attribute.type ?? '';
    const value = typeof attribute.value === 'string' ? attribute.value : Array.isArray(attribute.value) ? attribute.value.filter((v) => typeof v === 'string').join(' ') : '';
    if (type && value && !map.has(type)) map.set(type, value);
  }
  return map;
}

function scrubKey(key: forge.pki.rsa.PrivateKey | undefined): void {
  if (!key) return;
  for (const field of ['d', 'p', 'q', 'dP', 'dQ', 'qInv', 'n', 'e'] as const) {
    try {
      const big = key[field] as unknown as Scrubbable | undefined;
      if (big && Array.isArray(big.data)) big.data.fill(0);
      if (big) big.t = 0;
    } catch {
      // best effort only
    }
  }
}

function keyMatches(key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate): boolean {
  const pub = cert.publicKey as unknown as Partial<forge.pki.rsa.PublicKey>;
  if (!pub || typeof pub.n?.compareTo !== 'function' || typeof pub.verify !== 'function') return false;
  if (key.n.compareTo(pub.n) !== 0 || key.e.compareTo(pub.e as forge.jsbn.BigInteger) !== 0) return false;
  const md = forge.md.sha256.create();
  md.update(randomBytes(32).toString('binary'));
  const signature = key.sign(md);
  return pub.verify(md.digest().bytes(), signature);
}

function isRsaPrivateKey(key: unknown): key is forge.pki.rsa.PrivateKey {
  const k = key as Partial<forge.pki.rsa.PrivateKey> | null;
  return !!k && typeof k.sign === 'function' && !!k.n && typeof k.n.bitLength === 'function' && !!k.d;
}

interface ParsedMaterial {
  certificate: forge.pki.Certificate | null;
  key: forge.pki.rsa.PrivateKey | null;
  keys: forge.pki.rsa.PrivateKey[];
  reasons: CertificateRejectionReason[];
  passwordValid: boolean;
  keyAlgorithm: CertificateInspection['keyAlgorithm'];
}

function parsePkcs12(pfx: Buffer, password: string): ParsedMaterial {
  const reasons: CertificateRejectionReason[] = [];
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    // PKCS#12 MacData is the optional third PFX sequence member. Without it,
    // parsing a plaintext key bag cannot prove that the supplied password is valid.
    if(!Array.isArray(asn1.value)||asn1.value.length!==3){
      return {certificate:null,key:null,keys:[],reasons:[CertificateRejectionReason.PASSWORD_PROTECTION_REQUIRED],passwordValid:false,keyAlgorithm:null};
    }
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /mac could not be verified|invalid password|pkcs#12 mac/i.test(message) ? CertificateRejectionReason.PASSWORD_INVALID : CertificateRejectionReason.NOT_PKCS12;
    return { certificate: null, key: null, keys: [], reasons: [reason], passwordValid: reason !== CertificateRejectionReason.PASSWORD_INVALID && false, keyAlgorithm: null };
  }

  const certBagType = forge.pki.oids['certBag'] ?? '';
  const shroudedType = forge.pki.oids['pkcs8ShroudedKeyBag'] ?? '';
  const keyBagType = forge.pki.oids['keyBag'] ?? '';
  const certs = (p12.getBags({ bagType: certBagType })[certBagType] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const rawKeys = [...(p12.getBags({ bagType: shroudedType })[shroudedType] ?? []), ...(p12.getBags({ bagType: keyBagType })[keyBagType] ?? [])].map((b) => b.key);
  const keys = rawKeys.filter(isRsaPrivateKey);
  const endEntities=certs.filter(c=>(c.getExtension('basicConstraints') as {cA?:boolean}|null)?.cA!==true);
  // The whole archive is passed to Chromium. Permit exactly one selectable identity,
  // so Chromium cannot authenticate using a different key from the one inspected.
  if(rawKeys.length!==1||endEntities.length!==1)reasons.push(CertificateRejectionReason.MULTIPLE_CREDENTIALS);
  let keyAlgorithm: CertificateInspection['keyAlgorithm'] = null;
  if (rawKeys.length === 0) reasons.push(CertificateRejectionReason.NO_PRIVATE_KEY);
  else if (keys.length === 0) {
    reasons.push(CertificateRejectionReason.KEY_NOT_RSA);
    keyAlgorithm = 'UNSUPPORTED';
  } else keyAlgorithm = 'RSA';
  if (certs.length === 0) reasons.push(CertificateRejectionReason.NO_CERTIFICATE);

  let certificate: forge.pki.Certificate | null = null;
  let key: forge.pki.rsa.PrivateKey | null = null;
  for (const candidateKey of keys) {
    const paired = endEntities.find((c) => {
      try {
        return keyMatches(candidateKey, c);
      } catch {
        return false;
      }
    });
    if (paired) {
      certificate = paired;
      key = candidateKey;
      break;
    }
  }
  if (!certificate && certs.length > 0) {
    // No pairing: prefer a non-CA certificate for reporting; usability stays false.
    certificate = certs.find((c) => {
      const ext = c.getExtension('basicConstraints') as { cA?: boolean } | null;
      return !ext || ext.cA !== true;
    }) ?? certs[0] ?? null;
    if (keys.length > 0) reasons.push(CertificateRejectionReason.KEY_CERT_MISMATCH);
  }
  return { certificate, key, keys, reasons, passwordValid: true, keyAlgorithm };
}

function inspectMaterial(material: CertificateMaterial, options: CertInspectorOptions): { inspection: CertificateInspection; keys: forge.pki.rsa.PrivateKey[] } {
  const now = options.now ?? new Date();
  const maxPfxBytes = options.maxPfxBytes ?? CERT_INSPECTOR_DEFAULTS.MAX_PFX_BYTES;
  const empty: CertificateInspection = {
    usable: false,
    passwordValid: false,
    keyMatchesCertificate: false,
    identityMatches: false,
    expired: false,
    notYetValid: false,
    validFrom: null,
    validTo: null,
    daysUntilExpiry: null,
    subject: { commonName: null, serialNumber: null, givenName: null, surname: null, organization: null },
    issuer: { commonName: null, organization: null },
    identityDocumentsFound: [],
    fingerprintSha256: null,
    keyAlgorithm: null,
    keyBits: null,
    keyUsage: null,
    chainValidated: false,
    reasons: [],
  };

  if (material.pfx.length === 0) return { inspection: { ...empty, reasons: [CertificateRejectionReason.EMPTY_PFX] }, keys: [] };
  if (material.pfx.length > maxPfxBytes) return { inspection: { ...empty, reasons: [CertificateRejectionReason.PFX_TOO_LARGE] }, keys: [] };

  const parsed = parsePkcs12(material.pfx, material.password);
  const reasons = [...parsed.reasons];
  if (!parsed.passwordValid) {
    return { inspection: { ...empty, reasons }, keys: [] };
  }
  const cert = parsed.certificate;
  if (!cert) return { inspection: { ...empty, passwordValid: true, keyAlgorithm: parsed.keyAlgorithm, reasons }, keys: parsed.keys };

  const subject = attributeValues(cert.subject);
  const issuer = attributeValues(cert.issuer);
  const validFrom = cert.validity.notBefore;
  const validTo = cert.validity.notAfter;
  const expired = validTo.getTime() <= now.getTime();
  const notYetValid = validFrom.getTime() > now.getTime();
  if (expired) reasons.push(CertificateRejectionReason.EXPIRED);
  if (notYetValid) reasons.push(CertificateRejectionReason.NOT_YET_VALID);

  const expectedValid = parseSpanishIdentityDocument(material.expectedDni).valid;
  const subjectText = cert.subject.attributes.map(a=>typeof a.value==='string'?a.value:'').join(' ');
  const candidates = new Set<string>(findIdentityDocumentsInText(subjectText));
  const serial = subject.get(OID.serialNumber);
  if (serial) {
    const normalized = normalizeIdentityDocument(serial);
    if (parseSpanishIdentityDocument(normalized).valid) candidates.add(normalized);
  }
  let identityMatches = false;
  if (!expectedValid) reasons.push(CertificateRejectionReason.EXPECTED_IDENTITY_INVALID);
  else if (candidates.size === 0) reasons.push(CertificateRejectionReason.IDENTITY_NOT_IN_SUBJECT);
  else {
    identityMatches = [...candidates].some((c) => identityDocumentsEqual(material.expectedDni, c));
    if (!identityMatches) reasons.push(CertificateRejectionReason.IDENTITY_MISMATCH);
  }

  let fingerprintSha256: string | null = null;
  try {
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    fingerprintSha256 = createHash('sha256').update(der).digest('hex');
    der.fill(0);
  } catch {
    fingerprintSha256 = null;
  }

  const keyUsageExt = cert.getExtension('keyUsage') as { digitalSignature?: boolean; nonRepudiation?: boolean } | null;
  const keyMatchesCertificate = parsed.key !== null;
  const keyBits = parsed.key ? parsed.key.n.bitLength() : null;
  if(keyBits!==null&&keyBits<2048)reasons.push(CertificateRejectionReason.KEY_TOO_WEAK);
  if(candidates.size>1)reasons.push(CertificateRejectionReason.IDENTITY_AMBIGUOUS);
  const usable = keyMatchesCertificate && identityMatches && !expired && !notYetValid && parsed.keyAlgorithm === 'RSA' && reasons.length===0;

  return {
    inspection: {
      usable,
      passwordValid: true,
      keyMatchesCertificate,
      identityMatches,
      expired,
      notYetValid,
      validFrom,
      validTo,
      daysUntilExpiry: Math.floor((validTo.getTime() - now.getTime()) / 86_400_000),
      subject: {
        commonName: subject.get(OID.commonName) ?? null,
        serialNumber: serial ? maskIdentityDocument(serial) : null,
        givenName: subject.get(OID.givenName) ?? null,
        surname: subject.get(OID.surname) ?? null,
        organization: subject.get(OID.organization) ?? null,
      },
      issuer: { commonName: issuer.get(OID.commonName) ?? null, organization: issuer.get(OID.organization) ?? null },
      identityDocumentsFound: [...candidates].map(maskIdentityDocument),
      fingerprintSha256,
      keyAlgorithm: parsed.keyAlgorithm,
      keyBits,
      keyUsage: keyUsageExt ? { digitalSignature: keyUsageExt.digitalSignature === true, nonRepudiation: keyUsageExt.nonRepudiation === true } : null,
      chainValidated: false,
      reasons,
    },
    keys: parsed.keys,
  };
}

export class CertInspector {
  /**
   * Inspects the material and hands a bounded session to `use`. When `use` settles (or the
   * lifetime elapses) the PFX buffer is zero-filled and the session refuses further access.
   */
  static async withCertificate<T>(material: CertificateMaterial, use: (session: CertificateSession) => Promise<T>, options: CertInspectorOptions = {}): Promise<T> {
    if (!material || !Buffer.isBuffer(material.pfx)) throw new InvalidArgumentError('material.pfx must be a Buffer');
    if (typeof material.password !== 'string') throw new InvalidArgumentError('material.password must be a string');
    if (typeof material.expectedDni !== 'string' || material.expectedDni.trim().length === 0) throw new InvalidArgumentError('material.expectedDni required');
    if (typeof use !== 'function') throw new InvalidArgumentError('use callback required');
    const maxLifetimeMs = Math.min(Math.max(options.maxLifetimeMs ?? CERT_INSPECTOR_DEFAULTS.MAX_LIFETIME_MS, 1_000), CERT_INSPECTOR_DEFAULTS.MAX_LIFETIME_CAP_MS);

    let open = true;
    let keys: forge.pki.rsa.PrivateKey[] = [];
    let inspection: CertificateInspection;
    try {
      const result = inspectMaterial(material, options);
      inspection = result.inspection;
      keys = result.keys;
    } catch (error) {
      material.pfx.fill(0);
      throw new CertificateInspectionError('Certificate inspection failed', {}, { cause: error });
    }

    const session: CertificateSession = {
      certRef: randomUUID(),
      inspection,
      isOpen: () => open,
      material: () => {
        if (!open) throw new CertificateSessionClosedError('Certificate session is closed; material was wiped');
        if (!inspection.usable) throw new CertificateInspectionError('Certificate is not usable', { reasons: inspection.reasons });
        return { pfx: material.pfx, passphrase: material.password };
      },
    };

    let timer: NodeJS.Timeout | undefined;
    const lifetime = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        open = false;
        material.pfx.fill(0);
        reject(new TimeoutError(`Certificate session exceeded ${maxLifetimeMs} ms`, { maxLifetimeMs }));
      }, maxLifetimeMs);
      timer.unref();
    });

    try {
      return await Promise.race([use(session), lifetime]);
    } finally {
      if (timer) clearTimeout(timer);
      open = false;
      material.pfx.fill(0);
      for (const key of keys) scrubKey(key);
      keys = [];
    }
  }

  /** Inspection only. Consumes (wipes) the PFX buffer. */
  static async inspect(material: CertificateMaterial, options: CertInspectorOptions = {}): Promise<CertificateInspection> {
    return CertInspector.withCertificate(material, async (session) => session.inspection, options);
  }
}
