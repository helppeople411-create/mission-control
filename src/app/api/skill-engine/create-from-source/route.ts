import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { buildSkillFromSource } from '@/lib/skills/skill-builder';
import { findKnowledgeByTitle } from '@/lib/skills/db';
import { IngestError } from '@/lib/skills/ingest';

/**
 * POST /api/skill-engine/create-from-source — generate a skill from an
 * ingested knowledge source (spec §5G, §15).
 * Body: { name, source_id?, source? (title/slug), purpose? }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name)
      return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const workspaceId = auth.user.workspace_id ?? 1;
    let sourceId: number | undefined =
      typeof body.source_id === 'number' ? body.source_id : undefined;
    if (sourceId == null && typeof body.source === 'string') {
      sourceId = findKnowledgeByTitle(workspaceId, body.source)?.id;
    }
    if (sourceId == null) {
      return NextResponse.json(
        { error: 'A valid source_id or source title is required' },
        { status: 400 }
      );
    }

    const skill = await buildSkillFromSource({
      workspaceId,
      sourceId,
      name,
      purpose: body.purpose,
    });

    db_helpers.logActivity(
      'skill_created',
      'agent_skill',
      skill.id,
      auth.user.username,
      `Skill generated from source: ${skill.name}`,
      { source_id: sourceId },
      workspaceId
    );
    return NextResponse.json({ skill }, { status: 201 });
  } catch (err) {
    if (err instanceof IngestError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    logger.error({ err }, 'Failed to build skill from source');
    return NextResponse.json(
      { error: 'Failed to build skill from source' },
      { status: 500 }
    );
  }
}
