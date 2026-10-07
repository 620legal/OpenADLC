/**
 * Whether the crew can work in a repository, as settings says it.
 *
 * The bridge lets each bot into every repository OpenADLC works in — when one is
 * added, when it starts, each time it reconciles — and keeps what it found
 * (`apps/bridge/src/crew-access.ts`). This is that, in a line: how many of the
 * crew can work there, or that they are being let in, or why one cannot.
 */

import type { ReachAction, ReachFix } from './app-reach';

/** One bot, as the bridge found it in one repository. */
export interface BotAccess {
  bot: string;
  login: string | null;
  state: 'in' | 'invited' | 'no-account' | 'refused';
  changed: boolean;
  detail: string;
}

/** A repository's crew, as `GET /v1/repos` says it; null before anything has looked. */
export interface RepoAccess {
  repository: string;
  running: boolean;
  trigger: string | null;
  checkedAt: string | null;
  error: string | null;
  /**
   * What a person does so the app can reach the repository at all, when it
   * cannot. Absent from a bridge older than it.
   */
  needs?: ReachFix | null;
  bots: BotAccess[];
}

export interface AccessLine {
  tone: 'signal' | 'attention' | 'alarm' | 'muted';
  text: string;
  /** Why not all of them, when not; the first bot that cannot, and how many more. */
  reason: string | null;
  /** What the button says, when there is one to press. */
  action: 'Try again' | 'Check now' | null;
  /** A page on GitHub where the thing to do is done, instead of a button here. */
  link?: ReachAction;
  /** A run a person is waiting on. */
  busy: boolean;
}

/** Started by somebody who is looking at the page, rather than by the clock. */
const PERSON = new Set(['added', 'retry', 'invite']);

function why(bot: BotAccess, name: string): string {
  switch (bot.state) {
    case 'invited':
      return `${name} is invited, and accepts once it is connected`;
    case 'no-account':
      return `${name} has no GitHub account yet`;
    case 'refused':
      return `${name}: ${bot.detail}`;
    case 'in':
      return `${name} can work here`;
  }
}

/**
 * The line for one repository. `nameOf` turns a bot's name into the one a
 * person knows it by: a handle, or its role before an account is connected.
 */
export function accessLine(access: RepoAccess | null | undefined, nameOf: (bot: string) => string = (bot) => bot): AccessLine {
  if (!access) return { tone: 'muted', text: 'Not checked yet', reason: null, action: 'Check now', busy: false };

  // A check the clock started keeps saying what the last one found: the line
  // does not flicker every quarter hour. One somebody started says it is going.
  if (access.running && (!access.checkedAt || PERSON.has(access.trigger ?? ''))) {
    return { tone: 'muted', text: 'Inviting the crew…', reason: null, action: null, busy: true };
  }

  // The app cannot reach the repository: the step is a person's, on GitHub,
  // and trying again here could not do it. The line changes by itself once
  // GitHub says the app is installed.
  if (access.needs) {
    return { tone: 'attention', text: access.needs.title, reason: access.needs.detail, action: null, link: access.needs.action, busy: false };
  }

  if (access.error) {
    return { tone: 'alarm', text: 'The crew could not be let in', reason: access.error, action: 'Try again', busy: false };
  }

  const total = access.bots.length;
  if (total === 0) return { tone: 'muted', text: 'No bots to let in yet', reason: null, action: null, busy: false };

  const outside = access.bots.filter((bot) => bot.state !== 'in');
  const text = `${total - outside.length} of ${total} ${total === 1 ? 'bot can' : 'bots can'} work here`;
  if (outside.length === 0) return { tone: 'signal', text, reason: null, action: null, busy: false };

  const first = outside[0]!;
  const more = outside.length - 1;
  return {
    tone: 'attention',
    text,
    reason: `${why(first, nameOf(first.bot))}${more > 0 ? `, and ${more} more` : ''}`,
    action: 'Try again',
    busy: false,
  };
}
