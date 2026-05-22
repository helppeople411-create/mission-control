import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { getSkill, archiveSkill } from '@/lib/skills/db';

/** POST /api/skill-engine/:id/archive — disable a skill. */
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

    return NextResponse.json({ skill: archiveSkill(skillId) });
  } catch (err) {
    logger.error({ err }, 'Failed to archive skill');
    return NextResponse.json({ error: 'Failed to archive skill' }, { status: 500 });
  }
}
