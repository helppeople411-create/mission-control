/**
 * Skill Engine — knowledge ingestion orchestration.
 *
 * Implements the PDF (spec §5) and Link (spec §6) ingestion flows: extract
 * text, split into chunks, digest into a structured summary, persist the
 * source + chunks, and make them searchable.
 */

import { logger } from '@/lib/logger';
import {
  createKnowledgeSource,
  addKnowledgeChunks,
  type CreateKnowledgeInput,
} from './db';
import { getKnowledgeDigester } from './digester';
import { getPdfExtractor } from './pdf';
import type { KnowledgeSource, KnowledgeType } from './types';

export class IngestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Chunking (spec §5B)                                                          */
/* -------------------------------------------------------------------------- */

const CHUNK_TARGET = 1000; // characters
const CHUNK_OVERLAP = 120;

/** Split text into sentence-aware, slightly overlapping chunks. */
export function chunkText(text: string, target = CHUNK_TARGET): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= target) return [p.trim()];
    // Oversized paragraph: break on sentence boundaries.
    return (p.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [p]).map((s) => s.trim());
  });

  const chunks: string[] = [];
  let buffer = '';
  for (const piece of paragraphs) {
    if (!piece) continue;
    if (buffer && buffer.length + piece.length + 1 > target) {
      chunks.push(buffer.trim());
      // Carry a short overlap for retrieval continuity.
      buffer = buffer.slice(-CHUNK_OVERLAP) + ' ' + piece;
    } else {
      buffer = buffer ? `${buffer}\n${piece}` : piece;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks.filter((c) => c.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Link fetch + clean (spec §6A-C)                                              */
/* -------------------------------------------------------------------------- */

const BLOCK_TAGS = /<(script|style|noscript|nav|header|footer|aside|form|svg)[^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Strip a webpage down to readable body text. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  let body = html.replace(BLOCK_TAGS, ' ');
  // Drop the <head> entirely.
  body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ');
  // Preserve block structure as newlines.
  body = body.replace(
    /<\/(p|div|li|h[1-6]|tr|section|article|br)[^>]*>/gi,
    '\n'
  );
  body = body.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags + comments.
  body = body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: body };
}

export async function fetchLink(
  url: string
): Promise<{ title: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IngestError('Invalid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IngestError('Only http(s) URLs can be ingested.');
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'MissionControl-SkillEngine/1.0' },
      redirect: 'follow',
    });
  } catch (err) {
    logger.warn({ err, url }, 'Link fetch failed');
    throw new IngestError('Could not fetch the URL.', 502);
  }
  if (!res.ok) {
    throw new IngestError(`Fetch returned HTTP ${res.status}.`, 502);
  }

  const html = await res.text();
  const { title, text } = htmlToText(html);
  if (text.length < 40) {
    throw new IngestError('No readable content found at that URL.');
  }
  return { title: title || parsed.hostname, text };
}

/* -------------------------------------------------------------------------- */
/* Ingest orchestration                                                         */
/* -------------------------------------------------------------------------- */

export interface IngestResult {
  source: KnowledgeSource;
  chunkCount: number;
  /** True when the digest suggests a skill is worth generating (spec §5G). */
  suggestSkill: boolean;
}

async function ingest(
  workspaceId: number,
  type: KnowledgeType,
  title: string,
  text: string,
  extra: Partial<CreateKnowledgeInput>
): Promise<IngestResult> {
  if (!text || text.trim().length < 20) {
    throw new IngestError('Not enough text to ingest.');
  }

  const digest = await getKnowledgeDigester().digest(text, title);
  const source = createKnowledgeSource({
    workspaceId,
    type,
    title,
    rawText: text,
    summary: digest.summary,
    keyPoints: digest.keyPoints,
    entities: digest.entities,
    tags: digest.tags,
    ...extra,
  });

  const chunks = chunkText(text);
  addKnowledgeChunks(
    source.id,
    title,
    chunks.map((c, i) => ({
      text: c,
      index: i,
      metadata: { type, source_id: source.id },
    }))
  );

  // Suggest a skill when the source contains a real procedure.
  const suggestSkill =
    digest.procedures.length >= 2 || digest.rules.length >= 3;

  logger.info(
    { sourceId: source.id, type, chunks: chunks.length },
    'Knowledge source ingested'
  );

  return { source, chunkCount: chunks.length, suggestSkill };
}

export function ingestText(
  workspaceId: number,
  title: string,
  text: string
): Promise<IngestResult> {
  return ingest(workspaceId, 'text', title || 'Pasted note', text, {});
}

export async function ingestLink(
  workspaceId: number,
  url: string
): Promise<IngestResult> {
  const { title, text } = await fetchLink(url);
  return ingest(workspaceId, 'link', title, text, { url });
}

export async function ingestPdf(
  workspaceId: number,
  opts: {
    title: string;
    data?: Buffer;
    preExtractedText?: string;
    filePath?: string;
  }
): Promise<IngestResult> {
  const text = await getPdfExtractor().extract(
    opts.data ?? Buffer.alloc(0),
    opts.preExtractedText
  );
  return ingest(workspaceId, 'pdf', opts.title || 'Uploaded PDF', text, {
    filePath: opts.filePath,
  });
}
