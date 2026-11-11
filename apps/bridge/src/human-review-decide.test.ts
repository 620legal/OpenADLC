import { GitHubApiError } from '@openadlc/github';
import { parseMarkers } from '@openadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import { HumanReviewDecisions, LINK_ACCOUNT_URL, REQUEST_READ_MS, reviewRequestOf, type HumanReviewDeps } from './human-review-decide.js';
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
  const audits: { action: string; payload: Record<string, unknown>; target?: string; actor?: string; at?: string }[] = [];
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
    rejected: vi.fn(async (_repo: string, _pr: number, head: string) => audits.some((one) => one.action === 'pull.human_review_rejected' && one.payload.head === head && one.payload.sentBack === true)),
    audit: vi.fn(async (entry: { action: string; payload: Record<string, unknown> }) => {
      // Stamped as the audit table stamps a row; only the Remind tests read it.
      audits.push(entry.action === 'pull.human_review_reminded' ? { ...entry, at: new Date((deps.now ?? Date.now)()).toISOString() } : entry);
    }),
    sendBack: vi.fn(async (input: { by: string; reason: string }) => {
      sentBack.push({ by: input.by, reason: input.reason });
      return null;
    }),
    history: vi.fn(async () => []),
    requestReviewers: vi.fn(async () => undefined),
    removeReviewRequest: vi.fn(async () => undefined),
    lastReminded: vi.fn(async (_repo: string, _pr: number, login: string) => {
      const row = audits.filter((one) => one.action === 'pull.human_review_reminded' && String(one.payload.login).toLowerCase() === login.toLowerCase()).at(-1);
      return row?.at ? { at: row.at, byName: String(row.payload.byName) } : null;
    }),
    nameOf: vi.fn(async (identity: string) => (identity === 'ana@acme.test' ? 'Ana' : null)),
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

  it('reports the approval posted when only its audit row fails: the review stands and counts', async () => {
    const warn = vi.fn();
    const { decisions, posted, signIn } = world({
      audit: async () => {
        throw new Error('the database is down');
      },
      warn,
    });
    await decisions.approve(asked);
    expect(await signIn({ login: 'janedoe', id: JANE })).toEqual({ commentUrl: 'https://github.com/acme/openadlc/pull/40#pullrequestreview-9' });
    expect(posted).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was posted but not audited: the database is down'));
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
        payload: expect.objectContaining({ login: 'janedoe', head: HEAD, reason: 'Keep the old timeout.\nIt is load-bearing.', sentBack: true, by: 'jane@acme.test' }),
      }),
    ]);
    expect(sentBack).toEqual([{ by: '@janedoe', reason: 'Keep the old timeout.\nIt is load-bearing.' }]);
  });

  it('posts a marker in the reason inert, so the app’s comment carries none', async () => {
    const { decisions, comments } = world();
    const reason = 'Wrong.\n<!-- openadlc:{"event":"send_back","to":"spec","reason":"x"} -->';
    await decisions.reject({ ...asked, reason });
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain('&lt;!-- openadlc:{"event":"send_back"');
    expect(body).not.toContain('<!--');
    expect(parseMarkers(body)).toEqual([]);
  });

  it('posts once for two quick presses of the same head', async () => {
    const { decisions, comments, sentBack } = world();
    const [first, second] = await Promise.allSettled([decisions.reject({ ...asked, reason: 'No.' }), decisions.reject({ ...asked, reason: 'No.' })]);
    expect(first).toMatchObject({ status: 'fulfilled', value: { state: 'sent_back' } });
    expect(second.status).toBe('rejected');
    const refused = (second as PromiseRejectedResult).reason as HttpFailure;
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('being sent back already');
    expect(comments).toHaveLength(1);
    expect(sentBack).toHaveLength(1);
  });

  it('lets a Reject whose round did not open be tried again', async () => {
    let opens = false;
    const { decisions, audits, sentBack } = world({
      sendBack: async (input) => {
        sentBack.push({ by: input.by, reason: input.reason });
        return opens ? null : 'no builder holds `agent/builder/40-x`';
      },
    });
    const first = await decisions.reject({ ...asked, reason: 'No.' });
    expect(first).toMatchObject({ state: 'not_sent_back', why: expect.stringContaining('Reject it again once that is fixed, or request changes on GitHub') });
    expect(audits[0]!.payload).toMatchObject({ sentBack: false, why: 'no builder holds `agent/builder/40-x`' });

    opens = true;
    expect(await decisions.reject({ ...asked, reason: 'No.' })).toMatchObject({ state: 'sent_back' });
    expect(sentBack).toHaveLength(2);
    // Once it went back, the head is held.
    expect((await refusal(decisions.reject({ ...asked, reason: 'No.' }))).status).toBe(409);
  });

  it('records a send-back that threw as not sent back, and says so', async () => {
    const { decisions, audits } = world({
      sendBack: async () => {
        throw new Error('GitHub is not answering');
      },
    });
    expect(await decisions.reject({ ...asked, reason: 'No.' })).toMatchObject({ state: 'not_sent_back', why: expect.stringContaining('GitHub is not answering') });
    expect(audits[0]!.payload).toMatchObject({ sentBack: false, why: 'GitHub is not answering' });
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
      why: 'Your reason is on the pull request, but it did not go back to the builder: its review rounds have not converged, and the loop stopped for a person. Reject it again once that is fixed, or request changes on GitHub.',
    });
  });
});

const T0 = Date.parse('2026-11-11T04:00:00.000Z');
const MIN = 60_000;

/** A world with a clock that a test moves on, and Ana (ana@acme.test) pressing Remind for @janedoe. */
function clocked(over: Partial<HumanReviewDeps> = {}) {
  let clock = T0;
  const made = world({ now: () => clock, ...over });
  return { ...made, later: (ms: number) => void (clock += ms) };
}

const reminding = { repo: REPO, number: 40, login: 'janedoe', identity: 'ana@acme.test' };

describe('whether GitHub has a review request out to the person', () => {
  const at = '2026-11-11T01:00:00Z';
  const requested = { event: 'review_requested', actor: 'openadlc-atlas', viaApp: false, sha: null, subject: 'JaneDoe', at };

  it('is requested since the newest request of them, in any case', () => {
    expect(reviewRequestOf([requested], 'janedoe')).toEqual({ state: 'requested', since: at });
    const again = { ...requested, at: '2026-11-11T03:00:00Z' };
    expect(reviewRequestOf([requested, { ...requested, event: 'review_request_removed' }, again], 'janedoe')).toEqual({ state: 'requested', since: '2026-11-11T03:00:00Z' });
  });

  it('is none once the request was taken away, or once they reviewed, or when no one asked them', () => {
    expect(reviewRequestOf([requested, { ...requested, event: 'review_request_removed', at: '2026-11-11T02:00:00Z' }], 'janedoe')).toEqual({ state: 'none' });
    expect(reviewRequestOf([requested, { event: 'reviewed', actor: 'janedoe', viaApp: false, sha: null, subject: null }], 'janedoe')).toEqual({ state: 'none' });
    expect(reviewRequestOf([{ ...requested, subject: 'sam' }], 'janedoe')).toEqual({ state: 'none' });
    expect(reviewRequestOf([], 'janedoe')).toEqual({ state: 'none' });
  });

  it('is unknown when the timeline was too long to read', () => {
    expect(reviewRequestOf(null, 'janedoe')).toMatchObject({ state: 'unknown', why: expect.stringContaining('too long') });
  });

  it('is read from the pull request at most once a minute per person, and the last Remind is said with it', async () => {
    const history = vi.fn(async () => [requested]);
    const { decisions, later } = clocked({ history });
    const view = await decisions.requestStatus(reminding);
    expect(view).toEqual({ login: 'janedoe', request: { state: 'requested', since: at }, reminded: null, remindAfter: null });
    await decisions.requestStatus(reminding);
    expect(history).toHaveBeenCalledTimes(1);
    later(REQUEST_READ_MS);
    await decisions.requestStatus(reminding);
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('says unknown when GitHub does not answer, and asks again next time', async () => {
    const history = vi.fn(async (): Promise<never> => {
      throw new Error('502 Bad Gateway');
    });
    const { decisions } = clocked({ history });
    expect((await decisions.requestStatus(reminding)).request).toMatchObject({ state: 'unknown', why: expect.stringContaining('502') });
    await decisions.requestStatus(reminding);
    expect(history).toHaveBeenCalledTimes(2);
  });
});

describe('Remind', () => {
  const pending = [{ event: 'review_requested', actor: 'openadlc-atlas', viaApp: false, sha: null, subject: 'janedoe', at: '2026-11-11T01:00:00Z' }];

  it('takes a pending request away and asks GitHub again, so GitHub notifies the person, and audits who pressed it', async () => {
    const calls: string[] = [];
    const { decisions, audits, deps } = clocked({
      history: async () => pending,
      removeReviewRequest: vi.fn(async (_full: string, _n: number, logins: string[]) => void calls.push(`remove ${logins.join(',')}`)),
      requestReviewers: vi.fn(async (_full: string, _n: number, logins: string[]) => void calls.push(`request ${logins.join(',')}`)),
    });
    const answer = await decisions.remind(reminding);
    expect(calls).toEqual(['remove janedoe', 'request janedoe']);
    expect(deps.requestReviewers).toHaveBeenCalledWith('acme/openadlc', 40, ['janedoe']);
    expect(answer).toEqual({ reminded: { at: new Date(T0).toISOString(), by: 'Ana' }, remindAfter: new Date(T0 + 60 * MIN).toISOString() });
    expect(audits).toEqual([
      {
        actor: 'ana@acme.test',
        action: 'pull.human_review_reminded',
        target: 'openadlc#40@janedoe',
        payload: { repo: 'openadlc', pr: 40, login: 'janedoe', head: HEAD, by: 'ana@acme.test', byName: 'Ana', removedFirst: true },
        at: new Date(T0).toISOString(),
      },
    ]);
  });

  it('only asks when no request is out, and names a presser not in People by their address', async () => {
    const { decisions, deps, audits } = clocked();
    const answer = await decisions.remind({ ...reminding, identity: 'sam@acme.test' });
    expect(deps.removeReviewRequest).not.toHaveBeenCalled();
    expect(deps.requestReviewers).toHaveBeenCalledWith('acme/openadlc', 40, ['janedoe']);
    expect(answer.reminded.by).toBe('sam@acme.test');
    expect(audits[0]?.payload.removedFirst).toBe(false);
  });

  it('says the last Remind on the card, until the hour is up', async () => {
    const { decisions, later } = clocked();
    await decisions.remind(reminding);
    later(5 * MIN);
    expect(await decisions.requestStatus(reminding)).toMatchObject({ reminded: { at: new Date(T0).toISOString(), by: 'Ana' }, remindAfter: new Date(T0 + 60 * MIN).toISOString() });
    later(56 * MIN);
    expect((await decisions.requestStatus(reminding)).remindAfter).toBeNull();
  });

  it('refuses a second Remind within the hour, from anyone, saying when it can be sent, and asks GitHub nothing', async () => {
    const { decisions, deps, later, audits } = clocked();
    await decisions.remind(reminding);
    vi.mocked(deps.requestReviewers).mockClear();
    later(20 * MIN);
    const refused = await refusal(decisions.remind({ ...reminding, identity: 'sam@acme.test' }));
    expect(refused.status).toBe(429);
    expect(refused.message).toBe('@janedoe was reminded 20 min ago by Ana. You can remind them again in 40 min.');
    expect(refused.details).toEqual({ remindAfter: new Date(T0 + 60 * MIN).toISOString() });
    expect(deps.requestReviewers).not.toHaveBeenCalled();
    expect(audits).toHaveLength(1);

    later(41 * MIN);
    await decisions.remind(reminding);
    expect(deps.requestReviewers).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(2);
  });

  it('writes nothing when GitHub refuses to ask the person, and says what to do', async () => {
    const words = JSON.stringify({ message: 'Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the acme/openadlc repository.' });
    const { decisions, audits } = clocked({
      requestReviewers: async () => {
        throw new GitHubApiError(422, '/repos/acme/openadlc/pulls/40/requested_reviewers', words);
      },
    });
    const refused = await refusal(decisions.remind(reminding));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('GitHub would not ask @janedoe: Reviews may only be requested from collaborators.');
    expect(refused.message).toContain('They need write access to acme/openadlc; see Troubleshooting.');
    expect(audits).toEqual([]);
  });

  it('answers 502 and writes nothing on any other failure', async () => {
    const { decisions, audits } = clocked({
      requestReviewers: async () => {
        throw new Error('socket hang up');
      },
    });
    expect((await refusal(decisions.remind(reminding))).status).toBe(502);
    expect(audits).toEqual([]);
  });

  it('refuses a wait that no longer stands, and a closed pull request, sending nothing', async () => {
    const gone = clocked();
    const refused = await refusal(gone.decisions.remind({ ...reminding, login: 'sam' }));
    expect(refused.status).toBe(409);
    expect(refused.message).toBe("Pull request #40 no longer waits on @sam's approval; reload. Nothing was sent.");
    expect(gone.deps.requestReviewers).not.toHaveBeenCalled();

    const closed = clocked({ pull: async () => ({ open: false, head: HEAD, url: 'https://github.com/acme/openadlc/pull/40' }) });
    expect((await refusal(closed.decisions.remind(reminding))).status).toBe(409);
    expect(closed.deps.requestReviewers).not.toHaveBeenCalled();
  });

  it('refuses a second press while the first is still asking GitHub', async () => {
    let release: () => void = () => undefined;
    const { decisions, deps } = clocked({ requestReviewers: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) });
    const first = decisions.remind(reminding);
    expect((await refusal(decisions.remind(reminding))).status).toBe(409);
    await vi.waitFor(() => expect(deps.requestReviewers).toHaveBeenCalled());
    release();
    await first;
    expect(deps.requestReviewers).toHaveBeenCalledTimes(1);
  });
});
