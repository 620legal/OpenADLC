import { describe, expect, it, vi } from 'vitest';
import type { MergeBlocker } from './automation.js';
import { HeldMergeDecisions, PERMISSION_KEPT_MS, occurrence, offer, type HeldMergeDeps } from './held-merge-decide.js';
import { LINK_ACCOUNT_URL } from './human-review-decide.js';
import type { GitHubViewer } from './person-github.js';
import { HttpFailure } from './router.js';

const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
const NEXT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const REPO = { name: 'openadlc', fullName: 'acme/openadlc', defaultBranch: 'main' };
const JANE = 4242;
const STALE: MergeBlocker = { kind: 'person', reason: 'it is behind main, and main requires a branch to be up to date before it merges: update it from main' };
const NO_APPROVAL: MergeBlocker = { kind: 'human_review', reason: '@orzelig has not approved this version' };

/**
 * A world in which #40 is held at HEAD on a stale branch, jane@acme.test has
 * linked @janedoe (id 4242, write), and sam@acme.test has linked @sam (read).
 */
function world(over: Partial<HeldMergeDeps> = {}) {
  const merged: { token: string; number: number; head: string }[] = [];
  const audits: { action: string; payload: Record<string, unknown> }[] = [];
  let use: ((viewer: GitHubViewer, token: string) => Promise<unknown>) | null = null;
  let state: 'waiting' | 'done' | 'failed' = 'waiting';
  const pull = { open: true, head: HEAD, url: 'https://github.com/acme/openadlc/pull/40' };
  let blockers: MergeBlocker[] | null = [STALE];
  const roles: Record<string, string> = { janedoe: 'write', sam: 'read', ann: 'triage', boss: 'admin' };
  const deps: HeldMergeDeps = {
    linkOf: vi.fn(async (identity: string) =>
      identity === 'jane@acme.test'
        ? { githubLogin: 'janedoe', githubUserId: JANE }
        : identity === 'sam@acme.test'
          ? { githubLogin: 'sam', githubUserId: 7 }
          : identity === 'bot@acme.test'
            ? { githubLogin: 'openadlc-bot', githubUserId: 99 }
            : null,
    ),
    permissionOf: vi.fn(async (_full: string, login: string) => roles[login] ?? null),
    isCrew: vi.fn(async (login: string) => login === 'openadlc-bot'),
    held: vi.fn(async (_repo: string, pr: number) => (pr === 40 ? { head: HEAD, reason: STALE.reason } : null)),
    pull: vi.fn(async () => ({ ...pull })),
    blockers: vi.fn(async () => blockers),
    flows: {
      start: vi.fn(async (_identity: string, given: (viewer: GitHubViewer, token: string) => Promise<unknown>) => {
        use = given as never;
        state = 'waiting';
        return { flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, state: 'waiting' as const };
      }) as never,
      state: vi.fn(() => ({ state }) as never) as never,
    },
    mergeAsPerson: vi.fn(async (token: string, _full: string, number: number, head: string) => {
      merged.push({ token, number, head });
      return { sha: 'merged00merged00merged00merged00merged00' };
    }),
    audit: vi.fn(async (entry: { action: string; payload: Record<string, unknown> }) => {
      audits.push(entry);
    }),
    warn: vi.fn(),
    ...over,
  };
  const decisions = new HeldMergeDecisions(deps);
  const signIn = async (viewer: GitHubViewer) => {
    if (!use) throw new Error('no flow was started');
    try {
      const result = await use(viewer, 'gho_person');
      state = 'done';
      return result;
    } catch (error) {
      state = 'failed';
      throw error;
    }
  };
  return {
    deps,
    decisions,
    merged,
    audits,
    signIn,
    pull,
    setBlockers: (next: MergeBlocker[] | null) => {
      blockers = next;
    },
  };
}

const pressed = { repo: REPO, number: 40, head: HEAD, identity: 'jane@acme.test' };
const JANE_VIEWER = { id: JANE, login: 'janedoe' } as GitHubViewer;

async function refusal(work: Promise<unknown>): Promise<HttpFailure> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpFailure);
  return error as HttpFailure;
}

describe('what a held merge’s card offers', () => {
  const none = { humanReview: null, refusedOnHead: null };

  it.each([
    'it is held for a person (needs-human or openadlc:paused)',
    'it changes how CI runs (.github/workflows/ci.yml), and in this repository a person merges those',
    'auto-merge is not on for it',
    STALE.reason,
  ])('offers Merge over %s', (reason) => {
    expect(offer({ reason, head: HEAD }, none)).toEqual({ merge: true });
  });

  it.each([
    ['ci failed on the head', 'There is no Merge: a required check has not passed on this head. Open it on GitHub, or Discuss it.'],
    ['ci has not passed on the head', 'There is no Merge: a required check has not passed on this head. Open it on GitHub, or Discuss it.'],
    ['review-gate as OpenADLC published it is not green on the head', 'There is no Merge: a required check has not passed on this head. Open it on GitHub, or Discuss it.'],
    ['openadlc-lead has not reviewed it', 'There is no Merge: OpenADLC does not offer one over this hold (openadlc-lead has not reviewed it). Open it on GitHub, or Discuss it.'],
    ['@orzelig has not approved this version', 'There is no Merge: OpenADLC does not offer one over this hold (@orzelig has not approved this version). Open it on GitHub, or Discuss it.'],
  ])('offers no Merge over %s', (reason, why) => {
    expect(offer({ reason, head: HEAD }, none)).toEqual({ merge: false, why });
  });

  it('offers no Merge while a Human-review approval is awaited, whatever the stored reason', () => {
    // A CI change a person merges, also waiting on @orzelig: Merge must never stand in for that approval.
    const reason = 'it changes how CI runs (.github/workflows/ci.yml), and in this repository a person merges those';
    expect(offer({ reason, head: HEAD }, { humanReview: 'orzelig', refusedOnHead: null })).toEqual({
      merge: false,
      why: "There is no Merge: this waits for @orzelig's approval under AGENTS.md's Human review, which is decided on its own card.",
    });
  });

  it('offers no Merge on a head a Merge was refused on, with why', () => {
    expect(offer({ reason: STALE.reason, head: HEAD }, { humanReview: null, refusedOnHead: [NO_APPROVAL.reason] })).toEqual({
      merge: false,
      why: 'Merge was refused on 692cd1f: @orzelig has not approved this version.',
    });
  });

  it('offers no Merge when the held head was not recorded', () => {
    expect(offer({ reason: STALE.reason, head: null }, none).merge).toBe(false);
  });
});

describe('who may press Merge', () => {
  it('is a linked account GitHub lets write, and nobody else', async () => {
    const { decisions } = world();
    expect(await decisions.mayMerge('jane@acme.test', REPO)).toEqual({ yours: true, linkedId: JANE, login: 'janedoe' });
    expect(await decisions.mayMerge('sam@acme.test', REPO)).toMatchObject({ yours: false, status: 403, why: '@sam cannot merge in acme/openadlc (GitHub says read); someone who can merges it.' });
    expect(await decisions.mayMerge('nobody@acme.test', REPO)).toMatchObject({ yours: false, status: 409, settingsUrl: LINK_ACCOUNT_URL, why: expect.stringContaining('Link it in Settings') });
    expect(await decisions.mayMerge('bot@acme.test', REPO)).toMatchObject({ yours: false, status: 403, why: expect.stringContaining('the crew uses') });
  });

  it('is not anyone GitHub could not be asked about', async () => {
    const { decisions } = world({ permissionOf: vi.fn(async () => null) });
    expect(await decisions.mayMerge('jane@acme.test', REPO)).toMatchObject({ yours: false, status: 503 });
  });

  it('keeps GitHub’s answer ten minutes, per repository and login', async () => {
    let now = 1_000_000;
    const { decisions, deps } = world({ now: () => now });
    await decisions.mayMerge('jane@acme.test', REPO);
    await decisions.mayMerge('jane@acme.test', REPO);
    expect(deps.permissionOf).toHaveBeenCalledTimes(1);
    now += PERMISSION_KEPT_MS;
    await decisions.mayMerge('jane@acme.test', REPO);
    expect(deps.permissionOf).toHaveBeenCalledTimes(2);
  });
});

describe('a console Merge', () => {
  it('merges as the person, through their token alone, pinned to the head they saw', async () => {
    const { decisions, signIn, merged, audits, deps } = world();
    const { flow } = await decisions.merge(pressed);
    expect(flow.userCode).toBe('ABCD-1234');
    expect(merged).toEqual([]);

    expect(await signIn(JANE_VIEWER)).toEqual({ commentUrl: 'https://github.com/acme/openadlc/pull/40', mergedSha: 'merged00merged00merged00merged00merged00' });
    expect(merged).toEqual([{ token: 'gho_person', number: 40, head: HEAD }]);
    expect(audits.map((one) => one.action)).toEqual(['pull.person_merged']);
    expect(audits[0]!.payload).toMatchObject({ repo: 'openadlc', pr: 40, head: HEAD, login: 'janedoe', by: 'jane@acme.test' });
    // The blockers were read again once the code was approved.
    expect(deps.blockers).toHaveBeenCalledTimes(2);
  });

  it.each(['sam@acme.test', 'ann@acme.test'])('is refused, with no flow started, for %s whom GitHub does not let merge', async (identity) => {
    const { decisions, deps } = world({
      linkOf: vi.fn(async (who: string) => (who === identity ? { githubLogin: who.split('@')[0]!, githubUserId: 7 } : null)),
    });
    const failure = await refusal(decisions.merge({ ...pressed, identity }));
    expect(failure.status).toBe(403);
    expect(failure.message).toContain('cannot merge in acme/openadlc');
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('is refused when the pull request is no longer held, or moved', async () => {
    const { decisions, deps, pull } = world();
    expect((await refusal(decisions.merge({ ...pressed, number: 41 }))).message).toBe('#41 is no longer held for a person; reload. Nothing was merged.');
    pull.head = NEXT;
    expect((await refusal(decisions.merge(pressed))).message).toBe('Pull request #40 moved to c0ffee0 since you looked; reload. Nothing was merged.');
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('is refused over a missing Human-review approval the stored reason did not show, and says so', async () => {
    // Held as a CI change a person merges; the rules read now find @orzelig has not approved.
    const { decisions, deps, audits, setBlockers } = world();
    setBlockers([{ kind: 'person', reason: 'it changes how CI runs (.github/workflows/ci.yml), and in this repository a person merges those' }, NO_APPROVAL]);

    const failure = await refusal(decisions.merge(pressed));
    expect(failure.status).toBe(409);
    expect(failure.message).toBe('There is no Merge on 692cd1f: @orzelig has not approved this version. Nothing was merged.');
    expect(deps.flows.start).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ action: 'pull.person_merge_refused', payload: expect.objectContaining({ head: HEAD, blockers: [NO_APPROVAL] }) })]);
  });

  it.each<[string, MergeBlocker]>([
    ['a failed required check', { kind: 'check', reason: 'ci failed on the head' }],
    ['a missing crew review', { kind: 'review', reason: 'openadlc-lead has not reviewed it' }],
  ])('is refused over %s', async (_name, blocker) => {
    const { decisions, setBlockers, deps } = world();
    setBlockers([blocker]);
    expect((await refusal(decisions.merge(pressed))).status).toBe(409);
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('is refused when GitHub could not be read in full', async () => {
    const { decisions, setBlockers } = world();
    setBlockers(null);
    expect((await refusal(decisions.merge(pressed))).status).toBe(503);
  });

  it('merges nothing when the code is approved by another account, or a crew one', async () => {
    const { decisions, signIn, merged } = world();
    await decisions.merge(pressed);
    await expect(signIn({ id: 7, login: 'sam' } as GitHubViewer)).rejects.toThrow('not the GitHub account linked to you');
    expect(merged).toEqual([]);
  });

  it('merges nothing when the head moved while the person signed in', async () => {
    const { decisions, signIn, merged, pull } = world();
    await decisions.merge(pressed);
    pull.head = NEXT;
    await expect(signIn(JANE_VIEWER)).rejects.toThrow('moved to c0ffee0 while you signed in');
    expect(merged).toEqual([]);
  });

  it('merges nothing when a blocker came while the person signed in', async () => {
    const { decisions, signIn, merged, setBlockers, audits } = world();
    await decisions.merge(pressed);
    setBlockers([STALE, NO_APPROVAL]);
    await expect(signIn(JANE_VIEWER)).rejects.toThrow('@orzelig has not approved this version');
    expect(merged).toEqual([]);
    expect(audits.map((one) => one.action)).toEqual(['pull.person_merge_refused']);
  });

  it('says GitHub’s refusal, and records it, when GitHub will not merge', async () => {
    const refused = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
    const { decisions, signIn, audits } = world({ mergeAsPerson: vi.fn(async () => Promise.reject(refused)) });
    await decisions.merge(pressed);
    await expect(signIn(JANE_VIEWER)).rejects.toThrow('GitHub refused the merge: Pull Request is not mergeable. Nothing changed.');
    expect(audits).toEqual([expect.objectContaining({ action: 'pull.person_merge_failed', payload: expect.objectContaining({ status: 405, message: 'Pull Request is not mergeable' }) })]);
  });

  it('starts one sign-in at a time for the same head', async () => {
    const { decisions, deps } = world();
    await decisions.merge(pressed);
    expect((await refusal(decisions.merge(pressed))).message).toContain('still waiting for you');
    expect(deps.flows.start).toHaveBeenCalledTimes(1);
  });
});

describe('what a Leave it covers', () => {
  it('changes with the head, the reason and the newest review', () => {
    const base = occurrence({ head: HEAD, reason: STALE.reason }, 12);
    expect(base).toMatch(/^692cd1f88f3e45093ad9ba4e68e84d590af3b595\|[0-9a-f]{12}\|12$/);
    expect(occurrence({ head: HEAD, reason: STALE.reason }, 12)).toBe(base);
    expect(occurrence({ head: NEXT, reason: STALE.reason }, 12)).not.toBe(base);
    expect(occurrence({ head: HEAD, reason: 'auto-merge is not on for it' }, 12)).not.toBe(base);
    expect(occurrence({ head: HEAD, reason: STALE.reason }, 13)).not.toBe(base);
    expect(occurrence({ head: HEAD, reason: STALE.reason }, null)).toMatch(/\|none$/);
  });
});
