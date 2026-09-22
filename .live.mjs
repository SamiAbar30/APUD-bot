/** Live walkthrough: real webhook -> queue -> worker -> model -> outbox, on the running stack. */
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {PrismaClient} from '@prisma/client';

const require = createRequire('/Users/litigiosmacmini/Documents/ChatGPT/APOD-bot/wce-emulator/bridge/');
const {constructWebhookPayload} = require('./utils/webhookConstructor');
const env = Object.fromEntries(
  readFileSync('.env.wce', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
process.env.DATABASE_URL = env.DATABASE_URL;
const db = new PrismaClient();
const phone = env.DEMO_WHATSAPP_RECIPIENTS.split(',')[0].trim();
const seed = await db.botApodExpediente.findUniqueOrThrow({where: {telefono: phone}});

const lastSentMessageId = async () => {
  const action = await db.botApodAccion.findFirst({
    where: {expedienteId: seed.id, actionType: {in: ['SEND_WHATSAPP_BUTTONS', 'SEND_WHATSAPP_MESSAGE']}, status: {in: ['EXECUTED', 'AWAITING_DELIVERY']}},
    orderBy: {createdAt: 'desc'},
  });
  const receipt = action?.receipt;
  return receipt && typeof receipt === 'object' && typeof receipt.messageId === 'string' ? receipt.messageId : undefined;
};

const send = async (text) => {
  const button = text.startsWith('btn:') ? text.slice(4).split(':') : null;
  const contextMessageId = button ? await lastSentMessageId() : undefined;
  const payload = constructWebhookPayload(
    button
      ? {type: 'button_reply', payload: {id: button[0], title: button[1] ?? button[0]}, contextMessageId}
      : {type: 'text', payload: {body: text}},
    {phoneNumberId: env.WA_PHONE_NUMBER_ID, senderPhone: phone, businessAccountId: 'wce-local-business'},
  );
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', env.WA_APP_SECRET).update(raw).digest('hex');
  const res = await fetch(`http://127.0.0.1:${env.PORT}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}`},
    body: raw,
  });
  return res.status;
};

const waitForReply = async (before) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const count = await db.botApodMessage.count({where: {expedienteId: seed.id, role: 'assistant'}});
    if (count > before) {
      const latest = await db.botApodMessage.findFirst({
        where: {expedienteId: seed.id, role: 'assistant'},
        orderBy: {createdAt: 'desc'},
      });
      return latest.content;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return '(no reply within 5 minutes)';
};

for (const text of process.argv.slice(2)) {
  const before = await db.botApodMessage.count({where: {expedienteId: seed.id, role: 'assistant'}});
  const status = await send(text);
  console.log(`\nCLIENTE: ${text}\n  webhook ${status}`);
  console.log(`BOT: ${await waitForReply(before)}`);
}

const final = await db.botApodExpediente.findUniqueOrThrow({where: {id: seed.id}});
console.log('\nCASE: ' + JSON.stringify({
  state: final.currentState,
  cert: final.hasDigitalCert,
  device: final.certDevice,
  paused: final.automationPaused,
}));
await db.$disconnect();
