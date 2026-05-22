/**
 * Skill Engine + Knowledge Ingestion — shared types.
 *
 * Skills are reusable agent abilities. Knowledge sources are ingested PDFs,
 * links and notes. Both plug into Council Mode: a council session can load
 * skills, and skills can be generated from ingested knowledge.
 */

export type SkillSourceType = 'manual' | 'pdf' | 'link' | 'generated';
export type SkillStatus = 'draft' | 'active' | 'archived';
export type KnowledgeType = 'pdf' | 'link' | 'text' | 'note';

export interface AgentSkill {
  id: number;
  workspace_id: number;
  name: string;
  slug: string;
  description: string | null;
  instructions: string | null;
  input_schema_json: string | null;
  output_schema_json: string | null;
  tools_allowed_json: string | null;
  example_prompts_json: string | null;
  source_type: SkillSourceType;
  source_ids_json: string | null;
  status: SkillStatus;
  created_at: number;
  updated_at: number;
}

export interface AgentSkillVersion {
  id: number;
  skill_id: number;
  version_number: number;
  instructions: string | null;
  changelog: string | null;
  created_at: number;
}

export interface KnowledgeSource {
  id: number;
  workspace_id: number;
  type: KnowledgeType;
  title: string;
  url: string | null;
  file_path: string | null;
  raw_text: string | null;
  summary: string | null;
  key_points_json: string | null;
  entities_json: string | null;
  tags_json: string | null;
  created_at: number;
}

export interface KnowledgeChunk {
  id: number;
  knowledge_source_id: number;
  chunk_text: string;
  chunk_index: number;
  embedding_vector: string | null;
  metadata_json: string | null;
  created_at: number;
}

export interface AgentSkillRun {
  id: number;
  skill_id: number;
  goal_id: number | null;
  council_session_id: number | null;
  agent_id: number | null;
  input_json: string | null;
  output_json: string | null;
  success_score: number | null;
  created_at: number;
}

/** A skill with its parsed JSON fields expanded, for API responses. */
export interface AgentSkillDetail extends AgentSkill {
  input_schema: unknown;
  output_schema: unknown;
  tools_allowed: string[];
  example_prompts: string[];
  source_ids: number[];
  versions: AgentSkillVersion[];
}

/**
 * The structured digest produced from a knowledge source — see spec §5D.
 * Summarization is pluggable (digester.ts); this is its output contract.
 */
export interface KnowledgeDigest {
  summary: string;
  keyPoints: string[];
  procedures: string[];
  rules: string[];
  examples: string[];
  terminology: string[];
  warnings: string[];
  entities: string[];
  tags: string[];
}

/** Canonical skill document structure (spec §8). */
export const SKILL_FORMAT_SECTIONS = [
  'Name',
  'Purpose',
  'When to use',
  'When not to use',
  'Required inputs',
  'Allowed tools',
  'Step-by-step procedure',
  'Quality checklist',
  'Output format',
  'Examples',
] as const;

/** Prompt the Skill Builder Agent uses to turn knowledge into a skill (§14). */
export const SKILL_BUILDER_PROMPT = `You are the Skill Builder Agent. Convert the provided knowledge into a reusable agent skill. Extract the core procedure, decision rules, examples, tools needed, warnings, and output format. The skill must be clear enough that another agent can execute it consistently without rereading the original source.`;

/** Identity of the built-in Skill Builder Agent (spec §13). */
export const SKILL_BUILDER_AGENT = {
  name: 'Skill Builder',
  role: 'skill-builder',
  soul:
    'Reads PDFs and links, digests knowledge, and turns it into clear, ' +
    'reusable agent skills with step-by-step procedures, quality ' +
    'checklists, examples, and tool recommendations.',
};
