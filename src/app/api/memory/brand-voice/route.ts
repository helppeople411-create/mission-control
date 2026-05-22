import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getBrandVoice, setBrandVoice } from '@/lib/memory/brand-voice'

/** GET /api/memory/brand-voice */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const workspaceId = auth.user.workspace_id ?? 1
  const content = await getBrandVoice(workspaceId)
  return NextResponse.json({ content })
}

/** POST /api/memory/brand-voice — save and sync to Obsidian. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rate = mutationLimiter(request)
  if (rate) return rate
  const body = await request.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content : ''
  if (!content.trim()) return NextResponse.json({ error: 'content is required' }, { status: 400 })
  await setBrandVoice(auth.user.workspace_id ?? 1, content)
  return NextResponse.json({ ok: true })
}
