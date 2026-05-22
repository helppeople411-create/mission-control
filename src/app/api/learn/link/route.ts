import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { ingestLink, IngestError } from '@/lib/skills/ingest';

/** POST /api/learn/link — fetch, clean, and ingest a webpage (spec §6). */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const body = await request.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url)
      return NextResponse.json({ error: 'url is required' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    const result = await ingestLink(workspaceId, url);

    db_helpers.logActivity(
      'knowledge_ingested',
      'knowledge_source',
      result.source.id,
      auth.user.username,
      `Link ingested: ${result.source.title}`,
      { url, chunks: result.chunkCount },
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
    logger.error({ err }, 'Failed to ingest link');
    return NextResponse.json({ error: 'Failed to ingest link' }, { status: 500 });
  }
}
