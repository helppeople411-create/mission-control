import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getSkillDetail, getSkillStats } from '@/lib/skills/db';

/** GET /api/skill-engine/:id — full skill with versions and run stats. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const skillId = Number.parseInt(id, 10);
    if (!Number.isFinite(skillId))
      return NextResponse.json({ error: 'Invalid skill id' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    const skill = getSkillDetail(skillId, workspaceId);
    if (!skill)
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    return NextResponse.json({ skill, stats: getSkillStats(skillId) });
  } catch (err) {
    logger.error({ err }, 'Failed to load skill');
    return NextResponse.json({ error: 'Failed to load skill' }, { status: 500 });
  }
}
