/**
 * Skill Engine + Knowledge Ingestion — database access layer.
 */

import { getDatabase } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import type {
  AgentSkill,
  AgentSkillVersion,
  AgentSkillDetail,
  AgentSkillRun,
  KnowledgeSource,
  KnowledgeChunk,
  SkillSourceType,
  SkillStatus,
  KnowledgeType,
} from './types';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateSkillInput {
  workspaceId: number;
  name: string;
  description?: string;
  instructions?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  toolsAllowed?: string[];
  examplePrompts?: string[];
  sourceType?: SkillSourceType;
  sourceIds?: number[];
  status?: SkillStatus;
}

export function createSkill(input: CreateSkillInput): AgentSkill {
  const db = getDatabase();
  let slug = slugify(input.name);
  // Ensure slug uniqueness within the workspace.
  const exists = db.prepare(
    `SELECT 1 FROM agent_skills WHERE workspace_id = ? AND slug = ?`
  );
  let suffix = 2;
  while (exists.get(input.workspaceId, slug)) {
    slug = `${slugify(input.name)}-${suffix++}`;
  }

  const result = db
    .prepare(
      `INSERT INTO agent_skills
        (workspace_id, name, slug, description, instructions,
         input_schema_json, output_schema_json, tools_allowed_json,
         example_prompts_json, source_type, source_ids_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspaceId,
      input.name,
      slug,
      input.description ?? null,
      input.instructions ?? null,
      input.inputSchema ? JSON.stringify(input.inputSchema) : null,
      input.outputSchema ? JSON.stringify(input.outputSchema) : null,
      input.toolsAllowed ? JSON.stringify(input.toolsAllowed) : null,
      input.examplePrompts ? JSON.stringify(input.examplePrompts) : null,
      input.sourceType ?? 'manual',
      input.sourceIds && input.sourceIds.length
        ? JSON.stringify(input.sourceIds)
        : null,
      input.status ?? 'draft'
    );

  const skill = getSkill(Number(result.lastInsertRowid))!;
  // Seed version 1.
  addSkillVersion(skill.id, input.instructions ?? '', 'Initial version');
  eventBus.broadcast('skill.created', skill);
  return skill;
}

export function getSkill(id: number, workspaceId?: number): AgentSkill | undefined {
  const db = getDatabase();
  const row =
    workspaceId != null
      ? db
          .prepare(
            `SELECT * FROM agent_skills WHERE id = ? AND workspace_id = ?`
          )
          .get(id, workspaceId)
      : db.prepare(`SELECT * FROM agent_skills WHERE id = ?`).get(id);
  return row as AgentSkill | undefined;
}

export function getSkillBySlug(
  workspaceId: number,
  slug: string
): AgentSkill | undefined {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM agent_skills WHERE workspace_id = ? AND slug = ?`)
    .get(workspaceId, slug) as AgentSkill | undefined;
}

export function listSkills(
  workspaceId: number,
  status?: SkillStatus
): AgentSkill[] {
  const db = getDatabase();
  if (status) {
    return db
      .prepare(
        `SELECT * FROM agent_skills
         WHERE workspace_id = ? AND status = ?
         ORDER BY updated_at DESC`
      )
      .all(workspaceId, status) as AgentSkill[];
  }
  return db
    .prepare(
      `SELECT * FROM agent_skills
       WHERE workspace_id = ?
       ORDER BY updated_at DESC`
    )
    .all(workspaceId) as AgentSkill[];
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  instructions?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  toolsAllowed?: string[];
  examplePrompts?: string[];
  status?: SkillStatus;
  changelog?: string;
}

export function updateSkill(
  id: number,
  patch: UpdateSkillInput
): AgentSkill | undefined {
  const db = getDatabase();
  const current = getSkill(id);
  if (!current) return undefined;

  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.instructions !== undefined) set('instructions', patch.instructions);
  if (patch.inputSchema !== undefined)
    set('input_schema_json', JSON.stringify(patch.inputSchema));
  if (patch.outputSchema !== undefined)
    set('output_schema_json', JSON.stringify(patch.outputSchema));
  if (patch.toolsAllowed !== undefined)
    set('tools_allowed_json', JSON.stringify(patch.toolsAllowed));
  if (patch.examplePrompts !== undefined)
    set('example_prompts_json', JSON.stringify(patch.examplePrompts));
  if (patch.status !== undefined) set('status', patch.status);

  if (fields.length === 0) return current;
  fields.push('updated_at = unixepoch()');
  db.prepare(`UPDATE agent_skills SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
    id
  );

  // A change to instructions creates a new version.
  if (
    patch.instructions !== undefined &&
    patch.instructions !== current.instructions
  ) {
    const nextVersion = getNextVersionNumber(id);
    addSkillVersion(
      id,
      patch.instructions,
      patch.changelog ?? `Updated to version ${nextVersion}`
    );
  }

  const skill = getSkill(id);
  if (skill) eventBus.broadcast('skill.updated', skill);
  return skill;
}

export function archiveSkill(id: number): AgentSkill | undefined {
  return updateSkill(id, { status: 'archived', changelog: 'Archived' });
}

/* -------------------------------------------------------------------------- */
/* Skill versions                                                                */
/* -------------------------------------------------------------------------- */

function getNextVersionNumber(skillId: number): number {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
       FROM agent_skill_versions WHERE skill_id = ?`
    )
    .get(skillId) as { next: number };
  return row.next;
}

export function addSkillVersion(
  skillId: number,
  instructions: string,
  changelog: string
): AgentSkillVersion {
  const db = getDatabase();
  const version = getNextVersionNumber(skillId);
  const result = db
    .prepare(
      `INSERT INTO agent_skill_versions
        (skill_id, version_number, instructions, changelog)
       VALUES (?, ?, ?, ?)`
    )
    .run(skillId, version, instructions, changelog);
  return db
    .prepare(`SELECT * FROM agent_skill_versions WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as AgentSkillVersion;
}

export function getSkillVersions(skillId: number): AgentSkillVersion[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM agent_skill_versions
       WHERE skill_id = ?
       ORDER BY version_number DESC`
    )
    .all(skillId) as AgentSkillVersion[];
}

/** Expand a skill's JSON fields and attach version history. */
export function getSkillDetail(
  id: number,
  workspaceId?: number
): AgentSkillDetail | undefined {
  const skill = getSkill(id, workspaceId);
  if (!skill) return undefined;
  return {
    ...skill,
    input_schema: parseJson<unknown>(skill.input_schema_json, null),
    output_schema: parseJson<unknown>(skill.output_schema_json, null),
    tools_allowed: parseJson<string[]>(skill.tools_allowed_json, []),
    example_prompts: parseJson<string[]>(skill.example_prompts_json, []),
    source_ids: parseJson<number[]>(skill.source_ids_json, []),
    versions: getSkillVersions(id),
  };
}

/* -------------------------------------------------------------------------- */
/* Knowledge sources + chunks                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateKnowledgeInput {
  workspaceId: number;
  type: KnowledgeType;
  title: string;
  url?: string;
  filePath?: string;
  rawText?: string;
  summary?: string;
  keyPoints?: string[];
  entities?: string[];
  tags?: string[];
}

export function createKnowledgeSource(
  input: CreateKnowledgeInput
): KnowledgeSource {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO knowledge_sources
        (workspace_id, type, title, url, file_path, raw_text, summary,
         key_points_json, entities_json, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspaceId,
      input.type,
      input.title,
      input.url ?? null,
      input.filePath ?? null,
      input.rawText ?? null,
      input.summary ?? null,
      input.keyPoints ? JSON.stringify(input.keyPoints) : null,
      input.entities ? JSON.stringify(input.entities) : null,
      input.tags ? JSON.stringify(input.tags) : null
    );
  const source = getKnowledgeSource(Number(result.lastInsertRowid))!;
  eventBus.broadcast('knowledge.ingested', source);
  return source;
}

export function getKnowledgeSource(
  id: number,
  workspaceId?: number
): KnowledgeSource | undefined {
  const db = getDatabase();
  const row =
    workspaceId != null
      ? db
          .prepare(
            `SELECT * FROM knowledge_sources WHERE id = ? AND workspace_id = ?`
          )
          .get(id, workspaceId)
      : db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(id);
  return row as KnowledgeSource | undefined;
}

export function findKnowledgeByTitle(
  workspaceId: number,
  titleOrSlug: string
): KnowledgeSource | undefined {
  const db = getDatabase();
  const needle = titleOrSlug.toLowerCase();
  const all = db
    .prepare(`SELECT * FROM knowledge_sources WHERE workspace_id = ?`)
    .all(workspaceId) as KnowledgeSource[];
  return all.find(
    (s) =>
      s.title.toLowerCase() === needle ||
      slugify(s.title) === slugify(titleOrSlug)
  );
}

export function listKnowledgeSources(workspaceId: number): KnowledgeSource[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM knowledge_sources
       WHERE workspace_id = ?
       ORDER BY created_at DESC`
    )
    .all(workspaceId) as KnowledgeSource[];
}

export function addKnowledgeChunks(
  sourceId: number,
  sourceTitle: string,
  chunks: Array<{ text: string; index: number; metadata?: unknown }>
): KnowledgeChunk[] {
  const db = getDatabase();
  const insertChunk = db.prepare(
    `INSERT INTO knowledge_chunks
       (knowledge_source_id, chunk_text, chunk_index, metadata_json)
     VALUES (?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO knowledge_chunks_fts
       (chunk_text, source_title, chunk_id, source_id)
     VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(
    (rows: Array<{ text: string; index: number; metadata?: unknown }>) => {
      for (const r of rows) {
        const res = insertChunk.run(
          sourceId,
          r.text,
          r.index,
          r.metadata ? JSON.stringify(r.metadata) : null
        );
        insertFts.run(
          r.text,
          sourceTitle,
          Number(res.lastInsertRowid),
          sourceId
        );
      }
    }
  );
  tx(chunks);
  return getKnowledgeChunks(sourceId);
}

export function getKnowledgeChunks(sourceId: number): KnowledgeChunk[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM knowledge_chunks
       WHERE knowledge_source_id = ?
       ORDER BY chunk_index ASC`
    )
    .all(sourceId) as KnowledgeChunk[];
}

export interface KnowledgeSearchHit {
  chunk_id: number;
  source_id: number;
  source_title: string;
  snippet: string;
}

/** Keyword search across ingested knowledge (FTS5). */
export function searchKnowledge(
  query: string,
  limit = 10
): KnowledgeSearchHit[] {
  const db = getDatabase();
  const cleaned = query.replace(/["'*]/g, ' ').trim();
  if (!cleaned) return [];
  try {
    return db
      .prepare(
        `SELECT chunk_id, source_id, source_title,
                snippet(knowledge_chunks_fts, 0, '[', ']', '…', 12) AS snippet
         FROM knowledge_chunks_fts
         WHERE knowledge_chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(cleaned, limit) as KnowledgeSearchHit[];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Skill runs (which skills work best — spec §10)                               */
/* -------------------------------------------------------------------------- */

export interface RecordSkillRunInput {
  skillId: number;
  goalId?: number | null;
  councilSessionId?: number | null;
  agentId?: number | null;
  input?: unknown;
  output?: unknown;
  successScore?: number | null;
}

export function recordSkillRun(input: RecordSkillRunInput): AgentSkillRun {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO agent_skill_runs
        (skill_id, goal_id, council_session_id, agent_id,
         input_json, output_json, success_score)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.skillId,
      input.goalId ?? null,
      input.councilSessionId ?? null,
      input.agentId ?? null,
      input.input ? JSON.stringify(input.input) : null,
      input.output ? JSON.stringify(input.output) : null,
      input.successScore ?? null
    );
  return db
    .prepare(`SELECT * FROM agent_skill_runs WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as AgentSkillRun;
}

export interface SkillStats {
  skill_id: number;
  run_count: number;
  avg_success: number | null;
}

export function getSkillStats(skillId: number): SkillStats {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT ? AS skill_id,
              COUNT(*) AS run_count,
              AVG(success_score) AS avg_success
       FROM agent_skill_runs WHERE skill_id = ?`
    )
    .get(skillId, skillId) as SkillStats;
}

/* -------------------------------------------------------------------------- */
/* Council <-> Skill bridge (spec §9)                                            */
/* -------------------------------------------------------------------------- */

export function attachSkillsToCouncil(
  councilSessionId: number,
  assignments: Array<{
    skillId: number;
    agentId?: number;
    agentName?: string;
  }>
): void {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO council_session_skills
       (council_session_id, skill_id, agent_id, agent_name)
     VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: typeof assignments) => {
    for (const r of rows) {
      insert.run(
        councilSessionId,
        r.skillId,
        r.agentId ?? null,
        r.agentName ?? null
      );
    }
  });
  tx(assignments);
}

export interface CouncilSkillAssignment {
  id: number;
  council_session_id: number;
  skill_id: number;
  skill_name: string;
  agent_id: number | null;
  agent_name: string | null;
}

export function getCouncilSkills(
  councilSessionId: number
): CouncilSkillAssignment[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT css.id, css.council_session_id, css.skill_id,
              s.name AS skill_name, css.agent_id, css.agent_name
       FROM council_session_skills css
       JOIN agent_skills s ON s.id = css.skill_id
       WHERE css.council_session_id = ?
       ORDER BY css.id ASC`
    )
    .all(councilSessionId) as CouncilSkillAssignment[];
}
