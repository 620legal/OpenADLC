import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandsOffWindow } from '@openadlc/db';
import { mergeDecision, type MergeFacts } from './automation.js';
import { HandsOff } from './hands-off.js';
import { crewApprovedHead } from './host-check-service.js';
import { ReleaseCuts, type ReleaseCutDeps } from './release-routes.js';

/**
 * What a hands-off window never decides (#383, ADR 0093). The window is
 * consulted in one place, `Gates.open`; every decision the issue keeps for a
 * person is made somewhere that never reads it. Each test here opens a window
 * on the repository and shows that decision still waits on a person, and
 * the last one holds the boundary itself: nothing outside the allow-list
 * imports the window or its store.
 */

const WINDOW: HandsOffWindow = {
  id: 'window-1',
  repoId: 'repo-1',
  setBy: 'jane@example.com',
  setByLogin: 'janedoe',
  setByGithubId: 4242,
  duration: 'until_off',
  setAt: '2026-11-25T10:00:00.000Z',
  endsAt: null,
  endedAt: null,
  endedBy: null,
  endedWhy: null,
  endedNote: null,
};

const REPO = { id: 'repo-1', name: 'openadlc', fullName: 'janedoe/openadlc', defaultBranch: 'main' };

let handsOff: HandsOff;

beforeEach(() => {
  handsOff = new HandsOff({
    store: {
      openFor: vi.fn(async () => WINDOW),
      listOpen: vi.fn(async () => [WINDOW]),
      turnOn: vi.fn(async () => ({ window: WINDOW, created: false, expired: [] })),
      end: vi.fn(async () => null),
      endExpired: vi.fn(async () => []),
    },
    audit: async () => undefined,
    repoById: async () => REPO,
    repositoryRefusal: async () => null,
    taskRefusal: async () => null,
    humanReviewRules: async () => ({ rules: [], unread: null }),
    issueFacts: async () => ({ labels: [], declaredPaths: [] }),
  });
});

/** The window is on: what each test below decides, it decides with one open. */
async function windowIsOpen(): Promise<void> {
  expect(await handsOff.openFor(REPO.id)).toMatchObject({ id: 'window-1', endedAt: null });
}

const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const CREW = [
  { name: 'openadlc-sydney-janedoe', slot: 'lead-reviewer', githubLogin: 'sydney-janedoe' },
  { name: 'openadlc-vega-janedoe', slot: 'second-reviewer', githubLogin: 'vega-janedoe' },
];
const LOGIN: Record<string, string> = { 'openadlc-sydney-janedoe': 'sydney-janedoe', 'openadlc-vega-janedoe': 'vega-janedoe' };
let reviewId = 0;
const by = (seat: string, state: string) => ({ id: ++reviewId, user: LOGIN[seat] ?? seat, state, commitId: HEAD, body: `Verdict.\n\n<!-- openadlc-seat:${seat} -->` });
const ciRun = () => ({
  name: 'ci',
  status: 'completed',
  conclusion: 'success',
  app: 'github-actions',
  headSha: HEAD,
  workflow: 'ci',
  run: { event: 'pull_request', path: '.github/workflows/ci.yml', headBranch: 'feature', headRepoFullName: 'janedoe/openadlc', createdAt: '2026-10-01T10:00:00Z' },
});

/** A pull request every rule lets land, as `automation.test.ts` builds one. */
function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  const reviews = overrides.reviews ?? [by('openadlc-sydney-janedoe', 'APPROVED'), by('openadlc-vega-janedoe', 'APPROVED')];
  return {
    repoFullName: 'janedoe/openadlc',
    headRepoFullName: 'janedoe/openadlc',
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
    requestedReviewers: ['openadlc-sydney-janedoe', 'openadlc-vega-janedoe'],
    pendingOnGitHub: [],
    humansRequired: [],
    humanRulesUnknown: false,
    reviews,
    crew: CREW,
    signaturesEnforced: false,
    checkedReviews: reviews,
    ciMergedBy: 'openadlc',
    securitySeat: 'openadlc-vega-janedoe',
    checkRuns: [ciRun()],
    ciContext: { headRef: 'feature', openedAt: '2026-10-01T09:00:00Z', baseChangedAt: null, sameBranch: [] },
    statuses: [{ context: 'review-gate', state: 'success' }],
    gate: 'success',
    sameDiffAs: new Set(),
    carriedFrom: new Set(),
    leadRechecks: null,
    ...overrides,
  };
}

describe('with a hands-off window open, a person is still waited on for', () => {
  it('a merge without the lead’s approval', async () => {
    await windowIsOpen();
    expect(mergeDecision(facts()).land).toBe(true);
    expect(mergeDecision(facts({ reviews: [by('openadlc-vega-janedoe', 'APPROVED')], checkedReviews: [by('openadlc-vega-janedoe', 'APPROVED')] })).land).toBe(false);
  });

  it('a merge without ci on its head', async () => {
    await windowIsOpen();
    expect(mergeDecision(facts({ checkRuns: [] })).land).toBe(false);
  });

  it('a merge without the approval of a person AGENTS.md names, which is a held Human-review approval', async () => {
    await windowIsOpen();
    expect(mergeDecision(facts({ humansRequired: ['orzelig'] }))).toMatchObject({ land: false });
  });

  it('a merge of a pull request held for a person', async () => {
    await windowIsOpen();
    expect(mergeDecision(facts({ held: true }))).toMatchObject({ land: false, reason: 'it is held for a person (needs-human or openadlc:paused)' });
  });

  it('a host check before the crew approves the head', async () => {
    await windowIsOpen();
    expect(crewApprovedHead({ approved: [], decision: { lead: 'lead-reviewer', approvers: [] } })).toBe(false);
    expect(crewApprovedHead({ approved: ['second-reviewer'], decision: { lead: 'lead-reviewer', approvers: ['second-reviewer'] } })).toBe(false);
  });

  it('a release cut without a fresh proof: nothing starts', async () => {
    await windowIsOpen();
    const start = vi.fn();
    const cuts = new ReleaseCuts({
      release: { start, lastRelease: async () => null },
      repo: async () => REPO,
      getRelease: async () => null,
      reader: async () => null,
      runsOf: async () => [],
      run: async () => null,
      releasing: async () => [],
      flows: { start: vi.fn(), state: () => ({ state: 'none' as const }) } as unknown as ReleaseCutDeps['flows'],
      linkOf: async () => ({ githubLogin: 'janedoe', githubUserId: 4242 }),
      isCrew: async () => false,
      approves: async () => true,
      audit: async () => undefined,
      warn: () => undefined,
    });
    await expect(cuts.cut(REPO.name, WINDOW.setBy, { viewId: 'no-such-view' })).rejects.toMatchObject({ status: 409 });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('the boundary', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name === 'dist') return [];
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  it('lets only the allow-list import the window, its cover or its store', () => {
    const reaches = /from '\.\/hands-off(-routes)?\.js'|from '\.\/store\/hands-off\.js'|import \{[^}]*\bhandsOff\b[^}]*\} from '@openadlc\/db'/;
    const found = [...sources(join(root, 'apps')), ...sources(join(root, 'packages'))]
      .filter((path) => reaches.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
      .sort();
    expect(found).toEqual([
      'apps/bridge/src/api.ts',
      'apps/bridge/src/gates.ts',
      'apps/bridge/src/hands-off-routes.ts',
      'apps/bridge/src/hands-off.ts',
      'apps/bridge/src/main.ts',
      'packages/db/src/index.ts',
    ]);
  });

  it('keeps the window out of the merge, held approvals, promotes, host checks, releases, labels and settings', () => {
    for (const file of [
      'automation.ts',
      'merge-line.ts',
      'human-review-decide.ts',
      'held-merge-decide.ts',
      'pull-routes.ts',
      'host-check-service.ts',
      'release-routes.ts',
      'release-service.ts',
      'release-publish.ts',
      'webhooks.ts',
    ]) {
      const text = readFileSync(join(root, 'apps', 'bridge', 'src', file), 'utf8');
      expect(text, file).not.toMatch(/hands-off|handsOff/);
    }
  });
});
