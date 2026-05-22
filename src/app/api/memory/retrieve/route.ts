import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { retrieveContext } from '@/lib/memory/retriever'

/** GET /api/memory/retrieve?goal=... — fetch what context a council session would get. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const goal = new URL(request.url).searchParams.get('goal') ?? ''
  if (!goal.trim()) return NextResponse.json({ error: 'goal is required' }, { status: 400 })
  try {
    const result = await retrieveContext(auth.user.workspace_id ?? 1, goal)
    return NextResponse.json({
      goal,
      contextBlock: result.contextBlock,
      snippets: result.snippets,
      recommendedSkills: result.recommendedSkills.map(s => ({
        id: s.skill.id, name: s.skill.name, slug: s.skill.slug,
        relevanceScore: s.relevanceScore, combinedScore: s.combinedScore,
      })),
    })
  } catch (err) {
    logger.error({ err }, 'Context retrieval failed')
    return NextResponse.json({ error: 'Context retrieval failed' }, { status: 500 })
  }
}
