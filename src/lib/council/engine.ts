/**
 * Agent Council — orchestration engine.
 *
 * This is the deliberation layer that sits between "goal created" and
 * "task execution". It selects agents, runs debate rounds, evaluates
 * consensus, and — only once consensus is reached — hands a validated
 * strategy back to the existing Mission Control task system.
 *
 * It extends Mission Control; it does not replace it.
 */

import { getDatabase } from '@/lib/db';
import { logger } from '@/lib/logger';
import { eventBus } from '@/lib/event-bus';
import { getCouncilSkills } from '@/lib/skills/db';
import {
  COUNCIL_ROLE_ORDER,
  CONSENSUS_RULES,
  type CouncilRole,
  type CouncilSession,
  type CouncilParticipant,
  type CouncilMessage,
  type CouncilVoteRecord,
  type CouncilStrategyOutput,
  type CouncilExecutionTask,
} from './types';
import {
  createCouncilSession,
  addCouncilParticipants,
  getCouncilParticipants,
  addCouncilMessage,
  getCouncilMessages,
  addCouncilVote,
  getCouncilVotes,
  getCouncilSession,
  updateCouncilSession,
  type CreateSessionInput,
} from './db';
import { getCouncilReasoner, type ReasonerContext } from './reasoner';

/* -------------------------------------------------------------------------- */
/* Agent selection + role assignment (spec §4, §5b)                            */
/* -------------------------------------------------------------------------- */

interface AvailableAgent {
  id: number;
  name: string;
}

/** Pick 3–5 agents that aren't offline. Falls back to any agents if needed. */
function selectCouncilAgents(workspaceId: number): AvailableAgent[] {
  const db = getDatabase();
  let rows = db
    .prepare(
      `SELECT id, name FROM agents
       WHERE workspace_id = ? AND status != 'offline' AND hidden = 0
       ORDER BY last_seen DESC
       LIMIT 5`
    )
    .all(workspaceId) as AvailableAgent[];

  if (rows.length < 3) {
    rows = db
      .prepare(
        `SELECT id, name FROM agents
         WHERE workspace_id = ? AND hidden = 0
         ORDER BY created_at ASC
         LIMIT 5`
      )
      .all(workspaceId) as AvailableAgent[];
  }
  return rows;
}

/**
 * Map selected agents onto council roles. Strategist/Researcher/Critic are
 * always assigned; Validator and Executor are added when enough agents exist.
 */
function assignRoles(
  agents: AvailableAgent[]
): Array<{ agentId: number; agentName: string; role: CouncilRole }> {
  return agents.slice(0, COUNCIL_ROLE_ORDER.length).map((agent, i) => ({
    agentId: agent.id,
    agentName: agent.name,
    role: COUNCIL_ROLE_ORDER[i],
  }));
}

/* -------------------------------------------------------------------------- */
/* Start a council (spec §5a–c)                                                 */
/* -------------------------------------------------------------------------- */

export interface StartCouncilResult {
  session: CouncilSession;
  participants: CouncilParticipant[];
}

export class CouncilError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Create a council session, select agents, assign roles, and run round 1
 * (each agent gives a proposal).
 */
export async function startCouncil(
  input: CreateSessionInput
): Promise<StartCouncilResult> {
  const agents = selectCouncilAgents(input.workspaceId);
  if (agents.length < 3) {
    throw new CouncilError(
      'Council Mode needs at least 3 agents in the workspace.',
      409
    );
  }

  const session = createCouncilSession(input);
  const roleAssignments = assignRoles(agents);
  const participants = addCouncilParticipants(session.id, roleAssignments);

  // Memory loop — retrieve relevant context (brand voice, profile,
  // ingested knowledge, memory notes, recommended skills).
  try {
    const { retrieveContext, logContextRetrieval } = await import(
      '@/lib/memory/retriever'
    );
    const retrieved = await retrieveContext(input.workspaceId, input.userGoal);
    if (retrieved.contextBlock.trim()) {
      getDatabase()
        .prepare(
          `UPDATE council_sessions
             SET memory_context_json = ?
           WHERE id = ?`
        )
        .run(JSON.stringify({ contextBlock: retrieved.contextBlock }), session.id);
    }
    logContextRetrieval(session.id, retrieved);
  } catch (err) {
    // Memory retrieval is non-blocking — a failure must not abort the session.
    logger.warn({ err }, 'Memory context retrieval failed — continuing without it');
  }

  logger.info(
    { councilId: session.id, agents: participants.length },
    'Council session started'
  );

  // Round 1: every agent submits a proposal.
  await runDebateRound(session.id);

  return { session: getCouncilSession(session.id)!, participants };
}

/* -------------------------------------------------------------------------- */
/* Run one debate round (spec §5c–e)                                            */
/* -------------------------------------------------------------------------- */

/** Derive the current best strategy from the most recent revision/proposal. */
function deriveCurrentStrategy(messages: CouncilMessage[]): string | undefined {
  const meaningful = messages.filter(
    (m) => m.message_type === 'revision' || m.message_type === 'proposal'
  );
  return meaningful.length ? meaningful[meaningful.length - 1].content : undefined;
}

/**
 * Run the next debate round. Each participant reasons in role order and
 * responds to prior messages. Returns the messages produced this round.
 */
export async function runDebateRound(
  sessionId: number
): Promise<CouncilMessage[]> {
  const session = getCouncilSession(sessionId);
  if (!session) throw new CouncilError('Council session not found', 404);
  if (session.status === 'executed' || session.status === 'failed') {
    throw new CouncilError(
      `Council is ${session.status}; no further rounds allowed.`,
      409
    );
  }

  const round = session.current_round + 1;
  if (round > session.max_rounds) {
    throw new CouncilError('Maximum debate rounds reached.', 409);
  }

  const participants = getCouncilParticipants(sessionId);
  const reasoner = getCouncilReasoner();
  const produced: CouncilMessage[] = [];

  updateCouncilSession(sessionId, { status: 'debating', current_round: round });

  for (const p of participants) {
    const transcript = getCouncilMessages(sessionId); // grows as agents speak
    const ctx: ReasonerContext = {
      userGoal: session.user_goal,
      role: p.council_role,
      agentName: p.agent_name,
      round,
      transcript,
      currentStrategy: deriveCurrentStrategy(transcript),
    };
    const out = await reasoner.contribute(ctx);
    const message = addCouncilMessage({
      sessionId,
      roundNumber: round,
      agentId: p.agent_id,
      agentName: p.agent_name,
      role: p.council_role,
      messageType: out.messageType,
      content: out.content,
      confidenceScore: out.confidence,
      references: out.references ?? null,
    });
    produced.push(message);
  }

  eventBus.broadcast('council.round_completed', { sessionId, round });
  return produced;
}

/* -------------------------------------------------------------------------- */
/* Voting + consensus (spec §5f–g, §10)                                         */
/* -------------------------------------------------------------------------- */

export interface ConsensusResult {
  consensusReached: boolean;
  agreeFraction: number;
  averageConfidence: number;
  hasCriticalBlocker: boolean;
  votes: CouncilVoteRecord[];
}

/**
 * Collect one vote per participant for the current round, then evaluate
 * whether consensus is reached.
 */
export async function collectVotesAndEvaluate(
  sessionId: number
): Promise<ConsensusResult> {
  const session = getCouncilSession(sessionId);
  if (!session) throw new CouncilError('Council session not found', 404);

  const round = session.current_round;
  if (round < 1) {
    throw new CouncilError('Run at least one debate round before voting.', 409);
  }

  // Don't double-vote a round.
  const existing = getCouncilVotes(sessionId, round);
  if (existing.length === 0) {
    const participants = getCouncilParticipants(sessionId);
    const reasoner = getCouncilReasoner();
    const transcript = getCouncilMessages(sessionId);
    const currentStrategy = deriveCurrentStrategy(transcript);

    for (const p of participants) {
      const out = await reasoner.vote({
        userGoal: session.user_goal,
        role: p.council_role,
        agentName: p.agent_name,
        round,
        transcript,
        currentStrategy,
      });
      const vote = addCouncilVote({
        sessionId,
        roundNumber: round,
        agentId: p.agent_id,
        agentName: p.agent_name,
        vote: out.vote,
        confidenceScore: out.confidence,
        reason: out.reason,
      });
      // Record the vote in the transcript too (message_type: 'vote').
      addCouncilMessage({
        sessionId,
        roundNumber: round,
        agentId: p.agent_id,
        agentName: p.agent_name,
        role: p.council_role,
        messageType: 'vote',
        content: `Vote: ${out.vote.toUpperCase()} — ${out.reason}`,
        confidenceScore: out.confidence,
      });
      void vote;
    }
  }

  return evaluateConsensus(sessionId);
}

/** Pure consensus evaluation against the spec §10 rules. */
export function evaluateConsensus(sessionId: number): ConsensusResult {
  const session = getCouncilSession(sessionId);
  if (!session) throw new CouncilError('Council session not found', 404);

  const votes = getCouncilVotes(sessionId, session.current_round);
  if (votes.length === 0) {
    return {
      consensusReached: false,
      agreeFraction: 0,
      averageConfidence: 0,
      hasCriticalBlocker: false,
      votes,
    };
  }

  const agree = votes.filter((v) => v.vote === 'agree').length;
  const agreeFraction = agree / votes.length;
  const averageConfidence =
    votes.reduce((sum, v) => sum + (v.confidence_score ?? 0), 0) / votes.length;
  // A "disagree" vote is a critical blocker (spec §10).
  const hasCriticalBlocker = votes.some(
    (v) => v.vote === CONSENSUS_RULES.blockerVote
  );

  const transcript = getCouncilMessages(sessionId);
  const hasExecutableStrategy = !!deriveCurrentStrategy(transcript);

  const consensusReached =
    agreeFraction >= CONSENSUS_RULES.minAgreeFraction &&
    averageConfidence >= session.consensus_threshold &&
    !hasCriticalBlocker &&
    hasExecutableStrategy;

  return {
    consensusReached,
    agreeFraction,
    averageConfidence,
    hasCriticalBlocker,
    votes,
  };
}

/**
 * Evaluate the current round and advance the session: mark consensus_reached,
 * keep debating, or — at max rounds — pick the best plan or fail.
 */
export async function advanceCouncil(
  sessionId: number
): Promise<{ session: CouncilSession; consensus: ConsensusResult }> {
  const consensus = await collectVotesAndEvaluate(sessionId);
  let session = getCouncilSession(sessionId)!;

  if (consensus.consensusReached) {
    const strategy = deriveCurrentStrategy(getCouncilMessages(sessionId))!;
    session = updateCouncilSession(sessionId, {
      status: 'consensus_reached',
      final_strategy: strategy,
      final_confidence: consensus.averageConfidence,
    })!;
  } else if (session.current_round >= session.max_rounds) {
    // Max rounds: choose highest-confidence plan if it clears threshold,
    // otherwise mark failed (spec §5i).
    if (consensus.averageConfidence >= session.consensus_threshold * 0.9) {
      const strategy = deriveCurrentStrategy(getCouncilMessages(sessionId));
      session = updateCouncilSession(sessionId, {
        status: 'consensus_reached',
        final_strategy: strategy ?? null,
        final_confidence: consensus.averageConfidence,
      })!;
    } else {
      session = updateCouncilSession(sessionId, { status: 'failed' })!;
    }
  }
  // Otherwise the session stays 'debating' for another round.

  return { session, consensus };
}

/* -------------------------------------------------------------------------- */
/* Strategy output + execution (spec §5j–k, §11)                                */
/* -------------------------------------------------------------------------- */

/** Build the structured strategy output (spec §11 format). */
export function buildStrategyOutput(sessionId: number): CouncilStrategyOutput {
  const session = getCouncilSession(sessionId);
  if (!session) throw new CouncilError('Council session not found', 404);
  if (!session.final_strategy) {
    throw new CouncilError('Council has not reached a final strategy.', 409);
  }

  const participants = getCouncilParticipants(sessionId);
  const messages = getCouncilMessages(sessionId);
  const challenges = messages.filter((m) => m.message_type === 'challenge');

  // One execution task per non-Executor role, plus a measurement task.
  const executionTasks: CouncilExecutionTask[] = participants
    .filter((p) => p.council_role !== 'Executor')
    .map((p) => ({
      title: `${p.council_role}: deliver on "${session.title}"`,
      assigned_role: p.council_role,
      priority: p.council_role === 'Critic' ? 'medium' : 'high',
      instructions:
        `Per the council's consensus strategy, the ${p.council_role} owns ` +
        `the corresponding workstream for the goal: "${session.user_goal}". ` +
        `Follow the agreed sequence and report completion back to Mission ` +
        `Control.`,
    }));

  executionTasks.push({
    title: `Measurement & verification for "${session.title}"`,
    assigned_role: 'Validator',
    priority: 'medium',
    instructions:
      'Define and capture the success metrics agreed by the council, and ' +
      'verify the delivered work meets the definition of done.',
  });

  return {
    final_strategy: session.final_strategy,
    why_this_strategy:
      `Reached after ${session.current_round} debate round(s) with ` +
      `${challenges.length} challenge(s) resolved; average council ` +
      `confidence ${(session.final_confidence ?? 0).toFixed(2)}.`,
    confidence: session.final_confidence ?? 0,
    execution_tasks: executionTasks,
  };
}

/** Columns that actually exist on the tasks table (schema is introspected). */
function taskColumns(): Set<string> {
  const db = getDatabase();
  const rows = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Convert the consensus strategy into Mission Control tasks and dispatch them
 * into the existing task system (spec §5j–k). Returns created task ids.
 */
export function executeCouncilStrategy(sessionId: number): {
  taskIds: number[];
  output: CouncilStrategyOutput;
} {
  const session = getCouncilSession(sessionId);
  if (!session) throw new CouncilError('Council session not found', 404);
  if (session.status !== 'consensus_reached') {
    throw new CouncilError(
      `Council must reach consensus before execution (status: ${session.status}).`,
      409
    );
  }

  const output = buildStrategyOutput(sessionId);
  const db = getDatabase();
  const cols = taskColumns();
  const taskIds: number[] = [];

  const insertTask = db.transaction((tasks: CouncilExecutionTask[]) => {
    for (const t of tasks) {
      // Build an insert using only columns present in this DB.
      const fields: string[] = ['title', 'description', 'status', 'priority', 'created_by'];
      const values: unknown[] = [
        t.title,
        t.instructions,
        cols.has('status') ? 'inbox' : 'inbox',
        t.priority,
        'agent-council',
      ];
      if (cols.has('workspace_id')) {
        fields.push('workspace_id');
        values.push(session.workspace_id);
      }
      if (cols.has('tags')) {
        fields.push('tags');
        values.push(JSON.stringify(['council', `council:${session.id}`]));
      }
      if (cols.has('metadata')) {
        fields.push('metadata');
        values.push(
          JSON.stringify({
            source: 'agent-council',
            council_session_id: session.id,
            assigned_role: t.assigned_role,
          })
        );
      }
      const placeholders = fields.map(() => '?').join(', ');
      const res = db
        .prepare(
          `INSERT INTO tasks (${fields.join(', ')}) VALUES (${placeholders})`
        )
        .run(...values);
      taskIds.push(Number(res.lastInsertRowid));
    }
  });

  insertTask(output.execution_tasks);

  updateCouncilSession(sessionId, { status: 'executed' });
  eventBus.broadcast('council.executed', {
    sessionId,
    taskIds,
    taskCount: taskIds.length,
  });
  logger.info(
    { councilId: sessionId, taskCount: taskIds.length },
    'Council strategy converted into Mission Control tasks'
  );

  // Memory loop — write the session summary back to memory + Obsidian vault.
  const skillsUsed = getCouncilSkills(sessionId).map((s) => s.skill_name);
  import('@/lib/memory/writer')
    .then(({ writeSessionMemory }) =>
      writeSessionMemory({
        sessionId,
        workspaceId: session.workspace_id,
        title: session.title,
        goal: session.user_goal,
        consensus: output.final_strategy,
        roundCount: session.current_round,
        taskCount: taskIds.length,
        skillsUsed,
      })
    )
    .catch((err: unknown) =>
      logger.warn({ err }, 'Session write-back failed — continuing')
    );

  return { taskIds, output };
}
