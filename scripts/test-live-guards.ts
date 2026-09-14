import assert from 'node:assert/strict';
import { loadEnv } from '../src/config/env.js';
import { KmaleonGateway } from '../src/adapters/kmaleon/kmaleon-gateway.js';
import type { KmaleonResponseMapping } from '../src/contracts/kmaleon.contract.js';
import { demoFixture } from '../src/demo/demo-fixture.js';
import { WhatsAppClient, assertWhatsAppRecipientAllowed } from '../src/adapters/whatsapp/whatsapp-client.js';

const baseValues: Record<string, string> = {
  NODE_ENV: 'development',
  SERVICE_MODE: 'live',
  DATA_MODE: 'real',
  HOST: '127.0.0.1',
  PORT: '4722',
  DATABASE_URL: 'postgresql://apod:test@127.0.0.1:55432/apoderamientos',
  REDIS_URL: 'redis://127.0.0.1:56379',
  QUEUE_PREFIX: 'apod-live-guard',
  OPERATOR_TOKEN: 'x'.repeat(32),
  OUTBOUND_ENABLED: 'false',
  WORKERS_ENABLED: 'false',
  WHATSAPP_ENABLED: 'false',
  KMALEON_ENABLED: 'true',
  KMALEON_CONFIG_FILE: './config/kmaleon.json',
  KMALEON_BASE_URL: 'https://kmaleon.example',
  KMALEON_CLIENT_ID: 'client-id',
  KMALEON_CLIENT_SECRET: 'client-secret',
  KMALEON_AUTH_STATE: 'auth-state',
  KMALEON_REDIRECT_URI: 'https://apod.example/callback',
  CARMEN_USER_ID: '',
  APUDATA_ENABLED: 'false',
  SEDE_ENABLED: 'false',
};

const mapping: KmaleonResponseMapping = {
  reviewEvidenceRef: 'review-evidence-1',
  projectIdentity: () => ({ projectId: '123', dni: '12345678Z' }),
  projectSearchFilter: () => ({}),
  projectSearchPage: () => ({ items: [], hasMore: false }),
  projectCandidate: () => ({ projectId: '123', dni: '12345678Z', nombre: 'Demo', telefono: '34663094035' }),
  annotationsPage: () => ({ items: [], hasMore: false }),
  documentBytes: () => Buffer.from('%PDF-'),
};

const clientCalls: string[] = [];
const client = {
  invokeRead: async (method: string) => { clientCalls.push(`read:${method}`); return {}; },
  invokeWrite: async (method: string) => { clientCalls.push(`write:${method}`); return {}; },
} as never;

const env = loadEnv(baseValues);
assert.equal(env.CARMEN_USER_ID, undefined);

const gatewayWithoutRecipient = new KmaleonGateway(client, { mapping });
await assert.rejects(
  () => gatewayWithoutRecipient.notifyCarmen({
    projectId: '123',
    expectedDni: '12345678Z',
    idempotencyKey: 'notice-1',
    documentProof: {
      verified: true,
      projectId: '123',
      annotationId: 'annotation-1',
      documentId: 'document-1',
      sha256: 'a'.repeat(64),
      idempotencyKey: 'upload-1',
    },
    isProvisional: false,
  }),
  (error: unknown) => error instanceof Error && error.message === 'KMALEON_RECIPIENT_NOT_CONFIGURED',
);
assert.deepEqual(clientCalls, []);

assert.deepEqual(demoFixture('34663094035'), {
  source: 'DEMO_FIXTURE',
  dni: '12345678Z',
  nombre: 'DEMO APOD CLIENT',
  telefono: '34663094035',
  kmaleonExpedienteId: 'demo-kmaleon-34663094035',
});

assert.throws(
  () => assertWhatsAppRecipientAllowed('34663094036', ['34663094035']),
  (error: unknown) => error instanceof Error && error.message === 'DEMO_RECIPIENT_NOT_ALLOWED',
);
assert.doesNotThrow(() => assertWhatsAppRecipientAllowed('34663094035', ['34663094035']));
const demoWhatsApp=new WhatsAppClient({accessToken:'test-access-token',phoneNumberId:'123456789',apiVersion:'v23.0',writesEnabled:true,allowedRecipients:['34663094035']});
await assert.rejects(
  () => demoWhatsApp.sendText('34663094036','probe'),
  (error: unknown) => error instanceof Error && error.message === 'DEMO_RECIPIENT_NOT_ALLOWED',
);

console.log(JSON.stringify({ result: 'PASS', externalProviderCalls: 0, secretValuesPrinted: false }));
