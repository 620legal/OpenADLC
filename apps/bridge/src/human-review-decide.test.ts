import { GitHubApiError } from '@openadlc/github';
import { parseMarkers } from '@openadlc/shared';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_REFUSED, HumanReviewDecisions, LINK_ACCOUNT_URL, REQUEST_READ_MS, reviewRequestOf, type HumanReviewDeps } from './human-review-decide.js';
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
  // A crew pull request, by the builder's account: the held approval as before #322.
  const pull: { open: boolean; head: string; url: string; author: { login: string; id: number } | null } = {
    open: true,
    head: HEAD,
    url: 'https://github.com/acme/openadlc/pull/40',
    author: { login: 'openadlc-bot', id: 1 },
  };
  const signOffs: { id: string; repo: string; pr: number; head: string; githubUserId: number; githubLogin: string; identity: string }[] = [];
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
    // People has Approves on for @janedoe only.
    approves: vi.fn(async (id: number) => id === JANE),
    // Written as the store writes them, in one transaction: the row and its
    // audit entry land together, or neither does.
    signOff: {
      record: vi.fn(
        async (
          entry: { repo: string; pr: number; head: string; githubUserId: number; githubLogin: string; identity: string },
          audit: { actor: string; action: string; target: string; payload: Record<string, unknown> },
        ) => {
          const had = signOffs.find((one) => one.repo === entry.repo && one.pr === entry.pr && one.head === entry.head && one.githubUserId === entry.githubUserId);
          audits.push(audit);
          if (had) return { id: had.id, created: false };
          const id = `sign-off-${signOffs.length + 1}`;
          signOffs.push({ id, ...entry });
          return { id, created: true };
        },
      ),
    },
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
  return { deps, decisions, posted, comments, audits, sentBack, signIn, pull, signOffs };
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
    expect(moved.audits).toEqual([expect.objectContaining({ action: APPROVAL_REFUSED, payload: expect.objectContaining({ reason: 'head_moved' }) })]);
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

describe('an author’s sign-off of their own pull request (#322)', () => {
  const PULL_URL = 'https://github.com/acme/openadlc/pull/40';
  /** #40 opened by `author`, waiting on @janedoe at HEAD. */
  const opened = (author: { login: string; id: number }, over: Partial<HumanReviewDeps> = {}) =>
    world({ pull: vi.fn(async () => ({ open: true, head: HEAD, url: PULL_URL, author })), ...over });
  const jane = { login: 'janedoe', id: JANE };

  it('records the author’s sign-off at the head and audits it, posting nothing to GitHub', async () => {
    const { decisions, posted, audits, signIn, signOffs, deps } = opened(jane);
    await decisions.approve(asked);
    expect(await signIn(jane)).toEqual({ commentUrl: PULL_URL });
    expect(deps.postReviewAsPerson).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(signOffs).toEqual([{ id: 'sign-off-1', repo: 'openadlc', pr: 40, head: HEAD, githubUserId: JANE, githubLogin: 'janedoe', identity: 'jane@acme.test' }]);
    expect(audits).toEqual([
      {
        actor: 'jane@acme.test',
        action: 'pull.human_review_signed_off',
        target: 'openadlc#40',
        payload: { repo: 'openadlc', pr: 40, login: 'janedoe', awaited: 'janedoe', githubUserId: JANE, head: HEAD, by: 'jane@acme.test' },
      },
    ]);
    // The token is used for nothing.
    expect(JSON.stringify(audits)).not.toContain('gho_secret');
  });

  it('refuses before the sign-in, 403, when People has Approves off for them', async () => {
    const { decisions, deps, signOffs } = opened(jane, { approves: async () => false });
    const refused = await refusal(decisions.approve(asked));
    expect(refused.status).toBe(403);
    expect(refused.message).toContain('Approves is off for you in People');
    expect(deps.flows.start).not.toHaveBeenCalled();
    expect(signOffs).toEqual([]);
  });

  it('records nothing when Approves is turned off while they sign in', async () => {
    let on = true;
    const { decisions, signIn, signOffs, audits } = opened(jane, { approves: async () => on });
    await decisions.approve(asked);
    on = false;
    await expect(signIn(jane)).rejects.toThrow('Approves is off for you in People');
    expect(signOffs).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({ action: APPROVAL_REFUSED, payload: expect.objectContaining({ reason: 'approves_off', stage: 'after_sign_in' }) })]);
  });

  it('records nothing when the code is approved by another account, a crew account, or after the head moved', async () => {
    const other = opened(jane);
    await other.decisions.approve(asked);
    await expect(other.signIn({ login: 'sam', id: 7 })).rejects.toThrow('not the GitHub account linked to you here');
    expect(other.signOffs).toEqual([]);

    // A token acting as the account is not enough: the console sign-in's link must be that account too.
    const crew = opened({ login: 'janedoe', id: JANE }, { isCrew: async (login: string) => login === 'janedoe' });
    // Authored by a crew account, it is a crew pull request: a review is posted, never a sign-off.
    await crew.decisions.approve(asked);
    await expect(crew.signIn(jane)).rejects.toThrow('an account the crew uses');
    expect(crew.signOffs).toEqual([]);
    expect(crew.posted).toEqual([]);

    const moved = opened(jane);
    await moved.decisions.approve(asked);
    vi.mocked(moved.deps.pull).mockResolvedValue({ open: true, head: NEXT, url: PULL_URL, author: jane });
    await expect(moved.signIn(jane)).rejects.toThrow('moved to c0ffee0 while you signed in');
    expect(moved.signOffs).toEqual([]);
    expect(moved.audits).toEqual([expect.objectContaining({ action: APPROVAL_REFUSED, payload: expect.objectContaining({ reason: 'head_moved', how: 'sign_off' }) })]);
  });

  it('refuses a viewer whose linked account is not the author’s, 403, and records nothing', async () => {
    const { decisions, deps, signOffs } = opened(jane);
    const refused = await refusal(decisions.approve({ ...asked, identity: 'sam@acme.test' }));
    expect(refused.status).toBe(403);
    expect(deps.flows.start).not.toHaveBeenCalled();
    expect(signOffs).toEqual([]);
  });

  it('refuses, 409, when the person awaited did not open it: they approve it on GitHub', async () => {
    const { decisions, deps, signOffs, posted } = opened({ login: 'sam', id: 7 });
    const refused = await refusal(decisions.approve(asked));
    expect(refused.status).toBe(409);
    expect(refused.message).toBe('@janedoe approves pull request #40 on GitHub; the console signs off only for its author. Nothing was posted.');
    expect(refused.details).toEqual({ url: `${PULL_URL}/files` });
    expect(deps.flows.start).not.toHaveBeenCalled();
    expect(signOffs).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('keeps neither the sign-off nor its audit entry when they cannot be written together, and tells the person', async () => {
    const warn = vi.fn();
    const { decisions, signIn, signOffs, audits, deps } = opened(jane, {
      signOff: {
        record: vi.fn(async () => {
          throw new Error('the database is down');
        }),
      },
      warn,
    });
    await decisions.approve(asked);
    await expect(signIn(jane)).rejects.toThrow('could not record your sign-off and its audit entry, so it does not count');
    expect(deps.signOff.record).toHaveBeenCalledTimes(1);
    expect(signOffs).toEqual([]);
    expect(audits).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not recorded: the database is down'));
  });

  it('writes the sign-off with its audit entry, never the audit on its own', async () => {
    const { decisions, signIn, deps } = opened(jane);
    await decisions.approve(asked);
    await signIn(jane);
    expect(deps.signOff.record).toHaveBeenCalledWith(
      { repo: 'openadlc', pr: 40, head: HEAD, githubUserId: JANE, githubLogin: 'janedoe', identity: 'jane@acme.test' },
      expect.objectContaining({ action: 'pull.human_review_signed_off', target: 'openadlc#40' }),
    );
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('records nothing when GitHub names another author by the time the sign-in completes', async () => {
    const { decisions, signIn, signOffs, audits, deps, posted } = opened(jane);
    await decisions.approve(asked);
    // Checked as @janedoe's before the sign-in; GitHub names @bob once it completes.
    vi.mocked(deps.pull).mockResolvedValue({ open: true, head: HEAD, url: PULL_URL, author: { login: 'bob', id: 9 } });
    await expect(signIn(jane)).rejects.toThrow('@janedoe did not open pull request #40');
    expect(deps.signOff.record).not.toHaveBeenCalled();
    expect(signOffs).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({ action: APPROVAL_REFUSED, payload: expect.objectContaining({ reason: 'author_changed' }) })]);
    expect(posted).toEqual([]);
  });

  it('sends nothing back from a person’s own pull request: it has no builder', async () => {
    const { decisions, comments, sentBack } = opened(jane);
    const refused = await refusal(decisions.reject({ ...asked, reason: 'Not this way.' }));
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('no builder to send it back to');
    expect(comments).toEqual([]);
    expect(sentBack).toEqual([]);
  });

  it('leaves a crew pull request’s approval as it was: a review posted as the person', async () => {
    const { decisions, posted, signOffs, signIn } = world();
    await decisions.approve(asked);
    await signIn(jane);
    expect(posted).toHaveLength(1);
    expect(signOffs).toEqual([]);
  });
});

describe('a refused Approve is audited (#328)', () => {
  const PULL_URL = 'https://github.com/acme/openadlc/pull/40';
  const jane = { login: 'janedoe', id: JANE };
  /** #40 opened by `author`, waiting on @janedoe at HEAD. */
  const opened = (author: { login: string; id: number }, over: Partial<HumanReviewDeps> = {}) =>
    world({ pull: vi.fn(async () => ({ open: true, head: HEAD, url: PULL_URL, author })), ...over });

  /** The one row a refusal wrote, under the decision's target, as the presser. */
  function refusedRow(audits: { action: string; payload: Record<string, unknown>; target?: string; actor?: string }[], identity = 'jane@acme.test') {
    expect(audits).toHaveLength(1);
    const row = audits[0]!;
    expect(row).toMatchObject({ action: 'pull.human_review_approval_refused', target: 'openadlc#40', actor: identity });
    expect(row.payload).toMatchObject({ repo: 'openadlc', pr: 40, awaited: 'janedoe', by: identity });
    return row.payload;
  }

  /** What every refusal leaves behind besides its row: nothing. */
  function nothingElse(made: { posted: unknown[]; signOffs: unknown[]; comments: unknown[] }) {
    expect(made.posted).toEqual([]);
    expect(made.signOffs).toEqual([]);
    expect(made.comments).toEqual([]);
  }

  describe('before the sign-in', () => {
    it('not_linked: a viewer with no linked account', async () => {
      const made = world();
      const refused = await refusal(made.decisions.approve({ ...asked, identity: 'nobody@acme.test' }));
      expect(refused.status).toBe(409);
      expect(refused.details).toEqual({ url: LINK_ACCOUNT_URL });
      expect(refusedRow(made.audits, 'nobody@acme.test')).toEqual({
        repo: 'openadlc',
        pr: 40,
        awaited: 'janedoe',
        head: HEAD,
        reason: 'not_linked',
        why: refused.message,
        how: null,
        linkedLogin: null,
        linkedId: null,
        stage: 'before_sign_in',
        by: 'nobody@acme.test',
      });
      expect(made.deps.flows.start).not.toHaveBeenCalled();
      nothingElse(made);
    });

    it('not_awaited: a linked account that is not the one the gate waits on', async () => {
      const made = world();
      const refused = await refusal(made.decisions.approve({ ...asked, identity: 'sam@acme.test' }));
      expect(refused.status).toBe(403);
      expect(refused.message).toBe("This is @janedoe's to decide; you can Discuss it.");
      expect(refusedRow(made.audits, 'sam@acme.test')).toMatchObject({
        reason: 'not_awaited',
        why: "This is @janedoe's to decide; you can Discuss it.",
        head: HEAD,
        linkedLogin: 'sam',
        linkedId: 7,
        how: null,
        stage: 'before_sign_in',
      });
      expect(made.deps.linkOf).toHaveBeenCalledTimes(1);
      nothingElse(made);
    });

    it('not_waiting: the pull request no longer waits on the person', async () => {
      const made = world({ standing: async () => null });
      const refused = await refusal(made.decisions.approve(asked));
      expect(refused.status).toBe(409);
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'not_waiting', why: refused.message, linkedId: JANE, linkedLogin: 'janedoe' });
      nothingElse(made);
    });

    it('not_open: the pull request is closed', async () => {
      const made = world({ pull: async () => ({ open: false, head: HEAD, url: PULL_URL }) });
      const refused = await refusal(made.decisions.approve(asked));
      expect(refused.status).toBe(409);
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'not_open', linkedId: JANE });
      nothingElse(made);
    });

    it('head_moved: the head they saw is not the head now, kept as the head they saw', async () => {
      const made = opened(jane);
      const refused = await refusal(made.decisions.approve({ ...asked, head: NEXT }));
      expect(refused.status).toBe(409);
      expect(refused.message).toContain('reload');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'head_moved', head: NEXT, movedTo: HEAD, linkedId: JANE, stage: 'before_sign_in' });
      expect(made.deps.flows.start).not.toHaveBeenCalled();
      nothingElse(made);
    });

    it('on_github: the person awaited did not open their own pull request', async () => {
      const made = opened({ login: 'sam', id: 7 });
      const refused = await refusal(made.decisions.approve(asked));
      expect(refused.status).toBe(409);
      expect(refused.details).toEqual({ url: `${PULL_URL}/files` });
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'on_github', why: refused.message, how: null });
      nothingElse(made);
    });

    it('approves_off: People has Approves off for the author', async () => {
      const made = opened(jane, { approves: async () => false });
      const refused = await refusal(made.decisions.approve(asked));
      expect(refused.status).toBe(403);
      expect(refused.message).toContain('Approves is off for you in People');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'approves_off', how: 'sign_off', linkedId: JANE, stage: 'before_sign_in' });
      expect(made.deps.flows.start).not.toHaveBeenCalled();
      nothingElse(made);
    });
  });

  describe('once the device code is approved', () => {
    it('other_account: the code was approved by another account than the linked one', async () => {
      const made = opened(jane);
      await made.decisions.approve(asked);
      await expect(made.signIn({ login: 'sam', id: 7 })).rejects.toThrow(
        'You approved the code as @sam, which is not the GitHub account linked to you here; nothing was posted.',
      );
      expect(refusedRow(made.audits)).toEqual({
        repo: 'openadlc',
        pr: 40,
        awaited: 'janedoe',
        head: HEAD,
        reason: 'other_account',
        why: 'You approved the code as @sam, which is not the GitHub account linked to you here; nothing was posted.',
        how: 'sign_off',
        linkedLogin: 'janedoe',
        linkedId: JANE,
        stage: 'after_sign_in',
        by: 'jane@acme.test',
        login: 'sam',
        githubUserId: 7,
      });
      nothingElse(made);
    });

    it('crew_account: the code was approved by a crew account', async () => {
      const made = world({ linkOf: async () => ({ githubLogin: 'openadlc-bot', githubUserId: JANE }) });
      await made.decisions.approve(asked);
      await expect(made.signIn({ login: 'openadlc-bot', id: JANE })).rejects.toThrow('@openadlc-bot is an account the crew uses; nothing was posted.');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'crew_account', how: 'review', login: 'openadlc-bot', githubUserId: JANE, stage: 'after_sign_in' });
      nothingElse(made);
    });

    it('head_moved: the pull request moved while they signed in', async () => {
      const made = opened(jane);
      await made.decisions.approve(asked);
      vi.mocked(made.deps.pull).mockResolvedValue({ open: true, head: NEXT, url: PULL_URL, author: jane });
      await expect(made.signIn(jane)).rejects.toThrow('moved to c0ffee0 while you signed in');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'head_moved', head: HEAD, movedTo: NEXT, stage: 'after_sign_in' });
      nothingElse(made);
    });

    it('approves_off: Approves was turned off while they signed in', async () => {
      let on = true;
      const made = opened(jane, { approves: async () => on });
      await made.decisions.approve(asked);
      on = false;
      await expect(made.signIn(jane)).rejects.toThrow('Approves is off for you in People');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'approves_off', how: 'sign_off', stage: 'after_sign_in', login: 'janedoe', githubUserId: JANE });
      nothingElse(made);
    });

    it('author_changed: GitHub names another author by the time the sign-in completes', async () => {
      const made = opened(jane);
      await made.decisions.approve(asked);
      vi.mocked(made.deps.pull).mockResolvedValue({ open: true, head: HEAD, url: PULL_URL, author: { login: 'bob', id: 9 } });
      await expect(made.signIn(jane)).rejects.toThrow('@janedoe did not open pull request #40');
      expect(refusedRow(made.audits)).toMatchObject({ reason: 'author_changed', author: { login: 'bob', id: 9 }, linkedId: JANE, stage: 'after_sign_in' });
      expect(made.deps.signOff.record).not.toHaveBeenCalled();
      nothingElse(made);
    });

    it('keeps the token out of every refusal row', async () => {
      const made = opened(jane);
      await made.decisions.approve(asked);
      await expect(made.signIn({ login: 'sam', id: 7 })).rejects.toThrow();
      expect(made.audits).toHaveLength(1);
      expect(JSON.stringify(made.audits)).not.toContain('gho_secret');
    });
  });

  it('refuses exactly as before when the refusal’s row cannot be written, and says so in the log', async () => {
    const warn = vi.fn();
    const failing = { audit: vi.fn(async () => Promise.reject(new Error('the database is down'))), warn };
    const before = world(failing);
    const refused = await refusal(before.decisions.approve({ ...asked, identity: 'sam@acme.test' }));
    expect(refused.status).toBe(403);
    expect(refused.message).toBe("This is @janedoe's to decide; you can Discuss it.");
    expect(before.deps.audit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[bridge] sam@acme.test's refused Approve of openadlc#40 at 692cd1f was not audited: the database is down");
    expect(before.deps.flows.start).not.toHaveBeenCalled();
    nothingElse(before);

    const after = opened(jane, failing);
    await after.decisions.approve(asked);
    await expect(after.signIn({ login: 'sam', id: 7 })).rejects.toThrow('not the GitHub account linked to you here; nothing was posted.');
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('was not audited: the database is down'));
    nothingElse(after);

    // One that throws before it returns a promise is refused the same way, not answered 500.
    const sync = world({
      audit: vi.fn(() => {
        throw new Error('no pool');
      }) as never,
      warn,
    });
    expect((await refusal(sync.decisions.approve({ ...asked, identity: 'sam@acme.test' }))).status).toBe(403);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('was not audited: no pool'));
  });

  it('audits no failure that decides nothing about who or what', async () => {
    const malformed = world();
    expect((await refusal(malformed.decisions.approve({ ...asked, head: 'not-a-sha' }))).status).toBe(400);
    expect(malformed.audits).toEqual([]);

    const unknown = world({ userIdOf: async () => null });
    expect((await refusal(unknown.decisions.approve(asked))).status).toBe(503);
    expect(unknown.audits).toEqual([]);

    const twice = world();
    await twice.decisions.approve(asked);
    const refused = await refusal(twice.decisions.approve(asked));
    expect(refused.message).toContain('still waiting for you');
    expect(twice.audits).toEqual([]);
  });

  it('leaves Reject’s refusals as they were: unaudited', async () => {
    const made = world();
    expect((await refusal(made.decisions.reject({ ...asked, identity: 'sam@acme.test', reason: 'No.' }))).status).toBe(403);
    expect(made.audits).toEqual([]);
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
