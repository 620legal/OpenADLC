import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openadlc/db', () => ({
  repos: { listRepos: vi.fn(async () => []) },
  workItems: {
    ensureLink: vi.fn(async () => null),
    itemOf: vi.fn(async () => null),
    isNumbered: vi.fn(async () => true),
    mergeInto: vi.fn(async () => true),
  },
}));

import { repos, workItems, type WorkItem } from '@openadlc/db';
import { claimForPull, formatKey, linkFiled, linkPull, parseKey, planBackfill, type PullFacts, type PullSighting } from './work-items.js';

const APP = 'acme/app';
const item = (number: number): WorkItem => ({ id: `item-${number}`, number, mergedInto: null });

/** The items of issues, by repository and number. */
function lookupOf(entries: Record<string, number>) {
  return vi.fn(async (repo: string, number: number) => {
    const found = entries[`${repo.toLowerCase()}#${number}`];
    return found === undefined ? null : item(found);
  });
}

const pull = (patch: Partial<PullFacts> = {}): PullFacts => ({
  number: 40,
  repoFullName: APP,
  headRef: 'feature',
  headRepoFullName: APP,
  baseRef: 'main',
  defaultBranch: 'main',
  body: '',
  ...patch,
});

describe('the item a pull request joins', () => {
  it('is its branch’s issue’s, a person’s branch named for #12 included', async () => {
    const lookup = lookupOf({ 'acme/app#12': 3, 'acme/app#5': 1 });
    expect(await claimForPull(pull({ headRef: 'agent/x/12-y', body: 'Closes #5' }), [{ repo: APP, number: 5 }], lookup)).toBe('item-3');
  });

  it('is not the issue a fork’s branch happens to be named for', async () => {
    const lookup = lookupOf({ 'acme/app#12': 3 });
    expect(await claimForPull(pull({ headRef: 'agent/x/12-y', headRepoFullName: 'stranger/app' }), [], lookup)).toBeNull();
  });

  it('is the issue GitHub says it closes, in another managed repository too', async () => {
    expect(await claimForPull(pull(), [{ repo: APP, number: 5 }], lookupOf({ 'acme/app#5': 7 }))).toBe('item-7');
    expect(await claimForPull(pull(), [{ repo: 'acme/api', number: 2 }], lookupOf({ 'acme/api#2': 4 }))).toBe('item-4');
  });

  it('is the lower-numbered of two issues it closes, and does not join them', async () => {
    const lookup = lookupOf({ 'acme/app#5': 9, 'acme/app#6': 2 });
    expect(await claimForPull(pull(), [{ repo: APP, number: 5 }, { repo: APP, number: 6 }], lookup)).toBe('item-2');
  });

  it('is its own when it closes nothing', async () => {
    expect(await claimForPull(pull({ body: 'Tidies the readme.' }), [], lookupOf({ 'acme/app#5': 1 }))).toBeNull();
  });

  it('is found from `Closes #5` in its body when GitHub cannot be asked, into the default branch only', async () => {
    const lookup = lookupOf({ 'acme/app#5': 1 });
    expect(await claimForPull(pull({ body: 'Closes #5' }), null, lookup)).toBe('item-1');
    expect(await claimForPull(pull({ body: 'Closes #5', baseRef: 'release' }), null, lookup)).toBeNull();
  });
});

const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const issue = (number: number, day: number, repoId = 'r1'): workItems.Pending => ({
  kind: 'issue', repoId, repoFullName: repoId === 'r1' ? APP : 'acme/api', number, title: `#${number}`, state: 'open', url: null, openedAt: at(day),
  headRef: null, headRepo: null, baseRef: null, closes: [],
});
const pr = (number: number, day: number, patch: Partial<Exclude<workItems.Pending, { kind: 'request' }>> = {}): workItems.Pending => ({
  kind: 'pull', repoId: 'r1', repoFullName: APP, number, title: `#${number}`, state: 'merged', url: null, openedAt: at(day),
  headRef: 'patch', headRepo: APP, baseRef: 'main', closes: [], ...patch,
});
const request = (id: string, day: number, issueNumber: number | null, itemId: string | null = null): workItems.Pending => ({
  kind: 'request', requestId: id, repoId: issueNumber === null ? null : 'r1', issueNumber, title: id, state: 'open', openedAt: at(day), itemId,
});
const numbersOf = (groups: workItems.PlannedGroup[]) =>
  groups.map((group) => group.members.map((member) => (member.kind === 'request' ? member.requestId : `${member.repoId}#${member.number}`)));

describe('the history numbering’s plan', () => {
  it('puts each thing with what it belongs to, and orders the groups by when each was first opened, across repositories', () => {
    const groups = planBackfill(
      [
        pr(4, 6, { headRef: 'agent/builder/2-fix' }),
        issue(2, 3),
        issue(1, 1, 'r2'),
        request('req-a', 2, 2),
        request('req-b', 5, 2),
        pr(7, 8, { closes: [9, 3] }),
        issue(3, 7),
        issue(9, 4),
        request('req-c', 9, null),
      ],
      [],
    );
    expect(numbersOf(groups)).toEqual([['r2#1'], ['r1#4', 'r1#2', 'req-a', 'req-b'], ['r1#7', 'r1#9'], ['r1#3'], ['req-c']]);
    expect(groups.every((group) => group.claim === null)).toBe(true);
  });

  it('never puts two issues in one group, and a fork’s pull request is not its branch’s issue’s', () => {
    const groups = planBackfill([issue(1, 1), issue(2, 2), pr(3, 3, { closes: [1, 2] }), pr(4, 4, { headRef: 'agent/x/2-y', headRepo: 'stranger/app' })], []);
    expect(numbersOf(groups)).toEqual([['r1#1', 'r1#3'], ['r1#2'], ['r1#4']]);
  });

  it('joins an issue numbered before by its item, and a request numbered before by its own', () => {
    const groups = planBackfill([pr(8, 8, { closes: [1] }), issue(5, 5), request('req-a', 1, 5, 'item-req')], [{ repoId: 'r1', number: 1, itemId: 'item-1' }]);
    expect(groups.map((group) => group.claim)).toEqual(['item-req', 'item-1']);
    expect(numbersOf(groups)).toEqual([['r1#5', 'req-a'], ['r1#8']]);
  });
});

describe('a key', () => {
  it('reads as the organization and the number, and back', () => {
    expect(formatKey(71, '620legal')).toBe('620legal-71');
    expect(parseKey('620legal-71')).toEqual({ organization: '620legal', number: 71 });
    expect(parseKey('acme-corp-3')).toEqual({ organization: 'acme-corp', number: 3 });
    for (const not of ['71', 'acme-', '-3', 'acme-0', 'acme 3']) expect(parseKey(not)).toBeNull();
  });
});

describe('linking', () => {
  beforeEach(() => {
    vi.mocked(workItems.ensureLink).mockReset().mockResolvedValue(null);
    vi.mocked(workItems.itemOf).mockReset().mockResolvedValue(null);
    vi.mocked(workItems.mergeInto).mockReset().mockResolvedValue(true);
    vi.mocked(workItems.isNumbered).mockReset().mockResolvedValue(true);
    vi.mocked(repos.listRepos).mockResolvedValue([{ id: 'r1', fullName: APP }] as never);
  });

  it('puts a filed issue in the request’s item when the filing comes before its delivery, drawing no number', async () => {
    vi.mocked(workItems.itemOf).mockResolvedValueOnce(item(3)).mockResolvedValueOnce(null);
    vi.mocked(workItems.ensureLink).mockResolvedValueOnce(item(3));
    expect(await linkFiled({ id: 'req' }, { id: 'r1' }, { number: 12, title: 'x', htmlUrl: 'u' })).toEqual(item(3));
    expect(vi.mocked(workItems.ensureLink).mock.calls[0]?.[2]).toBe('item-3');
    expect(workItems.mergeInto).not.toHaveBeenCalled();
  });

  it('gives a filed issue the request’s number when the issue’s delivery came first', async () => {
    vi.mocked(workItems.itemOf).mockResolvedValueOnce(item(3)).mockResolvedValueOnce(item(4));
    vi.mocked(workItems.ensureLink).mockResolvedValueOnce(item(4));
    expect(await linkFiled({ id: 'req' }, { id: 'r1' }, { number: 12, title: 'x', htmlUrl: 'u' })).toEqual(item(3));
    expect(workItems.mergeInto).toHaveBeenCalledWith('item-4', 'item-3');
  });

  it('gives the issue the earlier request’s number when a second request is filed into it', async () => {
    vi.mocked(workItems.itemOf).mockResolvedValueOnce(item(6)).mockResolvedValueOnce(item(3));
    vi.mocked(workItems.ensureLink).mockResolvedValueOnce(item(3));
    expect(await linkFiled({ id: 'req-2' }, { id: 'r1' }, { number: 12, title: 'x', htmlUrl: 'u' })).toEqual(item(3));
    expect(workItems.mergeInto).toHaveBeenCalledWith('item-6', 'item-3');
  });

  const sighting = (patch: Partial<PullSighting> = {}): PullSighting => ({
    ...pull(),
    title: 'Add a dark mode',
    htmlUrl: 'https://github.com/acme/app/pull/40',
    state: 'open',
    merged: false,
    createdAt: at(1),
    ...patch,
  });

  it('claims a new pull request from GitHub’s closing references, and only refreshes a known one', async () => {
    const client = { closingIssueRefs: vi.fn(async () => [{ repo: APP, number: 5 }]) };
    vi.mocked(workItems.itemOf).mockImplementation(async (thing) => ('number' in thing && thing.number === 5 ? item(2) : null));
    await linkPull({ id: 'r1' }, sighting(), { reclaim: false, client });
    expect(vi.mocked(workItems.ensureLink).mock.calls[0]?.[2]).toBe('item-2');

    vi.mocked(workItems.itemOf).mockResolvedValue(item(8));
    client.closingIssueRefs.mockClear();
    await linkPull({ id: 'r1' }, sighting({ merged: true, state: 'closed' }), { reclaim: false, client });
    expect(client.closingIssueRefs).not.toHaveBeenCalled();
    expect(vi.mocked(workItems.ensureLink).mock.calls[1]?.[1]).toMatchObject({ state: 'merged' });
    expect(vi.mocked(workItems.ensureLink).mock.calls[1]?.[2]).toBeNull();
  });

  it('falls back to the body when GitHub cannot say what it closes', async () => {
    const client = { closingIssueRefs: vi.fn(async () => Promise.reject(new Error('rate limited'))) };
    vi.mocked(workItems.itemOf).mockImplementation(async (thing) => ('number' in thing && thing.number === 5 ? item(2) : null));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await linkPull({ id: 'r1' }, sighting({ body: 'Closes #5' }), { reclaim: true, client });
    expect(vi.mocked(workItems.ensureLink).mock.calls[0]?.[2]).toBe('item-2');
  });
});
