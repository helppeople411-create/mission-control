import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { listSkills } from '@/lib/skills/db';
import type { SkillStatus } from '@/lib/skills/types';

/** GET /api/skill-engine — list reusable agent skills. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const workspaceId = auth.user.workspace_id ?? 1;
    const status = new URL(request.url).searchParams.get('status') as
      | SkillStatus
      | null;
    return NextResponse.json({
      skills: listSkills(workspaceId, status ?? undefined),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list skills');
    return NextResponse.json({ error: 'Failed to list skills' }, { status: 500 });
  }
}
