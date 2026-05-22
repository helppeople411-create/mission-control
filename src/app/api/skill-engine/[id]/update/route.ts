import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { getSkill, updateSkill, getSkillDetail } from '@/lib/skills/db';

/**
 * POST /api/skill-engine/:id/update — update skill fields.
 * Changing instructions creates a new skill version.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const { id } = await params;
    const skillId = Number.parseInt(id, 10);
    if (!Number.isFinite(skillId))
      return NextResponse.json({ error: 'Invalid skill id' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    if (!getSkill(skillId, workspaceId))
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    updateSkill(skillId, {
      name: body.name,
      description: body.description,
      instructions: body.instructions,
      inputSchema: body.input_schema,
      outputSchema: body.output_schema,
      toolsAllowed: Array.isArray(body.tools_allowed)
        ? body.tools_allowed
        : undefined,
      examplePrompts: Array.isArray(body.example_prompts)
        ? body.example_prompts
        : undefined,
      status: body.status,
      changelog: body.changelog,
    });
    return NextResponse.json({ skill: getSkillDetail(skillId, workspaceId) });
  } catch (err) {
    logger.error({ err }, 'Failed to update skill');
    return NextResponse.json({ error: 'Failed to update skill' }, { status: 500 });
  }
}
