/**
 * Agent Council — reasoning layer.
 *
 * The council needs each agent to *produce* deliberation: proposals,
 * challenges, evidence, revisions and votes. How an agent reasons is
 * deliberately pluggable:
 *
 *   - The DEFAULT export (`heuristicReasoner`) is fully deterministic and
 *     dependency-free, so the whole council flow runs end-to-end out of the
 *     box with no model keys or gateway connectivity.
 *
 *   - To wire in real model inference (Claude, a local gateway agent, etc.),
 *     implement `CouncilReasoner` and register it with `setCouncilReasoner()`.
 *     A typical implementation builds a prompt from COUNCIL_SYSTEM_PROMPT +
 *     the transcript and dispatches it through the existing agent runtime.
 *
 * The orchestration engine (engine.ts) only depends on this interface — it
 * never assumes how the text was generated.
 */

import {
  COUNCIL_SYSTEM_PROMPT,
  type CouncilRole,
  type CouncilMessage,
  type CouncilMessageType,
  type CouncilVote,
} from './types';

/* -------------------------------------------------------------------------- */
/* Interface                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReasonerContext {
  /** The end user's goal in plain language. */
  userGoal: string;
  /** This agent's assigned council role. */
  role: CouncilRole;
  agentName: string;
  /** 1-based debate round. */
  round: number;
  /** Every message produced so far, oldest first. */
  transcript: CouncilMessage[];
  /** The current best strategy text, if one has emerged. */
  currentStrategy?: string;
}

export interface ReasonerMessage {
  messageType: CouncilMessageType;
  content: string;
  /** 0..1 — how strongly the agent backs its own contribution. */
  confidence: number;
  /** ids of prior council_messages this one responds to. */
  references?: number[];
}

export interface ReasonerVote {
  vote: CouncilVote;
  confidence: number;
  reason: string;
}

export interface CouncilReasoner {
  readonly name: string;
  /** Produce one agent's contribution for the given round. */
  contribute(ctx: ReasonerContext): Promise<ReasonerMessage> | ReasonerMessage;
  /** Produce one agent's vote on the current strategy. */
  vote(ctx: ReasonerContext): Promise<ReasonerVote> | ReasonerVote;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                     */
/* -------------------------------------------------------------------------- */

let activeReasoner: CouncilReasoner | null = null;

/** Swap in a custom reasoner (e.g. one backed by real model inference). */
export function setCouncilReasoner(reasoner: CouncilReasoner): void {
  activeReasoner = reasoner;
}

export function getCouncilReasoner(): CouncilReasoner {
  return activeReasoner ?? heuristicReasoner;
}

/* -------------------------------------------------------------------------- */
/* Default heuristic reasoner                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Each role reasons through a distinct "lens". The heuristic reasoner is not a
 * language model — it produces structured, role-appropriate deliberation that
 * reacts to the transcript so the council flow is coherent and demonstrable.
 */
const ROLE_LENS: Record<
  CouncilRole,
  { focus: string; defaultType: CouncilMessageType; baseConfidence: number }
> = {
  Strategist: {
    focus: 'shapes the initial plan and the overall sequence of work',
    defaultType: 'proposal',
    baseConfidence: 0.78,
  },
  Researcher: {
    focus: 'checks assumptions and supplies supporting evidence',
    defaultType: 'evidence',
    baseConfidence: 0.74,
  },
  Critic: {
    focus: 'attacks weak logic and surfaces risks before they cost anything',
    defaultType: 'challenge',
    baseConfidence: 0.7,
  },
  Validator: {
    focus: 'confirms the plan is concrete, sequenced and actionable',
    defaultType: 'revision',
    baseConfidence: 0.82,
  },
  Executor: {
    focus: 'waits for consensus, then translates strategy into tasks',
    defaultType: 'revision',
    baseConfidence: 0.8,
  },
};

function lastFromOthers(
  ctx: ReasonerContext
): CouncilMessage | undefined {
  for (let i = ctx.transcript.length - 1; i >= 0; i--) {
    if (ctx.transcript[i].agent_name !== ctx.agentName) return ctx.transcript[i];
  }
  return undefined;
}

/** Round-aware message type: proposal → challenge → revision. */
function typeForRound(role: CouncilRole, round: number): CouncilMessageType {
  if (round <= 1) return ROLE_LENS[role].defaultType;
  if (round === 2) return role === 'Critic' ? 'challenge' : 'challenge';
  return 'revision';
}

export const heuristicReasoner: CouncilReasoner = {
  name: 'heuristic',

  contribute(ctx: ReasonerContext): ReasonerMessage {
    const lens = ROLE_LENS[ctx.role];
    const prior = lastFromOthers(ctx);
    const messageType = typeForRound(ctx.role, ctx.round);

    // Confidence rises as the transcript grows and the plan firms up.
    const transcriptBoost = Math.min(0.12, ctx.transcript.length * 0.015);
    const strategyBoost = ctx.currentStrategy ? 0.05 : 0;
    const confidence = Math.min(
      0.97,
      lens.baseConfidence + transcriptBoost + strategyBoost
    );

    const refs = prior ? [prior.id] : [];
    const goal = ctx.userGoal.trim();

    let content: string;
    if (messageType === 'proposal') {
      content =
        `Position: As Strategist I propose we break "${goal}" into a ` +
        `sequenced plan: (1) clarify the desired outcome and constraints, ` +
        `(2) produce the primary deliverable, (3) add supporting work that ` +
        `de-risks it, (4) define how success is measured.\n` +
        `Challenge: the main risk is committing to execution before the ` +
        `outcome is well defined.\n` +
        `Evidence: prior councils converge faster when round 1 fixes scope.\n` +
        `Revision: open to reordering once the Researcher weighs in.`;
    } else if (messageType === 'challenge') {
      const target = prior ? `${prior.agent_name}'s ${prior.message_type}` : 'the current plan';
      content =
        `Position: I largely accept the direction but I ${ctx.role === 'Critic' ? 'challenge' : 'want to pressure-test'} ${target}.\n` +
        `Challenge: it assumes the first deliverable is the right one — that ` +
        `assumption is not yet backed by evidence for "${goal}".\n` +
        `Evidence: ${
          ctx.role === 'Researcher'
            ? 'a quick scan of comparable goals shows supporting work is usually needed alongside, not after, the primary deliverable.'
            : 'plans that skip a validation step tend to need rework.'
        }\n` +
        `Revision: add an explicit assumption-check step and a supporting ` +
        `work item, then re-sequence.`;
    } else {
      content =
        `Position: As ${ctx.role} I consolidate the discussion into a ` +
        `revised plan for "${goal}".\n` +
        `Challenge: remaining risk is execution detail — each step needs an ` +
        `owner and a clear definition of done.\n` +
        `Evidence: the council has now covered scope, the primary deliverable, ` +
        `supporting work and measurement.\n` +
        `Revision: lock the sequence — primary deliverable first, supporting ` +
        `work in parallel, measurement last — and proceed to a vote.`;
    }

    return { messageType, content, confidence, references: refs };
  },

  vote(ctx: ReasonerContext): ReasonerVote {
    const lens = ROLE_LENS[ctx.role];
    // Critics are the hardest to convince; Validators the most decisive.
    const roundMaturity = Math.min(0.15, ctx.round * 0.04);
    const confidence = Math.min(
      0.97,
      lens.baseConfidence + roundMaturity + (ctx.currentStrategy ? 0.06 : 0)
    );

    let vote: CouncilVote = 'agree';
    if (ctx.round <= 1 && ctx.role === 'Critic') vote = 'revise';
    if (!ctx.currentStrategy) vote = 'revise';

    const reason =
      vote === 'agree'
        ? `The strategy is concrete, sequenced and measurable; as ${ctx.role} I see no critical blocker.`
        : `As ${ctx.role} I want one more pass — ${lens.focus} and the plan is not yet fully de-risked.`;

    return { vote, confidence, reason };
  },
};

/** Re-exported for convenience when building a real reasoner. */
export { COUNCIL_SYSTEM_PROMPT };
