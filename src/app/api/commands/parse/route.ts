import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { mutationLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { parseCommand, isParseError } from '@/lib/skills/commands';
import {
  createSkill,
  listSkills,
  getSkillDetail,
  updateSkill,
  archiveSkill,
  findKnowledgeByTitle,
  attachSkillsToCouncil,
  slugify,
} from '@/lib/skills/db';
import { buildSkillFromSource } from '@/lib/skills/skill-builder';
import { ingestLink, ingestText, IngestError } from '@/lib/skills/ingest';
import { startCouncil, CouncilError } from '@/lib/council/engine';
import type { AgentSkill } from '@/lib/skills/types';

/** Resolve a skill by slug, then by case-insensitive name. */
function resolveSkill(
  workspaceId: number,
  nameOrSlug: string
): AgentSkill | undefined {
  const all = listSkills(workspaceId);
  const wantSlug = slugify(nameOrSlug);
  return (
    all.find((s) => s.slug === wantSlug) ??
    all.find((s) => s.name.toLowerCase() === nameOrSlug.toLowerCase())
  );
}

/**
 * POST /api/commands/parse — parse and execute a slash command (spec §7, §11).
 * Body: { command: string }
 *
 * Returns { command, action, result } where `action` tells the client what
 * happened (or what input is still needed, e.g. a PDF upload).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator');
  if ('error' in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  const rate = mutationLimiter(request);
  if (rate) return rate;

  const workspaceId = auth.user.workspace_id ?? 1;

  try {
    const body = await request.json().catch(() => ({}));
    const raw = typeof body.command === 'string' ? body.command : '';
    const parsed = parseCommand(raw);

    if (isParseError(parsed)) {
      return NextResponse.json(
        { error: parsed.error, hint: parsed.hint },
        { status: 400 }
      );
    }

    switch (parsed.kind) {
      case 'help':
        return NextResponse.json({
          command: parsed.kind,
          action: 'help',
          result: {
            commands: [
              '/skill create <name>',
              '/skill list',
              '/skill show <name>',
              '/skill edit <name>',
              '/skill archive <name>',
              '/skill create-from-source <name> from <source>',
              '/learn pdf <file>',
              '/learn link <url>',
              '/learn text <text>',
              '/use <skill> on <goal>',
              '/council use <skill1>, <skill2>',
            ],
          },
        });

      case 'skill.create': {
        const skill = createSkill({
          workspaceId,
          name: parsed.name,
          sourceType: 'manual',
          status: 'draft',
        });
        return NextResponse.json({
          command: parsed.kind,
          action: 'skill_created',
          result: { skill },
        });
      }

      case 'skill.list':
        return NextResponse.json({
          command: parsed.kind,
          action: 'skill_list',
          result: { skills: listSkills(workspaceId) },
        });

      case 'skill.show': {
        const found = resolveSkill(workspaceId, parsed.name);
        if (!found)
          return NextResponse.json(
            { error: `Skill "${parsed.name}" not found.` },
            { status: 404 }
          );
        return NextResponse.json({
          command: parsed.kind,
          action: 'skill_show',
          result: { skill: getSkillDetail(found.id, workspaceId) },
        });
      }

      case 'skill.edit': {
        const found = resolveSkill(workspaceId, parsed.name);
        if (!found)
          return NextResponse.json(
            { error: `Skill "${parsed.name}" not found.` },
            { status: 404 }
          );
        if (parsed.instructions) {
          updateSkill(found.id, {
            instructions: parsed.instructions,
            changelog: 'Edited via slash command',
          });
        }
        return NextResponse.json({
          command: parsed.kind,
          action: parsed.instructions ? 'skill_updated' : 'skill_edit_open',
          result: { skill: getSkillDetail(found.id, workspaceId) },
        });
      }

      case 'skill.archive': {
        const found = resolveSkill(workspaceId, parsed.name);
        if (!found)
          return NextResponse.json(
            { error: `Skill "${parsed.name}" not found.` },
            { status: 404 }
          );
        return NextResponse.json({
          command: parsed.kind,
          action: 'skill_archived',
          result: { skill: archiveSkill(found.id) },
        });
      }

      case 'skill.createFromSource': {
        const source = findKnowledgeByTitle(workspaceId, parsed.source);
        if (!source)
          return NextResponse.json(
            { error: `Knowledge source "${parsed.source}" not found.` },
            { status: 404 }
          );
        const skill = await buildSkillFromSource({
          workspaceId,
          sourceId: source.id,
          name: parsed.name,
        });
        return NextResponse.json({
          command: parsed.kind,
          action: 'skill_created',
          result: { skill },
        });
      }

      case 'learn.link': {
        const r = await ingestLink(workspaceId, parsed.url);
        return NextResponse.json({
          command: parsed.kind,
          action: 'knowledge_ingested',
          result: {
            source: r.source,
            chunk_count: r.chunkCount,
            suggest_skill: r.suggestSkill,
          },
        });
      }

      case 'learn.text': {
        const r = await ingestText(workspaceId, 'Pasted note', parsed.text);
        return NextResponse.json({
          command: parsed.kind,
          action: 'knowledge_ingested',
          result: { source: r.source, chunk_count: r.chunkCount },
        });
      }

      case 'learn.pdf':
        // A PDF can't be read from a filename alone — the client must upload.
        return NextResponse.json({
          command: parsed.kind,
          action: 'await_upload',
          result: {
            file: parsed.file,
            message:
              'Upload the PDF to /api/learn/pdf (raw_text or data_base64).',
          },
        });

      case 'use.skill':
      case 'council.use': {
        // Both commands open a Council session and attach skills (spec §9).
        const skillNames =
          parsed.kind === 'use.skill' ? [parsed.skill] : parsed.skills;
        const goal =
          parsed.kind === 'use.skill' ? parsed.goal : parsed.goal;
        if (!goal) {
          return NextResponse.json({
            command: parsed.kind,
            action: 'need_goal',
            result: {
              skills: skillNames,
              message:
                'Provide a goal — e.g. add a "Goal: ..." line, or use ' +
                '/use <skill> on <goal>.',
            },
          });
        }

        const resolved = skillNames
          .map((n) => resolveSkill(workspaceId, n))
          .filter((s): s is AgentSkill => !!s);
        const missing = skillNames.filter(
          (n) => !resolveSkill(workspaceId, n)
        );

        const { session } = await startCouncil({
          workspaceId,
          title: goal.slice(0, 80),
          userGoal: goal,
        });
        if (resolved.length) {
          attachSkillsToCouncil(
            session.id,
            resolved.map((s) => ({ skillId: s.id }))
          );
        }

        return NextResponse.json({
          command: parsed.kind,
          action: 'council_started',
          result: {
            council_session_id: session.id,
            attached_skills: resolved.map((s) => s.name),
            missing_skills: missing,
          },
        });
      }

      default:
        return NextResponse.json(
          { error: 'Unsupported command.' },
          { status: 400 }
        );
    }
  } catch (err) {
    if (err instanceof IngestError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof CouncilError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    logger.error({ err }, 'Command execution failed');
    return NextResponse.json(
      { error: 'Command execution failed' },
      { status: 500 }
    );
  }
}
