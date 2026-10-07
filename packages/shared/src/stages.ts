import type { StageMode } from './types.js';

export const STAGE_KEYS = ['intake', 'spec', 'build', 'review', 'merged', 'done'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/**
 * Whether a stage takes a mode. `conditional` is Design's alone: a design pass
 * is a stage a change can skip, and every other stage is one every change
 * passes through. The console's `modesFor` says the same.
 */
export function stageOffersMode(stage: StageKey, mode: StageMode): boolean {
  return mode !== 'conditional' || stage === 'spec';
}

/** The board's columns are GitHub labels; nothing else defines a stage. */
export const STAGE_LABELS: Record<StageKey, string> = {
  intake: 'adlc:intake',
  spec: 'adlc:spec',
  build: 'adlc:build',
  review: 'adlc:review',
  merged: 'adlc:merged',
  done: 'adlc:done',
};

/**
 * What a person calls each stage. The keys and the labels are the platform's
 * and stay as they are; these are the words on the board, in settings and in
 * the status issue: a design pass, a build, shipping — not `spec`, `implement`
 * and `merged`.
 */
export const STAGE_COLUMN_TITLES: Record<StageKey, string> = {
  intake: 'Intake',
  spec: 'Design',
  build: 'Build',
  review: 'Review',
  merged: 'Ship',
  done: 'Done',
};

export const STAGE_LABEL_PREFIX = 'adlc:';

/**
 * The prefix stage labels had before FleetADLC was named, when the pipeline was
 * called an SDLC. Issues on GitHub still carry it until label sync renames the
 * labels in place, so a stage is still read from it, and every stage move
 * replaces it with the current one.
 */
export const LEGACY_STAGE_LABEL_PREFIX = 'sdlc:';

/**
 * Whether a label is a stage label, under the current prefix or the legacy
 * one. By name, not by prefix: `adlc:ci` shares the prefix and is no stage,
 * and a stage move that dropped every `adlc:` label would drop it too.
 */
export function isStageLabel(label: string): boolean {
  return STAGE_KEYS.some((key) => label === `${STAGE_LABEL_PREFIX}${key}` || label === `${LEGACY_STAGE_LABEL_PREFIX}${key}`);
}

export function stageFromLabels(labels: readonly string[]): StageKey | null {
  for (const key of STAGE_KEYS) {
    if (labels.includes(STAGE_LABELS[key])) return key;
  }
  for (const key of STAGE_KEYS) {
    if (labels.includes(`${LEGACY_STAGE_LABEL_PREFIX}${key}`)) return key;
  }
  return null;
}

/**
 * A person telling the crew to leave an issue alone. `fleet:ignore` is the name
 * it had before the rename, and an issue labelled with it is still left alone.
 */
export const IGNORE_LABEL = 'fleetadlc:ignore';
export const LEGACY_IGNORE_LABEL = 'fleet:ignore';

export function isIgnoreLabel(label: string): boolean {
  return label === IGNORE_LABEL || label === LEGACY_IGNORE_LABEL;
}

export function hasIgnoreLabel(labels: readonly string[] | null | undefined): boolean {
  return (labels ?? []).some(isIgnoreLabel);
}

/**
 * A person holding one piece of work: the step running finishes, and nothing
 * new starts on it — no task, no review, no merge — until it is taken off.
 * On the issue and its pull request both: the merge line reads the pull
 * request's labels, the dispatcher and the task service the issue's.
 */
export const PAUSED_LABEL = 'fleetadlc:paused';

/** The one issue a repository builds next, ahead of priority order. */
export const NEXT_LABEL = 'fleetadlc:next';

export function hasPausedLabel(labels: readonly string[] | null | undefined): boolean {
  return (labels ?? []).includes(PAUSED_LABEL);
}

export function hasNextLabel(labels: readonly string[] | null | undefined): boolean {
  return (labels ?? []).includes(NEXT_LABEL);
}

/** Labels that were renamed, by their old name: label sync renames them in place. */
export const RENAMED_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(STAGE_KEYS.map((key) => [`${LEGACY_STAGE_LABEL_PREFIX}${key}`, `${STAGE_LABEL_PREFIX}${key}`])),
  [LEGACY_IGNORE_LABEL]: IGNORE_LABEL,
};

/**
 * Bots advance their own stage. A card moves backwards only by a send-back
 * (`previousStage`, through the bridge's `SendBack`) or by a person.
 */
const FORWARD: Partial<Record<StageKey, StageKey[]>> = {
  intake: ['spec', 'build'],
  spec: ['build'],
  build: ['review'],
  // Straight to Done when merging is shipping, in a repository that deploys nothing.
  review: ['merged', 'done'],
  merged: ['done'],
};

export function isForwardMove(from: StageKey, to: StageKey): boolean {
  return (FORWARD[from] ?? []).includes(to);
}

/** Whether a move goes to an earlier column: a send-back, or a person moving a card back. */
export function isBackwardMove(from: StageKey, to: StageKey): boolean {
  return STAGE_KEYS.indexOf(to) < STAGE_KEYS.indexOf(from);
}

/**
 * The stage work goes back to from each stage, before a stage nobody staffs is
 * skipped. Build has two, because whether the issue had a design pass is in its
 * history, not in the stage: an issue intake sent straight to build has no
 * design to go back to, and sending it to Design would staff a stage that never
 * saw it. Review and Ship send back to build: what they find is the builder's
 * to fix.
 */
export const BACKWARD: Partial<Record<StageKey, readonly StageKey[]>> = {
  spec: ['intake'],
  build: ['spec', 'intake'],
  review: ['build'],
  merged: ['build'],
};

/** One recorded stage move, as `stage_moves` keeps it, oldest first. */
export interface StageMoveEntry {
  from: StageKey | null;
  to: StageKey;
}

/** Where a send-back lands, and whether a bot staffs it there. */
export interface PreviousStage {
  to: StageKey;
  /** False when no stage on the way back is staffed: the issue moves and a person takes it. */
  staffed: boolean;
}

/**
 * Whether the issue was in Design since it last entered Intake. Moves before
 * that are an earlier cycle: an issue sent back to intake and refiled straight
 * to build has no design of this cycle to go back to.
 */
function wasInSpecThisCycle(history: readonly StageMoveEntry[]): boolean {
  // Only the moves after the last one into Intake: that move itself may be
  // Design sending the issue back (`spec → intake`), which is the end of an
  // earlier cycle's design pass, not a design pass in this one.
  const start = history.map((move) => move.to).lastIndexOf('intake');
  return history.slice(start + 1).some((move) => move.to === 'spec' || move.from === 'spec');
}

/** The stage directly before `from` in this issue's history, or null for Intake and Done. */
function stageBefore(from: StageKey, history: readonly StageMoveEntry[]): StageKey | null {
  if (from === 'build') return wasInSpecThisCycle(history) ? 'spec' : 'intake';
  return BACKWARD[from]?.[0] ?? null;
}

/**
 * The stages `untouched` means something in: only intake and spec are staffed
 * by the stage handoff, which is the one place that reads it. Set on build,
 * review, merged or done it was accepted, shown as "No bot", and ignored: the
 * dispatcher still leased that repository's Build issues, and the one thing
 * it changed was a send-back from Review skipping Build to land in Intake. A
 * repository's bots are stopped with Pause work.
 */
export const UNTOUCHABLE_STAGES = ['intake', 'spec'] as const satisfies readonly StageKey[];

/** Whether a stage may be set to `untouched`; see `UNTOUCHABLE_STAGES`. */
export function mayBeUntouched(stage: string): boolean {
  return (UNTOUCHABLE_STAGES as readonly string[]).includes(stage);
}

/** Why `untouched` is refused for a stage, said the same way by the config file and the API. */
export function untouchedRefusal(stage: string): string {
  return `${stage} cannot be untouched: only intake and spec can. Remove the line to leave ${stage} autonomous, or pause the repository (Settings → Pause work) to stop its bots`;
}

/**
 * Where a stage sends work back to, from the issue's own history rather than a
 * fixed map, or null when there is nothing before it.
 *
 * An untouched intake or spec is passed over walking back: no bot would
 * pick the work up there, and the send-back would sit in a column nobody
 * watches. `untouched` anywhere else means nothing (`UNTOUCHABLE_STAGES`). When every stage on the way back is untouched, the work still goes
 * to the stage directly before, unstaffed, and the caller hands it to a person.
 * A bot may send back only to exactly this stage; a person may move a card
 * anywhere.
 */
export function previousStage(
  from: StageKey,
  history: readonly StageMoveEntry[],
  modes: Partial<Record<StageKey, StageMode>>,
): PreviousStage | null {
  const first = stageBefore(from, history);
  if (!first) return null;
  for (let stage: StageKey | null = first; stage; stage = stageBefore(stage, history)) {
    if (modes[stage] !== 'untouched' || !mayBeUntouched(stage)) return { to: stage, staffed: true };
  }
  return { to: first, staffed: false };
}

/**
 * A stage mode as OpenADLC reads it now. `assist` — "prepare, then ask before the
 * stage's last act" — was offered for every stage and enforced in none: the
 * bot did the work and moved on exactly as `autonomous` does, while the board
 * promised a person in the loop. It is no longer offered, and wherever it is
 * still written — a repository row from before migration 0018, a restored
 * backup, an older `config/repos.yaml`, an older console — it means what it
 * always did. A person approves production through the environment's
 * required reviewers, never through a stage mode.
 */
export function normaliseStageMode(mode: string): string {
  return mode === 'assist' ? 'autonomous' : mode;
}

/**
 * Every stage's mode, read as `normaliseStageMode` reads one. `untouched` on a
 * stage that cannot be (`UNTOUCHABLE_STAGES`) reads as `autonomous`, which is
 * what the dispatcher always did with it. A row stored before it was refused,
 * or restored from a backup, would otherwise be sent back by the console's
 * next save, whole, and refused, so that repository's settings could never be
 * saved again.
 */
export function normaliseStageModes<T extends Partial<Record<string, string>>>(modes: T): { [K in keyof T]: StageMode } {
  const out: Record<string, string> = {};
  for (const [stage, mode] of Object.entries(modes)) {
    if (typeof mode !== 'string') continue;
    const read = normaliseStageMode(mode);
    out[stage] = read === 'untouched' && !mayBeUntouched(stage) ? 'autonomous' : read;
  }
  return out as { [K in keyof T]: StageMode };
}

/** A label as GitHub lists it. */
export interface ExistingLabel {
  name: string;
  color?: string;
  description?: string | null;
}

/** A label as OpenADLC wants it on a repository. */
export interface WantedLabel {
  name: string;
  color: string;
  description: string;
}

/**
 * What writing a label takes. `from` is the name to `PATCH`: the label's own,
 * or the one it had before the rename, so `sdlc:build` becomes `adlc:build` in
 * place and every issue that carries it keeps it. Creating `adlc:build` beside
 * it instead would leave each of those issues with the old label and none of
 * the new one.
 */
export type LabelStep =
  | { action: 'create'; detail: string }
  | { action: 'unchanged'; detail: string }
  | { action: 'update'; from: string; detail: string };

export function labelStep(wanted: WantedLabel, existing: readonly ExistingLabel[]): LabelStep {
  const current = existing.find((label) => label.name === wanted.name);
  if (!current) {
    const legacy = Object.entries(RENAMED_LABELS).find(([, now]) => now === wanted.name)?.[0];
    const old = legacy ? existing.find((label) => label.name === legacy) : undefined;
    if (old) return { action: 'update', from: old.name, detail: `renamed from ${old.name}; issues keep it` };
    return { action: 'create', detail: 'not there yet' };
  }
  if (current.color !== wanted.color || (current.description ?? '') !== wanted.description) {
    return { action: 'update', from: current.name, detail: 'color or description differs' };
  }
  return { action: 'unchanged', detail: '' };
}
