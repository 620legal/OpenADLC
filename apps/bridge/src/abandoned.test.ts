import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '@openadlc/github';
import { abandonMoveReason, howClosed, isAbandonMove, putAbandonedLabel } from './abandoned.js';

/**
 * How a closed issue closed: by a merge, by a commit, or abandoned. GitHub
 * closes an issue at the merge of a pull request that says `Closes #N`, and
 * that `issues.closed` delivery can arrive before the merge's: taken for an
 * abandon, a change that shipped would be in Done as not shipped, and what
 * waited on it would wait for good.
 */

/**
 * What GitHub's GraphQL answers for an issue's newest close, as it answered
 * for 620legal/OpenADLC#33, closed by the merge of #42: the REST close event
 * for the same close has `commit_id: null` and says nothing of #42.
 */
function closedBy(closer: Record<string, unknown> | null, stateReason = 'COMPLETED') {
  return { data: { repository: { issue: { timelineItems: { nodes: [{ createdAt: '2026-10-21T02:54:25Z', stateReason, closer }] } } } } };
}
const MERGED_42 = { __typename: 'PullRequest', number: 42, merged: true, repository: { nameWithOwner: 'janedoe/shop' }, mergeCommit: { oid: '9f'.repeat(20) } };

interface World {
  /** Pull requests GitHub has, by number. */
  pulls: Map<number, { merged: boolean; headRef: string }>;
  /** What GraphQL answers for the issue's newest close. */
  close: unknown;
  /** What a read of each kind throws, when GitHub cannot be asked. */
  pullsFail?: Error;
  closeFail?: Error;
}

function client(world: World) {
  const asked: string[] = [];
  return {
    asked,
    getPullRequest: vi.fn(async (_repo: string, number: number) => {
      if (world.pullsFail) throw world.pullsFail;
      const pull = world.pulls.get(number);
      if (!pull) throw new GitHubApiError(404, `/repos/janedoe/shop/pulls/${number}`, '{"message":"Not Found"}');
      return { number, merged: pull.merged, headRef: pull.headRef } as never;
    }),
    request: vi.fn(async (method: string, path: string, body?: { variables?: Record<string, unknown> }) => {
      asked.push(`${method} ${path}`);
      if (path.includes('/pulls?state=closed')) {
        if (world.pullsFail) throw world.pullsFail;
        return [...world.pulls].map(([number, pull]) => ({ number, merged_at: pull.merged ? '2026-10-01T00:00:00Z' : null, head: { ref: pull.headRef } })) as never;
      }
      if (method === 'POST' && path === '/graphql') {
        if (world.closeFail) throw world.closeFail;
        expect(body?.variables).toEqual({ owner: 'janedoe', name: 'shop', number: 11 });
        return world.close as never;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }),
  };
}

const world = (over: Partial<World> = {}): World => ({ pulls: new Map(), close: closedBy(null), ...over });

describe('how a closed issue closed', () => {
  it('merged, by the pull request recorded on it', async () => {
    const github = client(world({ pulls: new Map([[31, { merged: true, headRef: 'agent/atlas/11-issue-11' }]]) }));
    expect(await howClosed(github, 'janedoe/shop', { number: 11, prNumber: 31 })).toEqual({ merged: 31 });
  });

  it('merged, by a pull request whose branch was cut for it, when none was recorded', async () => {
    const pulls = new Map([
      [30, { merged: false, headRef: 'agent/atlas/11-issue-11' }],
      [32, { merged: true, headRef: 'agent/atlas/11-issue-11-again' }],
      [33, { merged: true, headRef: 'agent/atlas/12-issue-12' }],
    ]);
    expect(await howClosed(client(world({ pulls })), 'janedoe/shop', { number: 11, prNumber: null })).toEqual({ merged: 32 });
  });

  it('merged, by a person’s pull request on a branch of its own that closed it, which the close names', async () => {
    // #33 was closed as completed by #42 merging; read as an abandon, a
    // change that shipped was in Done as not shipped.
    expect(await howClosed(client(world({ close: closedBy(MERGED_42) })), 'janedoe/shop', { number: 11, prNumber: null })).toEqual({ merged: 42 });
  });

  it('landed by a commit, when a push or another repository’s pull request closed it', async () => {
    const commit = { __typename: 'Commit', oid: 'ab'.repeat(20) };
    expect(await howClosed(client(world({ close: closedBy(commit) })), 'janedoe/shop', { number: 11, prNumber: null })).toEqual({ commit: 'ab'.repeat(20) });
    const elsewhere = { ...MERGED_42, repository: { nameWithOwner: 'janedoe/other' } };
    expect(await howClosed(client(world({ close: closedBy(elsewhere) })), 'janedoe/shop', { number: 11, prNumber: null })).toEqual({ commit: '9f'.repeat(20) });
  });

  it('abandoned, when nothing closed it but a person, as completed or as not planned', async () => {
    for (const reason of ['COMPLETED', 'NOT_PLANNED']) {
      const github = client(world({ pulls: new Map([[31, { merged: false, headRef: 'agent/atlas/11-issue-11' }]]), close: closedBy(null, reason) }));
      expect(await howClosed(github, 'janedoe/shop', { number: 11, prNumber: 31 })).toBe('abandoned');
    }
  });

  it('abandoned, when what closed it ships nothing: a Projects board, or a pull request that never merged', async () => {
    // A board that closes what reaches its Done column is a `ProjectV2`
    // closer. Read as "GitHub could not say", the card never moved, and the
    // reconciler said so on every pass.
    const board = { __typename: 'ProjectV2', number: 3, title: 'Roadmap' };
    const of = (close: unknown) => howClosed(client(world({ close })), 'janedoe/shop', { number: 11, prNumber: null });
    expect(await of(closedBy(board))).toBe('abandoned');
    expect(await of(closedBy({ ...MERGED_42, merged: false }))).toBe('abandoned');
  });

  it('cannot be told when GitHub cannot be asked, or lists no close yet: nothing is moved on a guess', async () => {
    const down = new GitHubApiError(502, '/repos/janedoe/shop/pulls/31', 'Bad Gateway');
    const of = (over: Partial<World>) => howClosed(client(world(over)), 'janedoe/shop', { number: 11, prNumber: 31 });
    expect(await of({ pullsFail: down })).toBeUndefined();
    expect(await of({ closeFail: down })).toBeUndefined();
    expect(await of({ close: { errors: [{ message: 'Something went wrong' }] } })).toBeUndefined();
    expect(await of({ close: { data: { repository: { issue: { timelineItems: { nodes: [] } } } } } })).toBeUndefined();
  });
});

describe('an abandon’s stage move', () => {
  it('is told by its reason from a merge’s', () => {
    expect(isAbandonMove({ reason: abandonMoveReason('#31 was closed without merging') })).toBe(true);
    expect(isAbandonMove({ reason: 'closed by abababa' })).toBe(false);
    expect(isAbandonMove({ reason: null })).toBe(false);
    expect(isAbandonMove({})).toBe(false);
  });
});

describe('putting openadlc:abandoned on an issue', () => {
  it('adds it, once', async () => {
    const addLabels = vi.fn(async () => undefined);
    const ensureLabel = vi.fn(async () => true);
    expect(await putAbandonedLabel({ addLabels }, ensureLabel, 'janedoe/shop', 11)).toBeNull();
    expect(addLabels).toHaveBeenCalledWith('janedoe/shop', 11, ['openadlc:abandoned']);
    expect(ensureLabel).not.toHaveBeenCalled();
  });

  it('has the app make it first on a repository set up before it existed, then adds it again', async () => {
    // The automation account, with triage, may put a label on but not make
    // one: GitHub answers 422, or 403 "create labels".
    for (const refusal of [
      new GitHubApiError(422, '/repos/janedoe/shop/issues/11/labels', '{"message":"Validation Failed"}'),
      new GitHubApiError(403, '/repos/janedoe/shop/issues/11/labels', '{"message":"You do not have permission to create labels on this repository"}'),
    ]) {
      const addLabels = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined);
      const ensureLabel = vi.fn(async () => true);
      expect(await putAbandonedLabel({ addLabels }, ensureLabel, 'janedoe/shop', 11)).toBeNull();
      expect(ensureLabel).toHaveBeenCalledWith('janedoe/shop', 'openadlc:abandoned');
      expect(addLabels).toHaveBeenCalledTimes(2);
    }
  });

  it('says why when it could not, so the card stays where it is rather than in Done as shipped', async () => {
    const missing = new GitHubApiError(422, '/repos/janedoe/shop/issues/11/labels', '{"message":"Validation Failed"}');
    const notMade = await putAbandonedLabel({ addLabels: vi.fn().mockRejectedValue(missing) }, async () => false, 'janedoe/shop', 11);
    expect(notMade).toMatch(/janedoe\/shop has no openadlc:abandoned label, and OpenADLC could not make it/);

    const ensureLabel = vi.fn(async () => true);
    const down = await putAbandonedLabel({ addLabels: vi.fn().mockRejectedValue(new GitHubApiError(502, '/x', 'Bad Gateway')) }, ensureLabel, 'janedoe/shop', 11);
    expect(down).toMatch(/GitHub did not take openadlc:abandoned on janedoe\/shop#11/);
    expect(ensureLabel).not.toHaveBeenCalled();
  });
});
