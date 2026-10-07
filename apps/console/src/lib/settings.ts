import type { CrewMember } from './api';
import { botLabel } from './bot-label';
import { countWords, tasksAtOnce } from './crew';
import { modesFor, STAGES, type StageKey } from './stages';

/**
 * Settings in the words a person uses: what each stage may do without asking,
 * how many tasks run at once, whether each bot's account is connected.
 *
 * The stage controls map onto the bridge's modes and offer nothing else:
 * `autonomous` is "On its own" ("Always" on Design), and `conditional` is
 * Design's alone, "When it matters": a design pass only for issues that carry one of the repository's
 * spec-required labels. `untouched`, which no bot staffs, is not offered, and
 * is shown only on a stage already set to it, so the control never claims a
 * setting the repository does not have.
 *
 * "Waits for you" (`assist`) was offered on every stage and did nothing: the
 * bot did the stage's work and moved on exactly as "On its own" did. It
 * is gone, and a stage still set to it reads as on its own. A bot asks when it
 * needs something, whatever the mode. What releases production is the
 * repository's delivery rules — a person through the production environment's
 * required reviewers, or a wait on testing when it ships automatically — not
 * a setting here.
 */

/**
 * Where the sections of settings are, in order: the page's own navigation.
 * System used to be Engine updates; `/settings#engine-updates` still lands
 * on it, which is where a failed update's card links.
 */
export const SETTINGS_SECTIONS = [
  { id: 'repository', label: 'Repositories' },
  { id: 'github', label: 'GitHub' },
  { id: 'models', label: 'AI models' },
  { id: 'crew', label: 'Crew' },
  { id: 'system', label: 'System' },
  { id: 'spending-limits', label: 'Spending limits' },
  { id: 'backup', label: 'Backup' },
  { id: 'pause', label: 'Pause work' },
  { id: 'users', label: 'Users' },
  { id: 'appearance', label: 'Appearance' },
] as const;

/** `#engine-updates` is System. A failed update's card was written before the section was renamed. */
export function hashSection(hash: string): string | null {
  if (!hash) return null;
  return hash === 'engine-updates' ? 'system' : hash;
}

/**
 * Where one repository's settings are: a page of its own, so the list in
 * settings stays a list however many repositories there are, and a
 * repository's settings can be linked to.
 */
export function repoSettingsPath(name: string): string {
  return `/settings/repositories/${encodeURIComponent(name)}`;
}

export interface StageChoice {
  mode: string;
  label: string;
}

const ON_ITS_OWN: StageChoice = { mode: 'autonomous', label: 'On its own' };

/**
 * The choices a stage offers, in the order the design draws them. Only Design
 * has a real choice; every other stage runs on its own, which settings says
 * rather than drawing a control with one option. An untouched Intake or
 * Design is shown as it is; `untouched` means nothing on a later stage, which
 * the bridge reads as on its own, so it is never offered there.
 */
export function stageChoices(stage: StageKey, current: string | undefined): StageChoice[] {
  const choices = stage === 'spec' ? [{ mode: 'autonomous', label: 'Always' }, { mode: 'conditional', label: 'When it matters' }] : [ON_ITS_OWN];
  if (current === 'untouched' && modesFor(stage).includes('untouched')) choices.push({ mode: 'untouched', label: stage === 'spec' ? 'Never' : 'No bot' });
  return choices;
}

/** A stage's mode when the repository has none stored: what the bridge assumes for it. */
export function modeOf(modes: Readonly<Record<string, string>>, stage: StageKey): string {
  const mode = modes[stage] ?? (stage === 'spec' ? 'conditional' : 'autonomous');
  // What an older bridge may still send: `assist` did what `autonomous` does.
  return mode === 'assist' ? 'autonomous' : mode;
}

/** What each stage does, as the settings page says it. */
export function stageLine(stage: StageKey, crew: { reviewers: number; maxReviewRounds: number | null }): string {
  switch (stage) {
    case 'intake':
      return 'Files the issue once your request is complete';
    case 'spec':
      return 'A written plan before the build';
    case 'build':
      return 'Builds it, runs CI locally, opens the pull request';
    case 'review': {
      const who = crew.reviewers > 0 ? `${countWords(crew.reviewers, 'reviewer')} on different models` : 'Reviewers on different models';
      return crew.maxReviewRounds
        ? `${who}, the lead last; stops after ${crew.maxReviewRounds} rounds that do not agree`
        : `${who}, the lead last; stops when they cannot agree`;
    }
    case 'merged':
      return 'Deploys by the repository’s own rules';
    case 'done':
      return 'Closes the issue once the change is live';
  }
}

/** The stages in board order, under the board's names. */
export const SETTINGS_STAGES = STAGES.map(({ key, title }) => ({ key, title }));

/**
 * How many tasks a repository's builders can run at once between them: its
 * owner and every other bot with the owner's role, each up to its own tasks
 * at once (Crew), each task in a computer of its own. More than that at once
 * cannot mean anything.
 */
export function buildersOf(
  owner: Pick<CrewMember, 'role'> | null | undefined,
  crew: readonly Pick<CrewMember, 'role' | 'maxTasks'>[],
): number {
  const role = owner?.role ?? 'implement';
  return crew.filter((bot) => bot.role === role).reduce((sum, bot) => sum + tasksAtOnce(bot), 0);
}

/** The line under "Tasks at once", from what the builders can run at once between them. */
export function tasksAtOnceLine(capacity: number): string {
  if (capacity <= 0) return 'The crew has no builder yet, so nothing is built.';
  if (capacity === 1) return 'Its builder runs one task at a time. Raise its tasks at once on the Crew page, or add a builder, to run two.';
  return `Its builders can run ${countWords(capacity, 'task').toLowerCase()} at once between them, each in a computer of its own.`;
}

export interface AccountState {
  text: 'Connected' | 'Needs reconnecting' | 'Not connected';
  tone: 'signal' | 'attention' | 'muted';
  action: 'Reconnect' | 'Connect';
}

/**
 * Whether a bot's GitHub account can act. An expired or revoked credential is
 * still an account, one that needs connecting again; a bot with none has
 * nothing to reconnect.
 */
export function accountState(
  bot: Pick<CrewMember, 'authorization'> & Partial<Pick<CrewMember, 'githubLogin'>> & Parameters<typeof botLabel>[0],
): AccountState {
  if (bot.authorization === 'expired' || bot.authorization === 'revoked') {
    return { text: 'Needs reconnecting', tone: 'attention', action: 'Reconnect' };
  }
  // By its account, not its name: seats that share one account keep their
  // seats' names, so a name that is not a handle says nothing about it.
  if ((!botLabel(bot).handle && !bot.githubLogin) || bot.authorization === 'unauthorized') {
    return { text: 'Not connected', tone: 'muted', action: 'Connect' };
  }
  return { text: 'Connected', tone: 'signal', action: 'Reconnect' };
}

/**
 * Which section of settings is being read, for its navigation to mark: the
 * last whose top has scrolled up to the reading line. At the end of the page
 * the last sections cannot scroll that far, so there it is the one a link
 * named, while that one is on screen, and otherwise the last.
 */
export function sectionBeingRead(input: {
  /** Each section's top, measured from the top of the window, in page order. */
  tops: readonly { id: string; top: number }[];
  atBottom: boolean;
  /** The section the address names, `#system` or the old `#engine-updates`, if any. */
  named: string | null;
  viewportHeight: number;
  /** How far below the top of the window a section counts as being read. */
  line?: number;
}): string | null {
  const line = input.line ?? 120;
  if (input.tops.length === 0) return null;
  if (input.atBottom) {
    const named = input.tops.find((section) => section.id === input.named);
    if (named && named.top >= 0 && named.top < input.viewportHeight) return named.id;
    return input.tops[input.tops.length - 1]!.id;
  }
  let reading = input.tops[0]!.id;
  for (const section of input.tops) if (section.top <= line) reading = section.id;
  return reading;
}
