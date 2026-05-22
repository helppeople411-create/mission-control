/**
 * Skill recommender.
 *
 * Given a user goal, ranks active skills by relevance + historical
 * performance so Council sessions auto-suggest the most useful ones.
 *
 * Scoring = (word-overlap ratio with goal) × 0.6
 *          + (normalised avg success score) × 0.4
 */

import { getDatabase } from '@/lib/db';
import type { AgentSkill } from '@/lib/skills/types';

export interface ScoredSkill {
  skill: AgentSkill;
  relevanceScore: number;
  successScore: number | null;
  combinedScore: number;
}

function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) ?? []).filter(
      (w) => w.length > 2
    )
  );
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / Math.min(a.size, b.size);
}

interface SkillRunStat {
  skill_id: number;
  avg_success: number | null;
  run_count: number;
}

export function recommendSkills(
  workspaceId: number,
  goal: string,
  limit = 5
): ScoredSkill[] {
  const db = getDatabase();

  const skills = db
    .prepare(
      `SELECT * FROM agent_skills
       WHERE workspace_id = ? AND status = 'active'
       ORDER BY updated_at DESC`
    )
    .all(workspaceId) as AgentSkill[];

  if (!skills.length) return [];

  const stats = db
    .prepare(
      `SELECT skill_id,
              AVG(success_score) AS avg_success,
              COUNT(*) AS run_count
       FROM agent_skill_runs
       WHERE skill_id IN (${skills.map(() => '?').join(',')})
       GROUP BY skill_id`
    )
    .all(...skills.map((s) => s.id)) as SkillRunStat[];

  const statsMap = new Map(stats.map((s) => [s.skill_id, s]));
  const goalTokens = tokenize(goal);

  const scored = skills.map((skill) => {
    const haystack = tokenize(
      [skill.name, skill.description ?? '', skill.instructions ?? ''].join(' ')
    );
    const relevanceScore = overlapRatio(goalTokens, haystack);
    const stat = statsMap.get(skill.id);
    const successScore = stat?.avg_success ?? null;
    // Normalise success to 0-1 (stored as 0-1 already).
    const normSuccess = successScore != null ? Math.max(0, Math.min(1, successScore)) : 0.5;
    const combinedScore = relevanceScore * 0.6 + normSuccess * 0.4;
    return { skill, relevanceScore, successScore, combinedScore };
  });

  return scored
    .filter((s) => s.combinedScore > 0)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}
