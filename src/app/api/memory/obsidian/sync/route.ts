import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { listVaultNotes, readVaultNote, isVaultConfigured } from '@/lib/memory/obsidian'
import { ingestText } from '@/lib/skills/ingest'

/**
 * POST /api/memory/obsidian/sync — pull all markdown files from the
 * Mission Control vault folder into the knowledge system so they are
 * searchable and retrievable by council sessions.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rate = mutationLimiter(request)
  if (rate) return rate

  if (!isVaultConfigured()) {
    return NextResponse.json({ error: 'OBSIDIAN_VAULT_PATH is not set' }, { status: 400 })
  }

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const notes = await listVaultNotes('Mission Control')
    let synced = 0; const errors: string[] = []

    for (const relPath of notes) {
      const content = await readVaultNote(relPath)
      if (!content || content.trim().length < 20) continue
      try {
        await ingestText(workspaceId, relPath.replace(/\.md$/, ''), content)
        synced++
      } catch (err) {
        errors.push(relPath)
        logger.warn({ err, relPath }, 'Failed to ingest vault note')
      }
    }
    return NextResponse.json({ synced, total: notes.length, errors })
  } catch (err) {
    logger.error({ err }, 'Vault sync failed')
    return NextResponse.json({ error: 'Vault sync failed' }, { status: 500 })
  }
}
