import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getCouncilSessionDetail } from '@/lib/council/db';
import { getCouncilSkills } from '@/lib/skills/db';

/**
 * GET /api/council/:id — returns the session, participants, all debate
 * messages, votes, and the final strategy (if any).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const { id } = await params;
    const sessionId = Number.parseInt(id, 10);
    if (!Number.isFinite(sessionId)) {
      return NextResponse.json(
        { error: 'Invalid council session id' },
        { status: 400 }
      );
    }

    const workspaceId = auth.user.workspace_id ?? 1;
    const detail = getCouncilSessionDetail(sessionId, workspaceId);
    if (!detail) {
      return NextResponse.json(
        { error: 'Council session not found' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ...detail, skills: getCouncilSkills(sessionId) });
  } catch (err) {
    logger.error({ err }, 'Failed to load council session');
    return NextResponse.json(
      { error: 'Failed to load council session' },
      { status: 500 }
    );
  }
}
