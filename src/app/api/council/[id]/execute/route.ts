import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { executeCouncilStrategy, CouncilError } from '@/lib/council/engine';
import { getCouncilSessionDetail, getCouncilSession } from '@/lib/council/db';

/**
 * POST /api/council/:id/execute — convert the consensus strategy into
 * Mission Control tasks and dispatch them into the existing task system.
 *
 * Requires the session to be in status 'consensus_reached'.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

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
    if (!getCouncilSession(sessionId, workspaceId)) {
      return NextResponse.json(
        { error: 'Council session not found' },
        { status: 404 }
      );
    }

    const { taskIds, output } = executeCouncilStrategy(sessionId);

    db_helpers.logActivity(
      'council_executed',
      'council_session',
      sessionId,
      auth.user.username,
      `Council strategy executed — ${taskIds.length} task(s) created`,
      { task_ids: taskIds, confidence: output.confidence },
      workspaceId
    );

    const detail = getCouncilSessionDetail(sessionId, workspaceId);
    return NextResponse.json({
      strategy: output,
      created_task_ids: taskIds,
      ...detail,
    });
  } catch (err) {
    if (err instanceof CouncilError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, 'Failed to execute council strategy');
    return NextResponse.json(
      { error: 'Failed to execute council strategy' },
      { status: 500 }
    );
  }
}
