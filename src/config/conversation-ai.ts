/**
 * Online and local providers have separate configuration. Choosing local
 * never reads an online endpoint, model, or API key as a fallback.
 */
export type ConversationAiMode = 'online' | 'local';

export interface ConversationAiConfig {
  mode: ConversationAiMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  redactPii: boolean;
  streaming: boolean;
  omitTemperature: boolean;
}

export type ConversationAiConfigState =
  | { status: 'DISABLED'; config: null; reason: string; description: string }
  | { status: 'INCOMPLETE'; config: null; reason: string; description: string }
  | { status: 'CONFIGURED'; config: ConversationAiConfig; reason: ''; description: string };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Keep a provider URL stable when the .env contains either a host or /v1. */
export function normalizeConversationAiBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return /\/v\d+(?:\.\d+)?$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

/**
 * Read the selected provider without exposing any credentials.
 * Missing all three is an intentional safe state; partial configuration is
 * reported separately so an operator can fix the .env instead of wondering
 * why the model is silently unused.
 */
export function conversationAiFromEnv(
  env: Record<string, string | undefined> = process.env,
): ConversationAiConfigState {
  const mode = (env.AI_MODE ?? 'online').trim();
  if (mode !== 'online' && mode !== 'local') {
    return { status: 'INCOMPLETE', config: null, reason: 'AI_MODE must be online or local.', description: 'conversation AI configuration invalid' };
  }
  const local = mode === 'local';
  const baseUrl = local ? (env.LOCAL_AI_BASE_URL?.trim() || DEFAULT_LOCAL_BASE_URL) : (env.AI_BASE_URL ?? '').trim();
  const apiKey = ((local ? env.LOCAL_AI_API_KEY : env.AI_API_KEY) ?? '').trim();
  const model = ((local ? env.LOCAL_AI_MODEL : env.AI_MODEL) ?? '').trim();
  const missing = [
    baseUrl ? '' : 'AI_BASE_URL',
    local || apiKey ? '' : 'AI_API_KEY',
    model ? '' : local ? 'LOCAL_AI_MODEL' : 'AI_MODEL',
  ].filter(Boolean);

  if (missing.length === 3) {
    return {
      status: 'DISABLED',
      config: null,
      reason: 'AI_BASE_URL, AI_API_KEY and AI_MODEL are not configured.',
      description: 'conversation AI disabled; local policy only',
    };
  }
  if (missing.length > 0) {
    return {
      status: 'INCOMPLETE',
      config: null,
      reason: `Conversation AI configuration is incomplete; missing ${missing.join(', ')}.`,
      description: 'conversation AI configuration incomplete',
    };
  }

  let normalizedBaseUrl: string;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_URL');
    normalizedBaseUrl = normalizeConversationAiBaseUrl(url.href);
  } catch {
    return { status: 'INCOMPLETE', config: null, reason: `${local ? 'LOCAL_AI_BASE_URL' : 'AI_BASE_URL'} must be an HTTP(S) URL without credentials, query, or fragment.`, description: 'conversation AI endpoint invalid' };
  }

  const timeoutMs = positiveInteger(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  // Privacy is a boundary invariant for both providers, including history.
  const redactPii = true;
  return {
    status: 'CONFIGURED',
    config: {
      mode,
      baseUrl: normalizedBaseUrl,
      apiKey,
      model,
      timeoutMs,
      redactPii,
      streaming: bool(env.AI_STREAM, true),
      // Reasoning models such as gpt-5.6-luna reject temperature=0.  An
      // omitted value is accepted by both reasoning and ordinary chat models.
      omitTemperature: bool(env.AI_SIN_TEMPERATURE, true),
    },
    reason: '',
    description: `${mode}: ${model} via ${normalizedBaseUrl} · personal data redacted`,
  };
}
