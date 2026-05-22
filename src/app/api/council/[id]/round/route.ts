import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { runDebateRound, CouncilError } from '@/lib/council/engine';
import { getCouncilSessionDetail, getCouncilSession } from '@/lib/council/db';

/**
 * POST /api/council/:id/round — run the next debate round.
 *
 * Each participating agent reasons in role order, responding to prior
 * messages (proposal → challenge → revision depending on the round).
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

    const messages = await runDebateRound(sessionId);
    const detail = getCouncilSessionDetail(sessionId, workspaceId);
    return NextResponse.json({ round_messages: messages, ...detail });
  } catch (err) {
    if (err instanceof CouncilError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, 'Failed to run council round');
    return NextResponse.json(
      { error: 'Failed to run council round' },
      { status: 500 }
    );
  }
}
