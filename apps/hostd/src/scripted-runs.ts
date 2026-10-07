import type { MockScript } from '@fleetadlc/engines';
import { renderMarker } from '@fleetadlc/shared';

/**
 * Scripted runs for the integration suites, reached only when
 * `FLEETADLC_SCRIPTED_ENGINES=1` is set. They exist so the suites can show
 * the whole pipeline — task, session, gate, ledger, board — before an engine key
 * is configured. Nothing here runs unless FLEETADLC_SCRIPTED_ENGINES=1 is set;
 * when it is, every task runs its script whatever engine its bot has, installed
 * or not (`chooseEngine`).
 */
export function scriptedRunFor(skill: string, subject: string): MockScript {
  switch (skill) {
    case 'triage':
      return {
        say: [
          `reading the request and looking for duplicates of ${subject}`,
          'drafting the issue body: outcome, acceptance criteria, expected paths, verification',
          'three things are missing before this is routable',
        ],
        ask: {
          question: 'Which repository owns this change, and is the deadline hard?',
          options: ['fleetadlc (console)', 'fleetadlc (bridge)', 'let me decide after you answer'],
        },
        tokensIn: 3200,
        tokensOut: 900,
        costUsd: 0.04,
      };

    case 'spec':
      return {
        say: [
          `reading ${subject}, its comments and the paths it names`,
          'two designs are viable; the difference is whether the lease table owns expiry',
          'posting the write sequence, acceptance criteria and migration note',
        ],
        tokensIn: 5400,
        tokensOut: 1800,
        costUsd: 0.09,
      };

    case 'implement':
      return {
        say: [
          `re-deriving the premises of ${subject} from HEAD`,
          // Carries its marker, the way a real skill's plan comment does, so the
          // demo exercises the structured-event path rather than only narration.
          `posting the plan: approach, files, tests, risks, stop points ${renderMarker({ event: 'plan_posted' })}`,
          'implementing inside the declared paths, with tests as the evidence',
          "running fleetadlc-ci against the task's own database",
          'fleetadlc-ci is green; pushing and opening the pull request, ready for review',
        ],
        touch: ['src/dispatcher/lease.ts', 'tests/dispatcher/lease.test.ts'],
        tokensIn: 18000,
        tokensOut: 4200,
        costUsd: 0.31,
      };

    case 'pr-review':
      return {
        say: [
          `checking out ${subject} in a clean worktree to read it, and reading the recorded local CI run`,
          'reviewing against the correctness and contract checklist',
          'one major finding: the lease expiry path has no test for the paused case',
          'posting the review with findings and what was verified',
        ],
        tokensIn: 12000,
        tokensOut: 2600,
        costUsd: 0.2,
      };

    case 'deploy':
      return {
        say: [
          'reading the deploy-testing and smoke-testing runs',
          'the smoke failed on testing: reverting the merge commit, keeping its migrations',
          'opening the revert pull request with the failing smoke output',
        ],
        ask: {
          question: 'Could a user have seen the failure?',
          options: ['yes, open an incident', 'no'],
        },
        tokensIn: 4100,
        tokensOut: 1100,
        costUsd: 0.06,
      };

    case 'qa':
      return {
        say: [
          'running the journey, smoke and visual suites against testing',
          // The readiness report carries its marker, so it lands in the thread
          // as a milestone rather than as one more narration line.
          `all journeys green; readiness: promote may go ahead ${renderMarker({ event: 'verified' })}`,
        ],
        tokensIn: 3000,
        tokensOut: 800,
        costUsd: 0.05,
      };

    default:
      return {
        say: [`running ${skill} on ${subject}`],
        tokensIn: 1000,
        tokensOut: 300,
        costUsd: 0.01,
      };
  }
}
