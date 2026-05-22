/**
 * Thin client for the Mission Control LiteLLM proxy.
 *
 * All three pluggable LLM seams (council reasoner, knowledge digester, future
 * skill builder) share this client. It speaks the OpenAI Chat Completions
 * shape, so any OpenAI-compatible gateway works — not just LiteLLM.
 *
 * Configuration is env-driven; if `LITELLM_API_KEY` is unset the helpers
 * return `null` and callers should fall back to their deterministic default
 * implementations.
 */

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://146.190.72.191:4000/v1';
const DEFAULT_MODEL = 'claude-haiku-4-5';

export function getLiteLLMConfig(modelEnv: string): LiteLLMConfig | null {
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.LITELLM_BASE_URL ?? DEFAULT_BASE_URL;
  const model =
    process.env[modelEnv] ?? process.env.LITELLM_DEFAULT_MODEL ?? DEFAULT_MODEL;
  return { baseUrl, apiKey, model };
}

interface LiteLLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function chatCompletion(
  cfg: LiteLLMConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 800,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `LiteLLM ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`
      );
    }
    const data = (await res.json()) as LiteLLMResponse;
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON output from an LLM response, tolerating stray fenced blocks. */
export function parseJsonResponse<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate) as T;
}
