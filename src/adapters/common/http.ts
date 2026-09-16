import { createHash } from 'node:crypto';
import { fetch as undiciFetch, type Dispatcher } from 'undici';

export class AdapterError extends Error {
  constructor(public readonly code: string, public readonly outcome: 'not_applied' | 'uncertain' = 'not_applied') {
    super(code); this.name = 'AdapterError';
  }
}
export function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
export function checkedHttpsUrl(value: string, allowedOrigins?: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (allowedOrigins && !allowedOrigins.includes(url.origin))) {
    throw new AdapterError('UNAPPROVED_HTTPS_ENDPOINT');
  }
  return url;
}
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length'));
  if (advertised > maxBytes) { await response.body?.cancel(); throw new AdapterError('RESPONSE_TOO_LARGE'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) throw new AdapterError('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function requestJson(url: URL, options: RequestInit, config: {write?: boolean; timeoutMs?: number; maxBytes?: number; dispatcher?: Dispatcher} = {}): Promise<unknown> {
  const uncertain = config.write ? 'uncertain' : 'not_applied';
  try {
    const response = await undiciFetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs ?? 30_000), ...(config.dispatcher ? {dispatcher: config.dispatcher} : {}) } as Parameters<typeof undiciFetch>[1]);
    if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`HTTP_${response.status}`, uncertain); }
    const bytes = await readBounded(response as unknown as Response, config.maxBytes ?? 4 * 1024 * 1024);
    try { return JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw new AdapterError('INVALID_JSON_RESPONSE', uncertain); }
  } catch (error) {
    if (error instanceof AdapterError) {
      if (config.write && error.outcome !== 'uncertain') throw new AdapterError(error.code, 'uncertain');
      throw error;
    }
    throw new AdapterError('HTTP_TRANSPORT_FAILURE', uncertain);
  }
}
export function requireValue(value: string, name: string): void {
  if (!value.trim()) throw new AdapterError(`MISSING_${name}`);
}
export function requireId(value: string, name: string): void {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new AdapterError(`INVALID_${name}`);
}
