import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { startCouncil, CouncilError } from '@/lib/council/engine';
import { getCouncilSessionDetail } from '@/lib/council/db';

/**
 * POST /api/council/start — create a council session from a user goal.
 *
 * Body: { user_goal: string, title?: string, goal_id?: number,
 *         consensus_threshold?: number, max_rounds?: number }
 *
 * Selects 3–5 agents, assigns council roles, and runs the first
 * proposal round.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rateCheck = mutationLimiter(request);
  if (rateCheck) return rateCheck;

  try {
    const body = await request.json().catch(() => ({}));
    const userGoal =
      typeof body.user_goal === 'string' ? body.user_goal.trim() : '';
    if (!userGoal) {
      return NextResponse.json(
        { error: 'user_goal is required' },
        { status: 400 }
      );
    }

    const workspaceId = auth.user.workspace_id ?? 1;
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim()
        : userGoal.slice(0, 80);

    const consensusThreshold =
      typeof body.consensus_threshold === 'number'
        ? Math.min(Math.max(body.consensus_threshold, 0.5), 1)
        : undefined;
    const maxRounds =
      typeof body.max_rounds === 'number'
        ? Math.min(Math.max(Math.trunc(body.max_rounds), 1), 10)
        : undefined;

    const { session } = await startCouncil({
      workspaceId,
      goalId: typeof body.goal_id === 'number' ? body.goal_id : null,
      title,
      userGoal,
      consensusThreshold,
      maxRounds,
    });

    db_helpers.logActivity(
      'council_started',
      'council_session',
      session.id,
      auth.user.username,
      `Agent Council started for goal: ${title}`,
      { user_goal: userGoal },
      workspaceId
    );

    const detail = getCouncilSessionDetail(session.id, workspaceId);
    return NextResponse.json(detail, { status: 201 });
  } catch (err) {
    if (err instanceof CouncilError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, 'Failed to start council session');
    return NextResponse.json(
      { error: 'Failed to start council session' },
      { status: 500 }
    );
  }
}
