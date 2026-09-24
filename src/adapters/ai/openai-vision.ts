import type { ConversationAiConfig } from '../../config/conversation-ai.js';
import { parseStrictConversationJson, readCompletion } from './openai-compatible-conversation.js';

export type ImageKind = 'PANTALLA_SEDE' | 'APP_CERTIFICADO' | 'AUTOFIRMA' | 'MENSAJE_ERROR' | 'DOCUMENTO_IDENTIDAD' | 'JUSTIFICANTE' | 'OTRO_DOCUMENTO' | 'FOTO' | 'OTRO';
export interface ImageReading { kind: ImageKind; description: string; visibleText: string }
const KINDS: readonly ImageKind[] = ['PANTALLA_SEDE', 'APP_CERTIFICADO', 'AUTOFIRMA', 'MENSAJE_ERROR', 'DOCUMENTO_IDENTIDAD', 'JUSTIFICANTE', 'OTRO_DOCUMENTO', 'FOTO', 'OTRO'];

const PROMPT = `Eres parte del sistema de un despacho de abogados que ayuda a clientes por WhatsApp a firmar un
apoderamiento apud acta en la Sede Judicial. El cliente ha enviado esta imagen, normalmente una
captura del móvil o del ordenador. Di qué es, para que la asistente pueda ayudarle.
Tipos: PANTALLA_SEDE (web de la Sede Judicial o del apoderamiento), APP_CERTIFICADO (app Certificado
Digital de la FNMT u otra pantalla del certificado en el móvil), AUTOFIRMA (programa AutoFirma o su
ventana), MENSAJE_ERROR (un error o aviso en pantalla), DOCUMENTO_IDENTIDAD (DNI, NIE, pasaporte,
tarjeta de residencia), JUSTIFICANTE (justificante o PDF del apud acta), OTRO_DOCUMENTO (carta,
contrato, factura...), FOTO (foto normal), OTRO.
Reglas: describe la pantalla (en qué paso está, qué opciones o botones se ven, qué error dice) en una
o dos frases. En "texto_visible" copia solo títulos, botones y mensajes de error; nunca nombres,
DNI/NIE, direcciones, teléfonos, números de cuenta ni contraseñas: si aparecen, omítelos.
Si es un documento de identidad, no lo describas: solo el tipo.
Devuelve SOLO JSON: {"tipo":"...","descripcion":"...","texto_visible":"..."}`;

/** Reads what a client's screenshot shows. The image is sent once and never stored by the bot. */
export class OpenAIVisionReader {
  private readonly endpoint: string;
  constructor(private readonly config: ConversationAiConfig, private readonly model = config.model) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async read(image: Buffer, mimeType: string): Promise<ImageReading | null> {
    const media = /^image\/(?:jpeg|png|webp|gif)$/.test(mimeType) ? mimeType : null;
    if (!media) return null;
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${media};base64,${image.toString('base64')}`, detail: 'high' } }] },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) return null;
      const raw = parseStrictConversationJson(await readCompletion(response, false));
      if (!raw) return null;
      const kind = KINDS.includes(raw.tipo as ImageKind) ? raw.tipo as ImageKind : 'OTRO';
      return { kind, description: String(raw.descripcion ?? '').slice(0, 400), visibleText: String(raw.texto_visible ?? '').slice(0, 400) };
    } catch {
      return null;
    }
  }
}

/** The image type from its bytes, for the data URL; phones label screenshots inconsistently. */
export function imageMimeFromBytes(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
