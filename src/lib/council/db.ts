/**
 * Agent Council — database access layer.
 *
 * Thin, typed wrappers over the council_* tables. All writes broadcast on the
 * shared eventBus so the dashboard live-feed and webhooks pick them up, exactly
 * like the rest of Mission Control.
 */

import { getDatabase } from '@/lib/db';
import { eventBus } from '@/lib/event-bus';
import type {
  CouncilSession,
  CouncilParticipant,
  CouncilMessage,
  CouncilVoteRecord,
  CouncilSessionDetail,
  CouncilStatus,
  CouncilRole,
  CouncilMessageType,
  CouncilVote,
} from './types';

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateSessionInput {
  workspaceId: number;
  goalId?: number | null;
  title: string;
  userGoal: string;
  consensusThreshold?: number;
  maxRounds?: number;
}

export function createCouncilSession(input: CreateSessionInput): CouncilSession {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO council_sessions
        (workspace_id, goal_id, title, user_goal, status,
         consensus_threshold, max_rounds, current_round)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)`
    )
    .run(
      input.workspaceId,
      input.goalId ?? null,
      input.title,
      input.userGoal,
      input.consensusThreshold ?? 0.85,
      input.maxRounds ?? 5
    );
  const session = getCouncilSession(Number(result.lastInsertRowid), input.workspaceId)!;
  eventBus.broadcast('council.session_created', session);
  return session;
}

export function getCouncilSession(
  id: number,
  workspaceId?: number
): CouncilSession | undefined {
  const db = getDatabase();
  const row =
    workspaceId != null
      ? db
          .prepare(
            `SELECT * FROM council_sessions WHERE id = ? AND workspace_id = ?`
          )
          .get(id, workspaceId)
      : db.prepare(`SELECT * FROM council_sessions WHERE id = ?`).get(id);
  return row as CouncilSession | undefined;
}

export function listCouncilSessions(
  workspaceId: number,
  limit = 50,
  offset = 0
): CouncilSession[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM council_sessions
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(workspaceId, limit, offset) as CouncilSession[];
}

export function updateCouncilSession(
  id: number,
  patch: Partial<
    Pick<
      CouncilSession,
      | 'status'
      | 'current_round'
      | 'final_strategy'
      | 'final_confidence'
    >
  >
): CouncilSession | undefined {
  const db = getDatabase();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.current_round !== undefined) {
    fields.push('current_round = ?');
    values.push(patch.current_round);
  }
  if (patch.final_strategy !== undefined) {
    fields.push('final_strategy = ?');
    values.push(patch.final_strategy);
  }
  if (patch.final_confidence !== undefined) {
    fields.push('final_confidence = ?');
    values.push(patch.final_confidence);
  }
  if (fields.length === 0) return getCouncilSession(id);

  fields.push('updated_at = unixepoch()');
  db.prepare(
    `UPDATE council_sessions SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values, id);

  const session = getCouncilSession(id);
  if (session) eventBus.broadcast('council.session_updated', session);
  return session;
}

export function setCouncilStatus(
  id: number,
  status: CouncilStatus
): CouncilSession | undefined {
  return updateCouncilSession(id, { status });
}

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

export function addCouncilParticipants(
  sessionId: number,
  participants: Array<{ agentId: number; agentName: string; role: CouncilRole }>
): CouncilParticipant[] {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO council_participants
       (council_session_id, agent_id, agent_name, council_role)
     VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(
    (rows: Array<{ agentId: number; agentName: string; role: CouncilRole }>) => {
      for (const r of rows) {
        insert.run(sessionId, r.agentId, r.agentName, r.role);
      }
    }
  );
  tx(participants);
  return getCouncilParticipants(sessionId);
}

export function getCouncilParticipants(sessionId: number): CouncilParticipant[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM council_participants
       WHERE council_session_id = ?
       ORDER BY id ASC`
    )
    .all(sessionId) as CouncilParticipant[];
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export interface AddMessageInput {
  sessionId: number;
  roundNumber: number;
  agentId: number;
  agentName: string;
  role: CouncilRole | string;
  messageType: CouncilMessageType;
  content: string;
  confidenceScore?: number | null;
  references?: number[] | null;
}

export function addCouncilMessage(input: AddMessageInput): CouncilMessage {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO council_messages
        (council_session_id, round_number, agent_id, agent_name, role,
         message_type, content, confidence_score, references_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.roundNumber,
      input.agentId,
      input.agentName,
      input.role,
      input.messageType,
      input.content,
      input.confidenceScore ?? null,
      input.references && input.references.length
        ? JSON.stringify(input.references)
        : null
    );
  const message = db
    .prepare(`SELECT * FROM council_messages WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as CouncilMessage;
  eventBus.broadcast('council.message_created', message);
  return message;
}

export function getCouncilMessages(sessionId: number): CouncilMessage[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM council_messages
       WHERE council_session_id = ?
       ORDER BY round_number ASC, id ASC`
    )
    .all(sessionId) as CouncilMessage[];
}

/* -------------------------------------------------------------------------- */
/* Votes                                                                       */
/* -------------------------------------------------------------------------- */

export interface AddVoteInput {
  sessionId: number;
  roundNumber: number;
  agentId: number;
  agentName: string;
  vote: CouncilVote;
  confidenceScore?: number | null;
  reason?: string | null;
}

export function addCouncilVote(input: AddVoteInput): CouncilVoteRecord {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT INTO council_votes
        (council_session_id, round_number, agent_id, agent_name,
         vote, confidence_score, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.roundNumber,
      input.agentId,
      input.agentName,
      input.vote,
      input.confidenceScore ?? null,
      input.reason ?? null
    );
  const vote = db
    .prepare(`SELECT * FROM council_votes WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as CouncilVoteRecord;
  eventBus.broadcast('council.vote_created', vote);
  return vote;
}

export function getCouncilVotes(
  sessionId: number,
  roundNumber?: number
): CouncilVoteRecord[] {
  const db = getDatabase();
  if (roundNumber != null) {
    return db
      .prepare(
        `SELECT * FROM council_votes
         WHERE council_session_id = ? AND round_number = ?
         ORDER BY id ASC`
      )
      .all(sessionId, roundNumber) as CouncilVoteRecord[];
  }
  return db
    .prepare(
      `SELECT * FROM council_votes
       WHERE council_session_id = ?
       ORDER BY round_number ASC, id ASC`
    )
    .all(sessionId) as CouncilVoteRecord[];
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                    */
/* -------------------------------------------------------------------------- */

export function getCouncilSessionDetail(
  id: number,
  workspaceId?: number
): CouncilSessionDetail | undefined {
  const session = getCouncilSession(id, workspaceId);
  if (!session) return undefined;
  return {
    session,
    participants: getCouncilParticipants(id),
    messages: getCouncilMessages(id),
    votes: getCouncilVotes(id),
  };
}
