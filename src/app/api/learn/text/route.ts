import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { ingestText, IngestError } from '@/lib/skills/ingest';

/** POST /api/learn/text — store pasted knowledge (spec §7). */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim())
      return NextResponse.json({ error: 'text is required' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    const result = await ingestText(
      workspaceId,
      typeof body.title === 'string' ? body.title : 'Pasted note',
      text
    );

    db_helpers.logActivity(
      'knowledge_ingested',
      'knowledge_source',
      result.source.id,
      auth.user.username,
      `Note ingested: ${result.source.title}`,
      { chunks: result.chunkCount },
      workspaceId
    );
    return NextResponse.json(
      {
        source: result.source,
        chunk_count: result.chunkCount,
        suggest_skill: result.suggestSkill,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof IngestError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    logger.error({ err }, 'Failed to ingest text');
    return NextResponse.json({ error: 'Failed to ingest text' }, { status: 500 });
  }
}
