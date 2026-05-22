import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getVaultStatus, ensureMcFolders } from '@/lib/memory/obsidian'

/** GET /api/memory/obsidian — vault connection status. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const status = await getVaultStatus()
  return NextResponse.json(status)
}

/** POST /api/memory/obsidian — ensure MC folders exist in the vault. */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  ensureMcFolders()
  const status = await getVaultStatus()
  return NextResponse.json({ ok: true, status })
}
