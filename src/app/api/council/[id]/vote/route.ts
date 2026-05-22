import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { advanceCouncil, CouncilError } from '@/lib/council/engine';
import { getCouncilSessionDetail, getCouncilSession } from '@/lib/council/db';

/**
 * POST /api/council/:id/vote — collect one vote per agent for the current
 * round, evaluate consensus (spec §10), and advance the session:
 *   - consensus reached  → status = consensus_reached
 *   - max rounds hit     → best plan chosen, or status = failed
 *   - otherwise          → status stays debating (run another round)
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

    const { session, consensus } = await advanceCouncil(sessionId);

    db_helpers.logActivity(
      'council_voted',
      'council_session',
      sessionId,
      auth.user.username,
      `Council round ${session.current_round} vote — ${
        consensus.consensusReached ? 'consensus reached' : 'no consensus'
      }`,
      {
        agree_fraction: consensus.agreeFraction,
        average_confidence: consensus.averageConfidence,
        status: session.status,
      },
      workspaceId
    );

    const detail = getCouncilSessionDetail(sessionId, workspaceId);
    return NextResponse.json({
      consensus: {
        consensus_reached: consensus.consensusReached,
        agree_fraction: consensus.agreeFraction,
        average_confidence: consensus.averageConfidence,
        has_critical_blocker: consensus.hasCriticalBlocker,
      },
      ...detail,
    });
  } catch (err) {
    if (err instanceof CouncilError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, 'Failed to collect council votes');
    return NextResponse.json(
      { error: 'Failed to collect council votes' },
      { status: 500 }
    );
  }
}
