/**
 * Skill Engine — Skill Builder.
 *
 * Turns an ingested knowledge source into a reusable agent skill in the
 * canonical skill format (spec §8, §13, §14). The Skill Builder Agent uses
 * SKILL_BUILDER_PROMPT; this module assembles the skill document from the
 * structured digest already stored on the knowledge source.
 */

import { getKnowledgeDigester } from './digester';
import {
  getKnowledgeSource,
  createSkill,
  type CreateSkillInput,
} from './db';
import { IngestError } from './ingest';
import { SKILL_FORMAT_SECTIONS } from './types';
import type { AgentSkill, KnowledgeDigest } from './types';

function bullets(items: string[], emptyNote: string): string {
  if (!items.length) return `  - ${emptyNote}`;
  return items.map((i) => `  - ${i}`).join('\n');
}

/**
 * Render a skill document in the canonical 10-section format.
 * The section order matches SKILL_FORMAT_SECTIONS.
 */
export function renderSkillDocument(opts: {
  name: string;
  purpose: string;
  digest: KnowledgeDigest;
}): string {
  const { name, purpose, digest } = opts;
  const procedure = digest.procedures.length
    ? digest.procedures.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    : '  1. Review the inputs.\n  2. Apply the source material.\n  3. Produce the output.';

  const sections: Record<(typeof SKILL_FORMAT_SECTIONS)[number], string> = {
    Name: name,
    Purpose: purpose,
    'When to use':
      digest.keyPoints[0] ??
      'When a goal matches the topic this skill was built from.',
    'When not to use':
      'When the goal is unrelated to this skill, or when a more specific ' +
      'skill is available.',
    'Required inputs': bullets(
      digest.terminology.slice(0, 5),
      'A clearly stated goal or task'
    ),
    'Allowed tools': '  - (none specified — inherits the agent default)',
    'Step-by-step procedure': procedure,
    'Quality checklist': bullets(
      digest.rules,
      'Output is consistent with the source material'
    ),
    'Output format': bullets(
      digest.keyPoints.slice(0, 4),
      'A clear, actionable result'
    ),
    Examples: bullets(digest.examples, 'See the source material'),
  };

  let doc = '';
  for (const key of SKILL_FORMAT_SECTIONS) {
    doc += `${key}:\n${sections[key]}\n\n`;
  }
  if (digest.warnings.length) {
    doc += `Warnings:\n${bullets(digest.warnings, '')}\n`;
  }
  return doc.trim();
}

export interface BuildSkillFromSourceInput {
  workspaceId: number;
  /** Knowledge source id to build from. */
  sourceId: number;
  /** Desired skill name. */
  name: string;
  /** Optional purpose override. */
  purpose?: string;
}

/**
 * Create a skill from a knowledge source (spec §5G, §15).
 * The skill is created with status 'draft' and source_type 'generated'.
 */
export async function buildSkillFromSource(
  input: BuildSkillFromSourceInput
): Promise<AgentSkill> {
  const source = getKnowledgeSource(input.sourceId, input.workspaceId);
  if (!source) {
    throw new IngestError('Knowledge source not found.', 404);
  }
  if (!source.raw_text) {
    throw new IngestError('Knowledge source has no text to build from.');
  }

  // Re-digest so the skill reflects the full structured extraction.
  const digest = await getKnowledgeDigester().digest(
    source.raw_text,
    source.title
  );
  const purpose =
    input.purpose ||
    digest.summary ||
    `Apply the knowledge from "${source.title}".`;

  const instructions = renderSkillDocument({
    name: input.name,
    purpose,
    digest,
  });

  const skillInput: CreateSkillInput = {
    workspaceId: input.workspaceId,
    name: input.name,
    description: `Generated from ${source.type} source: ${source.title}`,
    instructions,
    examplePrompts: digest.examples.slice(0, 3),
    sourceType: 'generated',
    sourceIds: [source.id],
    status: 'draft',
  };

  return createSkill(skillInput);
}
