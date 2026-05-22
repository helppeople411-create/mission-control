/**
 * Session memory writer — loop piece 2 of 3.
 *
 * After a council session executes, this builds a structured markdown summary
 * and writes it to:
 *   1. The memory filesystem (so it's indexed by memory_fts and searchable)
 *   2. The Obsidian vault at Mission Control/Sessions/YYYY-MM-DD-{id}.md
 *
 * Future council sessions can retrieve these summaries via memory FTS, so the
 * system learns from past decisions automatically.
 */

import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { getDatabase } from '@/lib/db';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { writeVaultNote, mcPath, isVaultConfigured } from './obsidian';

async function indexSessionFile(absPath: string, relPath: string, content: string): Promise<void> {
  try {
    const { indexFile } = await import('@/lib/memory-search');
    const db = getDatabase();
    indexFile(db, relPath, content);
  } catch {
    // indexFile signature varies — skip FTS index on error.
  }
}

interface SessionSummaryInput {
  sessionId: number;
  workspaceId: number;
  title: string;
  goal: string;
  consensus: string | null;
  roundCount: number;
  taskCount: number;
  skillsUsed: string[];
}

function iso(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function buildSessionNote(s: SessionSummaryInput): string {
  const date = iso(Math.floor(Date.now() / 1000));
  const skills =
    s.skillsUsed.length ? s.skillsUsed.map((n) => `- [[${n}]]`).join('\n') : '- (none)';

  return `---
type: council-session
session_id: ${s.sessionId}
date: ${date}
tags: [mission-control, council, memory]
---

# ${s.title}

## Goal
${s.goal}

## Consensus strategy
${s.consensus ?? '(no consensus reached)'}

## Stats
- Debate rounds: ${s.roundCount}
- Tasks created: ${s.taskCount}

## Skills used
${skills}

## Links
[[Brand Voice]] | [[Profile]]
`;
}

/**
 * Write the council session summary to memory + Obsidian.
 * Called automatically by executeCouncilStrategy().
 */
export async function writeSessionMemory(
  input: SessionSummaryInput
): Promise<{ relPath: string; writtenToVault: boolean }> {
  const date = iso(Math.floor(Date.now() / 1000));
  const fileName = `${date}-council-${input.sessionId}.md`;
  const relPath = `Sessions/${fileName}`;
  const mcRelPath = mcPath(relPath);
  const content = buildSessionNote(input);

  let writtenToMemoryFs = false;
  let writtenToVault = false;

  // Write to memory filesystem.
  if (config.memoryDir) {
    try {
      const sessionsDir = join(config.memoryDir, 'Sessions');
      if (!existsSync(sessionsDir)) {
        await mkdir(sessionsDir, { recursive: true });
      }
      const absPath = join(config.memoryDir, relPath);
      await writeFile(absPath, content, 'utf-8');
      await indexSessionFile(absPath, relPath, content);
      writtenToMemoryFs = true;
    } catch (err) {
      logger.warn({ err }, 'Failed to write session to memory filesystem');
    }
  }

  // Write to Obsidian vault.
  if (isVaultConfigured()) {
    writtenToVault = await writeVaultNote(mcRelPath, content);
  }

  logger.info(
    { sessionId: input.sessionId, writtenToMemoryFs, writtenToVault },
    'Session memory written'
  );

  return { relPath: mcRelPath, writtenToVault };
}

/** Load the context log for a session — what knowledge was retrieved. */
export interface ContextLogEntry {
  source_type: string;
  source_id: number | null;
  snippet: string | null;
  relevance_score: number | null;
}

export function getContextLog(councilSessionId: number): ContextLogEntry[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT source_type, source_id, snippet, relevance_score
       FROM memory_context_log
       WHERE council_session_id = ?
       ORDER BY id ASC`
    )
    .all(councilSessionId) as ContextLogEntry[];
}
