/**
 * Knowledge digester backed by the LiteLLM proxy.
 *
 * Falls back to the deterministic extractive digester when
 * `LITELLM_API_KEY` is unset or when the model call fails — so PDF/link
 * ingestion never breaks.
 *
 * Wired in `src/instrumentation.ts` so it activates automatically.
 */

import { logger } from '@/lib/logger';
import {
  chatCompletion,
  getLiteLLMConfig,
  parseJsonResponse,
} from '@/lib/llm/litellm-client';
import { extractiveDigester, type KnowledgeDigester } from './digester';
import type { KnowledgeDigest } from './types';

const MODEL_ENV = 'LITELLM_MODEL_DIGESTER';
const MAX_INPUT_CHARS = 32_000;

const SYSTEM_PROMPT =
  `You are a careful knowledge digester. From a source document, extract a ` +
  `structured digest. Be faithful to the document — do not invent facts. ` +
  `Respond with a single JSON object only (no markdown, no commentary) using ` +
  `these fields:\n` +
  `  summary       (string)\n` +
  `  keyPoints     (string[])\n` +
  `  procedures    (string[])     — numbered or sequential steps\n` +
  `  rules         (string[])     — normative statements ("must", "should", "never")\n` +
  `  examples      (string[])\n` +
  `  terminology   (string[])     — defined terms or named concepts\n` +
  `  warnings      (string[])     — risks, cautions, hazards\n` +
  `  entities      (string[])     — proper nouns, products, URLs\n` +
  `  tags          (string[])     — 4-8 short topical tags`;

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s.length > 0) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

interface DigestJson {
  summary?: unknown;
  keyPoints?: unknown;
  procedures?: unknown;
  rules?: unknown;
  examples?: unknown;
  terminology?: unknown;
  warnings?: unknown;
  entities?: unknown;
  tags?: unknown;
}

function normalizeDigest(
  raw: DigestJson,
  title: string
): KnowledgeDigest {
  const summary =
    typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : `Ingested knowledge: ${title}.`;
  return {
    summary,
    keyPoints: asStringArray(raw.keyPoints, 12),
    procedures: asStringArray(raw.procedures, 20),
    rules: asStringArray(raw.rules, 15),
    examples: asStringArray(raw.examples, 10),
    terminology: asStringArray(raw.terminology, 20),
    warnings: asStringArray(raw.warnings, 12),
    entities: asStringArray(raw.entities, 25),
    tags: asStringArray(raw.tags, 8),
  };
}

export const llmDigester: KnowledgeDigester = {
  name: 'litellm',

  async digest(text: string, title: string): Promise<KnowledgeDigest> {
    const cfg = getLiteLLMConfig(MODEL_ENV);
    if (!cfg) return extractiveDigester.digest(text, title);

    const truncated = text.slice(0, MAX_INPUT_CHARS);
    try {
      const raw = await chatCompletion(
        cfg,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Title: ${title}\n\n---\n${truncated}`,
          },
        ],
        { json: true, temperature: 0.2, maxTokens: 1800, timeoutMs: 45_000 }
      );
      const parsed = parseJsonResponse<DigestJson>(raw);
      return normalizeDigest(parsed, title);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'llmDigester failed — using extractive digester'
      );
      return extractiveDigester.digest(text, title);
    }
  },
};
