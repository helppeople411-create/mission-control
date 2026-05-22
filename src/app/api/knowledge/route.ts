import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { listKnowledgeSources, searchKnowledge } from '@/lib/skills/db';

/**
 * GET /api/knowledge — list ingested PDFs, links, and notes.
 * Optional ?q= runs a keyword search across knowledge chunks.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const workspaceId = auth.user.workspace_id ?? 1;
    const q = new URL(request.url).searchParams.get('q');
    if (q && q.trim()) {
      return NextResponse.json({ query: q, results: searchKnowledge(q) });
    }
    return NextResponse.json({ sources: listKnowledgeSources(workspaceId) });
  } catch (err) {
    logger.error({ err }, 'Failed to list knowledge');
    return NextResponse.json(
      { error: 'Failed to list knowledge' },
      { status: 500 }
    );
  }
}
