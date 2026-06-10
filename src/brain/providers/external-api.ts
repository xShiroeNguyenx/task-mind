import { AiClient } from './ai-client';
import { warn } from '../../log';

type Provider = 'anthropic' | 'openai' | 'gemini';

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
};

const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dùng API key ngoài (Anthropic / OpenAI / Gemini). Key lấy từ secret storage. */
export class ExternalApiClient implements AiClient {
  readonly name = 'external';
  lastError?: string;

  constructor(
    private readonly provider: Provider,
    private readonly apiKey: string | undefined,
    private readonly model: string = '',
  ) {}

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private fail(msg: string): undefined {
    this.lastError = msg;
    warn(msg);
    return undefined;
  }

  /** Gọi HTTP có retry/backoff cho 429 (rate limit) và 5xx (overloaded tạm thời). */
  private async fetchWithRetry(url: string, init: any): Promise<any | undefined> {
    const fetchFn = (globalThis as any).fetch;
    if (typeof fetchFn !== 'function') {
      return this.fail('fetch không khả dụng trong runtime này (VS Code quá cũ?).');
    }
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: any;
      try {
        res = await fetchFn(url, init);
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await sleep(Math.min(8000, 600 * 2 ** attempt));
          continue;
        }
        return this.fail(`Lỗi mạng (${this.provider}): ${String(e)}`);
      }
      if (res.ok) {
        return res.json();
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(12000, 800 * 2 ** attempt);
        warn(`${this.provider} HTTP ${res.status} — thử lại sau ${Math.round(waitMs / 1000)}s (lần ${attempt + 1}/${MAX_RETRIES}).`);
        await sleep(waitMs);
        continue;
      }
      const body = await res.text().catch(() => '');
      return this.fail(`${this.provider} HTTP ${res.status}: ${body.slice(0, 240)}`);
    }
    return this.fail(`${this.provider}: hết lượt thử lại (rate limit / overloaded).`);
  }

  async complete(system: string, user: string): Promise<string | undefined> {
    this.lastError = undefined;
    if (!this.apiKey) {
      return this.fail('Chưa có API key.');
    }
    const model = this.model || DEFAULT_MODEL[this.provider];

    if (this.provider === 'anthropic') {
      const json = await this.fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 512, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!json) {
        return undefined;
      }
      return (json?.content?.[0]?.text as string)?.trim() || this.fail('Anthropic trả rỗng.');
    }

    if (this.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const json = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 800, temperature: 0.3 },
        }),
      });
      if (!json) {
        return undefined;
      }
      const parts = json?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
      if (text.trim()) {
        return text.trim();
      }
      const reason = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? 'không rõ';
      return this.fail(`Gemini không trả nội dung (finishReason=${reason}).`);
    }

    // openai
    const json = await this.fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!json) {
      return undefined;
    }
    return (json?.choices?.[0]?.message?.content as string)?.trim() || this.fail('OpenAI trả rỗng.');
  }
}
