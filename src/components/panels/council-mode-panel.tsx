'use client'

/**
 * Council Mode panel — the "reasoning room".
 *
 * Shows the user goal, the agents in the council and their roles, the live
 * debate transcript grouped by round, votes, confidence scores, and the
 * final consensus. Lets an operator start a council, run another debate
 * round, collect votes, and approve execution.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('CouncilModePanel')

/* ----------------------------- types ----------------------------- */

interface CouncilSession {
  id: number
  title: string
  user_goal: string
  status: string
  consensus_threshold: number
  max_rounds: number
  current_round: number
  final_strategy: string | null
  final_confidence: number | null
  created_at: number
}
interface Participant {
  id: number
  agent_name: string
  council_role: string
}
interface Message {
  id: number
  round_number: number
  agent_name: string
  role: string
  message_type: string
  content: string
  confidence_score: number | null
}
interface VoteRecord {
  id: number
  round_number: number
  agent_name: string | null
  vote: string
  confidence_score: number | null
  reason: string | null
}
interface SessionDetail {
  session: CouncilSession
  participants: Participant[]
  messages: Message[]
  votes: VoteRecord[]
}

/* --------------------------- helpers ------------------------------ */

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-secondary text-muted-foreground',
  debating: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  consensus_reached:
    'bg-green-500/15 text-green-400 border border-green-500/30',
  executed: 'bg-purple-500/15 text-purple-400 border border-purple-500/30',
  failed: 'bg-red-500/15 text-red-400 border border-red-500/30',
}

const TYPE_BADGE: Record<string, string> = {
  proposal: 'bg-blue-500/15 text-blue-400',
  challenge: 'bg-amber-500/15 text-amber-400',
  evidence: 'bg-teal-500/15 text-teal-400',
  revision: 'bg-indigo-500/15 text-indigo-400',
  vote: 'bg-green-500/15 text-green-400',
  final: 'bg-purple-500/15 text-purple-400',
}

const ROLE_EMOJI: Record<string, string> = {
  Strategist: '🧭',
  Researcher: '🔬',
  Critic: '⚔️',
  Validator: '✅',
  Executor: '🚀',
}

function confidenceColor(c: number | null): string {
  if (c == null) return 'text-muted-foreground'
  if (c >= 0.85) return 'text-green-400'
  if (c >= 0.7) return 'text-amber-400'
  return 'text-red-400'
}

/* ----------------------------- panel ------------------------------ */

export function CouncilModePanel() {
  const [sessions, setSessions] = useState<CouncilSession[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [goalInput, setGoalInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/council')
      if (!res.ok) throw new Error(`List failed (${res.status})`)
      const data = await res.json()
      setSessions(data.sessions ?? [])
    } catch (err) {
      log.error('Failed to load council sessions', err)
      setError('Could not load council sessions.')
    }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/council/${id}`)
      if (!res.ok) throw new Error(`Detail failed (${res.status})`)
      setDetail(await res.json())
    } catch (err) {
      log.error('Failed to load council detail', err)
      setError('Could not load council session.')
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (selectedId != null) loadDetail(selectedId)
  }, [selectedId, loadDetail])

  /* --------------------------- actions --------------------------- */

  async function startCouncil() {
    const goal = goalInput.trim()
    if (!goal) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/council/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_goal: goal }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start council')
      setGoalInput('')
      await loadSessions()
      setSelectedId(data.session.id)
      setDetail(data)
    } catch (err: any) {
      setError(err.message || 'Failed to start council')
    } finally {
      setBusy(false)
    }
  }

  async function act(path: string, label: string) {
    if (selectedId == null) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/council/${selectedId}/${path}`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `${label} failed`)
      setDetail(data)
      await loadSessions()
    } catch (err: any) {
      setError(err.message || `${label} failed`)
    } finally {
      setBusy(false)
    }
  }

  /* ---------------------------- render --------------------------- */

  const session = detail?.session
  const messagesByRound = groupByRound(detail?.messages ?? [])
  const canDebate =
    session &&
    (session.status === 'pending' || session.status === 'debating') &&
    session.current_round < session.max_rounds
  const canVote = session && session.status === 'debating'
  const canExecute = session && session.status === 'consensus_reached'

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center p-4 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold text-foreground">Council Mode</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            The reasoning room — agents debate and reach consensus before
            execution.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-3 m-4 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            className="text-red-400/60 hover:text-red-400 ml-2"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Sessions sidebar */}
        <aside className="w-72 border-r border-border flex flex-col flex-shrink-0">
          <div className="p-3 border-b border-border space-y-2">
            <textarea
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              placeholder="Enter a goal for the council to deliberate…"
              rows={3}
              className="w-full bg-surface-1 text-foreground rounded-md px-3 py-2 text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
            />
            <Button
              size="sm"
              className="w-full"
              disabled={busy || !goalInput.trim()}
              onClick={startCouncil}
            >
              {busy ? 'Working…' : 'Convene Council'}
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.length === 0 && (
              <p className="text-xs text-muted-foreground p-2">
                No council sessions yet.
              </p>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left p-2 rounded-md text-sm transition-colors ${
                  selectedId === s.id
                    ? 'bg-secondary'
                    : 'hover:bg-secondary/50'
                }`}
              >
                <div className="font-medium text-foreground truncate">
                  {s.title}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      STATUS_STYLE[s.status] ?? 'bg-secondary'
                    }`}
                  >
                    {s.status.replace('_', ' ')}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    round {s.current_round}/{s.max_rounds}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Detail */}
        <main className="flex-1 overflow-y-auto">
          {!session ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              Select a council session, or convene a new one.
            </div>
          ) : (
            <div className="p-4 space-y-6">
              {/* Goal + status */}
              <section className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      User Goal
                    </div>
                    <p className="text-foreground mt-1">{session.user_goal}</p>
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded whitespace-nowrap ${
                      STATUS_STYLE[session.status] ?? 'bg-secondary'
                    }`}
                  >
                    {session.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                  <span>
                    Round {session.current_round}/{session.max_rounds}
                  </span>
                  <span>
                    Threshold{' '}
                    {(session.consensus_threshold * 100).toFixed(0)}%
                  </span>
                  {session.final_confidence != null && (
                    <span className={confidenceColor(session.final_confidence)}>
                      Consensus{' '}
                      {(session.final_confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              </section>

              {/* Council members */}
              <section>
                <h2 className="text-sm font-semibold text-foreground mb-2">
                  Council ({detail!.participants.length} agents)
                </h2>
                <div className="flex flex-wrap gap-2">
                  {detail!.participants.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-md border border-border bg-card px-3 py-1.5 text-sm"
                    >
                      <span className="mr-1">
                        {ROLE_EMOJI[p.council_role] ?? '•'}
                      </span>
                      <span className="text-foreground font-medium">
                        {p.agent_name}
                      </span>
                      <span className="text-muted-foreground ml-1.5 text-xs">
                        {p.council_role}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Debate transcript */}
              <section>
                <h2 className="text-sm font-semibold text-foreground mb-2">
                  Debate
                </h2>
                {messagesByRound.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No messages yet.
                  </p>
                )}
                <div className="space-y-4">
                  {messagesByRound.map(([round, msgs]) => (
                    <div key={round}>
                      <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                        Round {round}
                      </div>
                      <div className="space-y-2">
                        {msgs.map((m) => (
                          <div
                            key={m.id}
                            className="rounded-md border border-border bg-card p-3"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium text-foreground">
                                {ROLE_EMOJI[m.role] ?? '•'} {m.agent_name}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {m.role}
                              </span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded ${
                                  TYPE_BADGE[m.message_type] ?? 'bg-secondary'
                                }`}
                              >
                                {m.message_type}
                              </span>
                              {m.confidence_score != null && (
                                <span
                                  className={`text-[10px] ml-auto ${confidenceColor(
                                    m.confidence_score
                                  )}`}
                                >
                                  {(m.confidence_score * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                              {m.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Votes */}
              {detail!.votes.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-foreground mb-2">
                    Votes
                  </h2>
                  <div className="space-y-1.5">
                    {detail!.votes.map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center gap-2 text-sm rounded-md border border-border bg-card px-3 py-2"
                      >
                        <span className="text-foreground font-medium">
                          {v.agent_name}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            v.vote === 'agree'
                              ? 'bg-green-500/15 text-green-400'
                              : v.vote === 'disagree'
                              ? 'bg-red-500/15 text-red-400'
                              : 'bg-amber-500/15 text-amber-400'
                          }`}
                        >
                          {v.vote}
                        </span>
                        {v.confidence_score != null && (
                          <span
                            className={`text-[10px] ${confidenceColor(
                              v.confidence_score
                            )}`}
                          >
                            {(v.confidence_score * 100).toFixed(0)}%
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground truncate">
                          {v.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Final consensus */}
              {session.final_strategy && (
                <section className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
                  <h2 className="text-sm font-semibold text-green-400 mb-1">
                    Final Consensus Strategy
                  </h2>
                  <p className="text-sm text-foreground whitespace-pre-wrap">
                    {session.final_strategy}
                  </p>
                </section>
              )}

              {/* Action bar */}
              <div className="flex gap-2 sticky bottom-0 bg-background/80 backdrop-blur py-2">
                {canDebate && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => act('round', 'Run round')}
                  >
                    Run Another Debate Round
                  </Button>
                )}
                {canVote && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => act('vote', 'Collect votes')}
                  >
                    Collect Votes
                  </Button>
                )}
                {canExecute && (
                  <Button
                    variant="success"
                    size="sm"
                    disabled={busy}
                    onClick={() => act('execute', 'Execute')}
                  >
                    Approve Execution
                  </Button>
                )}
                {session.status === 'executed' && (
                  <span className="text-sm text-purple-400 self-center">
                    ✓ Strategy executed — tasks dispatched to Mission Control.
                  </span>
                )}
                {session.status === 'failed' && (
                  <span className="text-sm text-red-400 self-center">
                    ✗ Council failed to reach consensus.
                  </span>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function groupByRound(messages: Message[]): Array<[number, Message[]]> {
  const map = new Map<number, Message[]>()
  for (const m of messages) {
    if (!map.has(m.round_number)) map.set(m.round_number, [])
    map.get(m.round_number)!.push(m)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
}

export default CouncilModePanel
