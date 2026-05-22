import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { getKnowledgeSource, getKnowledgeChunks } from '@/lib/skills/db';

/** GET /api/knowledge/:id — source summary, key points, and chunks. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { id } = await params;
    const sourceId = Number.parseInt(id, 10);
    if (!Number.isFinite(sourceId))
      return NextResponse.json({ error: 'Invalid source id' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    const source = getKnowledgeSource(sourceId, workspaceId);
    if (!source)
      return NextResponse.json(
        { error: 'Knowledge source not found' },
        { status: 404 }
      );
    return NextResponse.json({
      source,
      chunks: getKnowledgeChunks(sourceId),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load knowledge source');
    return NextResponse.json(
      { error: 'Failed to load knowledge source' },
      { status: 500 }
    );
  }
}
