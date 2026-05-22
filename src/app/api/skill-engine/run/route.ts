import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { getSkill, recordSkillRun } from '@/lib/skills/db';

/**
 * POST /api/skill-engine/run — record a skill run (spec §10).
 * Captures input/output and a success score so the system can learn which
 * skills work best. Body: { skill_id, goal_id?, council_session_id?,
 * agent_id?, input?, output?, success_score? }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const body = await request.json().catch(() => ({}));
    const skillId = Number(body.skill_id);
    if (!Number.isFinite(skillId))
      return NextResponse.json({ error: 'skill_id is required' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    if (!getSkill(skillId, workspaceId))
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });

    const run = recordSkillRun({
      skillId,
      goalId: body.goal_id ?? null,
      councilSessionId: body.council_session_id ?? null,
      agentId: body.agent_id ?? null,
      input: body.input,
      output: body.output,
      successScore:
        typeof body.success_score === 'number' ? body.success_score : null,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    logger.error({ err }, 'Failed to record skill run');
    return NextResponse.json(
      { error: 'Failed to record skill run' },
      { status: 500 }
    );
  }
}
