import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ConversationAiConfig } from './conversation-ai.js';
import { ConversationBrain } from '../core/conversation-brain.js';
import { OpenAICompatibleBrainModel } from '../adapters/ai/openai-brain.js';

/**
 * Builds the conversation brain from the playbook in the repo and the firm's own facts, which stay
 * in the agent package outside the repo (the list of procuradores and abogados).
 * CONVERSATION_BRAIN=off keeps the previous rule-based replies.
 */
export async function brainFromEnv(ai: ConversationAiConfig | null, env: Record<string, string | undefined> = process.env): Promise<ConversationBrain | undefined> {
  if (!ai || (env.CONVERSATION_BRAIN ?? 'on').trim().toLowerCase() === 'off') return undefined;
  const playbook = await readFile(resolve(env.BRAIN_PLAYBOOK_FILE ?? 'config/brain/playbook.md'), 'utf8');
  return new ConversationBrain(
    new OpenAICompatibleBrainModel(ai, env.BRAIN_MODEL?.trim() || ai.model, env.BRAIN_REASONING_EFFORT?.trim() || undefined),
    playbook,
    await firmFacts(env.APOD_AGENT_PACKAGE_DIR),
    env.CONSENT_VERSION,
  );
}

async function firmFacts(packageDir?: string): Promise<string> {
  if (!packageDir) return '';
  try {
    const placeholders = JSON.parse(await readFile(resolve(packageDir, 'placeholders.json'), 'utf8')) as Record<string, { value?: string; status?: string }>;
    const roster = placeholders.LISTA_PROCURADORES_ABOGADOS?.value;
    return roster && placeholders.LISTA_PROCURADORES_ABOGADOS?.status !== 'TODO'
      ? `Procuradores y abogados del despacho (los que el cliente debe poner en la Sede; en la guía PDF basta con el procurador Airam Díaz y el abogado Fernando Gómez):\n${roster}`
      : '';
  } catch {
    return '';
  }
}
