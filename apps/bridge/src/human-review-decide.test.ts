import { describe, expect, it, vi } from 'vitest';
import { HumanReviewDecisions, LINK_ACCOUNT_URL, type HumanReviewDeps } from './human-review-decide.js';
import type { GitHubViewer } from './person-github.js';
import { HttpFailure } from './router.js';

const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
const NEXT = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const REPO = { name: 'openadlc', fullName: 'acme/openadlc', defaultBranch: 'main' };
const JANE = 4242;

/** A world in which @janedoe (id 4242) is awaited on #40 at HEAD, and jane@acme.test has linked that account. */
function world(over: Partial<HumanReviewDeps> = {}) {
  const posted: { token: string; number: number; review: { commitId: string; body: string } }[] = [];
  const comments: { number: number; body: string }[] = [];
  const audits: { action: string; payload: Record<string, unknown> }[] = [];
  const sentBack: { by: string; reason: string }[] = [];
  let use: ((viewer: GitHubViewer, token: string) => Promise<unknown>) | null = null;
  let state: 'waiting' | 'done' | 'failed' = 'waiting';
  const pull = { open: true, head: HEAD, url: 'https://github.com/acme/openadlc/pull/40' };
  const deps: HumanReviewDeps = {
    linkOf: vi.fn(async (identity: string) => (identity === 'jane@acme.test' ? { githubLogin: 'janedoe', githubUserId: JANE } : identity === 'sam@acme.test' ? { githubLogin: 'sam', githubUserId: 7 } : null)),
    userIdOf: vi.fn(async (login: string) => (login.toLowerCase() === 'janedoe' ? JANE : 7)),
    standing: vi.fn(async (_repo: string, pr: number, login: string) => (pr === 40 && login.toLowerCase() === 'janedoe' ? { head: HEAD } : null)),
    pull: vi.fn(async () => ({ ...pull })),
    flows: {
      start: vi.fn(async (_identity: string, given: (viewer: GitHubViewer, token: string) => Promise<unknown>) => {
        use = given as never;
        state = 'waiting';
        return { flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, state: 'waiting' as const };
      }) as never,
      state: vi.fn(() => ({ state }) as never) as never,
    },
    isCrew: vi.fn(async (login: string) => login === 'openadlc-bot'),
    postReviewAsPerson: vi.fn(async (token: string, _full: string, number: number, review: { commitId: string; body: string }) => {
      posted.push({ token, number, review });
      return { id: 9, htmlUrl: 'https://github.com/acme/openadlc/pull/40#pullrequestreview-9' };
    }),
    commentAsApp: vi.fn(async (_full: string, number: number, body: string) => {
      comments.push({ number, body });
      return { htmlUrl: 'https://github.com/acme/openadlc/pull/40#issuecomment-1' };
    }),
    rejected: vi.fn(async (_repo: string, _pr: number, head: string) => audits.some((one) => one.action === 'pull.human_review_rejected' && one.payload.head === head)),
    audit: vi.fn(async (entry: { action: string; payload: Record<string, unknown> }) => {
      audits.push(entry);
    }),
    sendBack: vi.fn(async (input: { by: string; reason: string }) => {
      sentBack.push({ by: input.by, reason: input.reason });
      return null;
    }),
    ...over,
  };
  const decisions = new HumanReviewDecisions(deps);
  /** Answers the device code as `viewer`, as GitHub would once the person approves it. */
  const signIn = async (viewer: GitHubViewer) => {
    if (!use) throw new Error('no flow was started');
    try {
      const result = await use(viewer, 'gho_secret');
      state = 'done';
      return result;
    } catch (error) {
      state = 'failed';
      throw error;
    }
  };
  return { deps, decisions, posted, comments, audits, sentBack, signIn, pull };
}

const asked = { repo: REPO, number: 40, login: 'janedoe', head: HEAD, identity: 'jane@acme.test' };

async function refusal(work: Promise<unknown>): Promise<HttpFailure> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpFailure);
  return error as HttpFailure;
}

describe('who may decide a held approval', () => {
  it('is the person whose linked account id is the awaited login’s, and only them', async () => {
    const { decisions } = world();
    expect(await decisions.mayDecide('jane@acme.test', 'JaneDoe')).toEqual({ yours: true, linkedId: JANE });
    expect(await decisions.mayDecide('sam@acme.test', 'janedoe')).toMatchObject({ yours: false, status: 403, why: "This is @janedoe's to decide; you can Discuss it." });
    expect(await decisions.mayDecide('nobody@acme.test', 'janedoe')).toMatchObject({
      yours: false,
      status: 409,
      settingsUrl: LINK_ACCOUNT_URL,
      why: expect.stringContaining('Link it in Settings → Your GitHub account'),
    });
  });

  it('goes by account id, not login: a linked login that matches by name but not by id is not theirs', async () => {
    const { decisions } = world({ linkOf: async () => ({ githubLogin: 'janedoe', githubUserId: 999 }) });
    expect(await decisions.mayDecide('jane@acme.test', 'janedoe')).toMatchObject({ yours: false, status: 403 });
  });

  it('keeps no failed lookup: GitHub answering later lets the person decide', async () => {
    let answers = false;
    const { decisions } = world({ userIdOf: async () => (answers ? JANE : null) });
    expect(await decisions.mayDecide('jane@acme.test', 'janedoe')).toMatchObject({ yours: false, status: 503 });
    answers = true;
    expect(await decisions.mayDecide('jane@acme.test', 'janedoe')).toMatchObject({ yours: true });
  });
});

describe('Approve', () => {
  it('posts the linked person’s own APPROVE review, pinned to the head, through their one-post token, and audits it', async () => {
    const { decisions, posted, audits, signIn } = world();
    const started = await decisions.approve(asked);
    expect(started).toEqual({ flow: { flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } });
    expect(posted).toEqual([]);

    expect(await signIn({ login: 'janedoe', id: JANE })).toEqual({ commentUrl: 'https://github.com/acme/openadlc/pull/40#pullrequestreview-9' });
    expect(posted).toEqual([{ token: 'gho_secret', number: 40, review: { commitId: HEAD, body: 'Approved from the OpenADLC console.' } }]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'pull.human_review_approved',
        target: 'openadlc#40',
        payload: expect.objectContaining({ login: 'janedoe', awaited: 'janedoe', head: HEAD, reviewId: 9, by: 'jane@acme.test' }),
      }),
    ]);
    // The token goes nowhere but the post.
    expect(JSON.stringify(audits)).not.toContain('gho_secret');
  });

  it('refuses anyone else, 403, and starts nothing', async () => {
    const { decisions, deps, posted } = world();
    const refused = await refusal(decisions.approve({ ...asked, identity: 'sam@acme.test' }));
    expect(refused.status).toBe(403);
    expect(refused.message).toBe("This is @janedoe's to decide; you can Discuss it.");
    expect(deps.flows.start).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('sends a person with no linked account to Settings, 409', async () => {
    const { decisions, deps } = world();
    const refused = await refusal(decisions.approve({ ...asked, identity: 'nobody@acme.test' }));
    expect(refused.status).toBe(409);
    expect(refused.details).toEqual({ url: LINK_ACCOUNT_URL });
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('refuses a stale head with a message that says to reload, and posts nothing', async () => {
    const { decisions, deps } = world();
    const refused = await refusal(decisions.approve({ ...asked, head: NEXT }));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('reload');
    expect(refused.message).toContain('Nothing was posted');
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('refuses when the pull request no longer waits on the person', async () => {
    const { decisions, deps } = world({ standing: async () => null });
    const refused = await refusal(decisions.approve(asked));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('no longer waits on @janedoe');
    expect(deps.flows.start).not.toHaveBeenCalled();
  });

  it('refuses a second press while the first sign-in still waits', async () => {
    const { decisions, deps } = world();
    await decisions.approve(asked);
    const refused = await refusal(decisions.approve(asked));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('still waiting for you');
    expect(deps.flows.start).toHaveBeenCalledTimes(1);
  });

  it('posts nothing when the code is approved by another account, a crew account, or after the head moved', async () => {
    const other = world();
    await other.decisions.approve(asked);
    await expect(other.signIn({ login: 'sam', id: 7 })).rejects.toThrow('not the GitHub account linked to you here; nothing was posted');
    expect(other.posted).toEqual([]);

    const crew = world({ linkOf: async () => ({ githubLogin: 'openadlc-bot', githubUserId: JANE }) });
    await crew.decisions.approve(asked);
    await expect(crew.signIn({ login: 'openadlc-bot', id: JANE })).rejects.toThrow('an account the crew uses');
    expect(crew.posted).toEqual([]);

    const moved = world();
    await moved.decisions.approve(asked);
    vi.mocked(moved.deps.pull).mockResolvedValue({ open: true, head: NEXT, url: moved.pull.url });
    await expect(moved.signIn({ login: 'janedoe', id: JANE })).rejects.toThrow('moved to c0ffee0 while you signed in');
    expect(moved.posted).toEqual([]);
    expect(moved.audits).toEqual([]);
  });
});

describe('Reject', () => {
  it('needs a reason, and refuses an empty or blank one', async () => {
    const { decisions, comments, sentBack } = world();
    for (const reason of ['', '   \n ']) {
      const refused = await refusal(decisions.reject({ ...asked, reason }));
      expect(refused.status).toBe(400);
      expect(refused.message).toBe('A reason is required; it is what the builder fixes.');
    }
    expect((await refusal(decisions.reject({ ...asked, reason: 'x'.repeat(2001) }))).status).toBe(400);
    expect(comments).toEqual([]);
    expect(sentBack).toEqual([]);
  });

  it('says it on the pull request as the app, audits it, and opens the patch round with the reason as the finding', async () => {
    const { decisions, comments, audits, sentBack } = world();
    const result = await decisions.reject({ ...asked, reason: '  Keep the old timeout.\nIt is load-bearing.  ' });

    expect(result).toEqual({ state: 'sent_back', commentUrl: 'https://github.com/acme/openadlc/pull/40#issuecomment-1' });
    expect(comments).toEqual([{ number: 40, body: '@janedoe rejected `692cd1f` from the OpenADLC console:\n\n> Keep the old timeout.\n> It is load-bearing.' }]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'pull.human_review_rejected',
        target: 'openadlc#40',
        payload: expect.objectContaining({ login: 'janedoe', head: HEAD, reason: 'Keep the old timeout.\nIt is load-bearing.', by: 'jane@acme.test' }),
      }),
    ]);
    expect(sentBack).toEqual([{ by: '@janedoe', reason: 'Keep the old timeout.\nIt is load-bearing.' }]);
  });

  it('refuses a second Reject of the same head', async () => {
    const { decisions, sentBack } = world();
    await decisions.reject({ ...asked, reason: 'No.' });
    const refused = await refusal(decisions.reject({ ...asked, reason: 'Still no.' }));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('already sent back');
    expect(sentBack).toHaveLength(1);
  });

  it('refuses anyone else and a stale head, doing nothing', async () => {
    const { decisions, comments, sentBack, audits } = world();
    expect((await refusal(decisions.reject({ ...asked, identity: 'sam@acme.test', reason: 'No.' }))).status).toBe(403);
    const stale = await refusal(decisions.reject({ ...asked, head: NEXT, reason: 'No.' }));
    expect(stale.status).toBe(409);
    expect(stale.message).toContain('reload');
    expect(comments).toEqual([]);
    expect(audits).toEqual([]);
    expect(sentBack).toEqual([]);
  });

  it('does nothing when the app cannot post, and says why when no round could open', async () => {
    const none = world({ commentAsApp: async () => null });
    expect((await refusal(none.decisions.reject({ ...asked, reason: 'No.' }))).status).toBe(503);
    expect(none.sentBack).toEqual([]);
    expect(none.audits).toEqual([]);

    const stopped = world({ sendBack: async () => 'its review rounds have not converged, and the loop stopped for a person' });
    expect(await stopped.decisions.reject({ ...asked, reason: 'No.' })).toEqual({
      state: 'not_sent_back',
      commentUrl: 'https://github.com/acme/openadlc/pull/40#issuecomment-1',
      why: 'its review rounds have not converged, and the loop stopped for a person',
    });
  });
});
