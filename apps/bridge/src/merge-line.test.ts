import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CI_REQUEST_WAIT_MS, MergeLine, REQUIRED_CHECKS, UPDATE_WAIT_MS, askedForCi, heldForPerson, verdictFor } from './merge-line.js';
import { REQUIRED_CHECK, REVIEW_GATE_CHECK } from '@fleetadlc/shared';

const green = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
const red = (name: string) => ({ name, status: 'completed', conclusion: 'failure' });
const running = (name: string) => ({ name, status: 'in_progress', conclusion: null });

describe('whether a head may land', () => {
  it('lands only when every required check has passed on this commit', () => {
    expect(verdictFor(REQUIRED_CHECKS.map(green))).toBe('green');
  });

  it('treats a check that has not reported as a reason to wait, not consent', () => {
    // The whole point of the line is that nothing lands untested against the
    // main it is about to become part of.
    expect(verdictFor([green(REQUIRED_CHECK)])).toBe('pending');
    expect(verdictFor([])).toBe('pending');
  });

  it('waits while a required check is still running', () => {
    expect(verdictFor([green(REQUIRED_CHECK), running(REVIEW_GATE_CHECK)])).toBe('pending');
  });

  it('is red as soon as one required check failed, whatever else is pending', () => {
    expect(verdictFor([red(REQUIRED_CHECK), running(REVIEW_GATE_CHECK)])).toBe('red');
  });

  it('ignores checks nothing required', () => {
    expect(verdictFor([...REQUIRED_CHECKS.map(green), red('optional-lint')])).toBe('green');
  });
});

describe('a check run more than once on a head', () => {
  it('is read by its newest run: a rerun that passed answers the failure it reran', () => {
    const ci = (id: number, conclusion: string) => ({ id, name: REQUIRED_CHECK, status: 'completed', conclusion });
    expect(verdictFor([ci(1, 'failure'), ci(2, 'success'), green(REVIEW_GATE_CHECK)])).toBe('green');
    expect(verdictFor([ci(2, 'success'), ci(3, 'failure'), green(REVIEW_GATE_CHECK)])).toBe('red');
  });
});

describe('a check that produced no verdict', () => {
  const cancelled = (name: string) => ({ name, status: 'completed', conclusion: 'cancelled' });
  const skipped = (name: string) => ({ name, status: 'completed', conclusion: 'skipped' });

  it('holds the line rather than throwing the pull request out of it', () => {
    // A run superseded by the next push is cancelled. Nothing about the change
    // failed; nothing about it was tested either.
    expect(verdictFor([green(REQUIRED_CHECK), cancelled(REVIEW_GATE_CHECK)])).toBe('pending');
    expect(verdictFor([green(REQUIRED_CHECK), skipped(REVIEW_GATE_CHECK)])).toBe('pending');
  });

  it('does not mask a check that genuinely failed', () => {
    expect(verdictFor([red(REQUIRED_CHECK), cancelled(REVIEW_GATE_CHECK)])).toBe('red');
  });
});

const decide = vi.hoisted(() => vi.fn());
// The rules themselves are `mergeDecision`'s, tested in automation.test.ts;
// here it is what the line does with the answer.
vi.mock('./automation.js', () => ({ mergeDecision: decide }));

const store = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  states: [] as { state: string; detail?: string }[],
  audits: [] as Record<string, unknown>[],
  auditFails: false,
  configFails: false,
  settingsRead: true,
  entry: { id: 'line-1', prNumber: 31, state: 'testing', detail: null as string | null, headSha: null as string | null },
  entered: [] as number[],
  /** The stage of the issue the front pull request is for, as the board has it. */
  issueStage: 'review' as string,
}));

// The install's settings as the bridge reads them; failing, as a database
// that cannot be asked makes them.
vi.mock('./effective-config.js', () => ({
  effectiveConfig: vi.fn(async () => {
    if (store.configFails) throw new Error('the settings cannot be read');
    return {
      automationBot: null,
      settingsRead: store.settingsRead,
      bridgeMergeOff: (store.settings.bridgeMergeOff ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean),
    };
  }),
}));

vi.mock('@fleetadlc/db', () => ({
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

  audit: vi.fn(async (entry: Record<string, unknown>) => {
    if (store.auditFails) throw new Error('the audit table refused the row');
    store.audits.push(entry);
  }),
  bots: { listBots: vi.fn(async () => []), getBotById: vi.fn(async () => null) },
  mergeLines: {
    head: vi.fn(async () => ({ ...store.entry })),
    setState: vi.fn(async (_id: string, state: string, patch: { detail?: string; headSha?: string | null } = {}) => {
      store.states.push({ state, detail: patch.detail });
      store.entry = { ...store.entry, state, detail: patch.detail ?? null, headSha: patch.headSha ?? store.entry.headSha };
    }),
    leave: vi.fn(async () => undefined),
    enter: vi.fn(async (input: { prNumber: number }) => void store.entered.push(input.prNumber)),
  },
  issues: {
    listIssues: vi.fn(async () => [{ number: 11, prNumber: 31 }]),
    getIssue: vi.fn(async () => ({ number: 11, prNumber: 31, stage: store.issueStage })),
  },
  repos: { getRepoByName: vi.fn(async () => ({ id: 'repo-1', name: 'fleetadlc', fullName: 'janedoe/fleetadlc', ownerBotId: null, defaultBranch: 'main' })) },
  settings: { allSettings: vi.fn(async () => store.settings) },
  tasks: { listTasks: vi.fn(async () => []) },
}));

describe('the front of the line, green and up to date', () => {
  const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
  const MADE = 'feed0000feed0000feed0000feed0000feed0000';
  const APPROVALS = [{ reviewer: 'fleetadlc-sydney-janedoe', person: false, commitId: HEAD, ofHead: true }];

  function line(options: { land?: boolean; reason?: string; app?: boolean; pull?: Record<string, unknown> } = {}) {
    const pull = {
      number: 31,
      draft: false,
      merged: false,
      state: 'open',
      headRef: 'agent/fleetadlc-atlas-janedoe/11-issue-11',
      headSha: HEAD,
      baseRef: 'main',
      labels: [],
      mergeableState: 'clean',
      autoMerge: false,
      headRepoFullName: 'janedoe/fleetadlc',
      requestedReviewers: [],
      requestedTeams: [],
      ...options.pull,
    };
    const github = {
      getPullRequest: vi.fn(async () => ({ ...pull })),
      updateBranch: vi.fn(async () => ({ updated: true, conflict: false, message: 'updated' })),
      mergeIntoBranch: vi.fn(async (): Promise<{ merged: boolean; conflict: boolean; sha: string | null; parents: string[]; message: string }> => ({ merged: true, conflict: false, sha: MADE, parents: [HEAD, 'main0000'], message: 'merged' })),
      behindBy: vi.fn(async () => 0),
      checksFor: vi.fn(async () => REQUIRED_CHECKS.map(green)),
      comment: vi.fn(async () => null),
      mergePullRequest: vi.fn(async () => ({ sha: 'never' })),
    };
    const facts = { land: options.land ?? true, reason: options.reason ?? 'every requested reviewer approved', approvals: APPROVALS };
    const automation = {
      mergeFacts: vi.fn(async () => facts),
      mergeAsApp: vi.fn(async () => (options.app === false ? null : { sha: 'merged00merged00' })),
      setCiLabel: vi.fn(async () => 'app' as const),
    };
    const config = { automationBot: null, organization: 'janedoe', gitHubClientId: '', webhookSecret: '', humans: [], publicUrl: '' };
    const clock = { now: 1_000_000 };
    return {
      line: new MergeLine(config as never, { asBot: async () => github } as never, {} as never, automation as never, () => clock.now),
      github,
      automation,
      clock,
    };
  }

  it('asks GitHub’s CI to run, once, on a crew pull request that has none on its head, and waits for it', async () => {
    // GitHub's CI runs on a crew pull request only with adlc:ci on it. Put on
    // here, after the lead approved and once it is up to date, the one run is
    // on the head that lands.
    const { line: merge, github, automation, clock } = line();
    github.checksFor.mockResolvedValue([green(REVIEW_GATE_CHECK)]);

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'testing', detail: 'asked GitHub’s CI to run on c0ffee0'.replace('’', "'") });
    expect(automation.setCiLabel).toHaveBeenCalledWith('janedoe/fleetadlc', 31, true);
    expect(store.audits).toEqual([{ actor: 'fleetadlc-app', action: 'ci.requested', target: 'fleetadlc#31', payload: { head: HEAD, again: false } }]);
    expect(askedForCi('janedoe/fleetadlc', 31, clock.now)).toBe(true);
    expect(automation.mergeAsApp).not.toHaveBeenCalled();
  });

  it('waits for the run while the label is on, and puts it on again when no run appeared', async () => {
    const { line: merge, github, automation, clock } = line({ pull: { labels: ['adlc:ci'] } });
    github.checksFor.mockResolvedValue([green(REVIEW_GATE_CHECK)]);

    await merge.advance('fleetadlc');
    clock.now += CI_REQUEST_WAIT_MS - 1;
    await merge.advance('fleetadlc');
    expect(automation.setCiLabel).not.toHaveBeenCalled();

    clock.now += 2;
    await merge.advance('fleetadlc');
    expect(automation.setCiLabel.mock.calls).toEqual([
      ['janedoe/fleetadlc', 31, false],
      ['janedoe/fleetadlc', 31, true],
    ]);
    expect(store.audits.at(-1)).toMatchObject({ action: 'ci.requested', payload: { again: true } });
  });

  it('asks for no new run at the month’s CI minutes cap, and says why on the card, but lets a run already asked for finish', async () => {
    const cap = 'GitHub Actions minutes this month reached the cap of 2,000 (2,004 used): no more CI is asked for until it is raised in Costs, or the month turns';
    const { line: merge, github, automation } = line();
    github.checksFor.mockResolvedValue([green(REVIEW_GATE_CHECK)]);
    merge.useCiCap(async () => cap);

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'testing', detail: cap });
    expect(automation.setCiLabel).not.toHaveBeenCalled();

    // One already asked for, its label on: the line waits for it, cap or not.
    const asked = line({ pull: { labels: ['adlc:ci'] } });
    asked.github.checksFor.mockResolvedValue([green(REVIEW_GATE_CHECK)]);
    asked.line.useCiCap(async () => cap);
    expect(await asked.line.advance('fleetadlc')).toMatchObject({ detail: expect.stringContaining('waiting for GitHub') });

    // Raised, or a new month: the next pass asks.
    merge.useCiCap(async () => null);
    await merge.advance('fleetadlc');
    expect(automation.setCiLabel).toHaveBeenCalledWith('janedoe/fleetadlc', 31, true);
  });

  it('asks nothing for a person’s pull request, whose CI runs as it always did', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    const { line: merge, github, automation } = line({ pull: { headRef: 'janedoe/fix-typo' } });
    github.checksFor.mockResolvedValue([green(REVIEW_GATE_CHECK)]);

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'testing', detail: 'waiting for checks' });
    expect(automation.setCiLabel).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    store.settings = {};
    store.states = [];
    store.audits = [];
    store.auditFails = false;
    store.configFails = false;
    store.settingsRead = true;
    store.entry = { id: 'line-1', prNumber: 31, state: 'testing', detail: null, headSha: null };
    store.issueStage = 'review';
    decide.mockReset();
  });

  it('skips a pull request whose issue is not in review, instead of landing it', async () => {
    // A person moved the card back to Build; a reviewer that finished after
    // that turned the gate green and the pull request was let back in.
    store.issueStage = 'build';
    decide.mockReturnValue({ land: true, reason: 'every requested reviewer approved', approvals: APPROVALS });
    const { mergeLines } = await import('@fleetadlc/db');
    const { line: merge, github, automation } = line();

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'left', detail: 'left the line: its issue #11 is in build, not review' });

    expect(mergeLines.leave).toHaveBeenCalledWith('repo-1', 31);
    expect(automation.mergeAsApp).not.toHaveBeenCalled();
    expect(github.updateBranch).not.toHaveBeenCalled();
    expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, 'Leaving the merge line: its issue #11 is in build, not review.');
  });

  it('opens a resolution round for a branch that conflicts, not the whole round back in build', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(2);
    github.updateBranch.mockResolvedValue({ updated: false, conflict: true, message: 'merge conflict' });
    const backToBuild = vi.fn(async () => undefined);
    const start = vi.fn(async () => 'resolving' as const);
    merge.useSendBack(backToBuild);
    merge.useConflictRounds({ start, unstarted: vi.fn(async () => null) });

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'failed' });

    expect(start).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, baseRef: 'main' });
    expect(backToBuild).not.toHaveBeenCalled();
    expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, 'Leaving the merge line: the branch conflicts with main.');
  });

  it('waits, and opens no conflict round, when the head moved before GitHub made the update', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(2);
    github.updateBranch.mockResolvedValue({ updated: false, conflict: false, message: 'the head moved to 0ther00 since it was read' });
    const backToBuild = vi.fn(async () => undefined);
    const start = vi.fn(async () => 'resolving' as const);
    merge.useSendBack(backToBuild);
    merge.useConflictRounds({ start, unstarted: vi.fn(async () => null) });

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'waiting', detail: 'the head moved to 0ther00 since it was read' });

    expect(store.states.at(-1)).toMatchObject({ state: 'waiting' });
    expect(start).not.toHaveBeenCalled();
    expect(backToBuild).not.toHaveBeenCalled();
    expect(github.comment).not.toHaveBeenCalled();
  });

  it('asks for one update of a head, and waits while GitHub makes it, then asks again if it never came', async () => {
    const { line: merge, github, clock } = line();
    github.behindBy.mockResolvedValue(2);

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'updating' });
    expect(store.entry).toMatchObject({ state: 'updating', headSha: HEAD });
    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'updating', detail: 'still updating from main' });
    clock.now += UPDATE_WAIT_MS - 1;
    await merge.advance('fleetadlc');
    expect(github.updateBranch).toHaveBeenCalledTimes(1);

    clock.now += 2;
    await merge.advance('fleetadlc');
    expect(github.updateBranch).toHaveBeenCalledTimes(2);
  });

  it('asks for an update of a head it has not asked from yet', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(2);
    store.entry = { ...store.entry, state: 'updating', headSha: 'earlier0' };

    await merge.advance('fleetadlc');

    expect(github.updateBranch).toHaveBeenCalledWith('janedoe/fleetadlc', 31, HEAD);
  });

  it('sends a crew pull request that strayed outside its lease back to its builder, not to a person', async () => {
    const reason =
      'it changes 2 files outside the paths its lease declared: `src/auth/session.ts`, `src/billing/charge.ts`. Take them out of the branch, or ask for them with a `plan_change` marker';
    decide.mockReturnValue({ land: false, reason, approvals: [], sendBack: { files: ['src/auth/session.ts', 'src/billing/charge.ts'] } });
    const { line: merge, github, automation } = line();
    const backToBuild = vi.fn(async (_input: unknown) => undefined);
    merge.useSendBack(backToBuild);

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'failed', detail: 'changes files outside its lease; sent back to build' });

    expect(automation.mergeAsApp).not.toHaveBeenCalled();
    expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, `Leaving the merge line: ${reason}.`);
    expect(backToBuild).toHaveBeenCalledWith({
      repoName: 'fleetadlc',
      prNumber: 31,
      reason: `The branch left the merge line: ${reason}, run fleetadlc-ci, and push.`,
      leasePathsOnly: true,
    });
    // Nothing here is a person's: no needs-human, no "waiting to be merged".
    expect(JSON.stringify(github.comment.mock.calls)).not.toContain('needs-human');
    expect(JSON.stringify(github.comment.mock.calls)).not.toContain('waiting to be merged');
    expect(store.states.at(-1)).toMatchObject({ state: 'failed' });
  });

  it('waits, and merges nothing, when it cannot tell whether the branch is behind', async () => {
    // Read as 0, a failed comparison skipped the update and landed a branch
    // whose CI never ran against the main it joined.
    const { line: merge, github } = line();
    github.behindBy.mockRejectedValue(new Error('502 Bad Gateway'));

    const step = await merge.advance('fleetadlc');

    expect(step).toMatchObject({ state: 'waiting', detail: expect.stringContaining('could not compare it with main') });
    expect(github.updateBranch).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(store.states.at(-1)).toMatchObject({ state: 'waiting' });
  });

  it('notes a stacked branch’s update before making it, and records the commit it made', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(1);
    const order: string[] = [];
    const updating = vi.fn(async () => {
      order.push('noted');
      return true;
    });
    github.mergeIntoBranch.mockImplementation(async () => {
      order.push('merged');
      return { merged: true, conflict: false, sha: MADE, parents: [HEAD, 'main0000'], message: 'merged' };
    });
    const made = vi.fn(async () => undefined);
    merge.useStacking({ waitingOn: vi.fn(async () => null), updating, made });

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'updating' });

    expect(updating).toHaveBeenCalledWith({ repoName: 'fleetadlc', repoFullName: 'janedoe/fleetadlc', prNumber: 31, issue: 11, baseRef: 'main', headSha: HEAD });
    expect(order).toEqual(['noted', 'merged']);
    expect(github.mergeIntoBranch).toHaveBeenCalledWith('janedoe/fleetadlc', 'agent/fleetadlc-atlas-janedoe/11-issue-11', 'main');
    expect(github.updateBranch).not.toHaveBeenCalled();
    expect(made).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, from: HEAD, to: MADE });
  });

  it('records a stacked update that conflicted as making nothing, and opens the resolution round', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(1);
    github.mergeIntoBranch.mockResolvedValue({ merged: false, conflict: true, sha: null, parents: [], message: 'Merge conflict' });
    const made = vi.fn(async () => undefined);
    const start = vi.fn(async () => 'resolving' as const);
    merge.useSendBack(vi.fn(async () => undefined));
    merge.useConflictRounds({ start, unstarted: vi.fn(async () => null) });
    merge.useStacking({ waitingOn: vi.fn(async () => null), updating: vi.fn(async () => true), made });

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'failed' });

    expect(made).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, from: HEAD, to: null });
    expect(start).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, baseRef: 'main' });
  });

  it('vouches for no commit a stacked update made onto a head that had moved', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(1);
    github.mergeIntoBranch.mockResolvedValue({ merged: true, conflict: false, sha: MADE, parents: ['0ther000', 'main0000'], message: 'merged' });
    const made = vi.fn(async () => undefined);
    merge.useStacking({ waitingOn: vi.fn(async () => null), updating: vi.fn(async () => true), made });

    await merge.advance('fleetadlc');

    expect(made).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, from: HEAD, to: null });
  });

  it('updates a branch that is not stacked as before', async () => {
    const { line: merge, github } = line();
    github.behindBy.mockResolvedValue(1);
    const made = vi.fn(async () => undefined);
    merge.useStacking({ waitingOn: vi.fn(async () => null), updating: vi.fn(async () => false), made });

    expect(await merge.advance('fleetadlc')).toMatchObject({ state: 'updating' });

    expect(github.updateBranch).toHaveBeenCalledWith('janedoe/fleetadlc', 31, HEAD);
    expect(github.mergeIntoBranch).not.toHaveBeenCalled();
    expect(made).not.toHaveBeenCalled();
  });

  it('is merged by the app, audited with the approvals it landed on, and said on the pull request', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    const { line: merge, github, automation } = line();

    const step = await merge.advance('fleetadlc');

    expect(automation.mergeAsApp).toHaveBeenCalledWith('janedoe/fleetadlc', 31, HEAD);
    // Never with the automation account's token: that is a bot's.
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(step).toMatchObject({ state: 'merged' });
    expect(store.audits).toEqual([
      {
        actor: 'fleetadlc-app',
        action: 'merge.landed',
        target: 'fleetadlc#31',
        payload: { head: HEAD, merged: 'merged00merged00', method: 'squash', approvals: APPROVALS, checks: REQUIRED_CHECKS },
      },
    ]);
    expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, expect.stringContaining('- fleetadlc-sydney-janedoe approved `c0ffee0`'));
  });

  it('is not merged when a rule does not hold, and says which', async () => {
    decide.mockReturnValue({ land: false, reason: 'fleetadlc-vega-janedoe has not reviewed it', approvals: [] });
    const { line: merge, github, automation } = line();

    const step = await merge.advance('fleetadlc');

    expect(automation.mergeAsApp).not.toHaveBeenCalled();
    expect(step).toMatchObject({ state: 'merging' });
    expect(store.states.at(-1)?.detail).toBe('green and up to date; waiting for a person to merge it: OpenADLC did not, because fleetadlc-vega-janedoe has not reviewed it');
    expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, expect.stringContaining('OpenADLC did not merge it, because fleetadlc-vega-janedoe has not reviewed it'));
    expect(store.audits).toEqual([]);
  });

  it('is left for a person where the app cannot merge, rather than merged with a bot’s token', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    const { line: merge, github } = line({ app: false });

    const step = await merge.advance('fleetadlc');

    expect(step).toMatchObject({ state: 'merging' });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(store.audits).toEqual([]);
    // And says where to find out why, on the pull request.
    expect(github.comment).toHaveBeenCalledWith(
      'janedoe/fleetadlc',
      31,
      expect.stringContaining(
        'OpenADLC did not merge it, because the OpenADLC app could not get a token for janedoe/fleetadlc (the app’s card on the board, or fleetadlc doctor, says why)',
      ),
    );
  });

  it('is left for a person when the install’s settings cannot be read, as they may be what turned it off', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    store.configFails = true;
    const { line: merge, automation } = line();

    await merge.advance('fleetadlc');

    expect(automation.mergeAsApp).not.toHaveBeenCalled();
  });

  it('is left for a person when the settings table cannot be read, though the config falls back to the environment', async () => {
    // What `effectiveConfig` really does on a failed read: it resolves, with
    // an empty `bridgeMergeOff`, rather than throw.
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    store.settingsRead = false;
    const { line: merge, automation } = line();

    await merge.advance('fleetadlc');

    expect(automation.mergeAsApp).not.toHaveBeenCalled();
  });

  it('says why it waits once for each reason, not on every advance', async () => {
    decide.mockReturnValue({ land: false, reason: 'fleetadlc-vega-janedoe has not reviewed it', approvals: [] });
    const { line: merge, github } = line();

    await merge.advance('fleetadlc');
    await merge.advance('fleetadlc');
    expect(github.comment).toHaveBeenCalledTimes(1);

    decide.mockReturnValue({ land: false, reason: '@janedoe still asks for changes', approvals: [] });
    await merge.advance('fleetadlc');
    expect(github.comment).toHaveBeenCalledTimes(2);
  });

  it('is left for a person in a repository the install turned it off for', async () => {
    store.settings = { bridgeMergeOff: 'other-repo, FleetADLC' };
    const { line: merge, automation } = line();

    await merge.advance('fleetadlc');

    expect(automation.mergeFacts).not.toHaveBeenCalled();
    expect(automation.mergeAsApp).not.toHaveBeenCalled();
  });

  it('takes nothing from a fork, or onto a branch but the default one, out of the line, and updates nothing', async () => {
    for (const pull of [{ headRepoFullName: 'mallory/fleetadlc' }, { baseRef: 'release' }]) {
      store.states = [];
      decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
      const { line: merge, github, automation } = line({ pull });

      const step = await merge.advance('fleetadlc');

      expect(step).toMatchObject({ state: 'failed' });
      expect(store.states.at(-1)?.state).toBe('failed');
      expect(github.updateBranch).not.toHaveBeenCalled();
      expect(automation.mergeFacts).not.toHaveBeenCalled();
      expect(automation.mergeAsApp).not.toHaveBeenCalled();
    }
  });

  it('merges once when a webhook and the tick advance together, and the second says nothing untrue', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    const { line: merge, github, automation } = line();
    // GitHub lands it once; after that the pull request reads merged.
    let merged = false;
    automation.mergeAsApp.mockImplementation(async () => {
      if (merged) throw new Error('409 Head branch was modified');
      merged = true;
      return { sha: 'merged00merged00' };
    });
    const read = github.getPullRequest.getMockImplementation()!;
    github.getPullRequest.mockImplementation(async () => ({ ...(await read()), merged, state: merged ? 'closed' : 'open' }));

    await Promise.all([merge.advance('fleetadlc'), merge.advance('fleetadlc')]);

    expect(automation.mergeAsApp).toHaveBeenCalledTimes(1);
    expect(store.audits).toHaveLength(1);
    expect(github.comment).toHaveBeenCalledTimes(1);
    expect(github.comment).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining('did not merge'));
  });

  it('says nothing untrue when the merge call fails but the pull request did merge', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    const { line: merge, github, automation } = line();
    automation.mergeAsApp.mockRejectedValue(new Error('409 Head branch was modified'));
    github.getPullRequest.mockResolvedValueOnce({ ...(await github.getPullRequest()), merged: false });
    github.getPullRequest.mockResolvedValue({ ...(await github.getPullRequest()), merged: true });

    const step = await merge.advance('fleetadlc');

    expect(step).toMatchObject({ state: 'merged' });
    expect(github.comment).not.toHaveBeenCalled();
  });

  it('says loudly that a merge went unaudited, and still says on the pull request what it landed on', async () => {
    decide.mockReturnValue({ land: true, reason: 'ok', approvals: APPROVALS });
    store.auditFails = true;
    const loud = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { line: merge, github } = line();

    try {
      const step = await merge.advance('fleetadlc');

      expect(step).toMatchObject({ state: 'merged' });
      expect(loud).toHaveBeenCalledWith(expect.stringContaining('AUDIT NOT WRITTEN: fleetadlc#31 was merged by OpenADLC as merged00merged00'));
      expect(github.comment).toHaveBeenCalledWith('janedoe/fleetadlc', 31, expect.stringContaining('The approvals it landed on'));
    } finally {
      loud.mockRestore();
    }
  });
});

describe('a pull request only a person can land', () => {
  it('is told apart from one auto-merge will land, with the reason OpenADLC gave', () => {
    expect(heldForPerson({ state: 'merging', detail: 'green and up to date; waiting for a person to merge it: OpenADLC did not, because it changes how CI runs (Makefile)' })).toBe(
      'it changes how CI runs (Makefile)',
    );
    expect(heldForPerson({ state: 'merging', detail: 'green and up to date; waiting for a person to merge it' })).toBe('auto-merge is not on for it');
    expect(heldForPerson({ state: 'merging', detail: 'green and up to date; auto-merge will land it' })).toBeNull();
    expect(heldForPerson({ state: 'testing', detail: 'waiting for the checks' })).toBeNull();
  });
});

describe('a stacked pull request joining the line', () => {
  async function enter(waitingOn: () => Promise<number | null>) {
    const { mergeLines } = await import('@fleetadlc/db');
    vi.mocked(mergeLines.enter).mockClear();
    const merge = new MergeLine({ automationBot: null } as never, {} as never, {} as never, {} as never);
    merge.useStacking({ waitingOn: vi.fn(waitingOn), updating: vi.fn(async () => false), made: vi.fn(async () => undefined) });
    await merge.enter({ repoName: 'fleetadlc', prNumber: 31, headSha: 'c0ffee0' });
    return vi.mocked(mergeLines.enter);
  }

  it('waits while the issue it was built on has not merged', async () => {
    expect(await enter(async () => 4)).not.toHaveBeenCalled();
  });

  it('waits when whether it was stacked cannot be read, rather than landing with another’s commits', async () => {
    // A read error was taken for "no stack", and the pull request merged with
    // its dependency's unreviewed commits inside it.
    expect(
      await enter(async () => {
        throw new Error('the database went away');
      }),
    ).not.toHaveBeenCalled();
  });

  it('joins once it waits on nothing', async () => {
    expect(await enter(async () => null)).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'repo-1', prNumber: 31 }));
  });
});

describe('a pull request whose resolution round has not started', () => {
  // Back in the line, it conflicted again on every sweep: another comment,
  // another failed round, and never the round itself.
  const make = () => new MergeLine({} as never, {} as never, {} as never);

  beforeEach(() => {
    store.entered = [];
  });

  it('is not put back in the line, and its round is asked for again while it waits for its builder', async () => {
    const merge = make();
    const start = vi.fn(async () => 'pending' as const);
    merge.useConflictRounds({ start, unstarted: vi.fn(async () => ({ base: 'main', pending: 'busy' as const })) });

    await merge.enter({ repoName: 'fleetadlc', prNumber: 31, headSha: 'abc' });

    expect(store.entered).toEqual([]);
    expect(start).toHaveBeenCalledWith({ repoName: 'fleetadlc', prNumber: 31, baseRef: 'main' });
  });

  it('is left to Try again or the recovery when its start was recorded as a failed task', async () => {
    const merge = make();
    const start = vi.fn(async () => 'pending' as const);
    merge.useConflictRounds({ start, unstarted: vi.fn(async () => ({ base: 'main', pending: 'blocked' as const })) });

    await merge.enter({ repoName: 'fleetadlc', prNumber: 31, headSha: 'abc' });

    expect(store.entered).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it('joins the line as before with no round waiting', async () => {
    const merge = make();
    merge.useConflictRounds({ start: vi.fn(), unstarted: vi.fn(async () => null) });

    await merge.enter({ repoName: 'fleetadlc', prNumber: 31, headSha: 'abc' });

    expect(store.entered).toEqual([31]);
  });
});
