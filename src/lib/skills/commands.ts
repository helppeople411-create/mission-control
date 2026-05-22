/**
 * Skill Engine — slash command parser (spec §7).
 *
 * Pure parsing only: turns a raw command string into a structured intent.
 * Execution lives in /api/commands/parse.
 */

export type ParsedCommand =
  | { kind: 'skill.create'; name: string }
  | { kind: 'skill.list' }
  | { kind: 'skill.show'; name: string }
  | { kind: 'skill.edit'; name: string; instructions?: string }
  | { kind: 'skill.archive'; name: string }
  | { kind: 'skill.createFromSource'; name: string; source: string }
  | { kind: 'learn.pdf'; file: string }
  | { kind: 'learn.link'; url: string }
  | { kind: 'learn.text'; text: string }
  | { kind: 'use.skill'; skill: string; goal: string }
  | { kind: 'council.use'; skills: string[]; goal?: string }
  | { kind: 'help' };

export interface CommandParseError {
  error: string;
  hint?: string;
}

export type CommandParseResult = ParsedCommand | CommandParseError;

export function isCommand(input: string): boolean {
  return input.trimStart().startsWith('/');
}

export function isParseError(r: CommandParseResult): r is CommandParseError {
  return (r as CommandParseError).error !== undefined;
}

const USAGE: Record<string, string> = {
  skill:
    '/skill create <name> | list | show <name> | edit <name> | ' +
    'archive <name> | create-from-source <name> from <source>',
  learn: '/learn pdf <file> | link <url> | text <pasted text>',
  use: '/use <skill> on <goal>',
  council: '/council use <skill1>, <skill2>, ...',
};

/**
 * Parse a single slash command. Multi-line input is supported for
 * `/learn text` and `/council use` (a trailing "Goal: ..." line).
 */
export function parseCommand(raw: string): CommandParseResult {
  const input = raw.trim();
  if (!isCommand(input)) {
    return { error: 'Not a command — commands start with "/".' };
  }

  const firstLine = input.split('\n')[0].trim();
  const rest = input.slice(input.indexOf('\n') + 1).trim();
  const tokens = firstLine.slice(1).split(/\s+/);
  const root = (tokens[0] ?? '').toLowerCase();
  const sub = (tokens[1] ?? '').toLowerCase();
  const args = tokens.slice(2);

  switch (root) {
    case 'help':
      return { kind: 'help' };

    case 'skill': {
      if (sub === 'list') return { kind: 'skill.list' };
      if (sub === 'create') {
        const name = args.join(' ').trim();
        if (!name) return { error: 'Skill name required.', hint: USAGE.skill };
        return { kind: 'skill.create', name };
      }
      if (sub === 'show') {
        const name = args.join(' ').trim();
        if (!name) return { error: 'Skill name required.', hint: USAGE.skill };
        return { kind: 'skill.show', name };
      }
      if (sub === 'archive') {
        const name = args.join(' ').trim();
        if (!name) return { error: 'Skill name required.', hint: USAGE.skill };
        return { kind: 'skill.archive', name };
      }
      if (sub === 'edit') {
        const name = args.join(' ').trim();
        if (!name) return { error: 'Skill name required.', hint: USAGE.skill };
        // Instructions may follow on subsequent lines.
        return {
          kind: 'skill.edit',
          name,
          instructions: rest && rest !== input ? rest : undefined,
        };
      }
      if (sub === 'create-from-source') {
        // /skill create-from-source <name...> from <source...>
        const tail = args.join(' ');
        const m = tail.match(/^(.*?)\s+from\s+(.+)$/i);
        if (!m) {
          return {
            error: 'Expected: create-from-source <name> from <source>',
            hint: USAGE.skill,
          };
        }
        return {
          kind: 'skill.createFromSource',
          name: m[1].trim(),
          source: m[2].trim(),
        };
      }
      return { error: `Unknown /skill subcommand "${sub}".`, hint: USAGE.skill };
    }

    case 'learn': {
      if (sub === 'pdf') {
        const file = args.join(' ').trim();
        if (!file) return { error: 'PDF file required.', hint: USAGE.learn };
        return { kind: 'learn.pdf', file };
      }
      if (sub === 'link') {
        const url = args.join(' ').trim();
        if (!url) return { error: 'URL required.', hint: USAGE.learn };
        return { kind: 'learn.link', url };
      }
      if (sub === 'text') {
        const text = [args.join(' '), rest && rest !== input ? rest : '']
          .filter(Boolean)
          .join('\n')
          .trim();
        if (!text) return { error: 'No text provided.', hint: USAGE.learn };
        return { kind: 'learn.text', text };
      }
      return { error: `Unknown /learn subcommand "${sub}".`, hint: USAGE.learn };
    }

    case 'use': {
      // /use <skill> on <goal>
      const tail = tokens.slice(1).join(' ');
      const m = tail.match(/^(.*?)\s+on\s+(.+)$/i);
      if (!m) {
        return { error: 'Expected: /use <skill> on <goal>', hint: USAGE.use };
      }
      return { kind: 'use.skill', skill: m[1].trim(), goal: m[2].trim() };
    }

    case 'council': {
      if (sub !== 'use') {
        return {
          error: `Unknown /council subcommand "${sub}".`,
          hint: USAGE.council,
        };
      }
      const tail = args.join(' ');
      // Goal can be provided on a "Goal: ..." line.
      const goalMatch = rest.match(/goal:\s*(.+)/i);
      const skills = tail
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!skills.length) {
        return { error: 'At least one skill required.', hint: USAGE.council };
      }
      return {
        kind: 'council.use',
        skills,
        goal: goalMatch ? goalMatch[1].trim() : undefined,
      };
    }

    default:
      return {
        error: `Unknown command "/${root}".`,
        hint: 'Try /skill, /learn, /use, /council, or /help.',
      };
  }
}
