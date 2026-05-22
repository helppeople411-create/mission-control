'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('SkillEnginePanel')

/* ------------------------------------------------------------------ types */

interface Skill {
  id: number; name: string; slug: string; description: string | null
  instructions: string | null; source_type: string; status: string; updated_at: number
}
interface SkillDetail extends Skill {
  versions: Array<{ version_number: number; changelog: string | null }>
}
interface KnowledgeSource {
  id: number; type: string; title: string; url: string | null
  summary: string | null; created_at: number
}
interface KnowledgeDetail {
  source: KnowledgeSource & { raw_text: string | null; key_points_json: string | null }
  chunks: Array<{ id: number; chunk_text: string; chunk_index: number }>
}
interface VaultStatus {
  configured: boolean; vaultPath: string; noteCount: number; apiEnabled: boolean
}

type Tab = 'skills' | 'knowledge' | 'memory' | 'command'

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-secondary text-muted-foreground',
  active: 'bg-green-500/15 text-green-400 border border-green-500/30',
  archived: 'bg-red-500/15 text-red-400 border border-red-500/30',
}
const TYPE_EMOJI: Record<string, string> = {
  pdf: '📄', link: '🔗', text: '📝', note: '🗒️', manual: '✍️', generated: '⚙️',
}

/* ------------------------------------------------------------------ panel */

export function SkillEnginePanel() {
  const [tab, setTab] = useState<Tab>('skills')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* skills */
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null)
  const [newSkillName, setNewSkillName] = useState('')

  /* knowledge */
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [knowledgeDetail, setKnowledgeDetail] = useState<KnowledgeDetail | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [noteText, setNoteText] = useState('')

  /* memory */
  const [brandVoice, setBrandVoiceText] = useState('')
  const [profile, setProfileText] = useState('')
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null)
  const [memoryGoal, setMemoryGoal] = useState('')
  const [memoryCtx, setMemoryCtx] = useState<{
    contextBlock: string
    recommendedSkills: Array<{ name: string; combinedScore: number }>
  } | null>(null)

  /* command */
  const [commandInput, setCommandInput] = useState('')
  const [commandLog, setCommandLog] = useState<
    Array<{ input: string; output: string; ok: boolean }>
  >([])

  /* ---------------------------------------------------------------- loaders */

  const loadSkills = useCallback(async () => {
    try {
      const d = await fetch('/api/skill-engine').then(r => r.json())
      if (d.skills) setSkills(d.skills)
    } catch (err) { log.error('load skills', err) }
  }, [])

  const loadKnowledge = useCallback(async () => {
    try {
      const d = await fetch('/api/knowledge').then(r => r.json())
      if (d.sources) setSources(d.sources)
    } catch (err) { log.error('load knowledge', err) }
  }, [])

  const loadMemory = useCallback(async () => {
    try {
      const [bv, pr, vs] = await Promise.all([
        fetch('/api/memory/brand-voice').then(r => r.json()),
        fetch('/api/memory/profile').then(r => r.json()),
        fetch('/api/memory/obsidian').then(r => r.json()),
      ])
      setBrandVoiceText(bv.content ?? '')
      setProfileText(pr.content ?? '')
      setVaultStatus(vs)
    } catch (err) { log.error('load memory', err) }
  }, [])

  useEffect(() => {
    loadSkills(); loadKnowledge(); loadMemory()
  }, [loadSkills, loadKnowledge, loadMemory])

  /* ---------------------------------------------------------------- skills */

  async function openSkill(id: number) {
    try {
      const d = await fetch(`/api/skill-engine/${id}`).then(r => r.json())
      if (d.skill) setSkillDetail(d.skill)
    } catch (err) { log.error('open skill', err) }
  }

  async function createSkill() {
    if (!newSkillName.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/skill-engine/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSkillName.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Create failed')
      setNewSkillName(''); await loadSkills(); openSkill(d.skill.id)
    } catch (err: any) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function archiveSkill(id: number) {
    setBusy(true)
    try { await fetch(`/api/skill-engine/${id}/archive`, { method: 'POST' }); await loadSkills(); await openSkill(id) }
    finally { setBusy(false) }
  }

  /* --------------------------------------------------------------- knowledge */

  async function learnLink() {
    if (!linkUrl.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/learn/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: linkUrl.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Ingest failed')
      setLinkUrl(''); await loadKnowledge()
    } catch (err: any) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function learnText() {
    if (!noteText.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/learn/text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: noteText.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Ingest failed')
      setNoteText(''); await loadKnowledge()
    } catch (err: any) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function openKnowledge(id: number) {
    try {
      const d = await fetch(`/api/knowledge/${id}`).then(r => r.json())
      if (d.source) setKnowledgeDetail(d)
    } catch (err) { log.error('open knowledge', err) }
  }

  /* ---------------------------------------------------------------- memory */

  async function saveBrandVoice() {
    setBusy(true)
    try {
      await fetch('/api/memory/brand-voice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: brandVoice }),
      })
    } finally { setBusy(false) }
  }

  async function saveProfile() {
    setBusy(true)
    try {
      await fetch('/api/memory/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: profile }),
      })
    } finally { setBusy(false) }
  }

  async function syncVault() {
    setBusy(true)
    try {
      await fetch('/api/memory/obsidian/sync', { method: 'POST' })
      const s = await fetch('/api/memory/obsidian').then(r => r.json())
      setVaultStatus(s)
    } finally { setBusy(false) }
  }

  async function previewContext() {
    if (!memoryGoal.trim()) return
    setBusy(true)
    try {
      const d = await fetch(`/api/memory/retrieve?goal=${encodeURIComponent(memoryGoal)}`).then(r => r.json())
      setMemoryCtx({ contextBlock: d.contextBlock ?? '', recommendedSkills: d.recommendedSkills ?? [] })
    } finally { setBusy(false) }
  }

  /* --------------------------------------------------------------- command */

  async function runCommand() {
    const cmd = commandInput.trim()
    if (!cmd) return
    setBusy(true)
    try {
      const res = await fetch('/api/commands/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const d = await res.json()
      setCommandLog(prev => [{
        input: cmd,
        output: JSON.stringify(res.ok ? d : { error: d.error }, null, 2),
        ok: res.ok,
      }, ...prev])
      setCommandInput('')
      await loadSkills(); await loadKnowledge()
    } catch (err: any) {
      setCommandLog(prev => [{ input: cmd, output: String(err), ok: false }, ...prev])
    } finally { setBusy(false) }
  }

  /* ---------------------------------------------------------------- render */

  return (
    <div className="h-full flex flex-col">

      {/* header + tabs */}
      <div className="flex justify-between items-center p-4 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground">Skill Engine</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Reusable skills · ingested knowledge · memory · slash commands
          </p>
        </div>
        <div className="flex bg-secondary rounded-lg p-1">
          {(['skills', 'knowledge', 'memory', 'command'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-md capitalize transition-colors ${tab === t ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-3 m-4 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="text-red-400/60 hover:text-red-400 ml-2" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* ═══ SKILLS ═══ */}
      {tab === 'skills' && (
        <div className="flex-1 flex min-h-0">
          <aside className="w-72 border-r border-border flex flex-col flex-shrink-0">
            <div className="p-3 border-b border-border flex gap-2">
              <input value={newSkillName} onChange={e => setNewSkillName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createSkill()}
                placeholder="New skill name…"
                className="flex-1 bg-surface-1 text-foreground rounded-md px-3 py-1.5 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50" />
              <Button size="sm" disabled={busy || !newSkillName.trim()} onClick={createSkill}>Add</Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {skills.length === 0 && <p className="text-xs text-muted-foreground p-2">No skills yet.</p>}
              {skills.map(s => (
                <button key={s.id} onClick={() => openSkill(s.id)}
                  className={`w-full text-left p-2 rounded-md text-sm transition-colors ${skillDetail?.id === s.id ? 'bg-secondary' : 'hover:bg-secondary/50'}`}>
                  <div className="font-medium text-foreground truncate">{TYPE_EMOJI[s.source_type] ?? '•'} {s.name}</div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded mt-1 inline-block ${STATUS_STYLE[s.status] ?? 'bg-secondary'}`}>{s.status}</span>
                </button>
              ))}
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto p-4">
            {!skillDetail ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Select a skill or create one.</div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-foreground">{skillDetail.name}</h2>
                    <p className="text-xs text-muted-foreground">{skillDetail.slug} · {skillDetail.source_type}</p>
                  </div>
                  {skillDetail.status !== 'archived' && (
                    <Button variant="destructive" size="xs" disabled={busy} onClick={() => archiveSkill(skillDetail.id)}>Archive</Button>
                  )}
                </div>
                {skillDetail.description && <p className="text-sm text-muted-foreground">{skillDetail.description}</p>}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">Instructions</h3>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-card border border-border rounded-md p-3 font-mono">
                    {skillDetail.instructions || '(empty — edit to add instructions)'}
                  </pre>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">Versions ({skillDetail.versions.length})</h3>
                  {skillDetail.versions.map(v => (
                    <div key={v.version_number} className="text-xs text-muted-foreground">v{v.version_number} — {v.changelog}</div>
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ═══ KNOWLEDGE ═══ */}
      {tab === 'knowledge' && (
        <div className="flex-1 flex min-h-0">
          <aside className="w-80 border-r border-border flex flex-col flex-shrink-0">
            <div className="p-3 border-b border-border space-y-2">
              <div className="flex gap-2">
                <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                  placeholder="https://… (learn link)"
                  className="flex-1 bg-surface-1 text-foreground rounded-md px-3 py-1.5 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50" />
                <Button size="sm" disabled={busy} onClick={learnLink}>Learn</Button>
              </div>
              <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
                placeholder="Paste text to learn…" rows={3}
                className="w-full bg-surface-1 text-foreground rounded-md px-3 py-2 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none" />
              <Button size="sm" variant="secondary" className="w-full" disabled={busy || !noteText.trim()} onClick={learnText}>Learn Text</Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sources.length === 0 && <p className="text-xs text-muted-foreground p-2">No knowledge ingested yet.</p>}
              {sources.map(s => (
                <button key={s.id} onClick={() => openKnowledge(s.id)}
                  className={`w-full text-left p-2 rounded-md text-sm transition-colors ${knowledgeDetail?.source.id === s.id ? 'bg-secondary' : 'hover:bg-secondary/50'}`}>
                  <div className="font-medium text-foreground truncate">{TYPE_EMOJI[s.type] ?? '•'} {s.title}</div>
                  <div className="text-[10px] text-muted-foreground">{s.type}</div>
                </button>
              ))}
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto p-4">
            {!knowledgeDetail ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Select a knowledge source.</div>
            ) : (
              <div className="space-y-4">
                <h2 className="text-lg font-bold text-foreground">{knowledgeDetail.source.title}</h2>
                {knowledgeDetail.source.url && (
                  <a href={knowledgeDetail.source.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">{knowledgeDetail.source.url}</a>
                )}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">Summary</h3>
                  <p className="text-sm text-muted-foreground">{knowledgeDetail.source.summary || '(no summary)'}</p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-1">Chunks ({knowledgeDetail.chunks.length})</h3>
                  <div className="space-y-2">
                    {knowledgeDetail.chunks.slice(0, 30).map(c => (
                      <div key={c.id} className="text-xs text-muted-foreground bg-card border border-border rounded-md p-2">
                        <span className="text-[10px] text-muted-foreground/60">#{c.chunk_index}</span>
                        <p className="whitespace-pre-wrap mt-0.5">{c.chunk_text.slice(0, 400)}{c.chunk_text.length > 400 ? '…' : ''}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ═══ MEMORY ═══ */}
      {tab === 'memory' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">

          {/* Vault status */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-foreground">Obsidian Vault</h3>
              {vaultStatus?.configured && (
                <Button size="xs" variant="secondary" disabled={busy} onClick={syncVault}>Sync vault → knowledge</Button>
              )}
            </div>
            {!vaultStatus?.configured ? (
              <p className="text-xs text-muted-foreground">
                Set <code className="text-foreground">OBSIDIAN_VAULT_PATH=/path/to/vault</code> in{' '}
                <code className="text-foreground">.env.local</code> to connect your vault.
                Mission Control will read and write <code className="text-foreground">Mission Control/</code> notes inside it.
              </p>
            ) : (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p><span className="text-green-400">●</span> Connected — <span className="text-foreground font-mono">{vaultStatus.vaultPath}</span></p>
                <p>{vaultStatus.noteCount} notes in Mission Control folder</p>
                {vaultStatus.apiEnabled && <p className="text-primary">Local REST API enabled (live sync)</p>}
              </div>
            )}
          </div>

          {/* Brand voice */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Brand Voice</h3>
                <p className="text-[10px] text-muted-foreground">Synced to <code>Mission Control/Brand Voice.md</code>. Injected into every council debate.</p>
              </div>
              <Button size="xs" disabled={busy || !brandVoice.trim()} onClick={saveBrandVoice}>Save</Button>
            </div>
            <textarea value={brandVoice} onChange={e => setBrandVoiceText(e.target.value)} rows={10}
              className="w-full bg-surface-1 text-foreground rounded-md px-3 py-2 text-sm font-mono border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 resize-y"
              placeholder={'# Brand Voice\n\n## Tone\nDirect, confident, no jargon…\n\n## Writing rules\nShort sentences. Active voice. Customer-first.\n\n## Avoid\nBuzzwords, passive voice, weak hedging.'} />
          </div>

          {/* Profile */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Profile</h3>
                <p className="text-[10px] text-muted-foreground">Synced to <code>Mission Control/Profile.md</code>. Gives agents context about you and your brand.</p>
              </div>
              <Button size="xs" disabled={busy || !profile.trim()} onClick={saveProfile}>Save</Button>
            </div>
            <textarea value={profile} onChange={e => setProfileText(e.target.value)} rows={8}
              className="w-full bg-surface-1 text-foreground rounded-md px-3 py-2 text-sm font-mono border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 resize-y"
              placeholder={'# Profile\n\n## About me / my brand\n…\n\n## Audience\n…\n\n## Industry & niche\n…\n\n## Goals\n…'} />
          </div>

          {/* Context preview */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold text-foreground mb-1">Context preview</h3>
            <p className="text-xs text-muted-foreground mb-2">
              Enter a goal to see exactly what the memory loop would inject into a council session for it.
            </p>
            <div className="flex gap-2 mb-3">
              <input value={memoryGoal} onChange={e => setMemoryGoal(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && previewContext()}
                placeholder="e.g. Build SEO plan for emergency plumber Dallas"
                className="flex-1 bg-surface-1 text-foreground rounded-md px-3 py-1.5 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50" />
              <Button size="sm" disabled={busy || !memoryGoal.trim()} onClick={previewContext}>Preview</Button>
            </div>
            {memoryCtx && (
              <div className="space-y-3">
                {memoryCtx.recommendedSkills.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-foreground mb-1">Recommended skills</p>
                    {memoryCtx.recommendedSkills.map(s => (
                      <div key={s.name} className="text-xs text-muted-foreground flex justify-between">
                        <span>{s.name}</span>
                        <span className="text-primary">{(s.combinedScore * 100).toFixed(0)}% match</span>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <p className="text-xs font-medium text-foreground mb-1">Full context block agents receive</p>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-surface-1 border border-border rounded-md p-3 max-h-72 overflow-y-auto font-mono">
                    {memoryCtx.contextBlock || '(empty — fill in Brand Voice, Profile, or ingest some knowledge)'}
                  </pre>
                </div>
              </div>
            )}
          </div>

        </div>
      )}

      {/* ═══ COMMAND ═══ */}
      {tab === 'command' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-2">
              Try <code className="text-foreground">/skill list</code>,{' '}
              <code className="text-foreground">/learn link https://example.com</code>,{' '}
              <code className="text-foreground">/council use seo-auditor</code>, or{' '}
              <code className="text-foreground">/help</code>
            </p>
            <div className="flex gap-2">
              <input value={commandInput} onChange={e => setCommandInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runCommand()}
                placeholder="/skill create my-skill"
                className="flex-1 bg-surface-1 text-foreground rounded-md px-3 py-2 text-sm font-mono border border-border focus:outline-none focus:ring-1 focus:ring-primary/50" />
              <Button disabled={busy || !commandInput.trim()} onClick={runCommand}>Run</Button>
            </div>
          </div>
          <div className="space-y-2">
            {commandLog.map((entry, i) => (
              <div key={i} className="rounded-md border border-border bg-card overflow-hidden">
                <div className="px-3 py-1.5 text-xs font-mono text-foreground border-b border-border bg-secondary/40">{entry.input}</div>
                <pre className={`px-3 py-2 text-xs whitespace-pre-wrap font-mono ${entry.ok ? 'text-muted-foreground' : 'text-red-400'}`}>{entry.output}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

export default SkillEnginePanel
