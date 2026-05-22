import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { listCouncilSessions } from '@/lib/council/db';

/**
 * GET /api/council — list council sessions for the caller's workspace.
 * Query params: limit, offset
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const workspaceId = auth.user.workspace_id ?? 1;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');
    const sessions = listCouncilSessions(workspaceId, limit, offset);
    return NextResponse.json({ sessions });
  } catch (err) {
    logger.error({ err }, 'Failed to list council sessions');
    return NextResponse.json(
      { error: 'Failed to list council sessions' },
      { status: 500 }
    );
  }
}
