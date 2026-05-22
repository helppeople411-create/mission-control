import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { recommendSkills } from '@/lib/memory/skill-recommender'

/** GET /api/memory/skill-recommend?goal=... — ranked skill suggestions. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const params = new URL(request.url).searchParams
  const goal = params.get('goal') ?? ''
  const limit = Number(params.get('limit') ?? 5)
  if (!goal.trim()) return NextResponse.json({ error: 'goal is required' }, { status: 400 })
  const skills = recommendSkills(auth.user.workspace_id ?? 1, goal, limit)
  return NextResponse.json({
    goal,
    recommendations: skills.map(s => ({
      id: s.skill.id, name: s.skill.name, slug: s.skill.slug,
      description: s.skill.description, relevanceScore: s.relevanceScore,
      successScore: s.successScore, combinedScore: s.combinedScore,
    })),
  })
}
