/**
 * The attachment intake's pure parts: identification by content, PDF reading, password extraction and
 * the encrypted certificate check (real PKCS#12 parsing with generated FNMT-shaped certificates).
 * The live path is exercised by scripts/training/replay-attachments.ts; identification is validated
 * on the firm's real WhatsApp export by scripts/validate-attachment-kinds.ts.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sniffAttachment, readPdf } from '../src/core/attachment-kind.js';
import { AttachmentIntake, passwordCandidates } from '../src/core/attachment-intake.js';
import { CredentialVault } from '../src/infrastructure/credential-vault.js';
import { makeTestCertificates, TEST_CERT_PASSWORD } from './training/make-test-certificates.js';

const dir = await mkdtemp(join(tmpdir(), 'apod-attach-'));
try {
  const dni = '40000101L';
  const certs = await makeTestCertificates(dni, join(dir, 'certs'));
  const guide = await readFile('/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento/docs/guia_cliente_apud_acta.pdf');

  // Identification by bytes, whatever the name or label.
  assert.equal(sniffAttachment(certs.valid), 'CERTIFICATE');
  assert.equal(sniffAttachment(guide), 'PDF');
  assert.equal(sniffAttachment(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'IMAGE');
  assert.equal(sniffAttachment(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'IMAGE');
  assert.equal(sniffAttachment(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)])), 'ARCHIVE');
  assert.equal(sniffAttachment(Buffer.from('hola')), 'OTHER');
  // The firm's own guide is not a justificante.
  assert.equal((await readPdf(guide)).kind, 'FIRM_GUIDE');

  // Password extraction keeps trailing punctuation (live bug: "Prueba-2026!" was cut to "Prueba-2026").
  assert.ok(passwordCandidates('contraseña: Prueba-2026!').includes('Prueba-2026!'));
  assert.deepEqual(passwordCandidates('la contraseña es Mala-1234'), ['Mala-1234']);

  // The check: certificate and password arrive separately, in either order.
  const vault = new CredentialVault(dir, randomBytes(32).toString('hex'));
  const payloads = new Map<string, Buffer>();
  const intake = new AttachmentIntake({ media: { download: async id => ({ content: Buffer.from(payloads.get(id)!), mimeType: 'application/octet-stream' }) }, vault, vision: null });
  const client = { id: 'case-1', dni };
  payloads.set('1', certs.valid);
  assert.deepEqual(await intake.read(client, { mediaId: '1' }), { route: 'CERTIFICATE', marker: '[CERTIFICADO:WAITING_PASSWORD]', check: 'WAITING_PASSWORD' });
  await intake.storePassword(client, ['Mala-1234']);
  assert.equal((await intake.checkPair(client)).check, 'PASSWORD_INVALID');
  await intake.storePassword(client, passwordCandidates(`contraseña: ${TEST_CERT_PASSWORD}`));
  assert.equal((await intake.checkPair(client)).check, 'OK');
  assert.equal((await readdir(join(dir, 'credentials'))).filter(f => /^[0-9a-f-]{36}\.bin$/.test(f)).length, 1, 'kept encrypted for the office');
  assert.equal((await readdir(join(dir, 'credentials'))).filter(f => f.startsWith('pending-')).length, 0, 'waiting slots cleared');

  const other = { id: 'case-2', dni };
  await intake.storePassword(other, [TEST_CERT_PASSWORD]);
  assert.equal((await intake.checkPair(other)).check, 'WAITING_CERTIFICATE');
  payloads.set('2', certs.expired);
  assert.match((await intake.read(other, { mediaId: '2', mediaType: 'application/octet-stream', filename: 'documento.bin' })).marker, /^\[CERTIFICADO:EXPIRED:\d{4}-\d{2}-\d{2}\]$/);
  const third = { id: 'case-3', dni };
  payloads.set('3', certs.otherPerson);
  await intake.storePassword(third, [TEST_CERT_PASSWORD]);
  assert.equal((await intake.read(third, { mediaId: '3' })).marker, '[CERTIFICADO:OTHER_PERSON]');

  // Nothing readable at rest: the pending slot is ciphertext.
  const encrypted = await readdir(join(dir, 'credentials'));
  for (const f of encrypted) assert.ok(!(await readFile(join(dir, 'credentials', f))).includes(Buffer.from(TEST_CERT_PASSWORD)), 'password never stored in clear');

  console.log(JSON.stringify({ result: 'PASS', suite: 'attachments' }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
