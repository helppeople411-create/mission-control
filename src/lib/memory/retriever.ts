/**
 * Memory retriever — loop piece 1 of 3.
 *
 * At the start of a council session, this pulls relevant context from every
 * memory source and formats it as a string the council agents can read.
 *
 * Sources (in priority order):
 *   1. User profile + brand voice (always included)
 *   2. Ingested knowledge chunks (knowledge_chunks_fts FTS5 search)
 *   3. Memory filesystem FTS (memory_fts — markdown notes in the memory dir)
 *   4. Skill recommendations (returned separately for the UI)
 */

import { getDatabase } from '@/lib/db';
import { searchKnowledge } from '@/lib/skills/db';
import { buildMemoryContext } from './brand-voice';
import { recommendSkills, type ScoredSkill } from './skill-recommender';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';

export interface RetrievedContext {
  /** Full context block to inject into council system prompt. */
  contextBlock: string;
  /** Individual source snippets for the context log. */
  snippets: Array<{
    sourceType: 'knowledge' | 'memory_fts' | 'brand_voice' | 'skill';
    sourceId?: number;
    snippet: string;
    score?: number;
  }>;
  /** Skills recommended for this goal. */
  recommendedSkills: ScoredSkill[];
}

/** Remove Obsidian/markdown syntax for cleaner injection. */
function strip(text: string, maxLen = 500): string {
  return text
    .replace(/^---[\s\S]*?---\n?/, '') // frontmatter
    .replace(/!\[.*?\]\(.*?\)/g, '')   // image embeds
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wiki links → text
    .replace(/#{1,6} /g, '')           // headings
    .replace(/[*_`~>]/g, '')           // formatting
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export async function retrieveContext(
  workspaceId: number,
  goal: string
): Promise<RetrievedContext> {
  const snippets: RetrievedContext['snippets'] = [];
  const sections: string[] = [];

  // 1. Brand voice + profile (always).
  const memoryContext = await buildMemoryContext(workspaceId);
  if (memoryContext.trim()) {
    sections.push(memoryContext);
    snippets.push({ sourceType: 'brand_voice', snippet: memoryContext.slice(0, 200) });
  }

  // 2. Ingested knowledge chunks (FTS5).
  try {
    const knowledgeHits = searchKnowledge(goal, 6);
    if (knowledgeHits.length) {
      const knowledgeParts = knowledgeHits.map(
        (h) => `[${h.source_title}] ${strip(h.snippet, 300)}`
      );
      sections.push(`## Relevant knowledge\n${knowledgeParts.join('\n')}`);
      for (const h of knowledgeHits) {
        snippets.push({
          sourceType: 'knowledge',
          sourceId: h.source_id,
          snippet: strip(h.snippet, 200),
          score: 1,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Knowledge FTS retrieval failed');
  }

  // 3. Memory filesystem FTS (the existing memory dir / Obsidian vault notes).
  if (config.memoryDir) {
    try {
      const { searchMemory } = await import('@/lib/memory-search');
      const response = await searchMemory(
        config.memoryDir,
        config.memoryAllowedPrefixes ?? [],
        goal,
        { limit: 4 }
      );
      const memHits = response.results ?? [];
      if (memHits.length) {
        const memParts = memHits.map(
          (h: { path: string; snippet?: string }) =>
            `[${h.path}] ${strip(h.snippet ?? '', 300)}`
        );
        sections.push(`## Notes from memory\n${memParts.join('\n')}`);
        for (const h of memHits) {
          snippets.push({
            sourceType: 'memory_fts',
            snippet: strip(h.snippet ?? h.path, 200),
          });
        }
      }
    } catch {
      // Memory dir may not be configured — skip silently.
    }
  }

  // 4. Recommended skills (returned to the UI; also listed in context).
  const recommendedSkills = recommendSkills(workspaceId, goal, 5);
  if (recommendedSkills.length) {
    const skillList = recommendedSkills
      .map((s) => `- ${s.skill.name}: ${s.skill.description ?? s.skill.slug}`)
      .join('\n');
    sections.push(`## Suggested skills for this goal\n${skillList}`);
    for (const s of recommendedSkills) {
      snippets.push({
        sourceType: 'skill',
        sourceId: s.skill.id,
        snippet: `${s.skill.name} (score: ${s.combinedScore.toFixed(2)})`,
        score: s.combinedScore,
      });
    }
  }

  const contextBlock = sections.join('\n\n');
  return { contextBlock, snippets, recommendedSkills };
}

/** Persist the retrieved snippets so we can show what was used per session. */
export function logContextRetrieval(
  councilSessionId: number,
  retrieved: RetrievedContext
): void {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO memory_context_log
       (council_session_id, source_type, source_id, snippet, relevance_score)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const s of retrieved.snippets) {
      insert.run(
        councilSessionId,
        s.sourceType,
        s.sourceId ?? null,
        s.snippet,
        s.score ?? null
      );
    }
  });
  tx();
}
