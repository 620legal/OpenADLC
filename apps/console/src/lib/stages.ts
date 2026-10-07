/**
 * The stages, named as the board names them.
 *
 * The board's column titles come from the bridge, which reads them from
 * `STAGE_COLUMN_TITLES` in `@fleetadlc/shared`. The console does not depend on
 * that package — its barrel carries the config loader and `node:fs` — so the
 * titles are copied here, and `stages.test.ts` fails if the two disagree. Settings
 * showed the keys instead (BUILD, MERGED) while the board said Implement and
 * Deploy, and nothing on either screen said they were the same stage.
 *
 * Each has a line saying what happens in it, in the words a person filing a
 * request would use. The board shows it under the column, and the first-run
 * page under each step of "how a request moves".
 */
export const STAGES = [
  { key: 'intake', title: 'Intake', subtitle: 'Clarifies the request with you, then files the issue' },
  { key: 'spec', title: 'Design', subtitle: 'Designs what needs one, remembering what was decided' },
  { key: 'build', title: 'Build', subtitle: 'Builds it, runs CI locally, opens the pull request' },
  { key: 'review', title: 'Review', subtitle: 'Reviewers on different models; the lead decides last' },
  { key: 'merged', title: 'Ship', subtitle: 'Deploys by the repository’s own rules' },
  { key: 'done', title: 'Done', subtitle: 'Live, and closed on GitHub' },
] as const;

export type StageKey = (typeof STAGES)[number]['key'];

/** The bridge's `STAGE_MODES`; `stages.test.ts` fails if the two differ. `assist` is gone. */
export const STAGE_MODES = ['autonomous', 'untouched', 'conditional'] as const;

/**
 * The bridge's `UNTOUCHABLE_STAGES`: the stages `untouched` does anything in.
 * The bridge refuses it for the rest, and reads one stored there as
 * `autonomous`. `stages.test.ts` fails if the two differ.
 */
export const UNTOUCHABLE_STAGES = ['intake', 'spec'] as const;

/** A stage by its key, for a column the bridge names by key. */
export function stageOf(key: string): (typeof STAGES)[number] | undefined {
  return STAGES.find((stage) => stage.key === key);
}

/**
 * Whether a person can choose a mode for this stage. Done is not: no bot works a
 * card that has reached it, so there is nothing for a mode to allow or hold.
 */
export function modeIsSettable(stage: StageKey): boolean {
  return stage !== 'done';
}

/**
 * The modes a stage offers. `conditional` is Design's alone: a design pass is a
 * stage a change can skip, so Design can run only when a spec-required label
 * asks for it. Every other stage is one every change passes through, and there
 * is nothing for a condition to decide. `untouched` is Intake's and Design's
 * alone (`UNTOUCHABLE_STAGES`).
 */
export function modesFor(stage: StageKey): readonly (typeof STAGE_MODES)[number][] {
  return STAGE_MODES.filter(
    (mode) =>
      (mode !== 'conditional' || stage === 'spec') && (mode !== 'untouched' || (UNTOUCHABLE_STAGES as readonly string[]).includes(stage)),
  );
}
