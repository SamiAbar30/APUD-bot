import type { BrainModel } from '../../core/conversation-brain.js';
import type { ConversationAiConfig } from '../../config/conversation-ai.js';
import { parseStrictConversationJson, readCompletion } from './openai-compatible-conversation.js';

/**
 * OpenAI-compatible chat model for the conversation brain. The conversation goes in with its real
 * roles, so the model reads it as a dialogue; the playbook and case state are the system message.
 */
export class OpenAICompatibleBrainModel implements BrainModel {
  private readonly endpoint: string;
  readonly metrics = { calls: 0, failures: 0 };

  constructor(private readonly config: ConversationAiConfig, private readonly model = config.model, private readonly reasoningEffort?: string) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async think(input: Parameters<BrainModel['think']>[0]): Promise<unknown> {
    this.metrics.calls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const messages = [
        { role: 'system', content: input.system },
        ...input.history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: input.text },
        ...(input.feedback ? [{ role: 'system', content: `Tu borrador anterior no se puede enviar: ${input.feedback} Devuelve otro JSON corregido.` }] : []),
      ];
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model,
          messages,
          response_format: { type: 'json_object' },
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          ...(this.config.omitTemperature ? {} : { temperature: 0.4 }),
          stream: false,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) { this.metrics.failures++; return null; }
      return parseStrictConversationJson(await readCompletion(response, false));
    } catch {
      this.metrics.failures++;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
