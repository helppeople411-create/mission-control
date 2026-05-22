import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { db_helpers } from '@/lib/db';
import { createSkill } from '@/lib/skills/db';

/**
 * POST /api/skill-engine/create — create a skill.
 * Body: { name, description?, instructions?, tools_allowed?, example_prompts?,
 *         input_schema?, output_schema?, status? }
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
    const skill = createSkill({
      workspaceId,
      name,
      description: body.description,
      instructions: body.instructions,
      inputSchema: body.input_schema,
      outputSchema: body.output_schema,
      toolsAllowed: Array.isArray(body.tools_allowed)
        ? body.tools_allowed
        : undefined,
      examplePrompts: Array.isArray(body.example_prompts)
        ? body.example_prompts
        : undefined,
      sourceType: 'manual',
      status: body.status === 'active' ? 'active' : 'draft',
    });

    db_helpers.logActivity(
      'skill_created',
      'agent_skill',
      skill.id,
      auth.user.username,
      `Skill created: ${skill.name}`,
      { slug: skill.slug },
      workspaceId
    );
    return NextResponse.json({ skill }, { status: 201 });
  } catch (err) {
    logger.error({ err }, 'Failed to create skill');
    return NextResponse.json({ error: 'Failed to create skill' }, { status: 500 });
  }
}
