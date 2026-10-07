import { DEFAULT_DELIVERY_RULES, MERGE_IS_SHIPPING, deliveryRulesSchema, type DeliveryRules } from '@fleetadlc/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deploy pipeline: what a merge, a smoke and a failed production deploy
 * dispatch, by the repository's rules, and that each happens once per commit.
 */

const REPO = { id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' };

type Run = Record<string, unknown> & { sha: string };
/** What the store lets a promote be dispatched for (`deployRuns.claimPromote`). */
const promotable = (run: Run) => run.smoke === 'success' && !run.sent_back_at && !run.rollback_dispatched_at;
const world = {
  runs: new Map<string, Run>(),
  limits: null as { limits: { name: string; detail: string }[] } | null,
  audits: [] as Record<string, unknown>[],
};

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    world.audits.push(entry);
  }),
  issues: { listIssues: vi.fn(async () => [{ number: 12, prNumber: 40 }]) },
  repos: {
    listRepos: vi.fn(async () => [REPO]),
    getPlanLimits: vi.fn(async () => world.limits),
  },
  deployRuns: {
    ensure: vi.fn(async (_repo: string, sha: string, prNumber: number | null) => {
      const run = world.runs.get(sha) ?? { sha, prNumber };
      world.runs.set(sha, run);
      return run;
    }),
    claim: vi.fn(async (_repo: string, sha: string, step: string) => {
      const run = world.runs.get(sha);
      if (!run || run[step]) return false;
      run[step] = 'now';
      return true;
    }),
    release: vi.fn(async (_repo: string, sha: string, step: string) => {
      const run = world.runs.get(sha);
      if (run) delete run[step];
    }),
    // As the store does it: a red smoke stays red, and drops a held soak.
    recordSmoke: vi.fn(async (_repo: string, sha: string, conclusion: string) => {
      const run = world.runs.get(sha)!;
      run.smoke = run.smoke === 'failure' ? 'failure' : conclusion;
      if (conclusion === 'failure') delete run.promoteAfter;
    }),
    claimPromote: vi.fn(async (_repo: string, sha: string) => {
      const run = world.runs.get(sha);
      if (!run || run.promote_dispatched_at || !promotable(run)) return false;
      run.promote_dispatched_at = 'now';
      return true;
    }),
    recordProduction: vi.fn(async (_repo: string, sha: string, conclusion: string) => {
      world.runs.get(sha)!.production = conclusion;
    }),
    holdPromote: vi.fn(async (_repo: string, sha: string, after: Date) => {
      world.runs.get(sha)!.promoteAfter = after;
      delete world.runs.get(sha)!.held;
    }),
    holdForPerson: vi.fn(async (_repo: string, sha: string, detail: string) => {
      const run = world.runs.get(sha)!;
      if (run.promote_dispatched_at) return;
      run.held = true;
      run.detail = detail;
      delete run.promoteAfter;
    }),
    releaseHeld: vi.fn(async (_repo: string, sha: string) => {
      const run = world.runs.get(sha);
      if (!run?.held || run.promote_dispatched_at) return false;
      run.promote_dispatched_at = 'now';
      return true;
    }),
    recordRelease: vi.fn(async (_repo: string, sha: string, by: string) => {
      world.runs.get(sha)!.releasedBy = by;
    }),
    get: vi.fn(async (_repo: string, sha: string) => {
      const run = world.runs.get(sha);
      // As the store reads it back: each step's time under its camel-cased name.
      return run
        ? {
            ...run,
            sha,
            prNumber: run.prNumber ?? null,
            smokeConclusion: run.smoke ?? null,
            promoteDispatchedAt: run.promote_dispatched_at ?? null,
            productionConclusion: run.production ?? null,
            rollbackDispatchedAt: run.rollback_dispatched_at ?? null,
            rollbackConclusion: run.rollbackConclusion ?? null,
            sentBackAt: run.sent_back_at ?? null,
          }
        : null;
    }),
    unsentBack: vi.fn(async () =>
      [...world.runs.values()]
        .filter((run) => !run.sent_back_at && (run.smoke === 'failure' || run.production === 'failure'))
        .map((run) => ({
          repoId: REPO.id,
          sha: run.sha,
          smokeConclusion: run.smoke ?? null,
          productionConclusion: run.production ?? null,
          rollbackDispatchedAt: run.rollback_dispatched_at ?? null,
          rollbackConclusion: run.rollbackConclusion ?? null,
        })),
    ),
    oweRollback: vi.fn(async (_repo: string, sha: string) => {
      const run = world.runs.get(sha);
      if (run && !run.rollbackDue) run.rollbackDue = 'now';
    }),
    // As the store's queries pick them: the repository's newest commit only
    // for a promote, and no rollback once a newer commit was promoted.
    undispatchedPromotes: vi.fn(async () => {
      const newest = [...world.runs.values()].at(-1);
      return newest && newest.smoke === 'success' && !newest.promote_dispatched_at && !newest.promoteAfter ? [{ repoId: REPO.id, sha: newest.sha }] : [];
    }),
    undispatchedRollbacks: vi.fn(async () => {
      const runs = [...world.runs.values()];
      return runs
        .filter((run, index) => run.rollbackDue && !run.rollback_dispatched_at && !runs.slice(index + 1).some((newer) => newer.promote_dispatched_at))
        .map((run) => ({ repoId: REPO.id, sha: run.sha }));
    }),
    // A rollback owed that has not ended, as `rollbackOutstanding` reads it.
    rollbackOutstanding: vi.fn(async () => {
      const runs = [...world.runs.values()];
      const open = runs.find((run, index) => run.rollbackDue && !run.rollbackConclusion && !runs.slice(index + 1).some((newer) => newer.promote_dispatched_at));
      return open ? { repoId: REPO.id, sha: open.sha } : null;
    }),
    recordRollback: vi.fn(async (_repo: string, sha: string, conclusion: string) => {
      const run = world.runs.get(sha)!;
      run.rollbackConclusion = conclusion;
      if (conclusion === 'success') delete run.rollbackTrouble;
    }),
    rollbackDidNotRun: vi.fn(async (_repo: string, sha: string, why: string) => {
      const run = world.runs.get(sha)!;
      delete run.rollback_dispatched_at;
      run.rollbackTrouble = why;
    }),
    dispatchedRollbacks: vi.fn(async () =>
      [...world.runs.values()]
        .filter((run) => run.rollbackDue && run.rollback_dispatched_at && !run.rollbackConclusion)
        .map((run) => ({ repoId: REPO.id, sha: run.sha, rollbackDispatchedAt: run.rollback_dispatched_at as string })),
    ),
    duePromotes: vi.fn(async (now: Date) =>
      [...world.runs.values()]
        .filter((run) => run.promoteAfter instanceof Date && (run.promoteAfter as Date) <= now && !run.promote_dispatched_at && promotable(run))
        .map((run) => ({ repoId: REPO.id, sha: run.sha })),
    ),
  },
}));

import { DeployPipeline, promoteFailure, rollbackSaid, workflowFile } from './deploy-pipeline.js';

function rules(input: unknown): DeliveryRules {
  return deliveryRulesSchema.parse({ version: 1, ...(input as object) });
}

function pipeline(
  given: DeliveryRules,
  options: {
    /** Read at each dispatch, so a test can let GitHub recover. */
    refuse?: boolean;
    /** No app and no automation account by the time a dispatch asks: the run's jobs were read, and then nothing could act. */
    noClientToDispatch?: boolean;
    now?: number;
    pulls?: () => Promise<{ number: number; headRef: string }[]>;
    sendBack?: () => Promise<unknown>;
    /** The promote run's jobs, as `GET …/actions/runs/{id}/jobs` answers. */
    jobs?: { steps: { name: string; status: string; conclusion: string | null }[] }[];
    /** Why the rules could not be read; `given` is then only the fallback. */
    readError?: () => string | null;
    /** The promote runs GitHub lists, as `promote-production.yml` names them. */
    promoteRuns?: { id: number; status: string; display_title: string }[];
    /** The runs GitHub lists for a path, where a test needs them to differ by workflow or status. */
    runsFor?: (path: string) => unknown[];
    /** Who the client acts as; the app's client when absent. */
    actingAs?: string;
    /**
     * What `GET …/environments/production` answers. `held` has a required
     * reviewer; `open` has none; `unread` fails. A reviewers promote holds
     * unless the read shows a reviewer.
     */
    productionEnvironment?: 'held' | 'open' | 'unread';
  } = {},
) {
  const dispatched: { path: string; body: unknown }[] = [];
  const cancelled: string[] = [];
  const sentBack: Record<string, unknown>[] = [];
  const client = {
    ...(options.actingAs ? { actingAs: options.actingAs } : {}),
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path.endsWith('/environments/production')) {
        if (options.productionEnvironment === 'unread') throw new Error('502: Bad Gateway');
        if (options.productionEnvironment === 'open') return { protection_rules: [] } as never;
        return { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 1 }] }] } as never;
      }
      if (method === 'GET' && path.endsWith('/jobs')) {
        if (!options.jobs) throw new Error('404: Not Found');
        return { jobs: options.jobs } as never;
      }
      if (method === 'GET' && path.includes('/runs?')) return { workflow_runs: options.runsFor?.(path) ?? options.promoteRuns ?? [] } as never;
      if (path.endsWith('/cancel')) {
        cancelled.push(path);
        return {} as never;
      }
      if (options.refuse) throw new Error('422: Workflow does not have workflow_dispatch trigger');
      dispatched.push({ path, body });
      return {} as never;
    }),
    listPullsForCommit: vi.fn(options.pulls ?? (async () => [{ number: 40, headRef: 'agent/builder/12-thing' }])),
  };
  let now = options.now ?? Date.parse('2026-09-30T12:00:00Z');
  let current = given;
  let asked = 0;
  const line = new DeployPipeline({
    delivery: { get: async () => ({ rules: current, source: 'file', testingUrl: null, fileError: null, readError: options.readError?.() ?? null }) },
    client: async () => (options.noClientToDispatch && asked++ > 0 ? null : client),
    sendBack: {
      fromBridge: vi.fn(async (input) => {
        await options.sendBack?.();
        sentBack.push(input);
        return { sent: true as const, to: 'build' as const, count: 1 };
      }),
    } as never,
    now: () => now,
  });
  return {
    line,
    dispatched,
    cancelled,
    sentBack,
    client,
    advance: (ms: number) => (now += ms),
    setRules: (next: DeliveryRules) => {
      current = next;
    },
    refuse: (refusing: boolean) => {
      options.refuse = refusing;
    },
  };
}

beforeEach(() => {
  world.runs.clear();
  world.limits = null;
  world.audits = [];
});

describe('a merge', () => {
  it('dispatches the testing deploy of its merge commit, as the rules name it', async () => {
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES);
    await line.onMerged(REPO, 40, 'abc1234def');
    expect(dispatched).toEqual([
      { path: '/repos/exampleco/app/actions/workflows/deploy-testing.yml/dispatches', body: { ref: 'main', inputs: { sha: 'abc1234def' } } },
    ]);
  });

  it('records the dispatch as the account that made it: the app, or the automation account it fell back to', async () => {
    await pipeline(DEFAULT_DELIVERY_RULES, { actingAs: 'fleetadlc-app' }).line.onMerged(REPO, 40, 'abc1234def');
    world.runs.clear();
    await pipeline(DEFAULT_DELIVERY_RULES, { actingAs: 'janedoe-bot' }).line.onMerged(REPO, 41, 'def5678abc');
    expect(world.audits.map((entry) => entry.actor)).toEqual(['fleetadlc-app', 'janedoe-bot']);
  });

  it('dispatches it once, however often the merge is heard', async () => {
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES);
    await line.onMerged(REPO, 40, 'abc1234def');
    const again = await line.onMerged(REPO, 40, 'abc1234def');
    expect(dispatched).toHaveLength(1);
    expect(again).toContain('already dispatched');
  });

  it('dispatches nothing where merging is shipping', async () => {
    const { line, dispatched } = pipeline(MERGE_IS_SHIPPING);
    expect(await line.onMerged(REPO, 40, 'abc1234def')).toContain('merging is shipping');
    expect(dispatched).toEqual([]);
  });

  it('gives the step back when GitHub refuses, so the sweep tries again', async () => {
    const { line } = pipeline(DEFAULT_DELIVERY_RULES, { refuse: true });
    expect(await line.onMerged(REPO, 40, 'abc1234def')).toContain('the deploy sweep tries again');
    expect(world.runs.get('abc1234def')?.testing_dispatched_at).toBeUndefined();
  });
});

describe('the smoke on testing', () => {
  it('green: dispatches the promote with the candidate, and approves nothing', async () => {
    // A person approves production in GitHub: the environment holds it, not the bridge.
    const { line, dispatched } = pipeline(rules({ production: { approval: 'reviewers', soakMinutes: 0 } }));
    await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
    expect(dispatched).toEqual([
      {
        path: '/repos/exampleco/app/actions/workflows/promote-production.yml/dispatches',
        body: { ref: 'main', inputs: { candidate: 'abc1234def' } },
      },
    ]);
    // A dispatch is all it sends: approving the run is the environment's.
    expect(dispatched.every((one) => one.path.endsWith('/dispatches'))).toBe(true);
  });

  it('green, where testing is as far as it goes: nothing more', async () => {
    const { line, dispatched } = pipeline(rules({ production: { on: 'none' } }));
    await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
    expect(dispatched).toEqual([]);
  });

  it('green, on a plan with no environment rules: the bridge holds the soak, then promotes', async () => {
    world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
    const { line, dispatched, advance } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
    expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('soaking on testing for 30 minutes');
    expect(dispatched).toEqual([]);

    advance(29 * 60_000);
    expect(await line.promoteDue()).toEqual([]);
    advance(2 * 60_000);
    await line.promoteDue();
    expect(dispatched.map((one) => one.path)).toEqual(['/repos/exampleco/app/actions/workflows/promote-production.yml/dispatches']);
  });

  it('green, where the environment holds the soak itself: promotes at once', async () => {
    const { line, dispatched } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
    await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
    expect(dispatched).toHaveLength(1);
  });

  it('the promote is not dispatched on rules that could not be read', async () => {
    // The file says soak for an hour; the 502 left Settings' default, which
    // promotes at once.
    world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
    let readError: string | null = '.github/fleetadlc.yml could not be read: GitHub answered 502: Bad Gateway';
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, { readError: () => readError });

    expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toBe(
      'app@abc1234: its delivery rules could not be read (.github/fleetadlc.yml could not be read: GitHub answered 502: Bad Gateway); nothing dispatched',
    );
    expect(await line.onMerged(REPO, 41, 'def5678abc')).toContain('its delivery rules could not be read');
    expect(dispatched).toEqual([]);
    expect(world.runs.get('abc1234def')?.promote_dispatched_at).toBeUndefined();
    expect(world.runs.get('def5678abc')).toBeUndefined();

    // Read again, the step is still open to take.
    readError = null;
    await line.promote(REPO, 'abc1234def');
    expect(dispatched).toHaveLength(1);
  });

  it('a promote whose dispatch failed is dispatched by the next sweep, once', async () => {
    const options = { refuse: true };
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, options);
    expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('the deploy sweep tries again');
    expect(world.runs.get('abc1234def')?.promote_dispatched_at).toBeUndefined();
    // No soak the bridge held, so the soak's sweep has nothing to do.
    expect(await line.promoteDue()).toEqual([]);

    options.refuse = false;
    expect(await line.retryUndispatched()).toEqual(['app@abc1234: dispatched promote-production']);
    expect(await line.retryUndispatched()).toEqual([]);
    expect(dispatched.map((one) => one.path)).toEqual(['/repos/exampleco/app/actions/workflows/promote-production.yml/dispatches']);
  });

  it('a promote is not dispatched by the retry for a commit a newer one has moved past', async () => {
    const options = { refuse: true };
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, options);
    await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
    // A newer merge is on its way to testing; its own promote carries this one.
    await line.onMerged(REPO, 41, 'fedcba98765');

    options.refuse = false;
    expect(await line.retryUndispatched()).toEqual([]);
    expect(dispatched.filter((one) => one.path.includes('promote'))).toEqual([]);
  });

  it('a promote the rules no longer call for, or whose soak the bridge holds, is not dispatched by the retry', async () => {
    const options = { refuse: true };
    const failing = pipeline(DEFAULT_DELIVERY_RULES, options);
    await failing.line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
    options.refuse = false;

    const none = pipeline(rules({ production: { on: 'none' } }));
    expect(await none.line.retryUndispatched()).toEqual([]);
    expect(none.dispatched).toEqual([]);

    world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
    const soaks = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
    expect(await soaks.line.retryUndispatched()).toEqual(['app@abc1234: soaking on testing for 30 minutes before the promote']);
    expect(soaks.dispatched).toEqual([]);
    expect(world.runs.get('abc1234def')?.promoteAfter).toBeInstanceOf(Date);
  });

  describe('where the rules say a person approves and GitHub’s plan cannot hold a production reviewer', () => {
    const REVIEWERS = rules({ production: { approval: 'reviewers', soakMinutes: 0 } });
    const refusals = [
      ['private, on the free plan', 'GitHub protects a private repository’s environments only on a paid plan'],
      ['private, on Pro or Team', 'GitHub holds a required reviewer on a private repository’s environment only on GitHub Enterprise'],
    ];

    it.each(refusals)('green, %s: dispatches nothing, and holds the promote for a person', async (_plan, detail) => {
      world.limits = { limits: [{ name: 'environment production', detail }] };
      const { line, dispatched } = pipeline(REVIEWERS, { productionEnvironment: 'open' });

      expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('GitHub’s plan cannot hold a production reviewer here');
      expect(dispatched).toEqual([]);
      expect(world.runs.get('abc1234def')?.held).toBe(true);
      // The reason alone, as a sentence: the Needs-you card reads it as one.
      expect(world.runs.get('abc1234def')?.detail).toBe('GitHub’s plan cannot hold a production reviewer here.');
    });

    it('green, where a stored limit outlived it and GitHub holds the reviewer: dispatches once, never held twice', async () => {
      // An apply whose branch-policy write was refused reports production
      // skipped and keeps the row; the reviewer GitHub held is still there.
      world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
      const { line, dispatched } = pipeline(REVIEWERS, { productionEnvironment: 'held' });

      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
      expect(dispatched).toHaveLength(1);
      expect(world.runs.get('abc1234def')?.held).toBeUndefined();
    });

    it('green, where the stored limit is gone and production has no reviewer: holds, and dispatches nothing', async () => {
      const { line, dispatched } = pipeline(REVIEWERS, { productionEnvironment: 'open' });

      expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('the production environment is not holding a reviewer');
      expect(dispatched).toEqual([]);
      expect(world.runs.get('abc1234def')?.held).toBe(true);
      expect(world.runs.get('abc1234def')?.detail).toBe('The production environment is not holding a reviewer.');
    });

    it('green, where production cannot be read: holds, rather than dispatching into the dark', async () => {
      const { line, dispatched } = pipeline(REVIEWERS, { productionEnvironment: 'unread' });

      expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('could not be read');
      expect(dispatched).toEqual([]);
      expect(world.runs.get('abc1234def')?.held).toBe(true);
    });

    it('green, where GitHub holds the reviewer: dispatches the promote at once, as before', async () => {
      const { line, dispatched } = pipeline(REVIEWERS);
      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
      expect(dispatched).toHaveLength(1);
      expect(world.runs.get('abc1234def')?.held).toBeUndefined();
    });

    it('is dispatched once a person releases it, as the app, and says who did', async () => {
      world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
      const { line, dispatched } = pipeline(REVIEWERS, { productionEnvironment: 'open' });
      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);

      expect(await line.releaseHeld(REPO, 'abc1234def', 'janedoe')).toMatchObject({ released: true });
      expect(dispatched).toEqual([
        { path: '/repos/exampleco/app/actions/workflows/promote-production.yml/dispatches', body: { ref: 'main', inputs: { candidate: 'abc1234def' } } },
      ]);
      expect(world.runs.get('abc1234def')?.releasedBy).toBe('janedoe');
      expect(world.audits).toContainEqual(expect.objectContaining({ actor: 'janedoe', action: 'deploy.promote_released' }));
      // Once: the second release finds nothing held.
      expect(await line.releaseHeld(REPO, 'abc1234def', 'janedoe')).toMatchObject({ released: false, held: false });
    });

    it('stays held when the dispatch is refused, and says nobody released it', async () => {
      world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
      const { line, refuse } = pipeline(REVIEWERS, { productionEnvironment: 'open' });
      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
      refuse(true);

      expect(await line.releaseHeld(REPO, 'abc1234def', 'janedoe')).toMatchObject({ released: false, held: true });
      expect(world.runs.get('abc1234def')).toMatchObject({ held: true });
      expect(world.runs.get('abc1234def')?.promote_dispatched_at).toBeUndefined();
      expect(world.runs.get('abc1234def')?.releasedBy).toBeUndefined();
    });

    it('holds a soaked promote for a person when the rules said reviewers by the time the soak ended', async () => {
      world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
      const { line, dispatched, advance, setRules } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }), { productionEnvironment: 'open' });
      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
      setRules(REVIEWERS);
      advance(31 * 60_000);

      expect(await line.promoteDue()).toEqual([expect.stringContaining('waits in Needs you')]);
      expect(dispatched).toEqual([]);
      expect(world.runs.get('abc1234def')?.held).toBe(true);
    });
  });

  describe('a repository set to automatic', () => {
    it('is never held for a person: on a refused plan the bridge holds its soak, then promotes', async () => {
      world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
      const { line, dispatched, advance } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
      expect(await line.onTestingSmoke(REPO, 'abc1234def', 'success', null)).toContain('soaking on testing');
      expect(world.runs.get('abc1234def')?.held).toBeUndefined();
      advance(31 * 60_000);
      await line.promoteDue();
      expect(dispatched).toHaveLength(1);
      expect(world.runs.get('abc1234def')?.held).toBeUndefined();
    });

    it('is never held for a person: with no plan limit it promotes at once', async () => {
      const { line, dispatched } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
      await line.onTestingSmoke(REPO, 'abc1234def', 'success', null);
      expect(dispatched).toHaveLength(1);
      expect(world.runs.get('abc1234def')?.held).toBeUndefined();
    });
  });

  it('red: sends the change behind the commit back to build, once', async () => {
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES);
    await line.onTestingSmoke(REPO, 'abc1234def', 'failure', 'https://github.com/run/1');
    await line.onTestingSmoke(REPO, 'abc1234def', 'failure', 'https://github.com/run/1');
    expect(dispatched).toEqual([]);
    expect(sentBack).toEqual([
      expect.objectContaining({ repoName: 'app', issueNumber: 12, from: 'merged', reason: expect.stringContaining('https://github.com/run/1') }),
    ]);
  });

  it('red: says the change is being reverted only when a revert task opened', async () => {
    const opened = pipeline(DEFAULT_DELIVERY_RULES);
    await opened.line.onTestingSmoke(REPO, 'abc1234def', 'failure', null, { opened: true });
    expect(opened.sentBack).toEqual([expect.objectContaining({ reason: 'The smoke failed on testing at `abc1234`. The change is being reverted.' })]);

    world.runs.clear();
    const busy = pipeline(DEFAULT_DELIVERY_RULES);
    await busy.line.onTestingSmoke(REPO, 'abc1234def', 'failure', null, {
      opened: false,
      reason: 'busy',
      why: 'fleetadlc-deploy-janedoe was busy, and nothing asks for this revert again',
    });
    expect(busy.sentBack).toEqual([
      expect.objectContaining({
        reason: 'The smoke failed on testing at `abc1234`. No revert is running: fleetadlc-deploy-janedoe was busy, and nothing asks for this revert again.',
      }),
    ]);
  });
});

describe('a commit whose smoke went red', () => {
  const SHA = 'abc1234def';

  it('is not promoted when its soak ends, after a red re-run during the soak the bridge holds', async () => {
    world.limits = { limits: [{ name: 'environment production', detail: 'plan' }] };
    const { line, dispatched, advance } = pipeline(rules({ production: { approval: 'auto', soakMinutes: 30 } }));
    await line.onTestingSmoke(REPO, SHA, 'success', null);
    advance(10 * 60_000);
    await line.onTestingSmoke(REPO, SHA, 'failure', null);

    advance(21 * 60_000);
    expect(await line.promoteDue()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('is not promoted by a green re-run after it was sent back', async () => {
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES);
    await line.onTestingSmoke(REPO, SHA, 'failure', null);

    expect(await line.onTestingSmoke(REPO, SHA, 'success', null)).toContain('its smoke went red, or it was sent back; not promoting');
    expect(dispatched).toEqual([]);
  });

  it('is not promoted by a green re-run when nothing could send it back', async () => {
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, {
      pulls: async () => {
        throw new Error('fetch failed');
      },
    });
    await line.onTestingSmoke(REPO, SHA, 'failure', null);
    expect(world.runs.get(SHA)?.sent_back_at).toBeUndefined();

    await line.onTestingSmoke(REPO, SHA, 'success', null);
    expect(dispatched).toEqual([]);
  });

  it('has its promote cancelled while GitHub holds it, and one already deploying left to finish', async () => {
    const { line, dispatched, cancelled } = pipeline(DEFAULT_DELIVERY_RULES, {
      promoteRuns: [
        { id: 7, status: 'waiting', display_title: `promote-production ${SHA}` },
        { id: 8, status: 'waiting', display_title: 'promote-production 0ther0000' },
      ],
    });
    await line.onTestingSmoke(REPO, SHA, 'success', null);
    expect(dispatched).toHaveLength(1);

    const said = await line.onTestingSmoke(REPO, SHA, 'failure', null);

    expect(cancelled).toEqual(['/repos/exampleco/app/actions/runs/7/cancel']);
    expect(said).toContain('cancelled its promote, which GitHub was holding (waiting)');
    expect(world.audits).toContainEqual(expect.objectContaining({ action: 'deploy.promote_cancelled', payload: expect.objectContaining({ runId: 7 }) }));

    const running = pipeline(DEFAULT_DELIVERY_RULES, { promoteRuns: [{ id: 9, status: 'in_progress', display_title: 'promote-production f00d000000' }] });
    await running.line.onTestingSmoke(REPO, 'f00d000000', 'success', null);
    expect(await running.line.onTestingSmoke(REPO, 'f00d000000', 'failure', null)).toContain('its promote is already in progress, and is left to finish');
    expect(running.cancelled).toEqual([]);
  });

  it('is not promoted where the rules have since stopped at testing', async () => {
    const { line, dispatched } = pipeline(rules({ production: { on: 'none' } }));
    await deployRunsEnsure(SHA);
    world.runs.get(SHA)!.smoke = 'success';
    expect(await line.promote(REPO, SHA)).toContain('testing is as far as this repository goes');
    expect(dispatched).toEqual([]);
  });
});

/** A commit's row, as a merge makes it. */
async function deployRunsEnsure(sha: string): Promise<void> {
  const { deployRuns } = await import('@fleetadlc/db');
  await deployRuns.ensure(REPO.id, sha, 40);
}

describe('a send-back GitHub did not answer for', () => {
  it('is given back when the pull requests cannot be listed, and the deploy sweep sends it', async () => {
    let listed = false;
    const { line, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, {
      pulls: async () => {
        if (!listed) throw new Error('403: API rate limit exceeded');
        return [{ number: 40, headRef: 'agent/builder/12-thing' }];
      },
    });
    expect(await line.onTestingSmoke(REPO, 'abc1234def', 'failure', null)).toContain('not sent back (its pull requests could not be listed: 403');
    expect(sentBack).toEqual([]);
    expect(world.runs.get('abc1234def')?.sent_back_at).toBeUndefined();

    listed = true;
    expect(await line.sendBackDue()).toEqual(['app#12 sent back to build']);
    // The sweep does not know whether a revert started, so it does not say one did.
    expect(sentBack).toEqual([expect.objectContaining({ issueNumber: 12, reason: 'The smoke failed on testing at `abc1234`.' })]);
    expect(await line.sendBackDue()).toEqual([]);
  });

  it('falls back to the pull request recorded at the merge', async () => {
    const { line, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, {
      pulls: async () => {
        throw new Error('fetch failed');
      },
    });
    await line.deployTesting(REPO, 'abc1234def', 40);
    await line.onTestingSmoke(REPO, 'abc1234def', 'failure', null);
    expect(sentBack).toEqual([expect.objectContaining({ issueNumber: 12 })]);
  });

  it('is given back when sending one back throws', async () => {
    let fail = true;
    const { line, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, {
      sendBack: async () => {
        if (fail) throw new Error('database unavailable');
      },
      jobs: promoteSteps(6),
    });
    // A promote the bridge dispatched, whose production smoke failed.
    world.runs.set('abc1234def', { sha: 'abc1234def', prNumber: 40, promote_dispatched_at: 'earlier' });
    await line.onProductionFailed(REPO, 'abc1234def', 77, null);
    expect(sentBack).toEqual([]);
    fail = false;
    expect(await line.sendBackDue()).toEqual(['app#12 sent back to build']);
    // Nothing was rolled back, so the reason does not say it was.
    expect(sentBack).toEqual([expect.objectContaining({ reason: 'The production deploy of `abc1234` failed.' })]);
  });
});

/** OpenADLC's own promote's steps, as GitHub lists them, failing at `failing` (by index) with the rest skipped. */
function promoteSteps(failing: number | null, conclusion: 'failure' | 'cancelled' = 'failure') {
  const names = [
    'Set up job',
    'the candidate is a commit id',
    'the candidate is on the default branch',
    'build the release artifact',
    'migrate',
    'deploy at zero traffic',
    'smoke the new revision by its tag',
    'shift traffic to it',
    'what was promoted',
  ];
  return [
    {
      steps: names.map((name, index) => ({
        name,
        status: 'completed',
        conclusion: failing === null || index < failing ? 'success' : index === failing ? conclusion : 'skipped',
      })),
    },
  ];
}

describe('a production deploy that failed', () => {
  const SHA = 'abc1234def';
  const promoted = () => {
    world.runs.set(SHA, { sha: SHA, prNumber: 40, promote_dispatched_at: 'earlier' });
  };

  it('failure before the shift does not roll back: a person is told to check, and nothing is sent back', async () => {
    // The migrate step failed. Production still serves the healthy release,
    // and an empty rollback target would have moved it back one.
    promoted();
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(4) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, 'https://github.com/exampleco/app/actions/runs/77');

    expect(dispatched).toEqual([]);
    expect(sentBack).toEqual([]);
    expect(handled.person).toContain('Check whether traffic moved to the new revision; if it did, run `rollback-production`.');
    expect(world.runs.get(SHA)?.production).toBeUndefined();
  });

  it('a failed production smoke sends the change back to build, and rolls nothing back', async () => {
    promoted();
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(6) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    expect(handled.person).toBeNull();
    expect(sentBack).toEqual([
      expect.objectContaining({ reason: 'The production smoke of `abc1234` failed. Traffic never moved, so production still serves the previous release.' }),
    ]);
    expect(String((sentBack[0] as { reason: string }).reason)).not.toContain('rolled back');
  });

  it.each(['failure', 'cancelled'] as const)('a traffic shift that ended in %s dispatches the rollback once, and tells a person', async (conclusion) => {
    promoted();
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7, conclusion) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);
    await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([{ path: '/repos/exampleco/app/actions/workflows/rollback-production.yml/dispatches', body: { ref: 'main', inputs: {} } }]);
    expect(sentBack).toEqual([]);
    expect(handled.person).toContain('A rollback of production was dispatched: `rollback-production`, with no target');
    expect(handled.person).toContain('puts back the release that served before the last shift');
    expect(handled.person).toContain('Check that production serves that release');
    expect(handled.person).not.toMatch(/rolled back/);
  });

  it('a traffic shift that failed, with nothing that can dispatch here, says no rollback was dispatched', async () => {
    promoted();
    const { line } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7), noClientToDispatch: true });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(handled.person).toContain('The traffic shift of `abc1234` failed. OpenADLC could not dispatch `rollback-production`');
    expect(handled.person).toContain('the deploy sweep tries it again');
    expect(handled.person).toContain('production may serve the new revision');
    // Given back, for a person or a later failure to dispatch.
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBeUndefined();
  });

  it('a traffic shift that failed, whose rollback GitHub refused, says so, and the deploy sweep tries again', async () => {
    promoted();
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7), refuse: true });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    expect(handled.person).toContain('could not dispatch `rollback-production` (422: Workflow does not have workflow_dispatch trigger)');
    expect(handled.person).toContain('production may serve the new revision');
    expect(handled.line).toContain('tries again');
  });

  it('a traffic shift that failed, where the rules have no production step, dispatches nothing and says why', async () => {
    promoted();
    const { line, dispatched } = pipeline(rules({ production: { on: 'none' } }), { jobs: promoteSteps(7) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    expect(handled.person).toContain("This repository's rules name no production rollback, so OpenADLC dispatched none.");
  });

  it('a traffic shift whose rollback was already dispatched says so, not that it was dispatched again', async () => {
    promoted();
    world.runs.get(SHA)!.rollback_dispatched_at = 'earlier';
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    // The person was told when it was dispatched.
    expect(handled.person).toBeNull();
    expect(handled.line).toContain('its rollback was already dispatched');
  });

  it('a traffic shift that failed dispatches no rollback on rules that could not be read', async () => {
    promoted();
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7), readError: () => 'GitHub answered 502' });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBeUndefined();
    expect(handled.person).toContain('could not read this repository');
    expect(handled.person).not.toContain('dispatched `rollback-production`');
  });

  it('the send-back does not say production was rolled back when the rollback was not dispatched', async () => {
    // It said the rollback was dispatched whether or not it was, so
    // production could stay on the broken revision with everyone thinking otherwise.
    promoted();
    const options = { jobs: promoteSteps(7), refuse: true };
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, options);

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(dispatched).toEqual([]);
    expect(handled.line).toContain('rollback-production not dispatched');
    expect(handled.person).not.toContain('OpenADLC dispatched');
    expect(handled.person).toContain('could not dispatch `rollback-production` (422: Workflow does not have workflow_dispatch trigger)');
    expect(handled.person).toContain('the deploy sweep tries it again');
  });

  it('a rollback whose dispatch failed is dispatched by the next sweep, once, and sends nothing back', async () => {
    promoted();
    const options = { jobs: promoteSteps(7), refuse: true };
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, options);
    await line.onProductionFailed(REPO, SHA, 77, null);
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBeUndefined();

    options.refuse = false;
    expect(await line.retryUndispatched()).toEqual(['app@abc1234: dispatched rollback-production']);
    expect(await line.retryUndispatched()).toEqual([]);

    expect(dispatched.map((one) => one.path)).toEqual(['/repos/exampleco/app/actions/workflows/rollback-production.yml/dispatches']);
    expect(sentBack).toEqual([]);
  });

  it('a rollback is not dispatched once a newer commit has been promoted', async () => {
    promoted();
    const options = { jobs: promoteSteps(7), refuse: true };
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, options);
    await line.onProductionFailed(REPO, SHA, 77, null);
    world.runs.set('fedcba98765', { sha: 'fedcba98765', promote_dispatched_at: 'later' });

    options.refuse = false;
    expect(await line.retryUndispatched()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('no promote on record does nothing', async () => {
    // A failure from a run the bridge never dispatched rolled production back
    // and sent back whatever was at the tip.
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: promoteSteps(7) });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(handled).toEqual({ line: expect.stringContaining('dispatched no promote of it'), person: null });
    expect(dispatched).toEqual([]);
    expect(sentBack).toEqual([]);
    expect(world.runs.has(SHA)).toBe(false);
  });

  it('a rejected deployment, with no step run, does nothing', async () => {
    promoted();
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES, { jobs: [] });

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(handled.person).toBeNull();
    expect(dispatched).toEqual([]);
    expect(sentBack).toEqual([]);
  });

  it('a run whose steps cannot be read tells a person, and does nothing else', async () => {
    promoted();
    const { line, dispatched, sentBack } = pipeline(DEFAULT_DELIVERY_RULES);

    const handled = await line.onProductionFailed(REPO, SHA, 77, null);

    expect(handled.person).toContain('cannot tell at which step');
    expect(dispatched).toEqual([]);
    expect(sentBack).toEqual([]);
  });
});

describe('a rollback of production', () => {
  const SHA = 'abc1234def';
  const NEWER = 'beef5678aa';
  const DISPATCHED_AT = '2026-09-30T12:00:00.000Z';
  const shiftFailed = () => {
    world.runs.set(SHA, { sha: SHA, prNumber: 40, promote_dispatched_at: 'earlier' });
  };
  /** A rollback of SHA dispatched at DISPATCHED_AT, and nothing seen of its run yet. */
  const rollbackDispatched = () => {
    world.runs.set(SHA, { sha: SHA, prNumber: 40, promote_dispatched_at: 'earlier', rollbackDue: 'earlier', rollback_dispatched_at: DISPATCHED_AT });
  };
  /** GitHub's list of the rollback workflow's runs. */
  const rollbackRuns = (runs: Record<string, unknown>[]) => (path: string) => (path.includes('/rollback-production.yml/') ? runs : []);

  it('cancels the promotes GitHub has not started before it is dispatched, and leaves one running', async () => {
    // A promote waiting hours for a person's approval holds the concurrency
    // group the rollback shares, and the next one dispatched cancelled it.
    shiftFailed();
    const listed: string[] = [];
    const { line, client, cancelled } = pipeline(DEFAULT_DELIVERY_RULES, {
      jobs: promoteSteps(7),
      runsFor: (path) => {
        listed.push(path);
        if (path.includes('status=waiting')) return [{ id: 301, status: 'waiting' }];
        if (path.includes('status=queued')) return [{ id: 302, status: 'queued' }];
        return [];
      },
    });

    await line.onProductionFailed(REPO, SHA, 77, null);

    expect(listed).toEqual([
      '/repos/exampleco/app/actions/workflows/promote-production.yml/runs?status=queued&per_page=100',
      '/repos/exampleco/app/actions/workflows/promote-production.yml/runs?status=waiting&per_page=100',
      '/repos/exampleco/app/actions/workflows/promote-production.yml/runs?status=pending&per_page=100',
    ]);
    expect(cancelled).toEqual(['/repos/exampleco/app/actions/runs/302/cancel', '/repos/exampleco/app/actions/runs/301/cancel']);
    // In that order: every cancel before the dispatch.
    const posts = client.request.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path);
    expect(posts).toEqual([
      '/repos/exampleco/app/actions/runs/302/cancel',
      '/repos/exampleco/app/actions/runs/301/cancel',
      '/repos/exampleco/app/actions/workflows/rollback-production.yml/dispatches',
    ]);
    expect(world.audits.filter((entry) => entry.action === 'deploy.promote_cancelled')).toHaveLength(2);
  });

  it('holds every promote in the repository until it has finished, and lets them go once it succeeded', async () => {
    rollbackDispatched();
    world.runs.set(NEWER, { sha: NEWER, prNumber: 41, smoke: 'success' });
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, {
      runsFor: rollbackRuns([{ id: 91, status: 'completed', conclusion: 'success', created_at: '2026-09-30T12:00:05Z' }]),
    });

    const held = await line.promote(REPO, NEWER);

    expect(held).toBe('app@beef567: holding its promote for the rollback of production after abc1234, which has not finished');
    expect(dispatched).toEqual([]);
    expect(world.runs.get(NEWER)?.promoteAfter).toBeInstanceOf(Date);

    // The sweep sees the rollback succeed, then promotes what it held.
    expect(await line.checkRollbacks()).toEqual(['app@abc1234: production was rolled back (rollback-production run 91)']);
    await line.promoteDue();
    expect(dispatched).toEqual([{ path: '/repos/exampleco/app/actions/workflows/promote-production.yml/dispatches', body: { ref: 'main', inputs: { candidate: NEWER } } }]);
  });

  it('records a run that failed, and dispatches nothing again', async () => {
    rollbackDispatched();
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, {
      runsFor: rollbackRuns([{ id: 92, status: 'completed', conclusion: 'failure', created_at: '2026-09-30T12:00:05Z' }]),
    });

    const [said] = await line.checkRollbacks();

    expect(said).toContain('the rollback failed (rollback-production run 92: failure)');
    expect(world.runs.get(SHA)).toMatchObject({ rollbackConclusion: 'failure', rollback_dispatched_at: DISPATCHED_AT });
    expect(await line.retryUndispatched()).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('gives back a run that was cancelled, says why, and the sweep dispatches it again', async () => {
    rollbackDispatched();
    const { line, dispatched } = pipeline(DEFAULT_DELIVERY_RULES, {
      // An older run of the workflow, from before this dispatch, is not this one.
      runsFor: rollbackRuns([
        { id: 80, status: 'completed', conclusion: 'success', created_at: '2026-09-29T09:00:00Z' },
        { id: 93, status: 'completed', conclusion: 'cancelled', created_at: '2026-09-30T12:00:05Z' },
      ]),
    });

    const [said] = await line.checkRollbacks();

    expect(said).toBe('app@abc1234: rollback-production run 93 was cancelled before it finished; the deploy sweep dispatches it again');
    expect(world.runs.get(SHA)).toMatchObject({ rollbackTrouble: 'rollback-production run 93 was cancelled before it finished' });
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBeUndefined();
    await line.retryUndispatched();
    expect(dispatched).toEqual([{ path: '/repos/exampleco/app/actions/workflows/rollback-production.yml/dispatches', body: { ref: 'main', inputs: {} } }]);
  });

  it('waits for a run GitHub has not listed yet, and gives it back once it is overdue', async () => {
    rollbackDispatched();
    const { line, advance } = pipeline(DEFAULT_DELIVERY_RULES, { now: Date.parse(DISPATCHED_AT) + 60_000, runsFor: rollbackRuns([]) });

    expect(await line.checkRollbacks()).toEqual(['app@abc1234: its rollback was dispatched, and GitHub lists no run of it yet']);
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBe(DISPATCHED_AT);

    advance(10 * 60_000);
    const [said] = await line.checkRollbacks();

    expect(said).toContain('no run of rollback-production appeared within 10 minutes of its dispatch');
    expect(world.runs.get(SHA)?.rollback_dispatched_at).toBeUndefined();
    expect(world.runs.get(SHA)?.rollbackTrouble).toContain('no run of rollback-production appeared');
  });

  it('leaves a run that is still waiting or running', async () => {
    rollbackDispatched();
    const { line } = pipeline(DEFAULT_DELIVERY_RULES, { runsFor: rollbackRuns([{ id: 94, status: 'in_progress', conclusion: null, created_at: '2026-09-30T12:00:05Z' }]) });

    expect(await line.checkRollbacks()).toEqual(['app@abc1234: its rollback is in progress']);
    expect(world.runs.get(SHA)).toMatchObject({ rollback_dispatched_at: DISPATCHED_AT });
    expect(world.runs.get(SHA)?.rollbackConclusion).toBeUndefined();
  });

  it('is said to have been dispatched in a send-back, and to have rolled production back only once it succeeded', async () => {
    rollbackDispatched();
    world.runs.get(SHA)!.production = 'failure';
    const { line, sentBack } = pipeline(DEFAULT_DELIVERY_RULES);

    await line.sendBackDue();

    expect(sentBack).toEqual([expect.objectContaining({ reason: 'The production deploy of `abc1234` failed. A rollback of production was dispatched.' })]);
    expect(rollbackSaid({ rollbackDispatchedAt: DISPATCHED_AT, rollbackConclusion: 'success' })).toBe(' Production was rolled back.');
  });
});

describe('where a failed promote stopped', () => {
  it('places each step of OpenADLC’s own promote', () => {
    expect(promoteFailure(promoteSteps(1))).toBe('other');
    expect(promoteFailure(promoteSteps(6))).toBe('smoke');
    expect(promoteFailure(promoteSteps(7))).toBe('shift');
    expect(promoteFailure(promoteSteps(7, 'cancelled'))).toBe('shift');
    // After the shift, traffic did move: a person checks.
    expect(promoteFailure(promoteSteps(8))).toBe('other');
  });

  it('takes a run where nothing ran as never having run', () => {
    expect(promoteFailure([])).toBe('never-ran');
    expect(promoteFailure([{ steps: [{ name: 'promote', status: 'completed', conclusion: 'skipped' }] }])).toBe('never-ran');
  });

  it('cannot place the template’s single promote step, nor steps it could not read', () => {
    expect(promoteFailure([{ steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'promote', status: 'completed', conclusion: 'failure' }] }])).toBe('unknown');
    expect(promoteFailure(null)).toBe('unknown');
  });
});

describe('a workflow by its rules name', () => {
  it('is the file GitHub dispatches', () => {
    expect(workflowFile('deploy-testing')).toBe('deploy-testing.yml');
    expect(workflowFile('ship.yaml')).toBe('ship.yaml');
  });
});
