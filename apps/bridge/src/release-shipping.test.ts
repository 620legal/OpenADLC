import { DEFAULT_DELIVERY_RULES, deliveryRulesSchema, type DeliveryRules } from '@openadlc/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RELEASE_PAGES, ReleaseShipping, releaseOf, shipsWith, type GitHubRelease } from './release-shipping.js';

/**
 * A repository that ships by release: 620legal/OpenADLC, whose installs take
 * a change only from a `v*` release. Its merged cards wait in Ship until a
 * published release contains their merge, and then go to Done saying which.
 */

const REPO = { id: 'repo-1', name: 'openadlc', fullName: '620legal/OpenADLC', defaultBranch: 'main' };
const BY_RELEASE = deliveryRulesSchema.parse({ version: 1, testing: { on: 'release' } });

const world = vi.hoisted(() => ({
  board: [] as { number: number; prNumber: number | null; stage: string; labels: string[] }[],
  /** What was recorded of each merge (`deployRuns.forPullRequests`), newest first. */
  runs: [] as { sha: string; prNumber: number | null; createdAt: string; mergedAt?: string | null }[],
  ensured: [] as { sha: string; prNumber: number | null; mergedAt: Date | null }[],
  released: [] as { prNumber: number; why: string }[],
  shipped: [] as { number: number; at: Date }[],
  audits: [] as Record<string, unknown>[],
  threads: [] as { id: string; subject_ref: string }[],
  said: [] as { threadId: string; text: string; payload?: Record<string, unknown> }[],
}));

vi.mock('@openadlc/db', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => void world.audits.push(entry)),
  issues: {
    listIssues: vi.fn(async () => world.board.map((issue) => ({ ...issue, repoName: 'openadlc' }))),
    setShippedAt: vi.fn(async (_repo: string, number: number, at: Date) => void world.shipped.push({ number, at })),
  },
  deployRuns: {
    forPullRequests: vi.fn(async (_repo: string, numbers: number[]) => world.runs.filter((run) => run.prNumber !== null && numbers.includes(run.prNumber))),
    ensure: vi.fn(async (_repo: string, sha: string, prNumber: number | null, mergedAt: Date | null = null) => {
      world.ensured.push({ sha, prNumber, mergedAt });
      return { sha, prNumber };
    }),
  },
  leases: {
    releaseForPullRequest: vi.fn(async (_repo: string, prNumber: number, why: string) => {
      world.released.push({ prNumber, why });
      return { issueNumber: prNumber - 100 };
    }),
  },
  repos: { getRepoByName: vi.fn(async (name: string) => (name === REPO.name ? REPO : { ...REPO, id: `repo-${name}`, name, fullName: `janedoe/${name}` })) },
  threads: {
    listThreadsForSubjects: vi.fn(async (subjects: string[]) => world.threads.filter((thread) => subjects.includes(thread.subject_ref))),
    addMessage: vi.fn(async (message: { threadId: string; text: string; payload?: Record<string, unknown> }) => void world.said.push(message)),
  },
}));

beforeEach(() => {
  world.board = [];
  world.runs = [];
  world.ensured = [];
  world.released = [];
  world.shipped = [];
  world.audits = [];
  world.threads = [];
  world.said = [];
});

/** A release as GitHub writes it. */
const listed = (tag: string, publishedAt: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: false,
  published_at: publishedAt,
  created_at: publishedAt,
  html_url: `https://github.com/620legal/OpenADLC/releases/tag/${tag}`,
  ...extra,
});

/**
 * GitHub, as the app: the repository's releases, newest first, and which tag
 * holds which merge. `contains[tag]` lists the merges a tag's commit has.
 */
function github(options: { releases?: GitHubRelease[]; contains?: Record<string, string[]>; pulls?: Record<number, { merge_commit_sha: string | null; merged_at: string; merged?: boolean }>; failCompare?: boolean } = {}) {
  const asked: string[] = [];
  const client = {
    request: vi.fn(async (_method: string, path: string) => {
      asked.push(path);
      const releases = /\/releases\?per_page=(\d+)&page=(\d+)$/.exec(path);
      if (releases) {
        const per = Number(releases[1]);
        const page = Number(releases[2]);
        const all = [...(options.releases ?? [])].sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
        return all.slice((page - 1) * per, page * per);
      }
      const compare = /\/compare\/([^.]+)\.\.\.([^?]+)\?per_page=1$/.exec(path);
      if (compare) {
        if (options.failCompare) throw new Error('GitHub answered 502');
        const [, sha, tag] = compare;
        return { status: (options.contains?.[decodeURIComponent(tag!)] ?? []).includes(decodeURIComponent(sha!)) ? 'ahead' : 'behind' };
      }
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) {
        const found = options.pulls?.[Number(pull[1])];
        if (!found) throw new Error('404');
        return { merged: found.merged ?? true, ...found };
      }
      throw new Error(`${path}: not faked`);
    }),
  };
  return { client, asked };
}

function shipping(client: { request: (method: string, path: string) => Promise<unknown> } | null, rules: DeliveryRules = BY_RELEASE, now = '2026-10-23T12:00:00Z') {
  const moves: { repoName: string; issueNumber: number; to: string; actor: string; reason: string; prNumber: number }[] = [];
  const releases = new ReleaseShipping({
    delivery: { get: async () => ({ rules, source: 'repository', testingUrl: null, fileError: null, readError: null }) },
    client: async () => client as never,
    moveStage: async (input) => {
      moves.push(input);
      return { moved: true };
    },
    now: () => Date.parse(now),
  });
  return { releases, moves };
}

const MERGED = (number: number, prNumber: number) => ({ number, prNumber, stage: 'merged', labels: ['adlc:merged'] });

describe('which release ships anything', () => {
  it('is one published, with a tag, and neither a draft nor a prerelease', () => {
    expect(shipsWith(releaseOf(listed('v0.2.0', '2026-10-20T10:00:00Z')))).toBe(true);
    expect(shipsWith(releaseOf(listed('v0.2.0', '2026-10-20T10:00:00Z', { draft: true })))).toBe(false);
    expect(shipsWith(releaseOf(listed('v0.2.0-rc.1', '2026-10-20T10:00:00Z', { prerelease: true })))).toBe(false);
    expect(shipsWith(releaseOf(listed('v0.2.0', '2026-10-20T10:00:00Z', { published_at: null })))).toBe(false);
  });
});

describe('a merge in a repository that ships by release', () => {
  it('records its merge, lets its lease go as a merge that deploys nothing does, and tells its card it waits for the next release', async () => {
    world.board = [MERGED(45, 145)];
    world.threads = [{ id: 'thread-45', subject_ref: 'openadlc#45' }];
    const { releases } = shipping(github().client);
    const told: string[] = [];
    releases.onLeaseReleased((why) => void told.push(why));

    const line = await releases.merged(REPO, 145, 'fed98760000', new Date('2026-10-20T09:00:00Z'));

    expect(world.ensured).toEqual([{ sha: 'fed98760000', prNumber: 145, mergedAt: new Date('2026-10-20T09:00:00Z') }]);
    expect(world.released).toEqual([{ prNumber: 145, why: 'merged, and openadlc ships by release: nothing deploys it to verify' }]);
    expect(told).toEqual(['openadlc#145: merged, and openadlc ships by release: nothing deploys it to verify']);
    expect(world.said).toEqual([
      expect.objectContaining({
        threadId: 'thread-45',
        text: 'Merged. openadlc ships by release, so no testing deploy follows: this stays in Ship until a published release contains its merge (fed9876), then goes to Done.',
      }),
    ]);
    expect(line).toBe('openadlc#145: merged; openadlc ships by release, so no testing deploy was dispatched, and its card waits in Ship for the next release; released the lease on #45');
  });
});

describe('a published release', () => {
  const V020 = releaseOf(listed('v0.2.0', '2026-10-21T10:00:00Z'));

  beforeEach(() => {
    world.board = [MERGED(44, 144), MERGED(45, 145), MERGED(46, 146), MERGED(47, 147)];
    world.threads = [{ id: 'thread-44', subject_ref: 'openadlc#44' }];
    world.runs = [
      { sha: 'aaaa4440000', prNumber: 144, createdAt: '2026-10-20T08:00:00Z' },
      { sha: 'aaaa4450000', prNumber: 145, createdAt: '2026-10-20T09:00:00Z' },
      // Merged before the release was published, after its tag was cut.
      { sha: 'aaaa4460000', prNumber: 146, createdAt: '2026-10-21T09:00:00Z' },
      // Merged after it was published.
      { sha: 'aaaa4470000', prNumber: 147, createdAt: '2026-10-22T09:00:00Z' },
    ];
  });

  it('moves to Done every card in Ship whose merge it contains, saying which release, and none it does not', async () => {
    const { client, asked } = github({ contains: { 'v0.2.0': ['aaaa4440000', 'aaaa4450000'] } });
    const { releases, moves } = shipping(client);

    const lines = await releases.onPublished(REPO, V020);

    expect(moves).toEqual([
      { repoName: 'openadlc', issueNumber: 44, to: 'done', actor: 'bridge', reason: 'released in v0.2.0', prNumber: 144 },
      { repoName: 'openadlc', issueNumber: 45, to: 'done', actor: 'bridge', reason: 'released in v0.2.0', prNumber: 145 },
    ]);
    // When they shipped is when the release was published.
    expect(world.shipped).toEqual([
      { number: 44, at: new Date('2026-10-21T10:00:00Z') },
      { number: 45, at: new Date('2026-10-21T10:00:00Z') },
    ]);
    expect(world.audits).toEqual([
      expect.objectContaining({ actor: 'bridge', action: 'deploy.shipped_by_release', target: 'openadlc#44', payload: expect.objectContaining({ prNumber: 144, sha: 'aaaa4440000', release: 'v0.2.0', publishedAt: '2026-10-21T10:00:00Z' }) }),
      expect.objectContaining({ action: 'deploy.shipped_by_release', target: 'openadlc#45' }),
    ]);
    expect(world.said).toEqual([
      expect.objectContaining({ threadId: 'thread-44', text: 'Moved to Done: released in v0.2.0. The release, published 2026-10-21T10:00:00Z, contains its merge (aaaa444).' }),
    ]);
    expect(lines).toEqual([
      'openadlc#44 moved to Done: released in v0.2.0, which contains its merge (aaaa444)',
      'openadlc#45 moved to Done: released in v0.2.0, which contains its merge (aaaa445); no thread on it to say so in',
      'openadlc v0.2.0: openadlc#147 merged after it was published, so it cannot contain them',
    ]);
    // #146 was asked about and is not in it; #147, merged after, was not asked about at all.
    expect(asked.filter((path) => path.includes('/compare/'))).toEqual([
      '/repos/620legal/OpenADLC/compare/aaaa4440000...v0.2.0?per_page=1',
      '/repos/620legal/OpenADLC/compare/aaaa4450000...v0.2.0?per_page=1',
      '/repos/620legal/OpenADLC/compare/aaaa4460000...v0.2.0?per_page=1',
    ]);
  });

  it('counts its tagged commit itself as contained', async () => {
    world.board = [MERGED(45, 145)];
    const client = { request: vi.fn(async () => ({ status: 'identical' })) };
    const { releases, moves } = shipping(client);
    await releases.onPublished(REPO, V020);
    expect(moves.map((move) => move.issueNumber)).toEqual([45]);
  });

  it.each([
    ['a draft', { draft: true }],
    ['a prerelease', { prerelease: true }],
  ])('moves nothing, and asks GitHub nothing, when it is %s', async (what, extra) => {
    const { client, asked } = github({ contains: { 'v0.2.0': ['aaaa4440000'] } });
    const { releases, moves } = shipping(client);

    const lines = await releases.onPublished(REPO, releaseOf(listed('v0.2.0', '2026-10-21T10:00:00Z', extra)));

    expect(moves).toEqual([]);
    expect(asked).toEqual([]);
    expect(lines).toEqual([`openadlc v0.2.0: ${what}, which ships nothing; no card was moved`]);
  });

  it('moves nothing in a repository that does not ship by release', async () => {
    const { client, asked } = github({ contains: { 'v0.2.0': ['aaaa4440000'] } });
    const { releases, moves } = shipping(client, DEFAULT_DELIVERY_RULES);
    expect(await releases.onPublished(REPO, V020)).toEqual(['openadlc v0.2.0: openadlc does not ship by release; no card was moved']);
    expect(moves).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('moves nothing it could not ask about, and says the sweep asks again', async () => {
    const { client } = github({ failCompare: true });
    const { releases, moves } = shipping(client);
    const lines = await releases.onPublished(REPO, V020);
    expect(moves).toEqual([]);
    expect(lines[0]).toBe('openadlc#144: whether v0.2.0 contains its merge (aaaa444) could not be asked (GitHub answered 502); the deploy sweep asks again');
  });
});

describe('the deploy sweep, for a release whose delivery never came', () => {
  const inShip = [
    { repo: 'openadlc', number: 44, prNumber: 144 },
    { repo: 'openadlc', number: 45, prNumber: 145 },
  ];

  beforeEach(() => {
    world.runs = [
      { sha: 'aaaa4440000', prNumber: 144, createdAt: '2026-10-20T08:00:00Z' },
      { sha: 'aaaa4450000', prNumber: 145, createdAt: '2026-10-22T09:00:00Z' },
    ];
  });

  it('lists the releases published since the oldest merge in Ship, and moves each merge with the first that contains it', async () => {
    const { client, asked } = github({
      releases: [
        listed('v0.1.9', '2026-10-10T10:00:00Z'),
        listed('v0.2.0', '2026-10-21T10:00:00Z'),
        listed('v0.2.1-rc.1', '2026-10-22T10:00:00Z', { prerelease: true }),
        listed('v0.2.1', '2026-10-23T10:00:00Z'),
      ],
      contains: { 'v0.2.0': ['aaaa4440000'], 'v0.2.1': ['aaaa4440000', 'aaaa4450000'], 'v0.2.1-rc.1': ['aaaa4440000', 'aaaa4450000'] },
    });
    const { releases, moves } = shipping(client);

    const { waiting, moved } = await releases.sweep(inShip);

    expect(waiting).toEqual([]);
    expect(moves).toEqual([
      expect.objectContaining({ issueNumber: 44, reason: 'released in v0.2.0', prNumber: 144 }),
      expect.objectContaining({ issueNumber: 45, reason: 'released in v0.2.1', prNumber: 145 }),
    ]);
    expect(moved).toEqual([
      'openadlc#44 moved to Done: released in v0.2.0, which contains its merge (aaaa444); no thread on it to say so in',
      'openadlc#45 moved to Done: released in v0.2.1, which contains its merge (aaaa445); no thread on it to say so in',
    ]);
    expect(world.shipped).toEqual([
      { number: 44, at: new Date('2026-10-21T10:00:00Z') },
      { number: 45, at: new Date('2026-10-23T10:00:00Z') },
    ]);
    // One page of releases; one comparison for each merge and each release
    // published since it, stopping at the first that has it. The prerelease
    // and v0.1.9, published before either merge, are never compared.
    expect(asked).toEqual([
      '/repos/620legal/OpenADLC/releases?per_page=100&page=1',
      '/repos/620legal/OpenADLC/compare/aaaa4440000...v0.2.0?per_page=1',
      '/repos/620legal/OpenADLC/compare/aaaa4450000...v0.2.1?per_page=1',
    ]);
  });

  it('leaves in Ship what no release contains yet, says so, and never leaves it for a testing deploy', async () => {
    const { client } = github({ releases: [listed('v0.2.0', '2026-10-21T10:00:00Z')], contains: { 'v0.2.0': [] } });
    const { releases, moves } = shipping(client);

    const { waiting, moved } = await releases.sweep(inShip);

    expect(moves).toEqual([]);
    expect(waiting).toEqual([]);
    expect(moved).toEqual(['openadlc#44, openadlc#45: in Ship until a published release contains their merges; openadlc ships by release']);
  });

  it('passes the cards of a repository that does not ship by release on to the deploy path untouched', async () => {
    const { client, asked } = github();
    const { releases } = shipping(client, DEFAULT_DELIVERY_RULES);
    expect(await releases.sweep(inShip)).toEqual({ waiting: inShip, moved: [] });
    expect(asked).toEqual([]);
  });

  it('reads the merge of a card whose merge delivery was missed from GitHub, and settles it as that delivery would have', async () => {
    world.runs = [];
    const { client } = github({
      releases: [listed('v0.2.0', '2026-10-21T10:00:00Z')],
      contains: { 'v0.2.0': ['bbbb4440000'] },
      pulls: { 144: { merge_commit_sha: 'bbbb4440000', merged_at: '2026-10-20T08:00:00Z' } },
    });
    const { releases, moves } = shipping(client);

    const { moved } = await releases.sweep([inShip[0]!]);

    expect(world.ensured).toEqual([{ sha: 'bbbb4440000', prNumber: 144, mergedAt: new Date('2026-10-20T08:00:00Z') }]);
    expect(world.released.map((one) => one.prNumber)).toEqual([144]);
    expect(moves).toEqual([expect.objectContaining({ issueNumber: 44, reason: 'released in v0.2.0' })]);
    expect(moved[0]).toMatch(/^openadlc#144: merged; openadlc ships by release/);
  });

  it('says to move by hand a card in Ship with no pull request recorded', async () => {
    const { releases } = shipping(github().client);
    const { moved } = await releases.sweep([{ repo: 'openadlc', number: 43, prNumber: null }]);
    expect(moved).toEqual([
      'openadlc#43 is merged with no pull request recorded: no release can be matched to its merge; move it to Done by hand once a release has it',
    ]);
  });

  it('reads no more pages of releases than reach back to the oldest merge, and never more than a bound', async () => {
    // Two hundred and fifty releases an hour apart, the newest an hour ago.
    const many = Array.from({ length: 250 }, (_, index) => listed(`v1.0.${index}`, new Date(Date.parse('2026-10-23T11:00:00Z') - index * 3_600_000).toISOString()));
    world.runs = [{ sha: 'aaaa4450000', prNumber: 145, createdAt: '2026-10-22T09:00:00Z' }];
    const near = github({ releases: many });
    await shipping(near.client).releases.sweep([inShip[1]!]);
    expect(near.asked.filter((path) => path.includes('/releases?'))).toEqual(['/repos/620legal/OpenADLC/releases?per_page=100&page=1']);

    world.runs = [{ sha: 'aaaa4440000', prNumber: 144, createdAt: '2020-01-01T00:00:00Z' }];
    const endless = Array.from({ length: 700 }, (_, index) => listed(`v2.0.${index}`, new Date(Date.parse('2026-10-23T11:00:00Z') - index * 3_600_000).toISOString()));
    const far = github({ releases: endless });
    await shipping(far.client).releases.sweep([inShip[0]!]);
    expect(far.asked.filter((path) => path.includes('/releases?'))).toHaveLength(MAX_RELEASE_PAGES);
  });

  it('asks each release about each merge once in a pass, however many cards a merge has', async () => {
    world.runs = [{ sha: 'aaaa4440000', prNumber: 144, createdAt: '2026-10-20T08:00:00Z' }];
    const { client, asked } = github({ releases: [listed('v0.2.0', '2026-10-21T10:00:00Z'), listed('v0.2.1', '2026-10-22T10:00:00Z')], contains: { 'v0.2.1': ['aaaa4440000'] } });
    const { releases, moves } = shipping(client);

    await releases.sweep([
      { repo: 'openadlc', number: 44, prNumber: 144 },
      { repo: 'openadlc', number: 48, prNumber: 144 },
    ]);

    expect(moves.map((move) => [move.issueNumber, move.reason])).toEqual([
      [44, 'released in v0.2.1'],
      [48, 'released in v0.2.1'],
    ]);
    expect(asked.filter((path) => path.includes('/compare/'))).toEqual([
      '/repos/620legal/OpenADLC/compare/aaaa4440000...v0.2.0?per_page=1',
      '/repos/620legal/OpenADLC/compare/aaaa4440000...v0.2.1?per_page=1',
    ]);
  });
});
