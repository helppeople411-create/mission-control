import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { ingestPdf, IngestError } from '@/lib/skills/ingest';

/**
 * POST /api/learn/pdf — ingest a PDF (spec §5).
 * Body: { title, raw_text? (pre-extracted), data_base64? (raw PDF bytes),
 *         file_path? }
 * Supplying raw_text is the most reliable path; data_base64 works only if a
 * PDF parser is installed/registered (see lib/skills/pdf.ts).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = auth.user.workspace_id ?? 1;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const data =
      typeof body.data_base64 === 'string'
        ? Buffer.from(body.data_base64, 'base64')
        : undefined;

    const result = await ingestPdf(workspaceId, {
      title,
      data,
      preExtractedText:
        typeof body.raw_text === 'string' ? body.raw_text : undefined,
      filePath: typeof body.file_path === 'string' ? body.file_path : undefined,
    });

    db_helpers.logActivity(
      'knowledge_ingested',
      'knowledge_source',
      result.source.id,
      auth.user.username,
      `PDF ingested: ${result.source.title}`,
      { chunks: result.chunkCount },
      workspaceId
    );
    return NextResponse.json(
      {
        source: result.source,
        chunk_count: result.chunkCount,
        suggest_skill: result.suggestSkill,
        message: result.suggestSkill
          ? 'I learned this PDF. Do you want me to create a reusable skill from it?'
          : 'I learned this PDF.',
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof IngestError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    logger.error({ err }, 'Failed to ingest PDF');
    return NextResponse.json({ error: 'Failed to ingest PDF' }, { status: 500 });
  }
}
