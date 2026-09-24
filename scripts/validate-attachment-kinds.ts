/**
 * Validates the content-based file identification against the firm's real WhatsApp export, locally.
 * Nothing leaves this machine and nothing is printed but counts: certificates are only sniffed by
 * their first bytes, never opened.
 *
 * Usage: npx tsx scripts/validate-attachment-kinds.ts [media-root]
 */
import { readdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffAttachment, readPdf } from '../src/core/attachment-kind.js';

const root = process.argv[2] ?? '/Users/litigiosmacmini/Downloads/WhatsApp/Media';
const head = async (file: string) => { const h = await open(file, 'r'); try { const b = Buffer.alloc(4096); const { bytesRead } = await h.read(b, 0, 4096, 0); return b.subarray(0, bytesRead); } finally { await h.close(); } };
const expected = (name: string) => /\.(?:p12|pfx)$/i.test(name) ? 'CERTIFICATE' : /\.pdf$/i.test(name) ? 'PDF' : /\.(?:jpe?g|png|webp|heic)$/i.test(name) ? 'IMAGE' : null;

const confusion: Record<string, Record<string, number>> = {};
for (const sub of ['WhatsApp Documents', 'WhatsApp Images']) {
  for (const name of await readdir(join(root, sub))) {
    const want = expected(name); if (!want) continue;
    const got = sniffAttachment(await head(join(root, sub, name)));
    (confusion[want] ??= {})[got] = (confusion[want][got] ?? 0) + 1;
  }
}
const accuracy = Object.fromEntries(Object.entries(confusion).map(([k, v]) => [k, `${v[k] ?? 0}/${Object.values(v).reduce((a, b) => a + b, 0)}`]));
console.log(JSON.stringify({ sniff: accuracy, confusion }, null, 1));

// PDF classifier: files whose name says apud acta should read as APUD_ACTA; a spread of the rest as other.
const docs = (await readdir(join(root, 'WhatsApp Documents'))).filter(f => /\.pdf$/i.test(f));
const named = (f: string) => /apud|registro apud|justificante apud/i.test(f);
const tally = async (files: string[]) => { const t: Record<string, number> = {}; for (const f of files) { const r = await readPdf(await readFile(f.startsWith('/') ? f : join(root, 'WhatsApp Documents', f))); t[r.kind] = (t[r.kind] ?? 0) + 1; } return t; };
console.log(JSON.stringify({
  pdfNamedApud: await tally(docs.filter(named).slice(0, 200)),
  pdfOthers: await tally(docs.filter(f => !named(f)).filter((_, i) => i % 15 === 0).slice(0, 200)),
  firmGuide: await tally(['/Users/litigiosmacmini/Downloads/Desktop/whatsapp_export/ai_agent_apoderamiento/docs/guia_cliente_apud_acta.pdf']),
}, null, 1));
