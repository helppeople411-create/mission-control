/**
 * Agent Council — shared types.
 *
 * The Agent Council is a deliberation layer that sits between "goal created"
 * and "task execution". It does NOT replace Mission Control orchestration —
 * it produces a validated strategy that is then converted into ordinary
 * Mission Control tasks.
 */

export type CouncilStatus =
  | 'pending'
  | 'debating'
  | 'consensus_reached'
  | 'failed'
  | 'executed';

export type CouncilRole =
  | 'Strategist'
  | 'Researcher'
  | 'Critic'
  | 'Validator'
  | 'Executor';

export type CouncilMessageType =
  | 'proposal'
  | 'challenge'
  | 'evidence'
  | 'revision'
  | 'vote'
  | 'final';

export type CouncilVote = 'agree' | 'disagree' | 'revise';

export interface CouncilSession {
  id: number;
  workspace_id: number;
  goal_id: number | null;
  title: string;
  user_goal: string;
  status: CouncilStatus;
  consensus_threshold: number;
  max_rounds: number;
  current_round: number;
  final_strategy: string | null;
  final_confidence: number | null;
  created_at: number;
  updated_at: number;
}

export interface CouncilParticipant {
  id: number;
  council_session_id: number;
  agent_id: number;
  agent_name: string;
  council_role: CouncilRole;
  created_at: number;
}

export interface CouncilMessage {
  id: number;
  council_session_id: number;
  round_number: number;
  agent_id: number;
  agent_name: string;
  role: CouncilRole | string;
  message_type: CouncilMessageType;
  content: string;
  confidence_score: number | null;
  references_json: string | null;
  created_at: number;
}

export interface CouncilVoteRecord {
  id: number;
  council_session_id: number;
  round_number: number;
  agent_id: number;
  agent_name: string | null;
  vote: CouncilVote;
  confidence_score: number | null;
  reason: string | null;
  created_at: number;
}

/** Full session payload returned by GET /api/council/:id */
export interface CouncilSessionDetail {
  session: CouncilSession;
  participants: CouncilParticipant[];
  messages: CouncilMessage[];
  votes: CouncilVoteRecord[];
}

/** A single execution task produced when consensus is reached. */
export interface CouncilExecutionTask {
  title: string;
  assigned_role: CouncilRole | string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  instructions: string;
}

/** Consensus / execution output format (spec §11). */
export interface CouncilStrategyOutput {
  final_strategy: string;
  why_this_strategy: string;
  confidence: number;
  execution_tasks: CouncilExecutionTask[];
}

/** The 5 council roles, in the order they act within a round. */
export const COUNCIL_ROLE_ORDER: CouncilRole[] = [
  'Strategist',
  'Researcher',
  'Critic',
  'Validator',
  'Executor',
];

/** Consensus rules — see spec §10. */
export const CONSENSUS_RULES = {
  /** At least this fraction of agents must vote "agree". */
  minAgreeFraction: 0.7,
  /** A "disagree" vote is treated as a critical blocker. */
  blockerVote: 'disagree' as CouncilVote,
};

/** System prompt every council agent reasons under (spec §9). */
export const COUNCIL_SYSTEM_PROMPT = `You are participating in an Agent Council. Do not simply complete the task alone. Your job is to reason with the other agents. You must read prior agent messages, identify strengths, challenge weak assumptions, provide evidence, revise your position when needed, and vote only when the strategy is strong enough to execute. If the plan lacks evidence, say so. If another agent has a better approach, acknowledge it. Your output must include: position, challenge, evidence, revision, confidence score.`;
