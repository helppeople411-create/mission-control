/**
 * Council reasoner backed by the LiteLLM proxy.
 *
 * Falls back to the heuristic reasoner when `LITELLM_API_KEY` is unset or
 * when the model call fails — the council flow stays end-to-end.
 *
 * Wired in `src/instrumentation.ts` so it activates automatically on
 * `next dev` / `next start` without changing the engine code.
 */

import { logger } from '@/lib/logger';
import {
  chatCompletion,
  getLiteLLMConfig,
  parseJsonResponse,
} from '@/lib/llm/litellm-client';
import {
  heuristicReasoner,
  type CouncilReasoner,
  type ReasonerContext,
  type ReasonerMessage,
  type ReasonerVote,
} from './reasoner';
import {
  COUNCIL_SYSTEM_PROMPT,
  type CouncilMessageType,
  type CouncilVote,
} from './types';

const MODEL_ENV = 'LITELLM_MODEL_COUNCIL';

const ALLOWED_TYPES: ReadonlySet<CouncilMessageType> = new Set([
  'proposal',
  'challenge',
  'evidence',
  'revision',
]);
const ALLOWED_VOTES: ReadonlySet<CouncilVote> = new Set([
  'agree',
  'disagree',
  'revise',
]);

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.7;
  return Math.max(0, Math.min(1, v));
}

function renderTranscript(ctx: ReasonerContext): string {
  if (ctx.transcript.length === 0) return '(empty — this is the opening contribution)';
  return ctx.transcript
    .map(
      (m) =>
        `#${m.id} ${m.agent_name} (${m.role}, round ${m.round_number}, ` +
        `${m.message_type}, conf ${m.confidence_score ?? '?'}):\n${m.content}`
    )
    .join('\n\n');
}

function buildContributeMessages(ctx: ReasonerContext) {
  const user =
    `Goal: ${ctx.userGoal.trim()}\n\n` +
    `You are agent "${ctx.agentName}" acting as ${ctx.role}. ` +
    `This is round ${ctx.round}.\n\n` +
    `Current consensus strategy: ${ctx.currentStrategy ?? '(none yet)'}\n\n` +
    `Transcript so far:\n${renderTranscript(ctx)}\n\n` +
    `Produce your contribution for this round. Respond with a single JSON ` +
    `object — no markdown, no commentary — using these fields:\n` +
    `  messageType: one of "proposal", "challenge", "evidence", "revision"\n` +
    `  content:     your full position/challenge/evidence/revision as plain text\n` +
    `  confidence:  number 0..1 — how strongly you back this contribution\n` +
    `  references:  array of prior message #ids you respond to (may be empty)\n` +
    `Make the content specific to this goal — no template phrasing.`;
  return [
    { role: 'system' as const, content: COUNCIL_SYSTEM_PROMPT },
    { role: 'user' as const, content: user },
  ];
}

function buildVoteMessages(ctx: ReasonerContext) {
  const user =
    `Goal: ${ctx.userGoal.trim()}\n\n` +
    `You are agent "${ctx.agentName}" acting as ${ctx.role}. ` +
    `This is round ${ctx.round}.\n\n` +
    `Strategy under consideration:\n${ctx.currentStrategy ?? '(no strategy has emerged yet)'}\n\n` +
    `Transcript:\n${renderTranscript(ctx)}\n\n` +
    `Vote on the strategy. Respond with a single JSON object — no markdown — ` +
    `using these fields:\n` +
    `  vote:       one of "agree", "disagree", "revise"\n` +
    `  confidence: number 0..1\n` +
    `  reason:     one to two sentence justification`;
  return [
    { role: 'system' as const, content: COUNCIL_SYSTEM_PROMPT },
    { role: 'user' as const, content: user },
  ];
}

interface ContributeJson {
  messageType?: string;
  content?: string;
  confidence?: number;
  references?: unknown;
}

interface VoteJson {
  vote?: string;
  confidence?: number;
  reason?: string;
}

export const llmReasoner: CouncilReasoner = {
  name: 'litellm',

  async contribute(ctx: ReasonerContext): Promise<ReasonerMessage> {
    const cfg = getLiteLLMConfig(MODEL_ENV);
    if (!cfg) return heuristicReasoner.contribute(ctx);
    try {
      const raw = await chatCompletion(cfg, buildContributeMessages(ctx), {
        json: true,
        temperature: 0.5,
        maxTokens: 900,
      });
      const parsed = parseJsonResponse<ContributeJson>(raw);
      const messageType: CouncilMessageType = ALLOWED_TYPES.has(
        parsed.messageType as CouncilMessageType
      )
        ? (parsed.messageType as CouncilMessageType)
        : 'proposal';
      const content = String(parsed.content ?? '').trim();
      if (!content) {
        logger.warn(
          { reasoner: 'litellm' },
          'empty content from model — falling back to heuristic'
        );
        return heuristicReasoner.contribute(ctx);
      }
      const references = Array.isArray(parsed.references)
        ? parsed.references
            .map((r) => Number(r))
            .filter((n) => Number.isInteger(n) && n > 0)
        : undefined;
      return {
        messageType,
        content,
        confidence: clamp01(parsed.confidence),
        ...(references && references.length > 0 ? { references } : {}),
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'llmReasoner.contribute failed — using heuristic'
      );
      return heuristicReasoner.contribute(ctx);
    }
  },

  async vote(ctx: ReasonerContext): Promise<ReasonerVote> {
    const cfg = getLiteLLMConfig(MODEL_ENV);
    if (!cfg) return heuristicReasoner.vote(ctx);
    try {
      const raw = await chatCompletion(cfg, buildVoteMessages(ctx), {
        json: true,
        temperature: 0.2,
        maxTokens: 350,
      });
      const parsed = parseJsonResponse<VoteJson>(raw);
      const vote: CouncilVote = ALLOWED_VOTES.has(parsed.vote as CouncilVote)
        ? (parsed.vote as CouncilVote)
        : 'revise';
      const reason =
        String(parsed.reason ?? '').trim() ||
        `As ${ctx.role}, my position on the strategy.`;
      return { vote, confidence: clamp01(parsed.confidence), reason };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'llmReasoner.vote failed — using heuristic'
      );
      return heuristicReasoner.vote(ctx);
    }
  },
};
