#!/usr/bin/env node
/**
 * Convert a WhatsApp text export into anonymized JSONL for later human
 * labeling. The source file is read once and is never copied to the output.
 * Usage: node scripts/prepare-conversation-dataset.mjs input.txt output.jsonl
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/prepare-conversation-dataset.mjs <whatsapp-export.txt> <anonymized-output.jsonl>');
  process.exit(2);
}

const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const source = await readFile(inputPath);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const text = source.toString('utf8');
source.fill(0);

const lines = text.split(/\r?\n/);
const messages = [];
let current;
const messageStart = /^(\d{1,2}\/\d{1,2}\/\d{2}),\s+\d{1,2}:\d{2}\s+-\s+([^:]+):\s?(.*)$/;

for (const line of lines) {
  const match = messageStart.exec(line);
  if (match) {
    if (current) messages.push(current);
    current = { sender: match[2].trim(), text: match[3].trim() };
  } else if (current && line.trim()) {
    current.text += `\n${line.trim()}`;
  }
}
if (current) messages.push(current);

const systemMessage = /^(?:los mensajes y las llamadas están cifrados|messages and calls are end-to-end encrypted)/i;
const assistantSender = /litigios|dayana/i;
const phone = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const identity = /\b(?:[XYZ]\d{7}[A-Z]|\d{8}[A-Z])\b/gi;
const url = /https?:\/\/\S+/gi;
const knownNames = ['dayana', 'daniel'];
const company = /\bmykredit\b/gi;

function anonymize(value) {
  return value
    .replace(url, '<URL>')
    .replace(phone, '<PHONE>')
    .replace(identity, '<ID>')
    .replace(company, '<COMPANY>')
    .replace(new RegExp(`\\b(?:${knownNames.join('|')})\\b`, 'gi'), '<PERSON>')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

const rows = messages
  .filter((message) => !systemMessage.test(message.text))
  .map((message, index) => ({
    turn: index + 1,
    role: assistantSender.test(message.sender) ? 'assistant' : 'client',
    text: anonymize(message.text),
    labelStatus: 'UNREVIEWED',
  }))
  .filter((row) => row.text.length > 0);

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
const header = {
  format: 'apod-conversation-jsonl-v1',
  sourceSha256,
  anonymized: true,
  rawSourceStored: false,
  labelStatus: 'UNREVIEWED',
  turns: rows.length,
};
const output = [JSON.stringify({ meta: header }), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
await writeFile(outputPath, output, { mode: 0o600 });
console.log(JSON.stringify({ output: outputPath, ...header }));
