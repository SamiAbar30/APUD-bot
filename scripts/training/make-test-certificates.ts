/**
 * Test certificates for the attachment training: FNMT-shaped PKCS#12 files (serialNumber IDCES-<DNI>,
 * CN "APELLIDOS NOMBRE - <DNI>") for a training line, with known passwords. Real client certificates
 * are never used for this: their passwords are unknown and they belong to real people. Content
 * detection itself is validated on the real export by scripts/validate-attachment-kinds.ts.
 *
 * Writes to .runtime/test-certs/ (gitignored): valid.p12, expired.p12, other-person.p12.
 */
import forge from 'node-forge';
import { mkdir, writeFile } from 'node:fs/promises';

export const TEST_CERT_PASSWORD = 'Prueba-2026!';

function make(dni: string, name: string, from: Date, to: Date): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = from;
  cert.validity.notAfter = to;
  const subject = [{ name: 'countryName', value: 'ES' }, { type: '2.5.4.5', value: `IDCES-${dni}` }, { name: 'commonName', value: `${name} - ${dni}` }];
  cert.setSubject(subject);
  cert.setIssuer([{ name: 'countryName', value: 'ES' }, { name: 'organizationName', value: 'TEST TRAINING CA' }, { name: 'commonName', value: 'TEST TRAINING CA (NOT FNMT)' }]);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], TEST_CERT_PASSWORD, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

export async function makeTestCertificates(dni: string, dir = '.runtime/test-certs') {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const now = Date.now(), day = 86_400_000;
  const files = {
    valid: make(dni, 'CLIENTE PRUEBA ENTRENAMIENTO', new Date(now - 30 * day), new Date(now + 700 * day)),
    expired: make(dni, 'CLIENTE PRUEBA ENTRENAMIENTO', new Date(now - 800 * day), new Date(now - 60 * day)),
    otherPerson: make('87654321X', 'OTRA PERSONA PRUEBA', new Date(now - 30 * day), new Date(now + 700 * day)),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(`${dir}/${name}.p12`, bytes, { mode: 0o600 });
  return files;
}

if (process.argv[1]?.endsWith('make-test-certificates.ts')) {
  const dni = process.argv[2];
  if (!dni) throw new Error('usage: make-test-certificates.ts <DNI of the training line>');
  const made = await makeTestCertificates(dni);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(made).map(([k, v]) => [k, v.length]))));
}
