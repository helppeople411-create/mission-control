/**
 * Skill Engine — knowledge digestion.
 *
 * Turning raw text (from a PDF or webpage) into a structured digest —
 * summary, key points, procedures, rules, examples, terminology, warnings —
 * is the LLM-dependent part of ingestion (spec §5D, §6D-E).
 *
 * It is therefore pluggable, exactly like the Council reasoner:
 *
 *   - The DEFAULT (`extractiveDigester`) is deterministic and dependency-free
 *     so PDF/link ingestion runs end-to-end out of the box.
 *   - Register a model-backed digester with `setKnowledgeDigester()` for
 *     higher-quality summaries and extraction.
 */

import type { KnowledgeDigest } from './types';

export interface KnowledgeDigester {
  readonly name: string;
  digest(text: string, title: string): Promise<KnowledgeDigest> | KnowledgeDigest;
}

let activeDigester: KnowledgeDigester | null = null;

export function setKnowledgeDigester(digester: KnowledgeDigester): void {
  activeDigester = digester;
}

export function getKnowledgeDigester(): KnowledgeDigester {
  return activeDigester ?? extractiveDigester;
}

/* -------------------------------------------------------------------------- */
/* Default extractive digester                                                  */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set(
  ('the a an and or but if then else of to in on at by for with from as is ' +
    'are was were be been being this that these those it its their there here ' +
    'you your we our they them he she his her i me my not no can will would ' +
    'should could may might must do does did have has had how what when where ' +
    'why who which than too very just also into out up down over under about')
    .split(' ')
);

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function wordFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    freq.set(raw, (freq.get(raw) ?? 0) + 1);
  }
  return freq;
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

const RULE_RE = /\b(must|must not|should|shall|always|never|required?|do not|don't)\b/i;
const WARN_RE = /\b(warning|caution|danger|hazard|risk|avoid|do not|never|critical)\b/i;
const EXAMPLE_RE = /\b(example|e\.g\.|for instance|such as|for example)\b/i;
const STEP_RE = /^(\d+[.)]\s+|step\s+\d+|first|second|third|next|then|finally)\b/i;
const TERM_RE = /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,3})\s+(?:is|are|means|refers to|describes)\b/;

export const extractiveDigester: KnowledgeDigester = {
  name: 'extractive',

  digest(text: string, title: string): KnowledgeDigest {
    const sents = sentences(text);
    const ls = lines(text);
    const freq = wordFrequency(text);

    // Summary: highest-frequency-scoring sentences, kept in document order.
    const scored = sents.map((s, i) => {
      const score = (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).reduce(
        (acc, w) => acc + (freq.get(w) ?? 0),
        0
      );
      return { s, i, score: score / Math.max(1, s.length) };
    });
    const summary =
      scored
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
        .sort((a, b) => a.i - b.i)
        .map((x) => x.s)
        .join(' ') || `Ingested knowledge: ${title}.`;

    // Procedures: numbered / step-like lines.
    const procedures = unique(
      ls.filter((l) => STEP_RE.test(l)).map((l) => l.replace(/\s+/g, ' '))
    ).slice(0, 20);

    // Rules: sentences with normative language.
    const rules = unique(sents.filter((s) => RULE_RE.test(s))).slice(0, 15);

    // Warnings.
    const warnings = unique(sents.filter((s) => WARN_RE.test(s))).slice(0, 12);

    // Examples.
    const examples = unique(sents.filter((s) => EXAMPLE_RE.test(s))).slice(0, 10);

    // Terminology: "X is/means ..." definitions.
    const terminology = unique(
      sents
        .map((s) => s.match(TERM_RE)?.[1])
        .filter((t): t is string => !!t)
    ).slice(0, 20);

    // Key points: top sentences not already captured elsewhere.
    const captured = new Set(
      [...procedures, ...rules, ...warnings].map((s) => s.toLowerCase())
    );
    const keyPoints = scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s)
      .filter((s) => !captured.has(s.toLowerCase()))
      .slice(0, 8);

    // Entities: capitalized multi-word phrases + URLs.
    const phrases =
      text.match(/\b[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){1,3}\b/g) ?? [];
    const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    const entities = unique([...phrases, ...urls]).slice(0, 25);

    // Tags: most frequent meaningful words.
    const tags = [...freq.entries()]
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);

    return {
      summary,
      keyPoints,
      procedures,
      rules,
      examples,
      terminology,
      warnings,
      entities,
      tags,
    };
  },
};
