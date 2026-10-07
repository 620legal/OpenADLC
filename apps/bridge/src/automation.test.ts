import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError, ReviewerStandings, type PullCommit } from '@fleetadlc/github';
import { Automation, FORBIDDEN_PUSH, LABEL_READ_BACKOFF_MS, ciKeysChanged, contentChanged, fastPathOf, mergeDecision, requestsTakenAway, reviewSample, standingApprovals, type MergeFacts } from './automation.js';
import type { BridgeConfig } from './config.js';
import { ConflictRounds } from './conflict-round.js';
import { issueNumberFromBranch } from './webhooks.js';
import { declaredPathsFrom, reviewRulesSchema, type StageKey } from '@fleetadlc/shared';

/**
 * The crew as the install's database has it. Only the author check reads it:
 * everything else here is given what it needs directly.
 */
const world = vi.hoisted(() => ({
  crew: [] as Record<string, unknown>[],
  issues: [] as { number: number; stage: string; labels: string[] }[],
  lease: null as { id: string; state: string } | null,
  audited: [] as Record<string, unknown>[],
  /** When the pull request's current round of reviews began, or null when none was recorded. */
  roundAt: null as string | null,
  /** Events recorded, in order, beside the GitHub calls made: what came first. */
  recorded: [] as { type: string; payload: Record<string, string> }[],
  calls: [] as string[],
  /** Platform events, as `listEventsOfTypeWith` finds them. */
  events: [] as { type: string; payload: Record<string, string> }[],
  /** Stage moves as `stageMoves.record` stored them. */
  moves: [] as { from: string | null; to: string; kind: string }[],
}));

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    world.audited.push(entry);
  }),
  lastEventAt: vi.fn(async () => world.roundAt),
  recordEvent: vi.fn(async (event: { type: string; payload: Record<string, string> }) => {
    world.recorded.push(event);
    world.calls.push(`record ${event.type}`);
    return 'event-1';
  }),
  hasEventOfType: vi.fn(async (type: string, _since: Date, fields: Record<string, string>) =>
    world.recorded.some((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value)),
  ),
  listEventsOfTypeWith: vi.fn(async (type: string, fields: Record<string, string>) =>
    world.events
      .filter((event) => event.type === type && Object.entries(fields).every(([key, value]) => event.payload[key] === value))
      .map((event, id) => ({ id, at: '2026-10-01T00:00:00.000Z', payload: event.payload })),
  ),
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  bots: {
    listBots: vi.fn(async () => world.crew),
    getBotByName: vi.fn(async (name: string) => world.crew.find((bot) => bot.name === name) ?? null),
  },
  issues: {
    // Copies, as rows read from the database are: what a move read stays what it read.
    listIssues: vi.fn(async () => world.issues.map((issue) => ({ ...issue }))),
    setIssueLabels: vi.fn(async (_repo: string, number: number, labels: string[]) => {
      const issue = world.issues.find((one) => one.number === number);
      if (issue) issue.labels = labels;
    }),
    setIssueStage: vi.fn(async (_repo: string, number: number, stage: string) => {
      const issue = world.issues.find((one) => one.number === number);
      if (issue) issue.stage = stage;
    }),
  },
  leases: {
    getActiveLease: vi.fn(async () => world.lease),
    latestLease: vi.fn(async () => world.lease),
    setLeaseState: vi.fn(async () => null),
  },
  repos: {
    getRepoByName: vi.fn(async (name: string) => ({ id: 'repo-1', name, fullName: `janedoe/${name}` })),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'app', fullName: 'exampleco/app' }]),
  },
  settings: { allSettings: vi.fn(async () => ({})) },
  stageMoves: {
    record: vi.fn(async (move: { from: string | null; to: string; kind: string }) => {
      world.moves.push(move);
    }),
  },
}));

// By seat, as config/review.yaml names them.
const config = {
  review: reviewRulesSchema.parse({
    reviewers: [
      { seat: 'lead-reviewer', lens: 'lead', lead: true },
      { seat: 'second-reviewer', lens: 'second' },
      { seat: 'security-reviewer', lens: 'security', trigger: { labels: ['touches:security', 'safety', 'deps'], paths: ['.github/workflows/'], samplePercent: 10 } },
      { seat: 'sre', lens: 'workflows', trigger: { paths: ['.github/workflows/', 'docs/runbooks/'] } },
    ],
    maxRounds: 3,
  }),
} as BridgeConfig;

// The automation only needs its rules for these cases; no GitHub client is used.
const automation = new Automation(config, { asBot: async () => null, connected: false } as never);

describe('who reviews a pull request', () => {
  it('always requests the lead and the second lens', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['apps/console/src/page.tsx'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toEqual(['lead-reviewer', 'second-reviewer']);
    expect(decision.humanReviewRequired).toBe(false);
  });

  it('names each reviewer by the handle it goes by now, from the seat the rules name', () => {
    // A connected reviewer is its account's handle. Requested, tasked and
    // waited on as `lead-reviewer` it would be nobody on GitHub.
    const crew = [
      { name: 'tessexampleco', slot: 'lead-reviewer' },
      { name: 'second-reviewer', slot: 'second-reviewer' },
      { name: 'fleetadlc-cipher-janedoe', slot: 'security-reviewer' },
      { name: 'ottoexampleco', slot: 'sre' },
    ];
    const decision = automation.decideReviewers(
      {
        labels: ['touches:security'],
        changedFiles: ['.github/workflows/ci.yml'],
        isRevert: false,
        humanReviewPaths: [],
        sample: 99,
      },
      crew,
    );

    expect(decision.reviewers).toEqual(['tessexampleco', 'second-reviewer', 'fleetadlc-cipher-janedoe', 'ottoexampleco']);
    expect(Object.keys(decision.reasons)).toContain('tessexampleco');
  });

  it('reads a rules file that still names personas as the seats they were', () => {
    const older = new Automation(
      { review: { ...config.review, reviewers: [{ seat: 'sydney', lens: 'lead', lead: true, blocking: false, trigger: 'always' }, { seat: 'grok', lens: 'second', lead: false, blocking: false, trigger: 'always' }] } } as BridgeConfig,
      { asBot: async () => null } as never,
    );
    const decision = older.decideReviewers(
      { labels: [], changedFiles: [], isRevert: true, humanReviewPaths: [], sample: 99 },
      [{ name: 'tessexampleco', slot: 'lead-reviewer' }],
    );
    expect(decision.reviewers).toEqual(['tessexampleco']);
  });

  it('adds the security lens when a label puts it there', () => {
    const decision = automation.decideReviewers({
      labels: ['touches:security'],
      changedFiles: ['packages/github/src/token-broker.ts'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toContain('security-reviewer');
    expect(decision.reasons['security-reviewer']).toMatch(/labels/);
  });

  it('adds the security lens on a sample of ordinary changes', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['apps/console/src/page.tsx'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 1,
    });

    expect(decision.reviewers).toContain('security-reviewer');
    expect(decision.reasons['security-reviewer']).toMatch(/sampled/);
  });

  it('samples a pull request once: asked again, it gives the same answer', () => {
    // It was Math.random(), drawn again whenever the gate was worked out. On
    // fleetadlc-testbed#2 the draw at opening said no security review, the draw at
    // the lead reviewer's approval said yes, and the gate waited on a review
    // nobody had been asked for.
    const first = reviewSample('janedoe/fleetadlc-testbed', 2);
    for (let again = 0; again < 5; again += 1) expect(reviewSample('janedoe/fleetadlc-testbed', 2)).toBe(first);
    expect(reviewSample('JANEDOE/fleetadlc-testbed', 2)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it('still samples about as often as the rules say, across pull requests', () => {
    const sampled = Array.from({ length: 2000 }, (_, index) => reviewSample('janedoe/fleetadlc-testbed', index + 1)).filter(
      (value) => value < 10,
    ).length;
    expect(sampled).toBeGreaterThan(140);
    expect(sampled).toBeLessThan(260);
  });

  it('brings in the deploy bot when workflows change', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['.github/workflows/ci.yml'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toContain('sre');
    expect(decision.reviewers).toContain('security-reviewer');
  });

  it('requires a human when a human-review path is touched', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['config/costs.yaml'],
      isRevert: false,
      humanReviewPaths: ['config/'],
      sample: 99,
    });

    expect(decision.humanReviewRequired).toBe(true);
  });

  it('runs the fast path for a revert of ordinary files', () => {
    const decision = automation.decideReviewers({
      labels: ['revert'],
      changedFiles: ['apps/hostd/src/main.ts'],
      isRevert: true,
      humanReviewPaths: [],
      sample: 1,
    });

    expect(decision.reviewers).toEqual(['lead-reviewer']);
    expect(decision.reasons['lead-reviewer']).toBe('fast path: revert');
  });

  it('keeps the security reviewer a label asked for on the fast path', () => {
    // A seat's own label asks it, revert or not: dropped with the rest, the
    // label's trigger never took effect.
    const decision = automation.decideReviewers({
      labels: ['revert', 'touches:security'],
      changedFiles: ['apps/hostd/src/main.ts'],
      isRevert: true,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toEqual(['lead-reviewer', 'security-reviewer']);
    expect(decision.reasons['security-reviewer']).toBe('labels put this in the security lens');
  });

  it.each(['.github/dependabot.yml', 'Makefile', 'package.json'])('keeps the security reviewer on the fast path for a change to how CI runs (%s)', (file) => {
    // mergeDecision waits on that reviewer's approval of such a change; never
    // asked, the SRE's revert of one waited at the front of the line for a person.
    const decision = automation.decideReviewers({ labels: ['revert'], changedFiles: [file], isRevert: true, humanReviewPaths: [], sample: 99 });

    expect(decision.reviewers).toEqual(['lead-reviewer', 'security-reviewer']);
    expect(decision.reasons['security-reviewer']).toBe(`changes how CI runs (${file})`);
  });

  it('asks the security reviewer of a revert of a Makefile change, without making an advisory seat an approver', () => {
    // The default security seat can only comment. Putting it in `approvers`
    // made review-gate wait for an APPROVED review that gh refuses to post,
    // so a change to how CI runs never merged.
    const decision = automation.decideReviewers({ labels: ['revert'], changedFiles: ['Makefile'], isRevert: true, humanReviewPaths: [], sample: 99 });

    expect(decision.reviewers).toEqual(['lead-reviewer', 'security-reviewer']);
    expect(decision.approvers).toEqual(['lead-reviewer']);
  });

  it('asks the security reviewer of a deps change to CI, without making an advisory seat an approver', () => {
    const decision = automation.decideReviewers({
      labels: ['deps'],
      changedFiles: ['.github/workflows/ci.yml'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toEqual(expect.arrayContaining(['lead-reviewer', 'security-reviewer']));
    expect(decision.approvers).toEqual(['lead-reviewer']);
  });

  // mergeDecision counts a package.json whose `scripts` changed, or a
  // tsconfig whose includes did, as a change to how CI runs; never asked,
  // the security reviewer's approval it waits on never came.
  it('asks the security reviewer of a package’s package.json whose scripts changed', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['packages/x/package.json'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
      ciKeysChanged: ['packages/x/package.json'],
    });

    expect(decision.reviewers).toContain('security-reviewer');
    expect(decision.approvers).not.toContain('security-reviewer');
    expect(decision.reasons['security-reviewer']).toBe('changes how CI runs (packages/x/package.json)');
  });

  it('does not ask the security reviewer of a package.json whose only change is a dependency', () => {
    const decision = automation.decideReviewers({
      labels: [],
      changedFiles: ['packages/x/package.json', 'packages/x/tsconfig.json'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
      ciKeysChanged: [],
    });

    expect(decision.reviewers).not.toContain('security-reviewer');
    expect(decision.approvers).toEqual(['lead-reviewer']);
  });

  it('asks the security reviewer of any package.json or tsconfig when what changed in it was not read', () => {
    for (const file of ['packages/x/package.json', 'apps/web/tsconfig.build.json']) {
      const decision = automation.decideReviewers({ labels: [], changedFiles: [file], isRevert: false, humanReviewPaths: [], sample: 99 });
      expect(decision.reasons['security-reviewer']).toBe(`changes how CI runs (${file})`);
    }
  });

  it('drops the seats the fast path skips: every pull request’s, and the sampled', () => {
    const decision = automation.decideReviewers({ labels: ['deps'], changedFiles: ['pnpm-lock.yaml'], isRevert: false, humanReviewPaths: [], sample: 1 });
    expect(decision.reviewers).toEqual(['lead-reviewer', 'second-reviewer', 'security-reviewer']);

    const fast = automation.decideReviewers({ labels: ['revert'], changedFiles: ['pnpm-lock.yaml'], isRevert: true, humanReviewPaths: [], sample: 1 });
    expect(fast.reviewers).toEqual(['lead-reviewer']);
    expect(fast.approvers).toEqual(['lead-reviewer']);
  });
});

describe('which pull request takes the fast path', () => {
  it('is a revert on the SRE’s revert branch, and never a dependency bump', () => {
    expect(fastPathOf(['deps'], 'agent/builder/42-bump')).toBe(false);
    expect(fastPathOf(['revert'], 'system/revert-1a2b3c4d')).toBe(true);
    // A crew session that put `revert` on its own branch gets the full review.
    expect(fastPathOf(['revert'], 'agent/builder/42-fix')).toBe(false);
    expect(fastPathOf(['revert'], undefined)).toBe(false);
    expect(fastPathOf(['bug'], 'system/revert-1a2b3c4d')).toBe(false);
  });

  it('asks the security reviewer of a dependency change, as its `deps` trigger says', () => {
    // `deps` took the lead-only fast path, so the trigger never fired, and a
    // session could label its own pull request out of the security lens.
    const rules = new Automation(
      {
        review: reviewRulesSchema.parse({
          reviewers: [
            { seat: 'lead-reviewer', lens: 'lead', lead: true },
            { seat: 'second-reviewer', lens: 'second' },
            { seat: 'security-reviewer', lens: 'security', trigger: { labels: ['deps'], paths: ['.github/workflows/', 'packages/github/'], samplePercent: 10 } },
          ],
        }),
      } as BridgeConfig,
      { asBot: async () => null } as never,
    );
    const decision = rules.decideReviewers({
      labels: ['deps'],
      changedFiles: ['packages/github/package.json'],
      isRevert: false,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toEqual(['lead-reviewer', 'second-reviewer', 'security-reviewer']);

    // A revert of the security reviewer's paths loses the fast path too.
    const reverted = rules.decideReviewers({ labels: ['revert'], changedFiles: ['packages/github/src/client.ts'], isRevert: true, humanReviewPaths: [], sample: 99 });
    expect(reverted.reviewers).toContain('security-reviewer');
  });

  it('asks the security reviewer of a revert that changes how CI runs', () => {
    const decision = automation.decideReviewers({
      labels: ['revert'],
      changedFiles: ['Makefile'],
      isRevert: true,
      humanReviewPaths: [],
      sample: 99,
    });

    expect(decision.reviewers).toContain('security-reviewer');
  });
});

describe('the review gate holds until reviews are in', () => {
  it('stays pending while a reviewer asks for changes, though every review is in', () => {
    // Found live: both reviews on one pull request requested changes and the gate read
    // "every requested review has been posted" — green, on a repository with no
    // ruleset to hold the merge.
    const gate = automation.computeReviewGate({
      draft: false,
      requestedReviewers: ['lead-reviewer', 'second-reviewer'],
      postedReviewers: ['lead-reviewer', 'second-reviewer'],
      changesRequestedBy: ['lead-reviewer', 'second-reviewer'],
      humansRequired: [],
      humansApproved: [],
    });

    expect(gate).toEqual({ state: 'pending', description: 'changes requested by lead-reviewer, second-reviewer' });
  });

  it('is pending while the pull request is a draft', () => {
    const gate = automation.computeReviewGate({
      draft: true,
      requestedReviewers: ['lead-reviewer'],
      postedReviewers: ['lead-reviewer'],
      humansRequired: [],
      humansApproved: [],
    });

    expect(gate.state).toBe('pending');
    expect(gate.description).toMatch(/draft/);
  });

  it('names the reviewer it is waiting for', () => {
    const gate = automation.computeReviewGate({
      draft: false,
      requestedReviewers: ['fleetadlc-sydney', 'fleetadlc-grok'],
      postedReviewers: ['fleetadlc-sydney'],
      humansRequired: [],
      humansApproved: [],
    });

    expect(gate.state).toBe('pending');
    expect(gate.description).toContain('fleetadlc-grok');
  });

  it('stays pending for a human review even when every bot has posted', () => {
    const gate = automation.computeReviewGate({
      draft: false,
      requestedReviewers: ['fleetadlc-sydney'],
      postedReviewers: ['fleetadlc-sydney'],
      humansRequired: ['janedoe'],
      humansApproved: [],
    });

    expect(gate.state).toBe('pending');
    // The description names the person now. It used to say "a human reviewer",
    // which read the same on every pull request and is what made one person's
    // approval look like it answered another's requirement.
    expect(gate.description).toBe('waiting on @janedoe');
  });

  it('goes green once the human has approved too', () => {
    const gate = automation.computeReviewGate({
      draft: false,
      requestedReviewers: ['fleetadlc-sydney'],
      postedReviewers: ['fleetadlc-sydney'],
      humansRequired: ['janedoe'],
      humansApproved: ['janedoe'],
    });

    expect(gate.state).toBe('success');
  });
});

describe('reading the issue and the branch', () => {
  it('takes the declared paths out of the task form', () => {
    const body = [
      '### Outcome',
      'leases expire',
      '',
      '### Expected paths',
      '- apps/dispatcher/**',
      '- packages/db/migrations/**',
      '',
      '### Verification',
      'run the suite',
    ].join('\n');

    expect(declaredPathsFrom(body)).toEqual(['apps/dispatcher/**', 'packages/db/migrations/**']);
  });

  it('treats an unanswered paths field as declaring nothing', () => {
    expect(declaredPathsFrom('### Expected paths\n\n_No response_\n')).toEqual([]);
  });

  it('finds the issue a work branch belongs to', () => {
    expect(issueNumberFromBranch('agent/atlas/43-device-flow')).toBe(43);
    expect(issueNumberFromBranch('system/revert-abc1234')).toBeNull();
    expect(issueNumberFromBranch('main')).toBeNull();
  });
});

describe('a push only invalidates an approval when the work changed', () => {
  const approval = (id: number, user: string, state: string, submittedAt = '2026-09-18T00:00:00Z') => ({
    id,
    user,
    state,
    submittedAt,
  });

  it('keeps approvals when the diff against the base is identical', () => {
    // The merge line merges `main` into a branch before landing it. That moves
    // the head and changes nothing about the work, and is the exact case
    // GitHub's own "dismiss stale reviews on push" gets wrong.
    expect(contentChanged('abc123', 'abc123')).toBe(false);
  });

  it('dismisses when the diff moved', () => {
    expect(contentChanged('abc123', 'def456')).toBe(true);
  });

  it('treats a comparison it could not make as changed', () => {
    // Keeping an approval requires knowing the work is the same. Not knowing is
    // not the same as knowing it is, and the safe direction is another review.
    expect(contentChanged(null, 'abc123')).toBe(true);
    expect(contentChanged('abc123', null)).toBe(true);
    expect(contentChanged(null, null)).toBe(true);
  });

  it('takes only the standing approvals', () => {
    const standing = standingApprovals([
      approval(1, 'fleetadlc-sydney', 'APPROVED'),
      approval(2, 'fleetadlc-grok', 'CHANGES_REQUESTED'),
      approval(3, 'fleetadlc-cipher', 'APPROVED'),
    ]);

    expect(standing.map((review) => review.user).sort()).toEqual(['fleetadlc-cipher', 'fleetadlc-sydney']);
  });

  it('uses a reviewer’s latest position, not their first', () => {
    // Approved, then asked for changes: there is no approval to dismiss.
    expect(
      standingApprovals([
        approval(1, 'fleetadlc-sydney', 'APPROVED', '2026-09-18T00:00:00Z'),
        approval(2, 'fleetadlc-sydney', 'CHANGES_REQUESTED', '2026-09-18T01:00:00Z'),
      ]),
    ).toEqual([]);

    // And the other way round, which is the one that must be dismissed.
    expect(
      standingApprovals([
        approval(3, 'fleetadlc-grok', 'CHANGES_REQUESTED', '2026-09-18T00:00:00Z'),
        approval(4, 'fleetadlc-grok', 'APPROVED', '2026-09-18T01:00:00Z'),
      ]),
    ).toEqual([{ id: 4, user: 'fleetadlc-grok' }]);
  });

  it('does not let a comment displace a position', () => {
    // A reviewer who approves and then comments has still approved.
    expect(
      standingApprovals([
        approval(1, 'fleetadlc-sydney', 'APPROVED', '2026-09-18T00:00:00Z'),
        approval(2, 'fleetadlc-sydney', 'COMMENTED', '2026-09-18T01:00:00Z'),
      ]),
    ).toEqual([{ id: 1, user: 'fleetadlc-sydney' }]);
  });

  it('has nothing to dismiss on a pull request nobody has reviewed', () => {
    expect(standingApprovals([])).toEqual([]);
  });
});

describe('review:human waits for the person it names', () => {
  const automation = new Automation(
    { review: { lead: 'lead-reviewer', second: 'second-reviewer', maxRounds: 3 }, humans: ['janedoe', 'other-human'] } as never,
    {} as never,
  );

  const gate = (input: Partial<Parameters<Automation['computeReviewGate']>[0]>) =>
    automation.computeReviewGate({
      draft: false,
      requestedReviewers: [],
      postedReviewers: [],
      humansRequired: [],
      humansApproved: [],
      ...input,
    });

  it('names who it is waiting for, rather than "a human reviewer"', () => {
    // The old description made every pull request look alike, which is what let
    // one person's approval appear to answer another's requirement.
    expect(gate({ humansRequired: ['janedoe'] })).toEqual({
      state: 'pending',
      description: 'waiting on @janedoe',
    });
  });

  it('is not satisfied by a different human approving', () => {
    expect(gate({ humansRequired: ['janedoe'], humansApproved: ['other-human'] }).state).toBe('pending');
  });

  it('clears when the named person approves', () => {
    expect(gate({ humansRequired: ['janedoe'], humansApproved: ['janedoe'] }).state).toBe('success');
  });

  it('waits for all of them when a path names more than one', () => {
    const waiting = gate({ humansRequired: ['janedoe', 'security-lead'], humansApproved: ['janedoe'] });
    expect(waiting.state).toBe('pending');
    expect(waiting.description).toBe('waiting on @security-lead');
  });

  it('holds when the rules could not be read, rather than releasing', () => {
    // An unreadable AGENTS.md must not read as "nothing needs a human".
    const held = gate({ humanRulesUnknown: true });
    expect(held.state).toBe('pending');
    expect(held.description).toContain('AGENTS.md');
  });

  it('releases when the repository genuinely requires nobody', () => {
    expect(gate({ humansRequired: [] }).state).toBe('success');
  });
});

describe('an approval counts for the head it approved', () => {
  const automation = new Automation({ review: { lead: 'lead-reviewer' }, humans: [] } as never, {} as never);
  const review = (user: string, state: string, commitId: string | null) => ({ user, state, commitId });

  it('counts an approval of the current head', () => {
    expect(automation.approvedTheHead(['janedoe'], [review('janedoe', 'APPROVED', 'head1')], 'head1')).toEqual([
      'janedoe',
    ]);
  });

  it('does not count an approval of an earlier commit with a different diff', () => {
    // `old` is not among the heads whose diff is the head's.
    expect(automation.approvedTheHead(['janedoe'], [review('janedoe', 'APPROVED', 'old')], 'head1', new Set(['merged-main']))).toEqual([]);
  });

  it('counts an approval of an earlier head whose diff against the base is the head’s', () => {
    // The merge line brought it up to date with main: the head moved, the work did not.
    expect(automation.approvedTheHead(['janedoe'], [review('janedoe', 'APPROVED', 'before-update')], 'head1', new Set(['before-update']))).toEqual([
      'janedoe',
    ]);
  });

  it('matches the login whatever its case, as GitHub does', () => {
    // AGENTS.md writes @janedoe; GitHub reports the account as JaneDoe.
    expect(automation.approvedTheHead(['janedoe'], [review('JaneDoe', 'APPROVED', 'head1')], 'head1')).toEqual(['janedoe']);
    expect(
      automation.approvedTheHead(['janedoe'], [review('JaneDoe', 'APPROVED', 'head1'), review('janedoe', 'CHANGES_REQUESTED', 'head1')], 'head1'),
    ).toEqual([]);
  });

  it('does not count a review with no commit recorded', () => {
    // Treating unknown as "the current head" would release the gate on an
    // approval that may predate the work.
    expect(automation.approvedTheHead(['janedoe'], [review('janedoe', 'APPROVED', null)], 'head1')).toEqual([]);
  });

  it('uses the reviewer’s latest position', () => {
    expect(
      automation.approvedTheHead(
        ['janedoe'],
        [review('janedoe', 'APPROVED', 'head1'), review('janedoe', 'CHANGES_REQUESTED', 'head1')],
        'head1',
      ),
    ).toEqual([]);
  });

  it('does not count an approval from a login GitHub says cannot review here', () => {
    // A login freed by a rename, registered by someone else, reviewing a
    // public repository: the approval is the new account's, not the person's.
    const cannot = new Map([['janedoe', 'janedoe is not a collaborator on exampleco/app']]);
    expect(automation.approvedTheHead(['JaneDoe'], [review('JaneDoe', 'APPROVED', 'head1')], 'head1', new Set(), cannot)).toEqual([]);
    expect(automation.approvedTheHead(['janedoe'], [review('janedoe', 'APPROVED', 'head1')], 'head1', new Set(), new Map())).toEqual(['janedoe']);
  });

  it('ignores a comment left after approving', () => {
    expect(
      automation.approvedTheHead(
        ['janedoe'],
        [review('janedoe', 'APPROVED', 'head1'), review('janedoe', 'COMMENTED', 'head1')],
        'head1',
      ),
    ).toEqual(['janedoe']);
  });
});

describe('review-gate and a named person’s approval of an earlier head', () => {
  const lead = { id: 1, user: 'exampleco-lead', state: 'APPROVED', body: 'Approved.\n\n<!-- fleetadlc-seat:lead-reviewer -->', submittedAt: null, commitId: 'head' };

  /** The gate on a change to config/, which AGENTS.md says @janedoe approves. */
  async function gateWith(person: Record<string, unknown>, fingerprints: Record<string, string>, carried: string[] = []) {
    world.crew = [{ id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-lead' }];
    const github = {
      listPullFiles: vi.fn(async () => ['config/bots.yaml']),
      listEveryPullFile: vi.fn(async () => ({ files: ['config/bots.yaml'], complete: true, renamedFrom: [] })),
      listReviews: vi.fn(async () => [lead, person]),
      readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @janedoe\n'),
      diffFingerprint: vi.fn(async (_repo: string, _base: string, sha: string) => fingerprints[sha] ?? null),
      permissionOf: vi.fn(async () => 'write'),
    };
    const only = { ...config, review: reviewRulesSchema.parse({ reviewers: [{ seat: 'lead-reviewer', lens: 'lead', lead: true }] }) } as BridgeConfig;
    const reading = new Automation(only, { asBot: vi.fn(async () => github) } as never);
    reading.useCarriedHeads(async () => new Set(carried));
    return (await reading.reviewStanding('exampleco/app', { number: 70, draft: false, labels: [], head: { sha: 'head' }, baseRef: 'main' })).gate;
  }
  const janedoe = (commitId: string | null) => ({ id: 2, user: 'janedoe', state: 'APPROVED', body: '', submittedAt: null, commitId });

  it('counts it when the merge line only brought the branch up to date', async () => {
    const gate = await gateWith(janedoe('before-update'), { head: 'the diff', 'before-update': 'the diff' });
    expect(gate.description).not.toContain('@janedoe');
    expect(gate.state).toBe('success');
  });

  it('does not count it when the diff is another one', async () => {
    const gate = await gateWith(janedoe('before-a-fix'), { head: 'the diff', 'before-a-fix': 'another diff' });
    expect(gate).toMatchObject({ state: 'pending', description: 'waiting on @janedoe' });
  });

  it('does not count a head a lead-only conflict resolution carried, which the person never saw', async () => {
    const gate = await gateWith(janedoe('before-resolution'), { head: 'the diff', 'before-resolution': 'the diff before it' }, ['before-resolution']);
    expect(gate).toMatchObject({ state: 'pending', description: 'waiting on @janedoe' });
  });

  it('counts the head itself, whatever the case of the login GitHub reports', async () => {
    const gate = await gateWith({ ...janedoe('head'), user: 'JaneDoe' }, { head: 'the diff' });
    expect(gate.state).toBe('success');
  });

  it('does not count a review with no commit recorded', async () => {
    const gate = await gateWith(janedoe(null), { head: 'the diff' });
    expect(gate).toMatchObject({ state: 'pending', description: 'waiting on @janedoe' });
  });
});

/**
 * Reviewers, intake and the automation account hold write access they must
 * never use to land code. Which accounts those are is the install's own
 * knowledge — the configuration names none — so the gate reads them from the
 * crew, and who wrote the pull request from GitHub.
 */
describe('the review gate refuses a commit by an account that never authors', () => {
  const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
  const REVIEWS_IN = { state: 'success', description: 'every requested review has been posted' } as const;

  const builderCommit: PullCommit = {
    sha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    authorLogin: 'fleetadlc-atlas-janedoe',
    authorEmail: 'fleetadlc-atlas-janedoe@users.noreply.github.com',
    authorName: 'fleetadlc-atlas-janedoe',
  };

  beforeEach(() => {
    world.events = [];
    world.crew = [
      { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' },
      { name: 'fleetadlc-sydney-janedoe', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'FleetADLC-Sydney-Janedoe' },
      // A seat nobody has connected: no account, so nothing it could have written.
      { name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: null },
      { name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', githubLogin: 'janedoe-fleetadlc-flow' },
    ];
  });

  /** The automation account's GitHub, listing these commits or failing to. */
  function github(commits: PullCommit[] | Error) {
    const published: { sha: string; state: string; context: string; description: string }[] = [];
    const client = {
      // No `needs-human` on it, so the gate is the reviews' and the authors'.
      getPullRequest: vi.fn(async () => ({ labels: [] as string[] })),
      listPullCommits: vi.fn(async () => {
        if (commits instanceof Error) throw commits;
        return commits;
      }),
      setCommitStatus: vi.fn(
        async (_repo: string, sha: string, status: { state: string; context: string; description: string }) => {
          published.push({ sha, ...status });
        },
      ),
    };
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => client } as never);
    return { automation, client, published };
  }

  const setGate = (
    automation: Automation,
    gate: { state: 'pending' | 'success'; description: string } = REVIEWS_IN,
  ) => automation.setReviewGate({ repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 12, sha: HEAD, ...gate });

  it('fails on a commit GitHub matched to a reviewer, though every review is in', async () => {
    const { automation, client, published } = github([
      builderCommit,
      {
        sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        authorLogin: 'fleetadlc-sydney-janedoe',
        authorEmail: 'sydney@example.com',
        authorName: 'Sydney',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gate = await setGate(automation);
    warn.mockRestore();

    const refused = {
      state: 'failure',
      description: 'deadbee was authored by FleetADLC-Sydney-Janedoe — a reviewer must never author what it reviews',
    };
    expect(gate).toEqual(refused);
    expect(published).toEqual([{ sha: HEAD, context: 'review-gate', ...refused }]);
    expect(client.listPullCommits).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 12);
  });

  it('fails on a commit only its no-reply address ties to the automation account', async () => {
    // GitHub leaves `author` empty when it cannot tie the address to an
    // account, and then the address is what says whose commit it is.
    const { automation } = github([
      builderCommit,
      {
        sha: 'f10f10f10f10f10f10f10f10f10f10f10f10f10f',
        authorLogin: null,
        authorEmail: 'janedoe-fleetadlc-flow@users.noreply.github.com',
        authorName: 'Flow',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gate = await setGate(automation, { state: 'pending', description: 'waiting on fleetadlc-sydney-janedoe' });
    warn.mockRestore();

    // Refused outright, not left waiting on a review that cannot fix it.
    expect(gate).toEqual({
      state: 'failure',
      description:
        'f10f10f was authored by janedoe-fleetadlc-flow — the automation account sets labels and statuses; it never authors commits',
    });
  });

  it('leaves the gate as the reviews made it when only builders and people wrote the commits', async () => {
    const { automation, client, published } = github([
      builderCommit,
      {
        sha: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
        authorLogin: 'janedoe',
        authorEmail: 'janedoe@example.test',
        authorName: 'janedoe',
      },
    ]);

    expect(await setGate(automation)).toEqual(REVIEWS_IN);
    expect(await setGate(automation, { state: 'pending', description: 'waiting on fleetadlc-sydney-janedoe' })).toEqual({
      state: 'pending',
      description: 'waiting on fleetadlc-sydney-janedoe',
    });
    expect(published.map((status) => status.state)).toEqual(['success', 'pending']);
    // Looked, and found nobody who may not author.
    expect(client.listPullCommits).toHaveBeenCalledTimes(2);
  });

  it('fails a head a reviewer pushed, though every commit names the builder, each time the gate is set', async () => {
    // A reviewer session can commit as anyone; who pushed is GitHub's to say,
    // and the synchronize handler recorded it.
    world.events = [
      {
        type: FORBIDDEN_PUSH,
        payload: { repo: 'janedoe/fleetadlc-testbed', pr: '12', sha: HEAD, login: 'FleetADLC-Sydney-Janedoe', why: 'a reviewer must never author what it reviews' },
      },
    ];
    const { automation, published } = github([builderCommit]);

    const refused = {
      state: 'failure',
      description: 'FleetADLC-Sydney-Janedoe pushed c0ffee0, which changed the diff — a reviewer must never author what it reviews',
    };
    expect(await setGate(automation)).toEqual(refused);
    expect(await setGate(automation, { state: 'pending', description: 'waiting on fleetadlc-sydney-janedoe' })).toEqual(refused);
    expect(published.map((status) => status.state)).toEqual(['failure', 'failure']);

    // Another head, or another pull request, is not touched by it.
    expect(await automation.setReviewGate({ repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 12, sha: 'b'.repeat(40), ...REVIEWS_IN })).toEqual(REVIEWS_IN);
    expect(await automation.setReviewGate({ repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 13, sha: HEAD, ...REVIEWS_IN })).toEqual(REVIEWS_IN);
  });

  it.each([
    // Recorded before the push was stored in lower case, and asked for with the name as GitHub sends it.
    ['GitHub’s casing', 'GitHub’s casing', 'JaneDoe/FleetADLC-Testbed', 'JaneDoe/FleetADLC-Testbed'],
    // Recorded in lower case, as the synchronize handler stores it now, and asked for in GitHub's casing.
    ['lower case', 'GitHub’s casing', 'janedoe/fleetadlc-testbed', 'JaneDoe/FleetADLC-Testbed'],
    // Recorded in GitHub's casing before then, and asked for by a row stored in lower case.
    ['GitHub’s casing', 'lower case', 'JaneDoe/FleetADLC-Testbed', 'janedoe/fleetadlc-testbed'],
  ])('finds that push when it was recorded in %s and the gate names the repository in %s', async (_recorded, _asked, recorded, asked) => {
    world.events = [
      {
        type: FORBIDDEN_PUSH,
        payload: { repo: recorded, pr: '12', sha: HEAD, login: 'FleetADLC-Sydney-Janedoe', why: 'a reviewer must never author what it reviews' },
      },
    ];
    const { automation } = github([builderCommit]);

    expect(await automation.setReviewGate({ repoFullName: asked, prNumber: 12, sha: HEAD, ...REVIEWS_IN })).toEqual({
      state: 'failure',
      description: 'FleetADLC-Sydney-Janedoe pushed c0ffee0, which changed the diff — a reviewer must never author what it reviews',
    });
    // The same number and head in another repository is not touched by it.
    expect(await automation.setReviewGate({ repoFullName: 'janedoe/fleetadlc-other', prNumber: 12, sha: HEAD, ...REVIEWS_IN })).toEqual(REVIEWS_IN);
  });

  it('holds the gate, and says so, when the commits cannot be listed', async () => {
    const { automation, published } = github(
      new Error('/repos/janedoe/fleetadlc-testbed/pulls/12/commits → 502: bad gateway'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gate = await setGate(automation);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();

    // Not knowing who wrote the change is not knowing that nobody forbidden did.
    expect(gate).toEqual({
      state: 'pending',
      description: 'commit authors could not be checked; every requested review has been posted',
    });
    expect(published[0]?.state).toBe('pending');
    expect(lines.some((line) => line.includes('janedoe/fleetadlc-testbed#12') && line.includes('502: bad gateway'))).toBe(
      true,
    );
  });

  it('keeps what it says within the 140 characters a status holds, naming the commit first', async () => {
    // GitHub's longest login is 39 characters, and the automation account's is
    // the longest reason.
    const login = 'janedoe-fleetadlc-flow-with-a-long-hand';
    expect(login).toHaveLength(39);
    world.crew = [{ name: login, slot: 'automation', role: 'automation', githubLogin: login }];
    const byFlow = (sha: string): PullCommit => ({ sha, authorLogin: login, authorEmail: '', authorName: login });
    const { automation } = github([byFlow('abcdef0123456789'), byFlow('bcdef01234567890')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const refused = await setGate(automation);
    const held = await github(new Error('timeout')).automation.setReviewGate({
      repoFullName: 'janedoe/fleetadlc-testbed',
      prNumber: 12,
      sha: HEAD,
      state: 'pending',
      description: `waiting on ${'a-reviewer-with-a-long-handle, '.repeat(4)}and one more`,
    });
    warn.mockRestore();

    // The second commit's count does not fit, so the first is named whole.
    expect(refused?.description).toBe(
      `abcdef0 was authored by ${login} — the automation account sets labels and statuses; it never authors commits`,
    );
    expect(refused?.description.length).toBeLessThanOrEqual(140);
    expect(held?.state).toBe('pending');
    expect(held?.description).toHaveLength(140);
    expect(held?.description.startsWith('commit authors could not be checked; waiting on')).toBe(true);
  });

  it('asks GitHub nothing when the crew has no account that may not author', async () => {
    // A fresh install reserves nothing, and a seat with no account has written
    // nothing, so there is nobody to look for.
    world.crew = [
      { name: 'builder', slot: 'builder', role: 'implement', githubLogin: null },
      { name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null },
    ];
    const { automation, client } = github([builderCommit]);

    expect(await setGate(automation)).toEqual(REVIEWS_IN);
    expect(client.listPullCommits).not.toHaveBeenCalled();
  });
});

describe('reaching Done', () => {
  // fleetadlc-testbed#1's lease was still holding README.md after its pull request
  // had merged and shipped: nothing released a lease at the end of the work.
  it('releases the lease that held the issue, whatever moved it there', async () => {
    const { leases } = await import('@fleetadlc/db');
    world.issues = [{ number: 1, stage: 'review', labels: ['adlc:review'] }];
    world.lease = { id: 'lease-1', state: 'in_task' };
    vi.mocked(leases.setLeaseState).mockClear();

    const moved = await automation.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'done', actor: 'bridge' });

    expect(moved).toEqual({ moved: true });
    expect(vi.mocked(leases.setLeaseState)).toHaveBeenCalledWith('lease-1', 'released');
  });

  it('leaves the lease alone on the way there', async () => {
    const { leases } = await import('@fleetadlc/db');
    world.issues = [{ number: 1, stage: 'build', labels: ['adlc:build'] }];
    world.lease = { id: 'lease-1', state: 'in_task' };
    vi.mocked(leases.setLeaseState).mockClear();

    await automation.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'review', actor: 'bridge' });

    expect(vi.mocked(leases.setLeaseState)).not.toHaveBeenCalled();
  });
});

describe('the stage label a move writes', () => {
  it('writes GitHub’s own labels back in one call, with only the new stage', async () => {
    // Built from the stored row, the write took off a label a person had just
    // added (a fleetadlc:paused here; it was a fleetadlc:ignore, which is now
    // never moved at all), when a task finished before that delivery was
    // processed. Written as a removal and an addition, GitHub sent a delivery in
    // between with no stage label, which the webhook read as intake.
    world.issues = [{ number: 1, stage: 'spec', labels: ['adlc:spec', 'priority:p2'] }];
    const client = {
      getIssue: vi.fn(async () => ({ number: 1, labels: ['adlc:spec', 'adlc:intake', 'priority:p2', 'fleetadlc:paused'] })),
      setLabels: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
      removeLabel: vi.fn(async () => undefined),
    };
    const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);

    expect(await moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'build', actor: 'spec task' })).toEqual({ moved: true });

    expect(client.setLabels).toHaveBeenCalledTimes(1);
    expect(client.setLabels).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1, ['priority:p2', 'fleetadlc:paused', 'adlc:build']);
    expect(client.removeLabel).not.toHaveBeenCalled();
    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it('keeps a label added between its read and its write', async () => {
    // The write replaces the whole set. Built from the first read alone, it
    // dropped a fleetadlc:ignore added in a second call after the issue was
    // opened, while the stage and lease were being written.
    world.issues = [{ number: 1, stage: 'intake', labels: [] }];
    const reads = [['adlc:intake'], ['adlc:intake', 'fleetadlc:ignore']];
    const client = {
      getIssue: vi.fn(async () => ({ number: 1, labels: reads.shift() ?? [] })),
      setLabels: vi.fn(async () => undefined),
    };
    const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);

    expect(await moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'build', actor: 'intake task' })).toEqual({ moved: true });

    expect(client.setLabels).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1, ['fleetadlc:ignore', 'adlc:build']);
  });

  describe('of a closed issue', () => {
    function closedOnGitHub(stage = 'intake') {
      world.issues = [{ number: 1, stage, labels: [`adlc:${stage}`] }];
      const client = {
        getIssue: vi.fn(async () => ({ number: 1, labels: [`adlc:${stage}`], state: 'closed' as const })),
        setLabels: vi.fn(async () => undefined),
      };
      return { client, moving: new Automation(config, { asBot: vi.fn(async () => client) } as never) };
    }

    it('is refused with a reason, and writes nothing: intake resumed on a closed issue moved it to Build', async () => {
      const { client, moving } = closedOnGitHub();

      const moved = await moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'build', actor: 'intake task' });

      expect(moved).toEqual({ moved: false, reason: expect.stringContaining('fleetadlc-testbed#1 to build, but it is closed') });
      expect(client.setLabels).not.toHaveBeenCalled();
      expect(world.issues[0]?.stage).toBe('intake');
    });

    it('still records a merge reaching Done, since the merge is what closed it', async () => {
      const { client, moving } = closedOnGitHub('review');

      expect(await moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'done', actor: 'bridge' })).toEqual({ moved: true });
      expect(client.setLabels).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1, ['adlc:done']);
    });
  });

  describe('that records how the work ended', () => {
    // A person merged while the card was in Build: the forward rules refused
    // the move to Merged, the reconciler forgot the closed issue, and every
    // issue that depended on it waited for good.
    function storedIn(stage: string) {
      world.issues = [{ number: 1, stage, labels: [`adlc:${stage}`] }];
      world.moves = [];
      const client = {
        getIssue: vi.fn(async () => ({ number: 1, labels: [`adlc:${stage}`], state: 'closed' as const })),
        setLabels: vi.fn(async () => undefined),
      };
      const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);
      return (to: 'merged' | 'done' | 'review', recordsOutcome?: boolean) => moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to, actor: 'bridge', recordsOutcome });
    }

    it('goes to Merged or Done from Build, and is stored as a forward move', async () => {
      expect(await storedIn('build')('merged', true)).toEqual({ moved: true });
      expect(world.issues[0]?.stage).toBe('merged');
      expect(world.moves).toEqual([expect.objectContaining({ from: 'build', to: 'merged', kind: 'forward' })]);

      expect(await storedIn('build')('done', true)).toEqual({ moved: true });
      expect(world.issues[0]?.stage).toBe('done');
      expect(await storedIn('spec')('merged', true)).toEqual({ moved: true });
    });

    it('is still refused from Build without the option', async () => {
      expect(await storedIn('build')('done')).toMatchObject({ moved: false });
      expect(await storedIn('build')('merged')).toMatchObject({ moved: false });
      expect(world.issues[0]?.stage).toBe('build');
    });

    it('never moves Done back to Merged, nor anywhere but Merged or Done', async () => {
      expect(await storedIn('done')('merged', true)).toMatchObject({ moved: false });
      expect(world.issues[0]?.stage).toBe('done');
      expect(await storedIn('merged')('done', true)).toEqual({ moved: true });
      expect(await storedIn('intake')('review', true)).toMatchObject({ moved: false });
    });
  });

  describe('for a move that begins crew work', () => {
    // The stored row can be behind GitHub: a label added in a second call
    // after the issue was opened, or while intake was working, may not have
    // been delivered yet.
    function labelledOnGitHub(live: string[]) {
      world.issues = [{ number: 1, stage: 'intake', labels: [] }];
      const client = {
        getIssue: vi.fn(async () => ({ number: 1, labels: live })),
        setLabels: vi.fn(async () => undefined),
      };
      const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);
      return {
        client,
        move: (to: StageKey = 'intake', options: { recordsOutcome?: boolean; direction?: 'person' } = {}) =>
          moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to, actor: 'bridge', ...options }),
      };
    }

    it('is refused when GitHub has the issue labelled fleetadlc:ignore, and the label is stored', async () => {
      const { client, move } = labelledOnGitHub(['fleetadlc:ignore']);

      expect(await move()).toMatchObject({ moved: false, ignored: true });

      expect(client.setLabels).not.toHaveBeenCalled();
      expect(world.issues[0]).toMatchObject({ stage: 'intake', labels: ['fleetadlc:ignore'] });
    });

    it('goes ahead on an issue that is not labelled', async () => {
      const { client, move } = labelledOnGitHub(['priority:p2']);

      expect(await move()).toEqual({ moved: true });
      expect(client.setLabels).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1, ['priority:p2', 'adlc:intake']);
    });

    // An ignored issue is off the board, so nothing moves it there: a merge
    // moved its own issue to Done, and a person's move from the board did too.
    it.each([
      ['a merge reaching Done', 'done', { recordsOutcome: true }],
      ['a person moving the card', 'review', { direction: 'person' }],
    ] as const)('refuses %s as well', async (_what, to, options) => {
      const { client, move } = labelledOnGitHub(['adlc:build', 'fleetadlc:ignore']);
      world.issues = [{ number: 1, stage: 'build', labels: ['adlc:build'] }];
      world.moves = [];

      expect(await move(to, options)).toMatchObject({ moved: false, ignored: true });
      expect(client.setLabels).not.toHaveBeenCalled();
      expect(world.issues[0]).toMatchObject({ stage: 'build', labels: ['adlc:build', 'fleetadlc:ignore'] });
      expect(world.moves).toEqual([]);
    });
  });

  describe('when GitHub’s labels cannot be read', () => {
    // It fell back on the stored labels, which took off a label the
    // stored row had not seen yet: the loss the read is there to prevent.
    // Failing at once, though, lost what the caller does after the move to one
    // GitHub blip, so the read is tried three times first.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function failing(times: number) {
      world.issues = [{ number: 1, stage: 'spec', labels: ['adlc:spec', 'priority:p2'] }];
      let reads = 0;
      const client = {
        getIssue: vi.fn(async () => {
          reads += 1;
          if (reads <= times) throw new Error('GitHub answered 502');
          return { number: 1, labels: ['adlc:spec', 'priority:p2', 'fleetadlc:paused'] };
        }),
        setLabels: vi.fn(async () => undefined),
      };
      const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);
      return { client, move: () => moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'build', actor: 'spec task' }) };
    }

    it('moves the stage when a read after a failed one answers', async () => {
      const { client, move } = failing(1);

      const moved = move();
      await vi.advanceTimersByTimeAsync(LABEL_READ_BACKOFF_MS[0]);

      expect(await moved).toEqual({ moved: true });
      // Two reads before the stage moves, and one more just before the write.
      expect(client.getIssue).toHaveBeenCalledTimes(3);
      expect(client.setLabels).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1, ['priority:p2', 'fleetadlc:paused', 'adlc:build']);
      expect(world.issues[0]?.stage).toBe('build');
    });

    it('fails after three reads, and changes nothing', async () => {
      const { client, move } = failing(3);

      const moved = move();
      const failed = expect(moved).rejects.toThrow(
        'fleetadlc-testbed#1 was not moved to build: its labels could not be read from GitHub (GitHub answered 502)',
      );
      await vi.advanceTimersByTimeAsync(LABEL_READ_BACKOFF_MS[0] + LABEL_READ_BACKOFF_MS[1]);
      await failed;

      expect(client.getIssue).toHaveBeenCalledTimes(3);
      expect(client.setLabels).not.toHaveBeenCalled();
      expect(world.issues[0]?.stage).toBe('spec');
    });
  });
});

describe('a stage move whose label GitHub will not take', () => {
  // The stored stage moved and the label did not: the reconciler and the
  // webhook read the older label as a person moving the card back, and said
  // so on the issue, stopped later work and let the lease go.
  beforeEach(async () => {
    vi.useFakeTimers();
    const { issues, leases, stageMoves } = await import('@fleetadlc/db');
    vi.mocked(issues.setIssueStage).mockClear();
    vi.mocked(leases.setLeaseState).mockClear();
    vi.mocked(stageMoves.record).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    world.lease = null;
  });

  function refusing(times: number) {
    world.issues = [{ number: 1, stage: 'review', labels: ['adlc:review'] }];
    world.lease = { id: 'lease-1', state: 'in_task' };
    let writes = 0;
    const client = {
      getIssue: vi.fn(async () => ({ number: 1, labels: ['adlc:review'] })),
      setLabels: vi.fn(async () => {
        writes += 1;
        if (writes <= times) throw new Error('GitHub answered 502');
      }),
    };
    const moving = new Automation(config, { asBot: vi.fn(async () => client) } as never);
    return { client, move: () => moving.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'done', actor: 'bridge' }) };
  }

  it('puts the stored stage back, records no move, keeps the lease, and fails', async () => {
    const { issues, leases, stageMoves } = await import('@fleetadlc/db');
    const { client, move } = refusing(3);

    const moved = move();
    const failed = expect(moved).rejects.toThrow('fleetadlc-testbed#1 was not moved to done: its stage label could not be written on GitHub (GitHub answered 502)');
    await vi.advanceTimersByTimeAsync(LABEL_READ_BACKOFF_MS[0] + LABEL_READ_BACKOFF_MS[1]);
    await failed;

    expect(client.setLabels).toHaveBeenCalledTimes(3);
    expect(vi.mocked(issues.setIssueStage).mock.calls).toEqual([
      ['repo-1', 1, 'done'],
      ['repo-1', 1, 'review'],
    ]);
    expect(world.issues[0]?.stage).toBe('review');
    expect(stageMoves.record).not.toHaveBeenCalled();
    expect(leases.setLeaseState).not.toHaveBeenCalled();
  });

  it('moves once when a write after a failed one is taken, with one record of it', async () => {
    const { issues, leases, stageMoves } = await import('@fleetadlc/db');
    const { client, move } = refusing(1);

    const moved = move();
    await vi.advanceTimersByTimeAsync(LABEL_READ_BACKOFF_MS[0]);

    expect(await moved).toEqual({ moved: true });
    expect(client.setLabels).toHaveBeenCalledTimes(2);
    expect(stageMoves.record).toHaveBeenCalledTimes(1);
    expect(stageMoves.record).toHaveBeenCalledWith(expect.objectContaining({ from: 'review', to: 'done' }));
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'released');
    // The stored stage first, so the bridge's own `labeled` delivery finds the board agreeing.
    expect(vi.mocked(issues.setIssueStage).mock.invocationCallOrder[0]!).toBeLessThan(client.setLabels.mock.invocationCallOrder[0]!);
  });

  it('still records the move and lets the lease go at Done when there is no GitHub client', async () => {
    const { stageMoves, leases } = await import('@fleetadlc/db');
    world.issues = [{ number: 1, stage: 'review', labels: ['adlc:review'] }];
    world.lease = { id: 'lease-1', state: 'in_task' };

    expect(await automation.moveStage({ repoName: 'fleetadlc-testbed', issueNumber: 1, to: 'done', actor: 'bridge' })).toEqual({ moved: true });

    expect(stageMoves.record).toHaveBeenCalledTimes(1);
    expect(leases.setLeaseState).toHaveBeenCalledWith('lease-1', 'released');
  });
});

describe('the gate as it is read from GitHub', () => {
  // The second place the gate is worked out: the scheduler's sweep. With the
  // requests for changes left out of it, a gate with two of them read green.
  it('holds while a reviewer’s latest verdict asks for changes, by seat on a shared account', async () => {
    world.crew = [
      { id: 'b-flow', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'exampleco-crew' },
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-review' },
      { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'exampleco-review' },
    ];
    const seat = (name: string) => `Findings.\n\n<!-- fleetadlc-seat:${name} -->`;
    const github = {
      listPullFiles: vi.fn(async () => ['apps/console/src/page.tsx']),
      listEveryPullFile: vi.fn(async () => ({ files: ['apps/console/src/page.tsx'], complete: true, renamedFrom: [] })),
      listReviews: vi.fn(async () => [
        { id: 1, user: 'exampleco-review', state: 'CHANGES_REQUESTED', body: seat('lead-reviewer'), submittedAt: '2026-09-28T18:30:00Z', commitId: 'abc' },
        { id: 2, user: 'exampleco-review', state: 'APPROVED', body: seat('second-reviewer'), submittedAt: '2026-09-28T18:31:00Z', commitId: 'abc' },
      ]),
      readFileAtRef: vi.fn(async () => '# Agent notes\n'),
    };
    // Both signed: on a shared account the lead's verdict is the lead's only then.
    const attribution = { countable: vi.fn(async (posts: unknown[]) => [...posts]), reviewsThatCount: vi.fn(async (_repo: string, _n: number, posts: unknown[]) => [...posts]) };
    const reading = new Automation(config, { asBot: vi.fn(async () => github), attribution } as never);

    const gate = await reading.reviewGateFor('exampleco/app', {
      number: 70,
      draft: false,
      labels: [],
      head: { sha: 'abc' },
      baseRef: 'main',
    });

    expect(gate).toEqual({ state: 'pending', description: 'changes requested by lead-reviewer' });
  });

  // Read as a pull request that changes nothing, a file list GitHub refused or
  // cut off named nobody for `config/`, and the gate went green on the bots'
  // approvals: all a repository that merges by ruleset or by hand waits for.
  describe('when GitHub will not list every file the pull request changes', () => {
    function approvedByEverySeat(listEveryPullFile: () => Promise<unknown>) {
      world.crew = [
        { id: 'b-flow', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'exampleco-crew' },
        { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-review' },
        { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'exampleco-review' },
      ];
      const seat = (name: string) => `Findings.\n\n<!-- fleetadlc-seat:${name} -->`;
      const github = {
        listEveryPullFile: vi.fn(listEveryPullFile),
        listReviews: vi.fn(async () => [
          { id: 1, user: 'exampleco-review', state: 'APPROVED', body: seat('second-reviewer'), submittedAt: '2026-09-28T18:30:00Z', commitId: 'abc' },
          { id: 2, user: 'exampleco-review', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: '2026-09-28T18:31:00Z', commitId: 'abc' },
        ]),
        readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @orzelig\n'),
      };
      const attribution = { countable: vi.fn(async (posts: unknown[]) => [...posts]), reviewsThatCount: vi.fn(async (_repo: string, _n: number, posts: unknown[]) => [...posts]) };
      const reading = new Automation(config, { asBot: vi.fn(async () => github), attribution } as never);
      return reading.reviewGateFor('exampleco/app', { number: 70, draft: false, labels: [], head: { sha: 'abc' }, baseRef: 'main' });
    }

    it('passes once every seat approved a list it read to the end', async () => {
      expect(await approvedByEverySeat(async () => ({ files: ['apps/console/src/page.tsx'], complete: true, renamedFrom: [] }))).toMatchObject({
        state: 'success',
      });
    });

    it('holds, saying why, when the read fails, though every seat approved', async () => {
      const gate = await approvedByEverySeat(async () => {
        throw new Error('GitHub answered 502');
      });
      expect(gate).toEqual({ state: 'pending', description: 'cannot read every file this pull request changes' });
    });

    it('holds, saying why, when the list stopped at 3000', async () => {
      const gate = await approvedByEverySeat(async () => ({ files: ['apps/console/src/page.tsx'], complete: false, renamedFrom: [] }));
      expect(gate).toEqual({ state: 'pending', description: 'cannot read every file this pull request changes' });
    });
  });
});

describe('the lead reviews last', () => {
  const gate = (input: Partial<Parameters<Automation['computeReviewGate']>[0]>) =>
    automation.computeReviewGate({
      draft: false,
      requestedReviewers: ['lead-reviewer', 'second-reviewer', 'security-reviewer'],
      postedReviewers: [],
      lead: 'lead-reviewer',
      approvers: ['lead-reviewer'],
      humansRequired: [],
      humansApproved: [],
      ...input,
    });

  it('waits on the other seats first, naming only them', () => {
    expect(gate({ postedReviewers: ['second-reviewer'] })).toEqual({ state: 'pending', description: 'waiting on security-reviewer' });
  });

  it('waits on the lead once every other seat posted, or cannot be asked', () => {
    expect(gate({ postedReviewers: ['second-reviewer', 'security-reviewer'] })).toEqual({ state: 'pending', description: 'waiting on lead-reviewer' });
    expect(gate({ postedReviewers: ['second-reviewer'], cannotReview: new Map([['security-reviewer', 'GitHub says they are not a collaborator']]) })).toEqual({
      state: 'pending',
      description: 'waiting on lead-reviewer',
    });
  });

  it('lets the lead decide: an advisory seat that would ask for changes holds nothing', () => {
    const everyone = ['lead-reviewer', 'second-reviewer', 'security-reviewer'];
    expect(gate({ postedReviewers: everyone, changesRequestedBy: ['second-reviewer'], approvedBy: ['lead-reviewer'] })).toEqual({
      state: 'success',
      description: 'every requested review has been posted',
    });
    expect(gate({ postedReviewers: everyone, changesRequestedBy: ['lead-reviewer'], approvedBy: [] })).toEqual({
      state: 'pending',
      description: 'changes requested by lead-reviewer',
    });
  });

  it('holds until the lead and every blocking seat approved, a comment being no approval', () => {
    const everyone = ['lead-reviewer', 'second-reviewer', 'security-reviewer'];
    expect(gate({ postedReviewers: everyone, approvedBy: [] })).toEqual({ state: 'pending', description: 'not approved yet by lead-reviewer' });
    expect(gate({ postedReviewers: everyone, approvers: ['lead-reviewer', 'security-reviewer'], approvedBy: ['lead-reviewer'] })).toEqual({
      state: 'pending',
      description: 'not approved yet by security-reviewer',
    });
  });
});

describe('who the review rules need to approve', () => {
  it('is the lead, and a seat marked blocking that was asked', () => {
    const blocking = new Automation(
      {
        review: reviewRulesSchema.parse({
          reviewers: [
            { seat: 'lead-reviewer', lens: 'lead', lead: true },
            { seat: 'second-reviewer', lens: 'second' },
            { seat: 'security-reviewer', lens: 'security', blocking: true, trigger: { labels: ['touches:security'] } },
          ],
        }),
      } as BridgeConfig,
      { asBot: async () => null } as never,
    );
    const ask = (labels: string[]) => blocking.decideReviewers({ labels, changedFiles: [], isRevert: false, humanReviewPaths: [], sample: 99 });

    expect(ask([])).toMatchObject({ lead: 'lead-reviewer', approvers: ['lead-reviewer'], reviewers: ['lead-reviewer', 'second-reviewer'] });
    expect(ask(['touches:security'])).toMatchObject({ approvers: ['lead-reviewer', 'security-reviewer'] });
    expect(blocking.decideReviewers({ labels: [], changedFiles: [], isRevert: true, humanReviewPaths: [], sample: 99 })).toMatchObject({
      reviewers: ['lead-reviewer'],
      approvers: ['lead-reviewer'],
    });
    // The fast path drops only the seats there by default: a blocking seat
    // its trigger asked for is still asked, and still has to approve.
    expect(blocking.decideReviewers({ labels: ['touches:security'], changedFiles: [], isRevert: true, humanReviewPaths: [], sample: 99 })).toMatchObject({
      reviewers: ['lead-reviewer', 'security-reviewer'],
      approvers: ['lead-reviewer', 'security-reviewer'],
    });
  });
});

describe('the reviews on this diff, and the lead’s turn', () => {
  const seat = (name: string, verdict = '') => `Findings.\n\n<!-- fleetadlc:{"event":"review_posted"${verdict}} -->\n\n<!-- fleetadlc-seat:${name} -->`;

  // The lead and the second reviewer share an account here, so a lead review
  // counts only when the attribution's check says it was signed for it:
  // `signed` says which ids it passes, every one unless a test says otherwise.
  function standing(
    reviews: Record<string, unknown>[],
    fingerprints: Record<string, string> = { head: 'the diff' },
    signed: (review: { id: number }) => boolean = () => true,
    labels: { name: string }[] = [],
    ref = 'agent/builder/42-fix',
  ) {
    world.crew = [
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-review' },
      { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'exampleco-review' },
    ];
    const github = {
      listPullFiles: vi.fn(async () => ['apps/console/src/page.tsx']),
      listEveryPullFile: vi.fn(async () => ({ files: ['apps/console/src/page.tsx'], complete: true, renamedFrom: [] })),
      listReviews: vi.fn(async () => reviews),
      readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @janedoe\n'),
      diffFingerprint: vi.fn(async (_repo: string, _base: string, sha: string) => fingerprints[sha] ?? null),
    };
    const attribution = {
      countable: vi.fn(async (posts: unknown[]) => [...posts]),
      reviewsThatCount: vi.fn(async (_repo: string, _n: number, posts: { id: number }[]) => posts.filter(signed)),
    };
    const reading = new Automation(config, { asBot: vi.fn(async () => github), attribution } as never);
    return reading.reviewStanding('exampleco/app', { number: 70, draft: false, labels, head: { sha: 'head', ref }, baseRef: 'main' });
  }

  afterEach(() => {
    world.roundAt = null;
  });

  it('makes the lead’s turn due from when this diff’s round began, when that is later than the others posted', async () => {
    world.roundAt = '2026-09-30T11:00:00.000Z';
    const result = await standing([
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
    ]);

    expect(result.leadDue).toEqual({ seat: 'lead-reviewer', since: '2026-09-30T11:00:00.000Z' });
  });

  it('makes the lead’s turn on a pull request it alone reviews due from when the round began, not from never', async () => {
    // A revert: no other seat ever posts, and a null cut-off took the lead's
    // review of round one for every round after it.
    world.roundAt = '2026-09-30T11:00:00.000Z';
    const result = await standing([], undefined, undefined, [{ name: 'revert' }], 'system/revert-1a2b3c4d');

    expect(result.decision.reviewers).toEqual(['lead-reviewer']);
    expect(result.leadDue).toEqual({ seat: 'lead-reviewer', since: '2026-09-30T11:00:00.000Z' });
  });

  it('counts an advisory seat’s comment as its review, and makes the lead’s turn due from when it posted', async () => {
    const result = await standing([
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer', ',"verdict":"approve","lens":"second"'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
    ]);

    expect(result.posted).toEqual(['second-reviewer']);
    expect(result.gate).toEqual({ state: 'pending', description: 'waiting on lead-reviewer' });
    expect(result.leadDue).toEqual({ seat: 'lead-reviewer', since: '2026-09-30T10:00:00Z' });
  });

  it('takes a review of an earlier head with the same diff as this diff’s, and one of another diff as nobody’s', async () => {
    const reviews = [
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'before-main-merge' },
      { id: 2, user: 'exampleco-review', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: '2026-09-30T10:05:00Z', commitId: 'before-a-fix' },
    ];
    const result = await standing(reviews, { head: 'the diff', 'before-main-merge': 'the diff', 'before-a-fix': 'another diff' });

    expect(result.posted).toEqual(['second-reviewer']);
    expect(result.leadDue?.seat).toBe('lead-reviewer');
    expect(result.approved).toEqual([]);
  });

  it('is not the lead’s turn while another seat has not posted, nor once the lead has', async () => {
    expect((await standing([])).leadDue).toBeNull();
    const done = await standing([
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
      { id: 2, user: 'exampleco-review', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: '2026-09-30T10:05:00Z', commitId: 'head' },
    ]);
    expect(done.leadDue).toBeNull();
    expect(done.approved).toEqual(['lead-reviewer']);
    expect(done.gate).toEqual({ state: 'success', description: 'every requested review has been posted' });
  });

  it('takes an approval tagged as the lead’s on the shared account as nobody’s unless its signature checks, in audit mode too', async () => {
    // Another seat's session posted it with the account's token, around
    // OpenADLC's gh: the gate went green and the lead was never asked.
    const reviews = [
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
      { id: 2, user: 'exampleco-review', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: '2026-09-30T10:05:00Z', commitId: 'head' },
    ];
    const forged = await standing(reviews, undefined, (review) => review.id !== 2);
    expect(forged.posted).toEqual(['second-reviewer']);
    expect(forged.approved).toEqual([]);
    expect(forged.gate.state).toBe('pending');
    expect(forged.leadDue).toEqual({ seat: 'lead-reviewer', since: '2026-09-30T10:00:00Z' });

    const lead = await standing(reviews, undefined, (review) => review.id === 2);
    expect(lead.posted).toEqual(['lead-reviewer', 'second-reviewer']);
    expect(lead.gate.state).toBe('success');
    expect(lead.leadDue).toBeNull();
  });

  it('leaves a dismissed review out: its seat has not posted, and a dismissed lead is due again', async () => {
    // Counted as posted, a seat whose review a bot dismissed was never asked
    // again, and the pull request waited for a person.
    const result = await standing([
      { id: 1, user: 'exampleco-review', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
      { id: 2, user: 'exampleco-review', state: 'DISMISSED', body: seat('lead-reviewer'), submittedAt: '2026-09-30T10:05:00Z', commitId: 'head' },
    ]);
    expect(result.posted).toEqual(['second-reviewer']);
    expect(result.approved).toEqual([]);
    expect(result.gate.state).toBe('pending');
    expect(result.leadDue?.seat).toBe('lead-reviewer');

    const only = await standing([
      { id: 1, user: 'exampleco-review', state: 'DISMISSED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
    ]);
    expect(only.posted).toEqual([]);
  });

  it('passes a change to how CI runs on the security seat’s signed approve, and holds one unsigned or asking for changes', async () => {
    world.crew = [
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-review' },
      { id: 'b-security', name: 'security-reviewer', slot: 'security-reviewer', role: 'review_security', githubLogin: 'exampleco-security' },
    ];
    const marker = (name: string, verdict: string) =>
      `Findings.\n\n<!-- fleetadlc:{"event":"review_posted","verdict":"${verdict}","lens":"security"} -->\n\n<!-- fleetadlc-seat:${name} -->`;
    const reviews = (verdict: string) => [
      { id: 1, user: 'exampleco-security', state: 'COMMENTED', body: marker('security-reviewer', verdict), submittedAt: '2026-09-30T10:00:00Z', commitId: 'head' },
      { id: 2, user: 'exampleco-review', state: 'APPROVED', body: marker('lead-reviewer', 'approve'), submittedAt: '2026-09-30T10:05:00Z', commitId: 'head' },
    ];
    const github = {
      listEveryPullFile: vi.fn(async () => ({ files: ['Makefile'], complete: true, renamedFrom: [] })),
      listReviews: vi.fn(async () => reviews('approve')),
      readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @janedoe\n'),
      diffFingerprint: vi.fn(async () => 'the diff'),
    };
    const attribution = {
      countable: vi.fn(async (posts: unknown[]) => [...posts]),
      reviewsThatCount: vi.fn(async (_repo: string, _n: number, posts: unknown[]) => [...posts]),
    };
    const reading = new Automation(config, { asBot: vi.fn(async () => github), attribution } as never);
    const pr = { number: 70, draft: false, labels: [] as { name: string }[], head: { sha: 'head', ref: 'agent/builder/42-fix' }, baseRef: 'main' };

    expect((await reading.reviewStanding('exampleco/app', pr)).gate).toEqual({ state: 'success', description: 'every requested review has been posted' });

    github.listReviews.mockImplementation(async () => reviews('request_changes'));
    expect((await reading.reviewStanding('exampleco/app', pr)).gate).toEqual({ state: 'pending', description: 'changes requested by security-reviewer' });

    // An approve no signature backs is anyone's words on that account: the
    // merge line does not count it, so the gate does not either.
    github.listReviews.mockImplementation(async () => reviews('approve'));
    attribution.reviewsThatCount.mockImplementation(async (_repo: string, _n: number, posts: unknown[]) =>
      posts.filter((post) => (post as { user: string }).user !== 'exampleco-security'),
    );
    expect((await reading.reviewStanding('exampleco/app', pr)).gate).toEqual({ state: 'pending', description: 'not approved yet by security-reviewer' });
  });
});

describe('the bridge’s own dismissal of a superseded approval', () => {
  beforeEach(() => {
    world.recorded = [];
    world.calls = [];
  });

  function dismissing() {
    const github = {
      listReviews: vi.fn(async () => [{ id: 41, user: 'exampleco-review', state: 'APPROVED', body: '', submittedAt: '2026-09-30T10:00:00Z', commitId: 'before' }]),
      dismissReview: vi.fn(async () => {
        world.calls.push('dismiss');
      }),
    };
    return new Automation(config, { asBot: vi.fn(async () => github) } as never);
  }

  it('is recorded before GitHub is asked, since its delivery can arrive before the answer', async () => {
    await dismissing().dismissStaleApprovals({ repoFullName: 'exampleco/app', prNumber: 70, reason: 'the diff changed' });

    expect(world.calls).toEqual(['record review.dismissed_by_bridge', 'dismiss']);
    expect(world.recorded[0]?.payload).toEqual({ repo: 'exampleco/app', pr: '70', reviewId: '41' });
  });

  it('is known as its own by the review’s id, by a bridge that restarted since too', async () => {
    await dismissing().dismissStaleApprovals({ repoFullName: 'exampleco/app', prNumber: 70, reason: 'the diff changed' });

    const restarted = dismissing();
    expect(await restarted.dismissedByBridge('exampleco/app', 41)).toBe(true);
    expect(await restarted.dismissedByBridge('exampleco/app', 42)).toBe(false);
    expect(await restarted.dismissedByBridge('exampleco/other', 41)).toBe(false);
  });
});

describe('running a failed CI again', () => {
  it('is done as the app', async () => {
    const app = { request: vi.fn(async () => ({})) };
    const automation = new Automation({} as never, {} as never, { client: vi.fn(async () => app) } as never);

    expect(await automation.rerunFailedJobs('janedoe/fleetadlc', 4242)).toBe(true);
    expect(app.request).toHaveBeenCalledWith('POST', '/repos/janedoe/fleetadlc/actions/runs/4242/rerun-failed-jobs');
  });

  it('is not done at all where the app cannot be asked, rather than with a bot’s token', async () => {
    const automation = new Automation({} as never, {} as never, { client: vi.fn(async () => null) } as never);

    expect(await automation.rerunFailedJobs('janedoe/fleetadlc', 4242)).toBe(false);
  });
});

describe('whether the bridge may merge a pull request', () => {
  const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
  const EARLIER = 'bead00bead00bead00bead00bead00bead00bead';
  // Seats on accounts of their own, unless a test says otherwise.
  const CREW = [
    { name: 'fleetadlc-sydney-janedoe', slot: 'lead-reviewer', githubLogin: 'sydney-janedoe' },
    { name: 'fleetadlc-vega-janedoe', slot: 'second-reviewer', githubLogin: 'vega-janedoe' },
    { name: 'fleetadlc-atlas-janedoe', slot: 'builder', githubLogin: 'builder-janedoe' },
  ];
  const LOGIN: Record<string, string> = { 'fleetadlc-sydney-janedoe': 'sydney-janedoe', 'fleetadlc-vega-janedoe': 'vega-janedoe' };
  let reviewId = 0;
  const by = (seat: string, state: string, commitId = HEAD) => ({ id: ++reviewId, user: LOGIN[seat] ?? seat, state, commitId, body: `Verdict.\n\n<!-- fleetadlc-seat:${seat} -->` });
  const person = (login: string, state: string, association = 'OWNER', commitId = HEAD) => ({ id: ++reviewId, user: login, state, commitId, association, body: 'A person.' });
  const ciRun = (overrides: Record<string, unknown> = {}) => ({ name: 'ci', status: 'completed', conclusion: 'success', app: 'github-actions', headSha: HEAD, workflow: 'ci', ...overrides });
  const job = (name: string, conclusion = 'success') => ({ name, status: 'completed', conclusion, app: 'github-actions', headSha: HEAD, workflow: null });

  function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
    // The crew's reviews are signed by OpenADLC unless a test says otherwise:
    // a required seat's approval counts only when its signature checks.
    const reviews = overrides.reviews ?? [by('fleetadlc-sydney-janedoe', 'APPROVED'), by('fleetadlc-vega-janedoe', 'APPROVED')];
    return {
      repoFullName: 'janedoe/fleetadlc',
      headRepoFullName: 'janedoe/fleetadlc',
      baseRef: 'main',
      defaultBranch: 'main',
      draft: false,
      mergeableState: 'clean',
      headSha: HEAD,
      filesComplete: true,
      files: ['apps/api/src/route.ts'],
      ciKeysChanged: [],
      requestsTakenAway: [],
      askingPermission: new Map(),
      requestedReviewers: ['fleetadlc-sydney-janedoe', 'fleetadlc-vega-janedoe'],
      pendingOnGitHub: [],
      humansRequired: [],
      humanRulesUnknown: false,
      reviews,
      crew: CREW,
      signaturesEnforced: false,
      checkedReviews: reviews,
      ciMergedBy: 'fleetadlc',
      securitySeat: 'fleetadlc-vega-janedoe',
      checkRuns: [job('check'), job('integration'), ciRun()],
      statuses: [{ context: 'review-gate', state: 'success' }],
      gate: 'success',
      sameDiffAs: new Set(),
      carriedFrom: new Set(),
      leadRechecks: null,
      ...overrides,
    };
  }

  it('may, when every requested reviewer approved this head and every check is green, and names the approvals', () => {
    const decision = mergeDecision(facts());

    expect(decision.land).toBe(true);
    expect(decision.approvals).toEqual([
      { reviewer: 'fleetadlc-sydney-janedoe', person: false, commitId: HEAD, ofHead: true },
      { reviewer: 'fleetadlc-vega-janedoe', person: false, commitId: HEAD, ofHead: true },
    ]);
  });

  describe('where it would land', () => {
    it('may not from a fork', () => {
      expect(mergeDecision(facts({ headRepoFullName: 'mallory/fleetadlc' }))).toMatchObject({ land: false, reason: 'its head is in mallory/fleetadlc, not janedoe/fleetadlc' });
      expect(mergeDecision(facts({ headRepoFullName: null })).land).toBe(false);
    });

    it('may not while it is held for a person', () => {
      // "Hold this PR" on an unsigned post's card labels it `needs-human`.
      expect(mergeDecision(facts({ held: true }))).toMatchObject({ land: false, reason: 'it is held for a person (needs-human or fleetadlc:paused)' });
    });

    it('may not onto a branch that is not the default one', () => {
      expect(mergeDecision(facts({ baseRef: 'release' }))).toMatchObject({ land: false, reason: 'it would land on release, not the default branch main' });
    });

    it('may not when GitHub stopped listing its files, so the human paths are not all known', () => {
      expect(mergeDecision(facts({ filesComplete: false })).land).toBe(false);
    });
  });

  describe('a crew pull request held to its lease’s paths', () => {
    const crew = (scope: Partial<NonNullable<MergeFacts['scope']>> = {}) => ({
      crewBranch: true,
      issue: 11,
      closes: [11],
      declared: ['src/ui/button.tsx'],
      crossCutting: false,
      ...scope,
    });

    it('is refused and sent back when it strays, every file named, where it landed before', () => {
      // The audit's case: an issue about a button, and a diff in auth and billing.
      const strayed = { files: ['src/auth/session.ts', 'src/billing/charge.ts'] };
      expect(mergeDecision(facts(strayed)).land).toBe(true);

      const decision = mergeDecision(facts({ ...strayed, scope: crew() }));
      expect(decision.land).toBe(false);
      expect(decision.sendBack).toEqual({ files: ['src/auth/session.ts', 'src/billing/charge.ts'] });
      expect(decision.reason).toContain('`src/auth/session.ts`, `src/billing/charge.ts`');
      expect(decision.reason).toContain('plan_change');
    });

    it('counts a rename’s old name, a test beside a declared module and the docs as in scope or not as they are', () => {
      expect(mergeDecision(facts({ files: ['src/ui/button.tsx', 'src/ui/button.test.tsx', 'docs/ui.md'], scope: crew() })).land).toBe(true);
      // Moved out of billing: the old name is a change to billing.
      expect(mergeDecision(facts({ files: ['src/ui/button.tsx', 'src/billing/charge.ts'], scope: crew() })).sendBack).toEqual({ files: ['src/billing/charge.ts'] });
    });

    it('lands what strays when scope:cross-cutting counts, and not when it does not', () => {
      const strayed = { files: ['src/billing/charge.ts'] };
      expect(mergeDecision(facts({ ...strayed, scope: crew({ crossCutting: true }) })).land).toBe(true);
      expect(mergeDecision(facts({ ...strayed, scope: crew({ crossCutting: false }) })).land).toBe(false);
    });

    it('is held for a person, not sent back, when it closes no issue or no lease says what it may change', () => {
      const none = mergeDecision(facts({ scope: crew({ closes: [] }) }));
      expect(none).toMatchObject({ land: false, reason: expect.stringContaining('closes no issue') });
      expect(none.sendBack).toBeUndefined();
      const unleased = mergeDecision(facts({ scope: crew({ declared: null }) }));
      expect(unleased).toMatchObject({ land: false, reason: expect.stringContaining('no lease for #11') });
      expect(unleased.sendBack).toBeUndefined();
    });

    it('leaves a person’s pull request, or a revert’s, unchecked', () => {
      expect(mergeDecision(facts({ files: ['src/billing/charge.ts'], scope: crew({ crewBranch: false, closes: [], declared: null }) })).land).toBe(true);
    });
  });

  describe('approvals', () => {
    it('may not on an approval of an earlier head whose diff was different, or could not be compared', () => {
      const decision = mergeDecision(facts({ reviews: [by('fleetadlc-sydney-janedoe', 'APPROVED'), by('fleetadlc-vega-janedoe', 'APPROVED', EARLIER)] }));
      expect(decision).toMatchObject({ land: false, reason: 'fleetadlc-vega-janedoe approved an earlier version whose diff is not known to be this one' });
    });

    it('may on an approval that stands across a merge of the base, the diff being the same', () => {
      const decision = mergeDecision(
        facts({ reviews: [by('fleetadlc-sydney-janedoe', 'APPROVED'), by('fleetadlc-vega-janedoe', 'APPROVED', EARLIER)], sameDiffAs: new Set([EARLIER]) }),
      );
      expect(decision.land).toBe(true);
      expect(decision.approvals[1]).toEqual({ reviewer: 'fleetadlc-vega-janedoe', person: false, commitId: EARLIER, ofHead: false });
    });

    describe('after a lead-only resolution of a conflict', () => {
      // EARLIER is the head before the builder resolved the conflict; HEAD is
      // the resolution. Both seats approved EARLIER.
      const before = [by('fleetadlc-sydney-janedoe', 'APPROVED', EARLIER), by('fleetadlc-vega-janedoe', 'APPROVED', EARLIER)];
      const resolved = (overrides: Partial<MergeFacts> = {}) =>
        facts({ reviews: before, carriedFrom: new Set([EARLIER]), leadRechecks: 'fleetadlc-sydney-janedoe', ...overrides });

      it('may not until the lead approves the resolution head itself, though the other seat’s approval carries', () => {
        expect(mergeDecision(resolved())).toMatchObject({
          land: false,
          reason: 'fleetadlc-sydney-janedoe re-checks the resolution of a conflict, and has approved only the version before it',
        });

        const decision = mergeDecision(resolved({ reviews: [...before, by('fleetadlc-sydney-janedoe', 'APPROVED')] }));
        expect(decision.land).toBe(true);
        expect(decision.approvals).toEqual([
          { reviewer: 'fleetadlc-sydney-janedoe', person: false, commitId: HEAD, ofHead: true },
          { reviewer: 'fleetadlc-vega-janedoe', person: false, commitId: EARLIER, ofHead: false },
        ]);
      });

      it('may on the lead’s approval of a head with the resolution’s diff', () => {
        const SAME = '5a3e'.repeat(10);
        const decision = mergeDecision(resolved({ reviews: [...before, by('fleetadlc-sydney-janedoe', 'APPROVED', SAME)], sameDiffAs: new Set([SAME]) }));
        expect(decision.land).toBe(true);
      });

      it('may not on a person’s approval of a carried head', () => {
        const reviews = [...before, by('fleetadlc-sydney-janedoe', 'APPROVED'), person('janedoe', 'APPROVED', 'OWNER', EARLIER)];
        expect(mergeDecision(resolved({ reviews, humansRequired: ['janedoe'] }))).toMatchObject({ land: false, reason: '@janedoe has not approved this version' });
        // Nor when the carry is a stacked update's, where the lead's does stand.
        expect(mergeDecision(resolved({ reviews, humansRequired: ['janedoe'], leadRechecks: null })).land).toBe(false);
        expect(mergeDecision(resolved({ reviews: before, leadRechecks: null })).land).toBe(true);
      });
    });

    it('may not while one reviewer still asks for changes, whatever it said before', () => {
      const decision = mergeDecision(
        facts({ reviews: [by('fleetadlc-sydney-janedoe', 'APPROVED'), by('fleetadlc-vega-janedoe', 'APPROVED'), by('fleetadlc-vega-janedoe', 'CHANGES_REQUESTED')] }),
      );
      expect(decision).toMatchObject({ land: false, reason: 'fleetadlc-vega-janedoe still asks for changes' });
    });

    it('may not before every requested reviewer has reviewed', () => {
      expect(mergeDecision(facts({ reviews: [by('fleetadlc-sydney-janedoe', 'APPROVED')] }))).toMatchObject({ land: false, reason: 'fleetadlc-vega-janedoe has not reviewed it' });
    });

    it('may not count one account’s approval for two seats unless each signature checks', () => {
      const shared = CREW.map((bot) => (bot.slot === 'builder' ? bot : { ...bot, githubLogin: 'reviewer-janedoe' }));
      const reviews = [
        { ...by('fleetadlc-sydney-janedoe', 'APPROVED'), user: 'reviewer-janedoe' },
        { ...by('fleetadlc-vega-janedoe', 'APPROVED'), user: 'reviewer-janedoe' },
      ];
      expect(mergeDecision(facts({ crew: shared, reviews, checkedReviews: [reviews[0]!] }))).toMatchObject({
        land: false,
        reason: expect.stringContaining('fleetadlc-vega-janedoe’s review on reviewer-janedoe, an account other seats use too, is not signed'.replace('’', "'")),
      });
      expect(mergeDecision(facts({ crew: shared, reviews, checkedReviews: reviews })).land).toBe(true);
      expect(mergeDecision(facts({ crew: shared, reviews, checkedReviews: reviews, signaturesEnforced: true })).land).toBe(true);
    });

    describe('with the reviewers on one account and only the lead required', () => {
      // As the walkthrough and config/review.yaml set it up. Any reviewer
      // seat's session holds the account's token, and can end an approval in
      // the lead's tag.
      const REVIEWERS = [
        { name: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'exampleco-review' },
        { name: 'second-reviewer', slot: 'second-reviewer', githubLogin: 'exampleco-review' },
        { name: 'security-reviewer', slot: 'security-reviewer', githubLogin: 'exampleco-review' },
        { name: 'builder', slot: 'builder', githubLogin: 'exampleco-builder' },
      ];
      const lead = { id: 501, user: 'exampleco-review', state: 'APPROVED', commitId: HEAD, body: 'Approved.\n\n<!-- fleetadlc-seat:lead-reviewer -->' };
      const shared = (overrides: Partial<MergeFacts>) =>
        facts({ crew: REVIEWERS, requestedReviewers: ['lead-reviewer'], securitySeat: 'security-reviewer', signaturesEnforced: false, reviews: [lead], ...overrides });

      it('may not on an approval tagged as the lead’s whose signature does not check, in audit mode', () => {
        const decision = mergeDecision(shared({ checkedReviews: [] }));
        expect(decision.land).toBe(false);
        expect(decision.reason).toContain('lead-reviewer');
        expect(decision.reason).toContain('is not signed');
        expect(decision.reason).toContain('reviews it again with OpenADLC');
      });

      it('may on the lead’s approval whose signature checks, and names the lead', () => {
        const decision = mergeDecision(shared({ checkedReviews: [lead] }));
        expect(decision.land).toBe(true);
        expect(decision.approvals).toEqual([{ reviewer: 'lead-reviewer', person: false, commitId: HEAD, ofHead: true }]);
      });

      it('may not when nothing can check a signature', () => {
        expect(mergeDecision(shared({ checkedReviews: null }))).toMatchObject({ land: false, reason: expect.stringContaining('a person merges it') });
      });
    });

    it("counts a required seat's approval only when its signature checks, in audit mode too", () => {
      // A review session holds the reviewer account's token, so a test planted
      // in the code under review could post an approval tagged as the lead's
      // around OpenADLC's gh; in audit mode the merge counted it.
      const lead = by('fleetadlc-sydney-janedoe', 'APPROVED');
      const blocking = by('fleetadlc-vega-janedoe', 'APPROVED');
      const unsigned = mergeDecision(facts({ reviews: [lead, blocking], checkedReviews: [blocking], signaturesEnforced: false }));
      expect(unsigned.land).toBe(false);
      expect(unsigned.reason).toContain('fleetadlc-sydney-janedoe');
      expect(unsigned.reason).toContain('not signed by OpenADLC');
      expect(mergeDecision(facts({ reviews: [lead, blocking], checkedReviews: [lead, blocking], signaturesEnforced: false })).land).toBe(true);
      // With nothing to check a signature, a person merges it.
      expect(mergeDecision(facts({ reviews: [lead, blocking], checkedReviews: null }))).toMatchObject({
        land: false,
        reason: expect.stringContaining('cannot be checked'),
      });
      // A person's approval still counts as the mode says.
      const owner = person('janedoe', 'APPROVED');
      expect(
        mergeDecision(facts({ reviews: [lead, blocking, owner], checkedReviews: [lead, blocking], humansRequired: ['janedoe'], askingPermission: new Map([['janedoe', 'admin']]) })).land,
      ).toBe(true);
    });
  });

  describe('people', () => {
    it('may not without the approval of a person the repository names for these paths', () => {
      expect(mergeDecision(facts({ humansRequired: ['janedoe'] }))).toMatchObject({ land: false, reason: '@janedoe has not approved this version' });
      const approved = mergeDecision(
        facts({ humansRequired: ['janedoe'], reviews: [...facts().reviews, person('JaneDoe', 'APPROVED')], askingPermission: new Map([['janedoe', 'write']]) }),
      );
      expect(approved.land).toBe(true);
      expect(approved.approvals.at(-1)).toEqual({ reviewer: 'janedoe', person: true, commitId: HEAD, ofHead: true });
    });

    it('counts a named person’s approval only from an account GitHub says can write here', () => {
      // The audit's case: anyone who registers a login freed by a rename or a
      // deletion can review a public repository, and their approval landed it.
      const taken = { humansRequired: ['janedoe'], reviews: [...facts().reviews, person('janedoe', 'APPROVED', 'NONE')] };
      const refused = mergeDecision(facts(taken));
      expect(refused.land).toBe(false);
      expect(refused.reason).toContain('@janedoe');
      expect(refused.reason).toContain('lacks write access');
      for (const permission of ['unknown', 'read', 'triage', 'none']) {
        expect(mergeDecision(facts({ ...taken, askingPermission: new Map([['janedoe', permission]]) })).land, permission).toBe(false);
      }
      for (const permission of ['write', 'maintain', 'admin']) {
        expect(mergeDecision(facts({ ...taken, askingPermission: new Map([['janedoe', permission]]) })).land, permission).toBe(true);
      }
    });

    it('may not while anyone who can write to it still asks for changes, named or not', () => {
      expect(mergeDecision(facts({ reviews: [...facts().reviews, person('owner-janedoe', 'CHANGES_REQUESTED', 'OWNER')] }))).toMatchObject({
        land: false,
        reason: '@owner-janedoe still asks for changes',
      });
      expect(mergeDecision(facts({ reviews: [...facts().reviews, person('dev-janedoe', 'CHANGES_REQUESTED', 'COLLABORATOR')] })).land).toBe(false);
      // Withdrawn by a later approval, it no longer holds anything.
      const withdrawn = [...facts().reviews, person('owner-janedoe', 'CHANGES_REQUESTED'), person('owner-janedoe', 'APPROVED')];
      expect(mergeDecision(facts({ reviews: withdrawn })).land).toBe(true);
    });

    it('may not while someone GitHub says can write still asks for changes, whatever their association reads as', () => {
      // A private member of the organization reads as a contributor to a token outside it.
      const asking = [...facts().reviews, person('private-janedoe', 'CHANGES_REQUESTED', 'CONTRIBUTOR')];
      for (const permission of ['admin', 'maintain', 'write', 'unknown']) {
        expect(mergeDecision(facts({ reviews: asking, askingPermission: new Map([['private-janedoe', permission]]) })).land, permission).toBe(false);
      }
    });

    it('lets a merge go past a request for changes from someone who cannot write to the repository', () => {
      // On a public repository everyone can read, and a passer-by's review
      // would hold every pull request; an empty answer is a former collaborator.
      const asking = [...facts().reviews, person('passer-by', 'CHANGES_REQUESTED', 'NONE')];
      for (const permission of ['read', 'triage', 'none', '']) {
        expect(mergeDecision(facts({ reviews: asking, askingPermission: new Map([['passer-by', permission]]) })).land, permission || 'empty').toBe(true);
      }
    });

    it('may not while someone asked for a review on GitHub has not given one', () => {
      expect(mergeDecision(facts({ pendingOnGitHub: ['@janedoe'] }))).toMatchObject({ land: false, reason: '@janedoe is asked for a review on GitHub and has not given one' });
      expect(mergeDecision(facts({ pendingOnGitHub: ['@janedoe', '@alexdoe'] }))).toMatchObject({
        land: false,
        reason: '@janedoe, @alexdoe are asked for a review on GitHub and have not given one',
      });
      expect(mergeDecision(facts({ pendingOnGitHub: ['team maintainers'] })).land).toBe(false);
    });
  });

  describe('checks', () => {
    it('may not when CI is red, the required check or any other, errored included', () => {
      expect(mergeDecision(facts({ checkRuns: [job('check'), job('integration', 'failure'), ciRun({ conclusion: 'failure' })] }))).toMatchObject({
        land: false,
        reason: 'integration, ci failed on the head',
      });
      expect(mergeDecision(facts({ checkRuns: [ciRun(), job('integration', 'failure')] })).land).toBe(false);
      expect(mergeDecision(facts({ statuses: [{ context: 'optional-lint', state: 'error' }] })).land).toBe(false);
    });

    it('may not while ci has not reported', () => {
      expect(mergeDecision(facts({ checkRuns: [job('check')] }))).toMatchObject({ land: false, reason: 'ci has not passed on the head' });
    });

    it('never takes a commit status named ci for CI, whoever set it', () => {
      // A bot's token may write statuses; with Actions not running, a `ci`
      // status alone would have made the head green.
      expect(mergeDecision(facts({ checkRuns: [], statuses: [{ context: 'ci', state: 'success' }] })).land).toBe(false);
      expect(mergeDecision(facts({ statuses: [{ context: 'ci', state: 'success' }] })).land).toBe(false);
    });

    it('takes only GitHub Actions’ run of the ci workflow on this head', () => {
      expect(mergeDecision(facts({ checkRuns: [ciRun({ app: 'some-other-app' })] })).land).toBe(false);
      expect(mergeDecision(facts({ checkRuns: [ciRun({ workflow: 'docs' })] })).land).toBe(false);
      expect(mergeDecision(facts({ checkRuns: [ciRun({ headSha: EARLIER })] })).land).toBe(false);
    });

    it('may not unless OpenADLC’s own review-gate on the head is green', () => {
      for (const gate of ['pending', 'failure', null] as const) expect(mergeDecision(facts({ gate })).land).toBe(false);
    });
  });

  it('holds a change to how CI runs until the security reviewer has approved it too, by a checked review', () => {
    // CI runs the head's own workflow, so an edited `ci` job that exits 0 is a
    // genuine, green run of the `ci` workflow: the lead alone is not enough.
    for (const file of [
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      '.github/scripts/scope-check.mjs',
      'package.json',
      'Makefile',
      // GNU make reads these before `Makefile`: a new one beats a protected one.
      'makefile',
      'GNUmakefile',
      // What is installed and tested, and how.
      'pnpm-workspace.yaml',
      '.npmrc',
      '.pnpmfile.cjs',
      'apps/bridge/vitest.config.ts',
      'packages/db/vite.config.mts',
      'apps/web/jest.config.js',
    ]) {
      // The security seat is a requested reviewer here too; its approval is
      // not among the checked ones, so it is not the security verdict.
      const reviews = facts().reviews;
      expect(mergeDecision(facts({ files: ['apps/api/src/route.ts', file], reviews, checkedReviews: [reviews[0]!] })), file).toMatchObject({
        land: false,
        reason: expect.stringContaining('so the security reviewer must approve it as well, and has not approved this head'),
      });
    }
    // A package's own package.json, or a tsconfig, only when its CI part changed.
    const reviews = facts().reviews;
    expect(mergeDecision(facts({ files: ['apps/api/package.json'], ciKeysChanged: ['apps/api/package.json'], reviews, checkedReviews: [reviews[0]!] }))).toMatchObject({
      land: false,
      reason: expect.stringContaining('apps/api/package.json'),
    });
    expect(mergeDecision(facts({ files: ['apps/api/package.json', 'docs/github.md'] })).land).toBe(true);
  });

  it('merges a change to how CI runs on the security reviewer\u2019s checked approve verdict on this diff, as it merges anything else', () => {
    const verdict = (word: string, commitId = HEAD) => ({
      ...by('fleetadlc-vega-janedoe', 'COMMENTED', commitId),
      body: `Looks safe.\n\n<!-- fleetadlc:{"event":"review_posted","verdict":"${word}","lens":"security"} -->\n<!-- fleetadlc-seat:fleetadlc-vega-janedoe -->`,
    });
    const approvals = facts().reviews;
    const ci = { files: ['Makefile'], reviews: approvals };
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, verdict('approve')] })).land).toBe(true);
    // Asking for changes, on another diff, unchecked, or with nobody to check it: held, and why.
    expect(mergeDecision(facts({ ...ci, checkedReviews: [verdict('request_changes')] }))).toMatchObject({ land: false, reason: expect.stringContaining('its verdict: request_changes') });
    expect(mergeDecision(facts({ ...ci, checkedReviews: [verdict('approve', 'older-sha')] })).land).toBe(false);
    expect(mergeDecision(facts({ ...ci, checkedReviews: null }))).toMatchObject({ land: false, reason: expect.stringContaining('cannot be checked without signatures') });
    expect(mergeDecision(facts({ ...ci, securitySeat: null }))).toMatchObject({ land: false, reason: expect.stringContaining('no security reviewer') });
    // A repository that has a person merge them keeps it so, approved or not.
    expect(mergeDecision(facts({ ...ci, ciMergedBy: 'person', checkedReviews: [...approvals, verdict('approve')] }))).toMatchObject({
      land: false,
      reason: expect.stringContaining('in this repository a person merges those'),
    });
  });

  it('reads the security reviewer\u2019s verdict on a change to how CI runs from the marker its review ends with, never one it quotes', () => {
    const marker = (word: string) => `<!-- fleetadlc:{"event":"review_posted","verdict":"${word}","lens":"security"} -->`;
    const ending = '\n<!-- fleetadlc-seat:fleetadlc-vega-janedoe -->\n<!-- fleetadlc-sig:v1.abc.c2VjdXJpdHk.c2ln -->';
    const review = (body: string, commitId = HEAD) => ({ ...by('fleetadlc-vega-janedoe', 'COMMENTED', commitId), body: `${body}${ending}` });
    // The lead alone is required here, and its approval is signed, as it is when it lands.
    const lead = by('fleetadlc-sydney-janedoe', 'APPROVED');
    const approvals = [lead];
    const ci = { files: ['Makefile'], reviews: approvals, requestedReviewers: ['fleetadlc-sydney-janedoe'] };

    // A builder plants an approve marker in the diff, and the reviewer quotes it while asking for changes.
    const inline = review(`The Makefile gains \`${marker('approve')}\`, which is not the reviewer\u2019s to write.\n\n${marker('request_changes')}`);
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, inline] }))).toMatchObject({ land: false, reason: expect.stringContaining('its verdict: request_changes') });
    const fenced = review(`The Makefile gains:\n\n\`\`\`\n${marker('approve')}\n\`\`\`\n\n${marker('request_changes')}`);
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, fenced] }))).toMatchObject({ land: false, reason: expect.stringContaining('its verdict: request_changes') });
    // Quoting a request for changes does not hold its own approval.
    const approving = review(`An earlier round said \`${marker('request_changes')}\`; that is fixed.\n\n${marker('approve')}`);
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, approving] })).land).toBe(true);
    // A later review that quotes a marker with no verdict and ends asking for changes replaces an earlier approve.
    const later = review(`It quotes \`<!-- fleetadlc:{"event":"review_posted"} -->\`.\n\n${marker('request_changes')}`);
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, review(marker('approve')), later] }))).toMatchObject({
      land: false,
      reason: expect.stringContaining('its verdict: request_changes'),
    });
    // A quoted approve in a review with no marker of its own is no verdict at all.
    const unmarked = review(`The Makefile gains \`${marker('approve')}\`.`);
    expect(mergeDecision(facts({ ...ci, checkedReviews: [...approvals, unmarked] })).land).toBe(false);
  });

  it('holds a pull request whose review request someone without the say took away, until they review', () => {
    expect(mergeDecision(facts({ requestsTakenAway: ['@janedoe'] }))).toMatchObject({ land: false, reason: expect.stringContaining('@janedoe was asked for a review') });
    expect(mergeDecision(facts({ requestsTakenAway: null })).land).toBe(false);
  });

  it('may not on a draft, a conflict, or rules it cannot read, or with nobody asked', () => {
    expect(mergeDecision(facts({ draft: true })).land).toBe(false);
    expect(mergeDecision(facts({ mergeableState: 'dirty' })).land).toBe(false);
    expect(mergeDecision(facts({ mergeableState: null })).land).toBe(false);
    expect(mergeDecision(facts({ humanRulesUnknown: true })).land).toBe(false);
    expect(mergeDecision(facts({ requestedReviewers: [] })).land).toBe(false);
  });
});

describe('the part of a file that decides how CI runs', () => {
  const read = (files: Record<string, Record<string, string | null>>) => async (path: string, ref: string) => {
    const at = files[ref]?.[path];
    if (at === undefined) throw new Error(`no ${path} at ${ref}`);
    return at;
  };

  it('is a package’s scripts, not its dependencies', async () => {
    const base = JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { zod: '3.0.0' } });
    const bumped = JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { zod: '3.1.0' } });
    const weakened = JSON.stringify({ scripts: { test: 'true' }, dependencies: { zod: '3.0.0' } });
    const files = { main: { 'apps/api/package.json': base, 'apps/web/package.json': base }, head: { 'apps/api/package.json': bumped, 'apps/web/package.json': weakened } };

    expect(await ciKeysChanged(['apps/api/package.json', 'apps/web/package.json'], read(files), { base: 'main', head: 'head' })).toEqual(['apps/web/package.json']);
  });

  it('is what a tsconfig compiles, read through its comments', async () => {
    const base = '{\n  // the app\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"],\n}';
    const strict = '{\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"],\n  "compilerOptions": { "strict": true }\n}';
    const narrowed = '{ "extends": "../../tsconfig.base.json", "include": [] }';
    const files = { main: { 'a/tsconfig.json': base, 'b/tsconfig.build.json': base }, head: { 'a/tsconfig.json': strict, 'b/tsconfig.build.json': narrowed } };

    expect(await ciKeysChanged(['a/tsconfig.json', 'b/tsconfig.build.json'], read(files), { base: 'main', head: 'head' })).toEqual(['b/tsconfig.build.json']);
  });

  it('counts as changed when either side cannot be read or parsed, and a new file with scripts as a change', async () => {
    const files = { main: { 'x/package.json': null, 'y/package.json': '{ nope' }, head: { 'x/package.json': '{"scripts":{"test":"true"}}', 'y/package.json': '{}' } };

    expect(await ciKeysChanged(['x/package.json', 'y/package.json', 'z/package.json'], read(files), { base: 'main', head: 'head' })).toEqual([
      'x/package.json',
      'y/package.json',
      'z/package.json',
    ]);
  });
});

describe('a review request taken away', () => {
  const writer = (actor: string | null, viaApp: boolean) => !viaApp && actor === 'owner-janedoe';

  it('still holds when a crew account, an app, or someone who cannot write took it away', () => {
    const history = [
      { event: 'review_requested', actor: 'owner-janedoe', viaApp: false, subject: 'janedoe' },
      { event: 'review_request_removed', actor: 'fleetadlc-atlas-janedoe', viaApp: false, subject: 'janedoe' },
      { event: 'review_requested', actor: 'owner-janedoe', viaApp: false, subject: 'team maintainers' },
      { event: 'review_request_removed', actor: 'fleetadlc-app[bot]', viaApp: true, subject: 'team maintainers' },
    ];
    expect(requestsTakenAway(history, writer)).toEqual(['@janedoe', 'team maintainers']);
  });

  it('does not hold when a person who can write took it back, or the reviewer reviewed since', () => {
    expect(
      requestsTakenAway(
        [
          { event: 'review_request_removed', actor: 'owner-janedoe', viaApp: false, subject: 'janedoe' },
          { event: 'review_request_removed', actor: 'fleetadlc-atlas-janedoe', viaApp: false, subject: 'dev-janedoe' },
          { event: 'reviewed', actor: 'dev-janedoe', viaApp: false, subject: null },
        ],
        writer,
      ),
    ).toEqual([]);
  });

  it('is not known from a history too long to read', () => {
    expect(requestsTakenAway(null, writer)).toBeNull();
  });
});

describe('withdrawing the people a pull request does not need', () => {
  it('compares logins whatever their case, so a person who is needed stays asked', async () => {
    const github = { removeReviewRequest: vi.fn(async () => undefined) };
    const withdrawing = new Automation({ ...config, humans: ['JaneDoe', 'other-human'] }, { asBot: vi.fn(async () => github) } as never);

    await withdrawing.dropUnneededHumanRequests('exampleco/app', 79, ['janedoe']);

    expect(github.removeReviewRequest).toHaveBeenCalledWith('exampleco/app', 79, ['other-human']);
    github.removeReviewRequest.mockClear();
    await withdrawing.dropUnneededHumanRequests('exampleco/app', 79, ['janedoe', 'Other-Human']);
    expect(github.removeReviewRequest).not.toHaveBeenCalled();
  });
});

describe('merging as the app', () => {
  it('is done with the app’s client, on the head that was checked', async () => {
    const app = { mergePullRequest: vi.fn(async () => ({ sha: 'merged00' })) };
    const automation = new Automation({} as never, {} as never, { client: vi.fn(async () => app) } as never);

    expect(await automation.mergeAsApp('janedoe/fleetadlc', 31, 'c0ffee00')).toEqual({ sha: 'merged00' });
    expect(app.mergePullRequest).toHaveBeenCalledWith('janedoe/fleetadlc', 31, 'c0ffee00');
  });

  it('is not done at all where the app cannot be asked', async () => {
    const automation = new Automation({} as never, {} as never, { client: vi.fn(async () => null) } as never);
    expect(await automation.mergeAsApp('janedoe/fleetadlc', 31, 'c0ffee00')).toBeNull();
  });
});

describe('what the bridge reads before it merges', () => {
  const seat = (name: string) => `Approved.\n\n<!-- fleetadlc-seat:${name} -->`;
  const PULL = {
    number: 79,
    draft: false,
    headSha: 'head',
    baseRef: 'main',
    labels: [],
    mergeableState: 'clean',
    headRepoFullName: 'exampleco/app',
    requestedReviewers: ['janedoe'],
    requestedTeams: ['maintainers'],
  };

  function reading(overrides: Record<string, unknown> = {}) {
    world.crew = [
      { id: 'b-flow', name: 'automation', slot: 'automation', role: 'automation', githubLogin: 'exampleco-crew' },
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-lead' },
      { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'exampleco-second' },
    ];
    const fingerprints: Record<string, string> = { head: 'the diff', 'before-main-merge': 'the diff', 'before-a-fix': 'another diff' };
    const github = {
      listEveryPullFile: vi.fn(async () => ({ files: ['apps/console/src/page.tsx'], complete: true })),
      listReviews: vi.fn(async () => [
        { id: 1, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: null, commitId: 'before-main-merge' },
        { id: 2, user: 'exampleco-second', state: 'APPROVED', body: seat('second-reviewer'), submittedAt: null, commitId: 'before-a-fix' },
      ]),
      permissionOf: vi.fn(async () => 'write'),
      readFileIfPresent: vi.fn(async () => null),
      listPullHistory: vi.fn(async () => []),
      checkRunsFor: vi.fn(async () => [
        { name: 'ci', status: 'completed', conclusion: 'success', app: 'github-actions', headSha: 'head', suiteId: 9 },
        { name: 'check', status: 'completed', conclusion: 'success', app: 'github-actions', headSha: 'head', suiteId: 9 },
      ]),
      statusesFor: vi.fn(async () => []),
      workflowRunOfSuite: vi.fn(async () => ({ name: 'ci', headSha: 'head' })),
      readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @janedoe\n'),
      diffFingerprint: vi.fn(async (_repo: string, _base: string, sha: string) => fingerprints[sha] ?? null),
      closingIssues: vi.fn(async (): Promise<number[]> => []),
      getIssue: vi.fn(async (): Promise<{ number: number; body: string } | null> => null),
      ...overrides,
    };
    const appGate = { standing: vi.fn(async () => ({ state: 'success', description: 'every requested review has been posted' })), appId: vi.fn(async () => 7) };
    // Every crew review here is signed: a required seat's approval counts only when its signature checks.
    const attribution = { reviewsThatCount: vi.fn(async (_repo: string, _n: number, reviews: unknown[]) => reviews) };
    return { automation: new Automation(config, { asBot: vi.fn(async () => github), attribution } as never, appGate as never), github, appGate };
  }

  it('reads CI’s workflow, the rules from the default branch, and compares only earlier approved heads', async () => {
    const { automation, github, appGate } = reading();

    const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'trunk' }, { ...PULL, baseRef: 'trunk' });

    expect(github.readFileAtRef).toHaveBeenCalledWith('exampleco/app', 'AGENTS.md', 'trunk');
    expect(github.workflowRunOfSuite).toHaveBeenCalledTimes(1);
    expect(facts?.checkRuns.find((run) => run.name === 'ci')?.workflow).toBe('ci');
    expect(facts?.pendingOnGitHub).toEqual(['@janedoe', 'team maintainers']);
    // The second reviewer is advisory: only the lead's approval lands it.
    expect(facts?.requestedReviewers).toEqual(['lead-reviewer']);
    expect([...(facts?.sameDiffAs ?? [])]).toEqual(['before-main-merge']);
    expect(facts?.gate).toBe('success');
    expect(appGate.standing).toHaveBeenCalledWith('exampleco/app', 'head');
  });

  // A bare `review:human` was once described as a hold; nothing reads it.
  // Only `needs-human` (and a pause) holds a pull request.
  it('holds for needs-human, not for a bare review:human', async () => {
    const { automation } = reading();

    const bare = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, { ...PULL, labels: ['review:human'] });
    const held = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, { ...PULL, labels: ['needs-human'] });

    expect(bare?.held).toBe(false);
    expect(held?.held).toBe(true);
  });

  // Any token that may write statuses can set `review-gate`, the builder's
  // included, just before it merges.
  it('never takes review-gate from a status another account set', async () => {
    const statuses = (creator: string) => ({ statuses: [{ context: 'review-gate', state: 'success', creator: { login: creator } }] });
    const gateBy = async (creator: string) => {
      const github = { request: vi.fn(async () => statuses(creator)), viewer: vi.fn(async () => ({ login: 'exampleco-crew' })) };
      const automation = new Automation(config, { asBot: vi.fn(async () => github) } as never, { standing: vi.fn(async () => null), appId: vi.fn(async () => null) } as never);
      return automation.publishedGate('exampleco/app', 'head');
    };

    expect(await gateBy('exampleco-lead')).toBeNull();
    expect(await gateBy('exampleco-crew')).toBe('success');
  });

  it('counts a crew review only when its signature was made for this review, with signatures enforced', async () => {
    // Another seat's signed words, posted again as an approval: the
    // attribution's review check drops it, and the merge sees it as nobody's.
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockResolvedValue({ attributionMode: 'enforce' } as never);
    try {
      const reviewsThatCount = vi.fn(async (_repo: string, _n: number, reviews: { id: number }[]) => reviews.filter((review) => review.id !== 2));
      const { github } = reading();
      const full = { ...config, organization: 'exampleco', gitHubClientId: '', webhookSecret: '', humans: [], publicUrl: '' };
      const automation = new Automation(full as never, { asBot: vi.fn(async () => github), attribution: { reviewsThatCount } } as never, {
        standing: vi.fn(async () => ({ state: 'success', description: '' })),
        appId: vi.fn(async () => 7),
      } as never);

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL);

      expect(reviewsThatCount).toHaveBeenCalledWith('exampleco/app', 79, expect.any(Array), expect.any(Array));
      expect(facts?.signaturesEnforced).toBe(true);
      expect(facts?.reviews.map((review) => (review as { id?: number }).id)).toEqual([1]);
    } finally {
      vi.mocked(settings.allSettings).mockResolvedValue({} as never);
    }
  });

  it('leaves a change to CI for a person to merge when the settings cannot be read', async () => {
    // `effectiveConfig` still resolves on a failed read, from the environment,
    // with no repository in `ciMergeByPerson`: that is not "nobody asked".
    const { settings } = await import('@fleetadlc/db');
    vi.mocked(settings.allSettings).mockRejectedValue(new Error('connection terminated'));
    try {
      const { github, appGate } = reading({ listEveryPullFile: vi.fn(async () => ({ files: ['.github/workflows/ci.yml'], complete: true })) });
      // A config the environment completes, so the settings are what fail.
      const full = { ...config, organization: 'exampleco', gitHubClientId: '', webhookSecret: '', humans: [], publicUrl: '' };
      const automation = new Automation(full as never, { asBot: vi.fn(async () => github) } as never, appGate as never);

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL);

      expect(facts?.ciMergedBy).toBe('person');
    } finally {
      vi.mocked(settings.allSettings).mockResolvedValue({} as never);
    }
  });

  // CODEOWNERS asks for a person on every pull request, and the bridge, as the
  // automation account, withdraws those AGENTS.md does not need. Read as a
  // crew account taking a request away, that held every such pull request.
  describe('a review request taken away by the bridge', () => {
    const ASKED_OF_NOBODY = { ...PULL, requestedReviewers: [], requestedTeams: [] };
    const lead = { id: 1, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: null, commitId: 'head' };
    const withdrawn = (by: string) => [
      { event: 'review_requested', actor: 'exampleco-app[bot]', viaApp: true, sha: null, subject: 'janedoe' },
      { event: 'review_request_removed', actor: by, viaApp: false, sha: null, subject: 'janedoe' },
    ];
    const decide = async (history: object[], overrides: Record<string, unknown> = {}) => {
      const { github, appGate } = reading({ listReviews: vi.fn(async () => [lead]), listPullHistory: vi.fn(async () => history), ...overrides });
      const attribution = { reviewsThatCount: vi.fn(async (_repo: string, _n: number, reviews: unknown[]) => reviews) };
      const automation = new Automation({ ...config, humans: ['JaneDoe'] }, { asBot: vi.fn(async () => github), attribution } as never, appGate as never);
      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, ASKED_OF_NOBODY);
      return { facts, decision: mergeDecision(facts as MergeFacts) };
    };

    it('is not taken away when the automation account withdrew a person AGENTS.md does not name for these files', async () => {
      const { facts, decision } = await decide(withdrawn('exampleco-crew'));

      expect(facts?.requestsTakenAway).toEqual([]);
      expect(decision).toMatchObject({ land: true });
    });

    it('still holds the merge when another crew account took it away', async () => {
      const { facts, decision } = await decide(withdrawn('exampleco-second'));

      expect(facts?.requestsTakenAway).toEqual(['@janedoe']);
      expect(decision).toMatchObject({ land: false, reason: expect.stringContaining('@janedoe was asked for a review') });
    });

    it('still holds the merge when the automation account took away a person the rules need, or the rules cannot be read', async () => {
      const needed = await decide(withdrawn('exampleco-crew'), { listEveryPullFile: vi.fn(async () => ({ files: ['config/bots.yaml'], complete: true })) });
      expect(needed.facts?.requestsTakenAway).toEqual(['@janedoe']);
      expect(needed.decision.land).toBe(false);

      const unread = await decide(withdrawn('exampleco-crew'), { readFileAtRef: vi.fn(async () => null) });
      expect(unread.facts?.requestsTakenAway).toEqual(['@janedoe']);
      expect(unread.decision.land).toBe(false);
    });
  });

  describe('a person’s request for changes that was dismissed', () => {
    const ASKED_OF_NOBODY = { ...PULL, requestedReviewers: [], requestedTeams: [] };
    const lead = { id: 1, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: null, commitId: 'head' };
    const dismissed = { id: 3, user: 'janedoe', state: 'DISMISSED', body: 'Not like this.', submittedAt: null, commitId: 'head' };
    const dismissal = (actor: string, viaApp = false) => ({ event: 'review_dismissed', actor, viaApp, sha: null, subject: null, dismissedReviewId: 3, dismissedState: 'changes_requested' });
    const decide = async (reviews: object[], history: object[], permission: (login: string) => string = () => 'write') => {
      const { automation } = reading({
        listReviews: vi.fn(async () => reviews),
        listPullHistory: vi.fn(async () => history),
        permissionOf: vi.fn(async (_repo: string, login: string) => permission(login)),
      });
      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, ASKED_OF_NOBODY);
      return mergeDecision(facts as MergeFacts);
    };

    it('still holds the merge when a crew account dismissed it, though the lead approved and CI is green', async () => {
      expect(await decide([lead], [])).toMatchObject({ land: true });
      expect(await decide([lead, dismissed], [dismissal('exampleco-second')])).toMatchObject({ land: false, reason: '@janedoe still asks for changes' });
      // An app, or someone who cannot write, may not lift it either.
      expect((await decide([lead, dismissed], [dismissal('some-app[bot]', true)])).land).toBe(false);
      expect((await decide([lead, dismissed], [dismissal('passer-by')], (login) => (login === 'passer-by' ? 'read' : 'write'))).land).toBe(false);
    });

    it('lets the merge go when someone who can write dismissed it', async () => {
      for (const permission of ['write', 'maintain', 'admin']) {
        expect((await decide([lead, dismissed], [dismissal('owner-janedoe')], () => permission)).land, permission).toBe(true);
      }
    });

    it('takes the person’s later review as their verdict', async () => {
      const later = { id: 4, user: 'janedoe', state: 'APPROVED', body: 'Fine now.', submittedAt: null, commitId: 'head' };
      expect((await decide([lead, dismissed, later], [dismissal('exampleco-second')])).land).toBe(true);
    });
  });

  describe('a passer-by’s request for changes', () => {
    const ASKED_OF_NOBODY = { ...PULL, requestedReviewers: [], requestedTeams: [] };
    const lead = { id: 1, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: null, commitId: 'head' };
    const changes = { id: 5, user: 'passer-by', state: 'CHANGES_REQUESTED', body: 'No.', submittedAt: null, commitId: 'head' };
    // GitHub refuses the permission lookup to a triage automation account.
    const refused = vi.fn(async () => Promise.reject(new Error('403 Must have push access')));
    const decide = async () => {
      const { automation } = reading({ listReviews: vi.fn(async () => [lead, changes]), permissionOf: refused });
      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, ASKED_OF_NOBODY);
      return { facts: facts as MergeFacts, decision: mergeDecision(facts as MergeFacts) };
    };

    afterEach(async () => (await import('./people.js')).forgetRepoAccess());

    it('does not hold the merge when the app answers read', async () => {
      (await import('./people.js')).askAsTheApp(async () => ({ request: vi.fn(async () => ({ permission: 'read', role_name: 'read' })) }) as never);

      const { facts, decision } = await decide();

      expect([...facts.askingPermission]).toEqual([['passer-by', 'read']]);
      expect(decision).not.toMatchObject({ reason: '@passer-by still asks for changes' });
      expect(decision).toMatchObject({ land: true });
    });

    it('still holds the merge when neither the app nor the automation account gets an answer', async () => {
      (await import('./people.js')).askAsTheApp(async () => ({ request: vi.fn(async () => Promise.reject(new Error('502'))) }) as never);

      const { facts, decision } = await decide();

      expect([...facts.askingPermission]).toEqual([['passer-by', 'unknown']]);
      expect(decision).toMatchObject({ land: false, reason: '@passer-by still asks for changes' });
    });
  });

  it('asks what each person the rules require may do here, as the app first', async () => {
    const people = await import('./people.js');
    const app = { request: vi.fn(async () => ({ permission: 'read', role_name: 'read' })) };
    people.askAsTheApp(async () => app as never);
    try {
      const { automation, github } = reading({
        listEveryPullFile: vi.fn(async () => ({ files: ['config/bots.yaml'], complete: true })),
        permissionOf: vi.fn(async () => 'admin'),
      });

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL);

      expect(facts?.humansRequired).toEqual(['janedoe']);
      expect(facts?.askingPermission.get('janedoe')).toBe('read');
      expect(app.request).toHaveBeenCalledWith('GET', '/repos/exampleco/app/collaborators/janedoe/permission');
      expect(github.permissionOf).not.toHaveBeenCalledWith('exampleco/app', 'janedoe');
    } finally {
      people.forgetRepoAccess();
    }
  });

  describe('a crew pull request’s scope', () => {
    const CREW_PULL = { ...PULL, requestedReviewers: [], requestedTeams: [], headRef: 'agent/builder/11-button' };
    const BUTTON = { id: 'lease-11', repoId: 'repo-1', issueNumber: 11, botId: 'b-builder', declaredPaths: ['src/ui/button.tsx'], state: 'in_task', expiresAt: null, prNumber: 79 };

    afterEach(() => {
      world.lease = null;
    });

    it('takes its paths from the lease, so an issue body edited to add one lets nothing more through', async () => {
      world.lease = BUTTON as never;
      const { automation, github } = reading({
        listEveryPullFile: vi.fn(async () => ({ files: ['src/ui/button.tsx', 'src/billing/charge.ts'], complete: true })),
        closingIssues: vi.fn(async () => [11]),
        // The issue now says billing is in scope; the lease does not.
        getIssue: vi.fn(async () => ({ number: 11, body: '## Expected paths\n\n- src/ui/button.tsx\n- src/billing/\n' })),
      });

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, CREW_PULL);

      expect(facts?.scope).toEqual({ crewBranch: true, issue: 11, closes: [11], declared: ['src/ui/button.tsx'], crossCutting: false });
      expect(github.getIssue).not.toHaveBeenCalled();
      expect(mergeDecision(facts as MergeFacts)).toMatchObject({ land: false, sendBack: { files: ['src/billing/charge.ts'] } });
    });

    it('reads the closing keywords in its body when GitHub’s list cannot be had', async () => {
      world.lease = BUTTON as never;
      const { automation } = reading({
        closingIssues: vi.fn(async () => {
          throw new Error('502: Bad Gateway');
        }),
        getIssue: vi.fn(async () => ({ number: 79, body: 'Fixed #11' })),
      });

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, CREW_PULL);

      expect(facts?.scope?.closes).toEqual([11]);
    });

    it('counts scope:cross-cutting from a person or the app, never from a crew account', async () => {
      world.lease = BUTTON as never;
      const labelled = (actor: string, viaApp = false) => [{ event: 'labeled', actor, viaApp, sha: null, label: 'scope:cross-cutting' }];
      const read = async (history: object[]) => {
        const { automation } = reading({ closingIssues: vi.fn(async () => [11]), listPullHistory: vi.fn(async () => history) });
        return (await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, { ...CREW_PULL, labels: ['scope:cross-cutting'] }))?.scope?.crossCutting;
      };

      expect(await read(labelled('janedoe'))).toBe(true);
      expect(await read(labelled('fleetadlc-exampleco[bot]', true))).toBe(true);
      expect(await read(labelled('exampleco-lead'))).toBe(false);
      expect(await read([])).toBe(false);
    });

    it('is not read for a pull request that is not on an agent/ branch', async () => {
      const { automation, github } = reading({ closingIssues: vi.fn(async () => []) });

      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, { ...CREW_PULL, headRef: 'system/revert-deadbeef' });

      expect(facts?.scope?.crewBranch).toBe(false);
      expect(github.closingIssues).not.toHaveBeenCalled();
    });
  });

  it('keeps heads a lead-only resolution carried from apart from heads with this diff, and names the lead who re-checks it', async () => {
    const { automation } = reading();
    automation.useCarriedHeads(async () => new Set(['before-a-fix']));
    automation.useResolutions(async () => '2026-09-30T11:00:00.000Z');

    const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL);

    expect([...(facts?.sameDiffAs ?? [])]).toEqual(['before-main-merge']);
    expect([...(facts?.carriedFrom ?? [])]).toEqual(['before-a-fix']);
    expect(facts?.leadRechecks).toBe('lead-reviewer');

    automation.useResolutions(async () => null);
    expect((await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL))?.leadRechecks).toBeNull();
  });

  describe('a pull request that changes AGENTS.md', () => {
    const BASE_AGENTS = '# Agent notes\n\nBuild with pnpm.\n\n## Human review\n\n- `config/` @janedoe\n\n## Invariants\n\nA bot never merges.\n';
    const ALONE = { ...PULL, requestedReviewers: [], requestedTeams: [] };

    /** The merge's answer for a pull request changing only AGENTS.md to `head`, approved by the lead alone, with `ci` green. */
    async function landing(head: string) {
      const { automation, github } = reading({
        listEveryPullFile: vi.fn(async () => ({ files: ['AGENTS.md'], complete: true })),
        listReviews: vi.fn(async () => [{ id: 1, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: null, commitId: 'head' }]),
        readFileAtRef: vi.fn(async (_repo: string, _path: string, ref: string) => (ref === 'head' ? head : BASE_AGENTS)),
      });
      const facts = await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, ALONE);
      return { facts, decision: mergeDecision(facts as MergeFacts), github };
    }

    it('waits for the person the base’s section names when it takes a rule out of it', async () => {
      // Merged on the lead's approval, it left every later change to config/
      // needing nobody.
      const { facts, decision, github } = await landing(BASE_AGENTS.replace('- `config/` @janedoe\n', ''));

      expect(github.readFileAtRef).toHaveBeenCalledWith('exampleco/app', 'AGENTS.md', 'head');
      expect(facts?.humansRequired).toEqual(['janedoe']);
      expect(decision.land).toBe(false);
      expect(decision.reason).toContain('janedoe');
    });

    it('lands on the lead’s approval alone when it changes only text outside the section', async () => {
      const { facts, decision } = await landing(BASE_AGENTS.replace('Build with pnpm.', 'Build with pnpm, then run make ci.'));

      expect(facts?.humansRequired).toEqual([]);
      expect(decision).toMatchObject({ land: true });
    });

    it('does not read the head’s copy for a pull request that leaves AGENTS.md alone', async () => {
      const { automation, github } = reading();

      await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL);

      expect(github.readFileAtRef).toHaveBeenCalledTimes(1);
      expect(github.readFileAtRef).toHaveBeenCalledWith('exampleco/app', 'AGENTS.md', 'main');
    });
  });

  it('fails, rather than deciding on part of it, when a list cannot be read to its end', async () => {
    const { automation } = reading({ listReviews: vi.fn(async () => Promise.reject(new Error('page 3 → 502'))) });

    await expect(automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL)).rejects.toThrow('page 3 → 502');
  });

  describe('review-gate as OpenADLC published it', () => {
    const APP_BOT = 'fleetadlc-exampleco[bot]';

    /** The gate the merge line reads, given the app's check run and the statuses on the head. */
    async function gateWith(input: {
      appId: number | null;
      run: 'pending' | 'success' | 'failure' | null;
      statuses: { state: string; creator: string }[];
    }) {
      const { github } = reading({
        request: vi.fn(async () => ({
          statuses: input.statuses.map((status) => ({ context: 'review-gate', state: status.state, creator: { login: status.creator } })),
        })),
        viewer: vi.fn(async () => ({ login: 'exampleco-crew' })),
      });
      const appGate = {
        appId: vi.fn(async () => input.appId),
        botLogin: vi.fn(async () => APP_BOT),
        standing: vi.fn(async () => (input.run ? { state: input.run, description: '' } : null)),
      };
      const automation = new Automation(config, { asBot: vi.fn(async () => github) } as never, appGate as never);
      return (await automation.mergeFacts({ fullName: 'exampleco/app', defaultBranch: 'main' }, PULL))?.gate;
    }

    it('reads the status the app set when the app has no Checks permission', async () => {
      // Every merge was refused with "not green" while GitHub showed it green:
      // only the automation account's status was read, and the app had set it.
      expect(await gateWith({ appId: null, run: null, statuses: [{ state: 'success', creator: APP_BOT }] })).toBe('success');
      expect(await gateWith({ appId: null, run: null, statuses: [{ state: 'success', creator: 'exampleco-crew' }] })).toBe('success');
    });

    it('never reads a status anybody else set, a bot’s token included', async () => {
      expect(await gateWith({ appId: null, run: null, statuses: [{ state: 'success', creator: 'exampleco-builder' }] })).toBeNull();
      expect(await gateWith({ appId: 7, run: null, statuses: [{ state: 'success', creator: 'exampleco-builder' }] })).toBeNull();
    });

    it('takes the more restrictive of the app’s check run and its status', async () => {
      // The check run failed to update, so an older success stood over the
      // newer pending status, and the merge line read the success.
      expect(await gateWith({ appId: 7, run: 'success', statuses: [{ state: 'pending', creator: APP_BOT }] })).toBe('pending');
      expect(await gateWith({ appId: 7, run: 'pending', statuses: [{ state: 'success', creator: APP_BOT }] })).toBe('pending');
      expect(await gateWith({ appId: 7, run: 'success', statuses: [{ state: 'error', creator: APP_BOT }] })).toBe('failure');
      expect(await gateWith({ appId: 7, run: 'success', statuses: [{ state: 'success', creator: APP_BOT }] })).toBe('success');
      expect(await gateWith({ appId: 7, run: 'success', statuses: [] })).toBe('success');
    });

    it('says so when the check run could not be updated, and still sets the status', async () => {
      world.crew = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const client = {
          getPullRequest: vi.fn(async () => ({ labels: [], headSha: 'head' })),
          setCommitStatus: vi.fn(async () => undefined),
        };
        const appGate = {
          appId: vi.fn(async () => 7),
          publish: vi.fn(async () => false),
          publishStatus: vi.fn(async () => true),
        };
        const automation = new Automation(config, { asBot: async () => client } as never, appGate as never);

        await automation.setReviewGate({ repoFullName: 'exampleco/app', prNumber: 79, sha: 'head', state: 'pending', description: 'waiting on lead-reviewer' });

        expect(appGate.publishStatus).toHaveBeenCalledWith('exampleco/app', 'head', 'pending', 'waiting on lead-reviewer');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('review-gate check run not updated on exampleco/app@head'));
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('holding a pull request for a person', () => {
  const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

  beforeEach(() => {
    // Nobody barred from authoring: the author check asks GitHub nothing.
    world.crew = [];
  });

  function github(pull: { labels: string[]; autoMerge: boolean }) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const statuses: { state: string; context: string; description: string }[] = [];
    const client = {
      addLabels: vi.fn(async (_repo: string, _n: number, labels: string[]) => void pull.labels.push(...labels)),
      getPullRequest: vi.fn(async () => ({ ...pull, headSha: HEAD })),
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return method === 'GET' ? { node_id: 'PR_kw31' } : {};
      }),
      setCommitStatus: vi.fn(async (_repo: string, _sha: string, status: { state: string; context: string; description: string }) => void statuses.push(status)),
    };
    return { client, calls, statuses };
  }

  it('labels it, turns auto-merge off as the app, and holds the gate pending', async () => {
    const pull = { labels: [] as string[], autoMerge: true };
    const bot = github(pull);
    const app = github(pull);
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => bot.client } as never, {
      client: vi.fn(async () => app.client),
      publish: vi.fn(async () => false),
      publishStatus: vi.fn(async () => false),
    } as never);

    const held = await automation.holdPull('janedoe/fleetadlc-testbed', 31);

    expect(pull.labels).toEqual(['needs-human']);
    // As the app, by the pull request's node id.
    expect(app.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /repos/janedoe/fleetadlc-testbed/pulls/31', 'POST /graphql']);
    expect(JSON.stringify(app.calls[1]!.body)).toContain('disablePullRequestAutoMerge');
    expect(JSON.stringify(app.calls[1]!.body)).toContain('PR_kw31');
    expect(held).toEqual({ autoMergeOff: true, gate: { state: 'pending', description: expect.stringContaining('needs-human') } });
    expect(bot.statuses).toEqual([{ state: 'pending', context: 'review-gate', description: expect.stringContaining('held for a person') }]);
  });

  it('keeps review-gate pending while needs-human is on, however the reviews stand', async () => {
    const labelled = github({ labels: ['needs-human'], autoMerge: false });
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => labelled.client } as never);
    const reviewsIn = { repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 31, sha: HEAD, state: 'success', description: 'every requested review has been posted' } as const;
    expect((await automation.setReviewGate(reviewsIn))?.state).toBe('pending');
    expect(labelled.statuses.at(-1)?.state).toBe('pending');

    // With the label off, the reviews decide again.
    const free = github({ labels: [], autoMerge: false });
    const again = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => free.client } as never);
    expect((await again.setReviewGate(reviewsIn))?.state).toBe('success');
  });

  it('keeps review-gate pending while its work is paused, saying so', async () => {
    // A paused pull request's gate went green, and auto-merge or a person could land it.
    const paused = github({ labels: ['fleetadlc:paused'], autoMerge: false });
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => paused.client } as never);
    const reviewsIn = { repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 31, sha: HEAD, state: 'success', description: 'every requested review has been posted' } as const;
    expect(await automation.setReviewGate(reviewsIn)).toEqual({ state: 'pending', description: expect.stringContaining('fleetadlc:paused') });
  });

  it('holds a paused item’s pull request at once: auto-merge off, the gate pending, and no needs-human', async () => {
    const pull = { labels: ['fleetadlc:paused'], autoMerge: true };
    const bot = github(pull);
    const app = github(pull);
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => bot.client } as never, {
      client: vi.fn(async () => app.client),
      publish: vi.fn(async () => false),
      publishStatus: vi.fn(async () => false),
    } as never);

    const held = await automation.pausePull('janedoe/fleetadlc-testbed', 31);

    expect(pull.labels).toEqual(['fleetadlc:paused']);
    expect(JSON.stringify(app.calls[1]?.body)).toContain('disablePullRequestAutoMerge');
    expect(held).toEqual({ autoMergeOff: true, gate: { state: 'pending', description: expect.stringContaining('paused') } });
  });

  it('holds the gate when the labels cannot be read, rather than going green on a pull request a person may have held', async () => {
    const unreadable = github({ labels: ['needs-human'], autoMerge: false });
    unreadable.client.getPullRequest.mockRejectedValue(new Error('GitHub answered 502'));
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => unreadable.client } as never);
    const reviewsIn = { repoFullName: 'janedoe/fleetadlc-testbed', prNumber: 31, sha: HEAD, state: 'success', description: 'every requested review has been posted' } as const;
    const gate = await automation.setReviewGate(reviewsIn);
    expect(gate).toMatchObject({ state: 'pending', description: expect.stringContaining('could not read') });
  });

  it('asks nothing of GraphQL when auto-merge is not on', async () => {
    const pull = { labels: [] as string[], autoMerge: false };
    const bot = github(pull);
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => bot.client } as never);
    expect(await automation.holdPull('janedoe/fleetadlc-testbed', 31)).toMatchObject({ autoMergeOff: true, gate: { state: 'pending' } });
    expect(bot.calls).toEqual([]);
  });
});

/**
 * A reviewer GitHub will never ask — a login with no account, or one nobody
 * invited — is said on the gate, not waited on.
 */
describe('a reviewer who cannot review', () => {
  const automation = new Automation({ review: { lead: 'lead-reviewer', second: 'second-reviewer', maxRounds: 3 }, humans: [] } as never, {} as never);
  const cannot = new Map([['janedoe-reviewer', 'there is no such GitHub account']]);
  const gate = (input: Partial<Parameters<Automation['computeReviewGate']>[0]>) =>
    automation.computeReviewGate({ draft: false, requestedReviewers: [], postedReviewers: [], humansRequired: [], humansApproved: [], ...input });

  it('fails the gate with why, rather than waiting on them', () => {
    expect(gate({ humansRequired: ['janedoe-reviewer'], cannotReview: cannot })).toEqual({
      state: 'failure',
      description: '@janedoe-reviewer cannot be asked for a review: there is no such GitHub account',
    });
  });

  it('keeps its usual words when nothing is known, so an outage calls nobody missing', () => {
    expect(gate({ humansRequired: ['janedoe-reviewer'], cannotReview: new Map() })).toEqual({ state: 'pending', description: 'waiting on @janedoe-reviewer' });
  });

  it('waits on the reviews that can still come first, and never names the one that cannot', () => {
    const waiting = gate({
      requestedReviewers: ['lead-reviewer', 'second-reviewer'],
      humansRequired: ['janedoe-reviewer'],
      cannotReview: new Map([...cannot, ['second-reviewer', 'GitHub says they are not a collaborator']]),
    });
    expect(waiting).toEqual({ state: 'pending', description: 'waiting on lead-reviewer' });
    expect(
      gate({
        requestedReviewers: ['lead-reviewer', 'second-reviewer'],
        postedReviewers: ['lead-reviewer'],
        cannotReview: new Map([['second-reviewer', 'GitHub says they are not a collaborator']]),
      }),
    ).toEqual({ state: 'failure', description: 'second-reviewer cannot be asked for a review: GitHub says they are not a collaborator' });
  });

  it('fails, rather than passing, when one that cannot be asked has only commented', () => {
    // On a public repository an account not yet a collaborator can comment,
    // and the gate went green with no approval from it.
    const commented = gate({
      requestedReviewers: ['lead-reviewer', 'second-reviewer'],
      postedReviewers: ['lead-reviewer', 'second-reviewer'],
      approvers: ['lead-reviewer', 'second-reviewer'],
      approvedBy: ['lead-reviewer'],
      cannotReview: new Map([['second-reviewer', 'GitHub says they are not a collaborator']]),
    });
    expect(commented).toEqual({ state: 'failure', description: 'second-reviewer cannot be asked for a review: GitHub says they are not a collaborator' });
  });

  it('passes once the person approves, whatever was said of them', () => {
    expect(gate({ humansRequired: ['janedoe-reviewer'], humansApproved: ['janedoe-reviewer'], cannotReview: cannot }).state).toBe('success');
  });
});

describe('asking GitHub for the reviews', () => {
  beforeEach(() => {
    world.audited = [];
    world.crew = [
      { name: 'fleetadlc-sydney-janedoe', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'fleetadlc-sydney-janedoe' },
      { name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'janedoe-reviewer' },
      { name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', githubLogin: 'janedoe-fleetadlc-flow' },
    ];
  });

  function github(refuse: (logins: string[]) => GitHubApiError | null) {
    const asked: string[][] = [];
    const client = {
      getPullRequest: vi.fn(async () => ({ author: 'fleetadlc-atlas-janedoe', labels: [] })),
      requestReviewers: vi.fn(async (_repo: string, _pr: number, logins: string[]) => {
        asked.push(logins);
        const refused = refuse(logins);
        if (refused) throw refused;
      }),
      request: vi.fn(async () => {
        throw new GitHubApiError(502, '/users/x', 'bad gateway');
      }),
    };
    const standings = new ReviewerStandings();
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => client } as never, null, standings);
    return { automation, asked, standings };
  }

  const noSuchUser = (logins: string[]) =>
    logins.includes('janedoe-reviewer')
      ? new GitHubApiError(422, '/repos/exampleco/api/pulls/4/requested_reviewers', JSON.stringify({ message: "Could not resolve user with login 'janedoe-reviewer'" }))
      : null;

  it('asks the others when GitHub refuses one, and says who it refused and why', async () => {
    const { automation, asked } = github(noSuchUser);
    const refused = await automation.requestReviewers('exampleco/api', 4, ['fleetadlc-sydney-janedoe', 'second-reviewer']);
    expect(refused).toEqual([
      { seat: 'second-reviewer', login: 'janedoe-reviewer', reason: 'there is no such GitHub account', words: "Could not resolve user with login 'janedoe-reviewer'" },
    ]);
    expect(asked).toEqual([['fleetadlc-sydney-janedoe', 'janedoe-reviewer'], ['fleetadlc-sydney-janedoe'], ['janedoe-reviewer']]);
    // In the audit in GitHub's words, not swallowed.
    expect(world.audited).toEqual([
      expect.objectContaining({
        action: 'review.request_refused',
        target: 'exampleco/api#4',
        payload: expect.objectContaining({ login: 'janedoe-reviewer', github: "Could not resolve user with login 'janedoe-reviewer'" }),
      }),
    ]);
  });

  it('remembers the refusal, so every later gate says why instead of waiting', async () => {
    const { automation } = github(noSuchUser);
    await automation.requestReviewers('exampleco/api', 4, ['fleetadlc-sydney-janedoe', 'second-reviewer']);
    const cannot = await automation.cannotReviewHere('exampleco/api', { seats: ['fleetadlc-sydney-janedoe', 'second-reviewer'], humans: [] });
    expect([...cannot]).toEqual([['second-reviewer', 'there is no such GitHub account']]);
  });

  it('still throws a failure that says nothing about the reviewer', async () => {
    const { automation } = github(() => new GitHubApiError(403, '/repos/exampleco/api/pulls/4/requested_reviewers', '{"message":"Resource not accessible by integration"}'));
    await expect(automation.requestReviewers('exampleco/api', 4, ['fleetadlc-sydney-janedoe'])).rejects.toThrow(/403/);
  });

  it('calls no person missing when GitHub cannot be asked about them', async () => {
    const { automation } = github(() => null);
    const cannot = await automation.cannotReviewHere('exampleco/api', { seats: [], humans: ['janedoe'] });
    expect(cannot.size).toBe(0);
  });

  it('uses what the configuration check last learned about a person', async () => {
    const { automation, standings } = github(() => null);
    standings.record('exampleco/api', 'janedoe', { state: 'cannot-review', reason: 'janedoe is not a collaborator on exampleco/api' });
    const cannot = await automation.cannotReviewHere('exampleco/api', { seats: [], humans: ['JaneDoe'] });
    expect([...cannot]).toEqual([['janedoe', 'janedoe is not a collaborator on exampleco/api']]);
  });

  // `@owner` is an organization on GitHub; the gate said it was not a
  // collaborator, which sends a person to invite an organization.
  it('says `@owner` is the template’s placeholder, without asking GitHub', async () => {
    const { automation, standings } = github(() => null);
    standings.record('exampleco/api', 'owner', { state: 'not-a-person', reason: 'owner is an organization, not a person' });
    const cannot = await automation.cannotReviewHere('exampleco/api', { seats: [], humans: ['owner'] });
    expect([...cannot]).toEqual([['owner', 'it is the AGENTS.md template’s placeholder; name who must approve']]);
    expect(
      automation.computeReviewGate({
        draft: false,
        requestedReviewers: [],
        postedReviewers: [],
        humansRequired: ['owner'],
        humansApproved: [],
        cannotReview: cannot,
      }),
    ).toEqual({
      state: 'failure',
      description: '@owner cannot be asked for a review: it is the AGENTS.md template’s placeholder; name who must approve',
    });
  });

  it('says an organization named as a reviewer is not a person', async () => {
    const { automation, standings } = github(() => null);
    standings.record('exampleco/api', 'exampleco', { state: 'not-a-person', reason: 'exampleco is an organization, not a person' });
    const cannot = await automation.cannotReviewHere('exampleco/api', { seats: [], humans: ['exampleco'] });
    expect([...cannot]).toEqual([['exampleco', 'exampleco is an organization, not a person']]);
  });

  // A seat refused before the bot was let in stayed "cannot be asked" for the
  // hour its answer was kept, after its access was put right.
  it('forgets what GitHub refused about a seat once the crew’s access changes', async () => {
    const { automation, standings } = github(noSuchUser);
    standings.record('exampleco/api', 'janedoe', { state: 'cannot-review', reason: 'janedoe is not a collaborator on exampleco/api' });
    await automation.requestReviewers('exampleco/api', 4, ['fleetadlc-sydney-janedoe', 'second-reviewer']);
    expect((await automation.cannotReviewHere('exampleco/api', { seats: ['second-reviewer'], humans: [] })).size).toBe(1);
    await automation.forgetCrewStandings();
    expect((await automation.cannotReviewHere('exampleco/api', { seats: ['second-reviewer'], humans: [] })).size).toBe(0);
    // A person's answer is not the crew's to forget.
    expect(standings.known('exampleco/api', 'janedoe')).not.toBeNull();
  });
});

describe('reviews of a head a conflict resolution led from', () => {
  const BEFORE = 'b'.repeat(40);
  const AFTER = 'a'.repeat(40);
  // The resolution brought the base's Makefile line in, so the diff against
  // the base is not the one the reviewers approved.
  const client = { diffFingerprint: vi.fn(async (_repo: string, _base: string, sha: string) => (sha === AFTER ? 'resolved' : 'approved')) };
  const reviews = [
    { commitId: BEFORE, state: 'APPROVED', user: 'second' },
    { commitId: AFTER, state: 'APPROVED', user: 'lead' },
  ];

  it('count for the new head when the lead alone re-checked the resolution', async () => {
    const seen = await automation.onThisDiff(client, 'exampleco/api', 'main', AFTER, reviews, new Set([BEFORE]));
    expect(seen.map((review) => review.user)).toEqual(['second', 'lead']);
  });

  it('do not, otherwise: a changed diff is reviewed again', async () => {
    const seen = await automation.onThisDiff(client, 'exampleco/api', 'main', AFTER, reviews);
    expect(seen.map((review) => review.user)).toEqual(['lead']);
  });
});

describe('a person’s review label on a repository whose automation account has triage', () => {
  const TRIAGE_REFUSAL = () =>
    new GitHubApiError(403, '/repos/exampleco/api/issues/12/labels', '{"message":"You do not have permission to create labels on this repository."}');

  afterEach(async () => {
    (await import('./people.js')).forgetRepoAccess();
  });

  it('is made by the app first, then put on, since adding one that is not there makes GitHub create it as the adder', async () => {
    const made = new Set<string>();
    const posted: { path: string; body: unknown }[] = [];
    (await import('./people.js')).askAsTheApp(async () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        posted.push({ path, body });
        made.add((body as { name: string }).name);
        return {} as T;
      },
    }));
    const client = {
      getPullRequest: vi.fn(async () => ({ labels: [] as string[] })),
      removeLabel: vi.fn(async () => undefined),
      // Triage may put a label on, but not make one.
      addLabels: vi.fn(async (_repo: string, _number: number, labels: string[]) => {
        if (labels.some((label) => !made.has(label))) throw TRIAGE_REFUSAL();
      }),
    };
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => client } as never);

    await automation.setHumanReviewLabels('exampleco/api', 12, ['janedoe']);

    expect(posted).toEqual([
      {
        path: '/repos/exampleco/api/labels',
        body: { name: 'review:human:janedoe', color: 'd4a017', description: "Waiting on janedoe's review: AGENTS.md names them for a path this changes" },
      },
    ]);
    expect(client.addLabels).toHaveBeenCalledWith('exampleco/api', 12, ['review:human:janedoe']);
  });

  it('counts one the repository already has as made', async () => {
    (await import('./people.js')).askAsTheApp(async () => ({
      request: async <T>(): Promise<T> => {
        throw new GitHubApiError(422, '/repos/exampleco/api/labels', '{"message":"Validation Failed","errors":[{"resource":"Label","code":"already_exists","field":"name"}]}');
      },
    }));
    const client = {
      getPullRequest: vi.fn(async () => ({ labels: [] as string[] })),
      removeLabel: vi.fn(async () => undefined),
      addLabels: vi.fn(async () => undefined),
    };
    const automation = new Automation({ automationBot: null } as BridgeConfig, { asBot: async () => client } as never);

    await automation.setHumanReviewLabels('exampleco/api', 12, ['janedoe']);

    expect(client.addLabels).toHaveBeenCalledWith('exampleco/api', 12, ['review:human:janedoe']);
  });
});

describe('the lead’s turn after a lead-only resolution of a conflict', () => {
  const BEFORE = 'b'.repeat(40);
  const AFTER = 'a'.repeat(40);
  const RESOLVED_AT = '2026-09-30T11:00:00.000Z';
  const seat = (name: string) => `Approved.\n\n<!-- fleetadlc-seat:${name} -->`;

  /** The reviews standing on AFTER, with the carry wired as main.ts wires it, over the real resolution round's events. */
  function standing(reviews: Record<string, unknown>[], resolution: 'lead-only' | 'none' = 'lead-only') {
    world.crew = [
      { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'exampleco-lead' },
      { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'exampleco-second' },
    ];
    const log =
      resolution === 'lead-only'
        ? [{ at: RESOLVED_AT, payload: { repo: 'app', pr: 70, issue: 7, files: ['Makefile'], review: 'lead-only', from: BEFORE, to: AFTER, at: RESOLVED_AT } }]
        : [];
    const rounds = new ConflictRounds({ taskService: {} as never, client: async () => null, backToBuild: async () => undefined, events: async () => log });
    const github = {
      listPullFiles: vi.fn(async () => ['apps/console/src/page.tsx']),
      listEveryPullFile: vi.fn(async () => ({ files: ['apps/console/src/page.tsx'], complete: true, renamedFrom: [] })),
      listReviews: vi.fn(async () => reviews),
      readFileAtRef: vi.fn(async () => '# Agent notes\n\n## Human review\n\n- `config/` @janedoe\n'),
      // The resolution brought the base's Makefile line in: the diff moved.
      diffFingerprint: vi.fn(async (_repo: string, _base: string, sha: string) => (sha === AFTER ? 'resolved' : 'approved')),
    };
    const reading = new Automation(config, { asBot: vi.fn(async () => github) } as never);
    reading.useCarriedHeads((repoName, prNumber, head) => rounds.carriedTo(repoName, prNumber, head));
    reading.useResolutions((repoName, prNumber, head) => rounds.resolvedAt(repoName, prNumber, head));
    return reading.reviewStanding('exampleco/app', { number: 70, draft: false, labels: [], head: { sha: AFTER }, baseRef: 'main' });
  }

  const second = { id: 1, user: 'exampleco-second', state: 'COMMENTED', body: seat('second-reviewer'), submittedAt: '2026-09-30T10:00:00Z', commitId: BEFORE };
  const leadBefore = { id: 2, user: 'exampleco-lead', state: 'APPROVED', body: seat('lead-reviewer'), submittedAt: '2026-09-30T10:05:00Z', commitId: BEFORE };

  it('holds the gate, and makes the lead’s re-check due from the resolution, when the lead approved only the head before it', async () => {
    const result = await standing([second, leadBefore]);

    expect(result.posted).toEqual(['second-reviewer']);
    expect(result.approved).toEqual([]);
    expect(result.gate.state).toBe('pending');
    expect(result.leadDue).toEqual({ seat: 'lead-reviewer', since: RESOLVED_AT });
  });

  it('passes once the lead approves the resolution head itself', async () => {
    const result = await standing([second, leadBefore, { ...leadBefore, id: 3, commitId: AFTER, submittedAt: '2026-09-30T11:30:00Z' }]);

    expect(result.posted).toEqual(['lead-reviewer', 'second-reviewer']);
    expect(result.approved).toEqual(['lead-reviewer']);
    expect(result.gate.state).toBe('success');
    expect(result.leadDue).toBeNull();
  });

  it('counts no review of the head before, the other seat’s included, when no resolution carried it', async () => {
    const result = await standing([second, leadBefore], 'none');

    expect(result.posted).toEqual([]);
    expect(result.leadDue).toBeNull();
  });
});

describe('the per-person review labels', () => {
  it('takes off a bare review:human and puts on one label per person', async () => {
    const people = await import('./people.js');
    const app = { request: vi.fn(async () => ({})) };
    people.askAsTheApp(async () => app as never);
    try {
      const calls: string[] = [];
      const client = {
        getPullRequest: vi.fn(async () => ({ labels: ['review:human', 'stage:review'] })),
        removeLabel: vi.fn(async (_repo: string, _n: number, label: string) => void calls.push(`remove ${label}`)),
        addLabels: vi.fn(async (_repo: string, _n: number, labels: string[]) => void calls.push(...labels.map((label) => `add ${label}`))),
      };
      const labelling = new Automation(config, { asBot: vi.fn(async () => client) } as never);

      await labelling.setHumanReviewLabels('exampleco/app', 79, ['janedoe']);

      expect(calls).toEqual(['remove review:human', 'add review:human:janedoe']);
      expect(app.request).toHaveBeenCalledWith('POST', '/repos/exampleco/app/labels', expect.objectContaining({ name: 'review:human:janedoe' }));
    } finally {
      people.forgetRepoAccess();
    }
  });
});
