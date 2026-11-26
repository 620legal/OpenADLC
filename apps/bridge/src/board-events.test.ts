import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskedRow, HeldAuditRow, LiveTaskRow, MergedRow, StartedRow } from '@openadlc/db';
import {
  BoardFeed,
  leadSeatOf,
  liveTaskView,
  oneLine,
  readHistory,
  registerBoardEventRoutes,
  toBoardEvent,
  type ApprovalRow,
  type BoardEvent,
  type BoardEventStore,
  type BoardFacts,
  type EventWindow,
  type HeldLineRow,
  type LineEntry,
  type PullOpenedRow,
  type ReleasePublishedRow,
} from './board-events.js';
import { costCapGate } from '@openadlc/shared';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REVIEW } from './config.js';
import { ROUTE_ROLES } from './roles.js';
import { WAITING_FOR_PERSON } from './merge-line.js';
import { Router } from './router.js';

/**
 * The board's event feed, read from the tables events happen in: started
 * tasks, opened gates, moves into Merged and held pull requests. A subscriber
 * hears what happens after it subscribed, once each, and nothing about an
 * ignored issue.
 */

const NOW = new Date('2026-11-02T00:10:00.000Z');
const later = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

const FACTS: BoardFacts = {
  issues: [
    { repoId: 'r1', repoName: 'OpenADLC', number: 227, prNumber: 231, title: 'Add ls and watch', url: 'https://github.com/620legal/OpenADLC/issues/227', labels: [] },
    { repoId: 'r1', repoName: 'OpenADLC', number: 300, prNumber: null, title: 'A person’s own', url: null, labels: ['openadlc:ignore'] },
  ],
  repos: [{ id: 'r1', name: 'OpenADLC', fullName: '620legal/OpenADLC' }],
  requests: [{ id: 'ab12cd34-0000-0000-0000-000000000000', text: 'Make a thing', repoId: null, issueNumber: null, state: 'open' }],
  crew: [
    { name: 'builder', slot: 'builder', githubLogin: 'openadlc-builder' },
    // The reviewers share one account, as they do on a real install.
    { name: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'openadlc-review' },
    { name: 'second-reviewer', slot: 'second-reviewer', githubLogin: 'openadlc-review' },
  ],
  leadSeat: 'lead-reviewer',
};

/** Rows in a window, as the real store reads them: newest first, at most `limit` and every row tied at the last one's time. */
function inWindow<T extends { at: string }>(rows: readonly T[], window: EventWindow, key: (row: T) => string): T[] {
  const inside = rows
    .filter((row) => Date.parse(row.at) >= window.from.getTime() && (!window.to || Date.parse(row.at) <= window.to.getTime()))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (key(a) < key(b) ? 1 : -1));
  if (window.limit === undefined || inside.length <= window.limit) return inside;
  const last = Date.parse(inside[window.limit - 1]!.at);
  return inside.filter((row, index) => index < window.limit! || Date.parse(row.at) === last);
}

/** A store whose tables a test writes to, read the way the real one reads them. */
function fakeStore() {
  const tables = {
    now: NOW,
    started: [] as StartedRow[],
    asked: [] as AskedRow[],
    merged: [] as MergedRow[],
    held: [] as HeldAuditRow[],
    opened: [] as PullOpenedRow[],
    approvals: [] as ApprovalRow[],
    releases: [] as ReleasePublishedRow[],
    heldLine: [] as HeldLineRow[],
    line: [] as LineEntry[],
    live: [] as LiveTaskRow[],
    facts: FACTS,
    olderRequests: [] as BoardFacts['requests'],
    failing: false,
    factsFailing: false,
    reads: 0,
  };
  const read = <T extends { at: string }>(rows: T[], window: EventWindow, key: (row: T) => string): T[] => {
    if (tables.failing) throw new Error('connection terminated');
    tables.reads += 1;
    return inWindow(rows, window, key);
  };
  const store: BoardEventStore = {
    dbNow: async () => tables.now,
    startedIn: async (window) => read(tables.started, window, (row) => row.taskId),
    askedIn: async (window) => read(tables.asked, window, (row) => row.gateId),
    mergedIn: async (window) => read(tables.merged, window, (row) => row.moveId),
    heldAuditIn: async (window) => read(tables.held, window, (row) => row.auditId),
    pullsOpenedIn: async (window) => read(tables.opened, window, (row) => row.eventId),
    approvalsIn: async (window) => read(tables.approvals, window, (row) => row.reviewId),
    releasesPublishedIn: async (window) => read(tables.releases, window, (row) => row.runId),
    heldLineIn: async (window) => read(tables.heldLine, window, (row) => row.id),
    liveTasks: async () => tables.live,
    mergeLine: async () => tables.line,
    facts: async () => {
      if (tables.factsFailing) throw new Error('connection terminated');
      return tables.facts;
    },
    requestByPrefix: async (prefix) => tables.olderRequests.find((one) => one.id.startsWith(prefix)) ?? null,
  };
  return { tables, store };
}

function started(id: string, at: string, subjectRef = 'OpenADLC#227'): StartedRow {
  return { taskId: id, at, bot: 'builder', subjectRef, kind: 'implement', skill: 'implement' };
}

/** A feed driven by hand: its interval never fires in a test. */
async function watching(store: BoardEventStore) {
  const feed = new BoardFeed(store, 1_000_000);
  const heard: BoardEvent[] = [];
  const stop = feed.subscribe((event) => heard.push(event));
  await feed.ready();
  return { feed, heard, stop };
}

describe('the board feed', () => {
  it('says nothing about what was there when it started', async () => {
    const { tables, store } = fakeStore();
    tables.started.push(started('t0', later(-5)));
    tables.line.push({ id: 'e0', repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: `${WAITING_FOR_PERSON} because auto-merge is not on for it` });
    const { feed, heard } = await watching(store);
    await feed.probe();
    expect(heard).toEqual([]);
  });

  it('sends one event for each task started, question asked, merge and hold after it started', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t1', later(1)));
    tables.asked.push({ gateId: 'g1', at: later(2), bot: 'system-engineer', subjectRef: 'OpenADLC#227', question: 'Store it per round,\nor per call?', options: [] });
    tables.merged.push({ moveId: 'm1', at: later(3), repoName: 'OpenADLC', issueNumber: 227, prNumber: 231, actor: 'orzelig', bot: null });
    tables.held.push({ auditId: '9', at: later(4), actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' });
    tables.line.push({ id: 'e1', repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: `${WAITING_FOR_PERSON} because auto-merge is not on for it` });
    await feed.probe();

    expect(heard.map((event) => event.type).sort()).toEqual(['merged', 'pull_request.held', 'pull_request.held', 'question.asked', 'task.started']);
    const byId = new Map(heard.map((event) => [event.id, event]));
    expect(byId.get('task.started:t1')).toMatchObject({ bot: 'builder', text: 'builder started implement on 620legal/OpenADLC#227', item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC' } });
    expect(byId.get('question.asked:g1')?.text).toBe('system-engineer asked: Store it per round, or per call?');
    expect(byId.get('merged:m1')).toMatchObject({ bot: null, text: '620legal/OpenADLC#227 merged (#231) by orzelig' });
    expect(byId.get('pull_request.held:audit:9')).toMatchObject({ bot: null, item: { ref: 'OpenADLC#231' }, text: '620legal/OpenADLC#231 held by orzelig: an unsigned crew post' });
    const hold = heard.find((event) => event.id.startsWith('pull_request.held:merge-line:e1:'));
    expect(hold).toMatchObject({ bot: null, text: '620legal/OpenADLC#231 held: auto-merge is not on for it' });

    // A hold that stays held is not news; a new reason is.
    await feed.probe();
    expect(heard).toHaveLength(5);
    tables.line[0] = { ...tables.line[0]!, detail: `${WAITING_FOR_PERSON} because a person has to approve it` };
    await feed.probe();
    expect(heard.at(-1)?.text).toBe('620legal/OpenADLC#231 held: a person has to approve it');
  });

  it('sends a row the ten-second overlap reads twice once', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t1', later(1)));
    await feed.probe();
    await feed.probe();
    await feed.probe();
    expect(heard.map((event) => event.id)).toEqual(['task.started:t1']);
  });

  it('still sends a row that committed after the cursor passed its time', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t2', later(20)));
    await feed.probe();
    // Written at +15 s inside a transaction that committed after the probe read +20 s.
    tables.asked.push({ gateId: 'g-late', at: later(15), bot: 'builder', subjectRef: 'OpenADLC#227', question: 'Late?', options: [] });
    await feed.probe();
    expect(heard.map((event) => event.id)).toEqual(['task.started:t2', 'question.asked:g-late']);
  });

  it('leaves out work on an issue labelled openadlc:ignore', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t3', later(1), 'OpenADLC#300'));
    await feed.probe();
    expect(heard).toEqual([]);
  });

  it('keeps the stream through a database error, and reads again next probe', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t4', later(1)));
    tables.failing = true;
    await feed.probe();
    tables.failing = false;
    await feed.probe();
    expect(heard.map((event) => event.id)).toEqual(['task.started:t4']);
  });

  it('sends a hold again when it clears and comes back with the same reason', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    const held: LineEntry = { id: 'e2', repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: `${WAITING_FOR_PERSON} because auto-merge is not on for it` };
    tables.line = [held];
    await feed.probe();
    tables.line = [];
    await feed.probe();
    tables.line = [held];
    await feed.probe();
    expect(heard.map((event) => event.text)).toEqual(['620legal/OpenADLC#231 held: auto-merge is not on for it', '620legal/OpenADLC#231 held: auto-merge is not on for it']);
  });

  it('keeps a hold and a row for the next probe when reading what to say about them fails', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.started.push(started('t5', later(1)));
    tables.line.push({ id: 'e3', repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: `${WAITING_FOR_PERSON} because auto-merge is not on for it` });
    tables.factsFailing = true;
    await feed.probe();
    expect(heard).toEqual([]);
    tables.factsFailing = false;
    await feed.probe();
    expect(heard.map((event) => event.type).sort()).toEqual(['pull_request.held', 'task.started']);
  });

  it('gives a new subscriber its own baseline, and nothing from a read begun before it', async () => {
    const { tables, store } = fakeStore();
    const feed = new BoardFeed(store, 1_000_000);
    const first = feed.subscribe(() => undefined);
    await feed.ready();
    tables.started.push(started('t6', later(1)));
    // The read stalls on `facts()` while the last subscriber leaves and a new one arrives.
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    const facts = store.facts;
    store.facts = async () => {
      await stalled;
      return facts();
    };
    const reading = feed.probe();
    first();
    tables.now = new Date(NOW.getTime() + 5_000);
    const heard: BoardEvent[] = [];
    feed.subscribe((event) => heard.push(event));
    let ready = false;
    const baseline = feed.ready().then(() => (ready = true));
    await baseline;
    expect(ready).toBe(true);
    release();
    await reading;
    expect(heard).toEqual([]);
    // The new start's baseline is its own: t6, before it, is never sent.
    store.facts = facts;
    await feed.probe();
    expect(heard).toEqual([]);
    tables.started.push(started('t7', later(6)));
    await feed.probe();
    expect(heard.map((event) => event.id)).toEqual(['task.started:t7']);
  });

  it('stops polling when the last subscriber leaves', async () => {
    const { store } = fakeStore();
    const feed = new BoardFeed(store, 1_000_000);
    const one = feed.subscribe(() => undefined);
    const two = feed.subscribe(() => undefined);
    expect(feed.watching).toBe(true);
    one();
    expect(feed.watching).toBe(true);
    two();
    expect(feed.watching).toBe(false);
  });
});

describe('a board event', () => {
  it('is exactly id, type, at, bot, item and one line of text', () => {
    const event = toBoardEvent({ type: 'question.asked', row: { gateId: 'g', at: NOW.toISOString(), bot: 'x', subjectRef: 'request:ab12cd34', question: 'a\n\nb '.repeat(200), options: [] } }, FACTS);
    expect(Object.keys(event).sort()).toEqual(['at', 'bot', 'id', 'item', 'text', 'type']);
    expect(Object.keys(event.item).sort()).toEqual(['ref', 'repo', 'url']);
    expect(event.item).toEqual({ ref: 'request:ab12cd34', repo: null, url: null });
    expect(event.text).not.toMatch(/\n/);
    expect(event.text.length).toBeLessThanOrEqual(200);
  });

  it('cuts text to one line', () => {
    expect(oneLine('  one\ntwo  ')).toBe('one two');
  });

  it('never cuts an emoji in half', () => {
    // 198 letters, then emoji: a cut by UTF-16 units at 199 lands inside the first.
    const cut = oneLine(`${'a'.repeat(198)}${'😀'.repeat(5)}`);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).toBe(`${'a'.repeat(198)}😀…`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('a live task', () => {
  it('carries its seat, item, state, time in it and spend against its cap', () => {
    const view = liveTaskView({ id: 't', bot: 'builder', kind: 'implement', skill: null, subjectRef: 'OpenADLC#227', state: 'running', since: NOW.toISOString(), costUsd: 1.2, capUsd: 15 }, FACTS);
    expect(view).toEqual({
      id: 't',
      bot: 'builder',
      kind: 'implement',
      item: { ref: 'OpenADLC#227', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/issues/227' },
      state: 'running',
      since: NOW.toISOString(),
      costUsd: 1.2,
      capUsd: 15,
    });
  });
});

const HELD_DETAIL = `${WAITING_FOR_PERSON} because auto-merge is not on for it`;

function capped(id: string, at: string): AskedRow {
  return { gateId: id, at, bot: 'builder', subjectRef: 'OpenADLC#227', ...costCapGate({ capUsd: 15, stepUsd: 15, spentUsd: 15.02, subjectRef: 'OpenADLC#227' }) };
}

function opened(at: string, overrides: Partial<PullOpenedRow> = {}): PullOpenedRow {
  return {
    eventId: `ev-${at}`,
    at,
    login: 'openadlc-builder',
    repoName: 'OpenADLC',
    repoFullName: '620legal/OpenADLC',
    prNumber: 412,
    headRef: 'agent/builder/374-issue-374',
    title: 'Show the crew’s activity',
    url: 'https://github.com/620legal/OpenADLC/pull/412',
    ...overrides,
  };
}

function approval(id: string, at: string, overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    reviewId: id,
    at,
    login: 'openadlc-review',
    body: 'Approved.\n\n<!-- openadlc-seat:lead-reviewer -->',
    repoName: 'OpenADLC',
    repoFullName: '620legal/OpenADLC',
    prNumber: 412,
    url: 'https://github.com/620legal/OpenADLC/pull/412',
    ...overrides,
  };
}

function release(id: string, at: string): ReleasePublishedRow {
  return {
    runId: id,
    at,
    repoName: 'OpenADLC',
    repoFullName: '620legal/OpenADLC',
    tag: 'v1.4.2',
    version: '1.4.2',
    url: 'https://github.com/620legal/OpenADLC/releases/tag/v1.4.2',
    cutBy: 'orzelig',
  };
}

/** One row of each of the eight types, at +1 s to +8 s. */
function seedEveryType(tables: ReturnType<typeof fakeStore>['tables']): void {
  tables.started.push(started('t1', later(1)));
  tables.asked.push({ gateId: 'g1', at: later(2), bot: 'system-engineer', subjectRef: 'OpenADLC#227', question: 'Which?', options: ['a', 'b'] });
  tables.asked.push(capped('g-cap', later(3)));
  tables.merged.push({ moveId: 'm1', at: later(4), repoName: 'OpenADLC', issueNumber: 227, prNumber: 231, actor: 'orzelig', bot: null });
  tables.held.push({ auditId: '9', at: later(5), actor: 'orzelig', target: '620legal/OpenADLC#231', why: 'an unsigned crew post' });
  tables.opened.push(opened(later(6)));
  tables.approvals.push(approval('r1', later(7)));
  tables.releases.push(release('run-1', later(8)));
  // A merge-line hold: the stream sees it in the line, the history in the entry's row.
  tables.line.push({ id: 'e1', repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: HELD_DETAIL });
  tables.heldLine.push({ id: 'e1', at: later(9), repoName: 'OpenADLC', prNumber: 231, state: 'merging', detail: HELD_DETAIL });
}

/** What both reads must agree on: everything but a merge-line hold's time, which the stream takes as when it saw it. */
const shape = (events: BoardEvent[]) =>
  events.map(({ id, type, bot, item, text }) => ({ id, type, bot, item, text })).sort((a, b) => (a.id < b.id ? -1 : 1));

/** Every page of the history, by following `next`. */
async function everyPage(store: BoardEventStore, options: { limit: number; repo?: string; bot?: string }): Promise<{ events: BoardEvent[]; pages: number }> {
  const events: BoardEvent[] = [];
  let before = null as { at: string; id: string } | null;
  let pages = 0;
  for (;;) {
    const page = await readHistory(store, { ...options, before });
    pages += 1;
    events.push(...page.events);
    if (!page.next) return { events, pages };
    const cut = page.next.indexOf('~');
    before = { at: page.next.slice(0, cut), id: page.next.slice(cut + 1) };
    if (pages > 1_000) throw new Error('the history never reached its floor');
  }
}

describe('the new event types', () => {
  it('derives every type the same way in the stream and in the history', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    seedEveryType(tables);
    await feed.probe();
    tables.now = new Date(NOW.getTime() + 60_000);
    const history = await readHistory(store);

    expect(new Set(heard.map((event) => event.type))).toEqual(
      new Set(['task.started', 'question.asked', 'task.capped', 'merged', 'pull_request.held', 'pull_request.opened', 'pull_request.lead_approved', 'release.published']),
    );
    expect(shape(history.events)).toEqual(shape(heard));
    // The merge-line hold has one id in both, so a client that has both shows it once.
    const holdId = heard.find((event) => event.id.startsWith('pull_request.held:merge-line:'))!.id;
    expect(history.events.filter((event) => event.id === holdId)).toHaveLength(1);
  });

  it('reports a task stopped at its cost cap once, as task.capped, and any other gate as a question', async () => {
    const { tables, store } = fakeStore();
    const { feed, heard } = await watching(store);
    tables.asked.push(capped('g-cap', later(1)));
    tables.asked.push({ gateId: 'g-q', at: later(2), bot: 'builder', subjectRef: 'OpenADLC#227', question: 'Continue?', options: ['continue for another $15', 'something else'] });
    await feed.probe();
    expect(heard.map((event) => [event.id, event.type])).toEqual([
      ['task.capped:g-cap', 'task.capped'],
      ['question.asked:g-q', 'question.asked'],
    ]);
    expect(heard[0]).toMatchObject({ bot: 'builder', text: 'builder stopped at the $15 cap on 620legal/OpenADLC#227 after $15.02' });
  });

  it('says which seat opened a pull request, from the account or the branch on a shared one, and nothing for a person', async () => {
    const { tables, store } = fakeStore();
    tables.opened.push(opened(later(1)));
    // The same pull request delivered twice, and read twice: one event.
    tables.opened.push(opened(later(1)));
    tables.opened.push(opened(later(2), { prNumber: 413, login: 'openadlc-review', headRef: 'agent/second-reviewer/1-x', title: 'Shared' }));
    tables.opened.push(opened(later(3), { prNumber: 414, login: 'openadlc-review', headRef: 'feature/x', title: 'No seat' }));
    tables.opened.push(opened(later(4), { prNumber: 415, login: 'a-person', headRef: 'agent/builder/2-x', title: 'Mine' }));
    tables.now = new Date(NOW.getTime() + 60_000);
    const { events } = await readHistory(store);
    expect(events.map((event) => [event.id, event.bot, event.text])).toEqual([
      ['pull_request.opened:620legal/OpenADLC#414', null, 'openadlc-review opened #414: No seat'],
      ['pull_request.opened:620legal/OpenADLC#413', 'second-reviewer', 'second-reviewer opened #413: Shared'],
      ['pull_request.opened:620legal/OpenADLC#412', 'builder', 'builder opened #412: Show the crew’s activity'],
    ]);
    expect(events.at(-1)!.item).toEqual({ ref: 'OpenADLC#412', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/pull/412' });
  });

  it('keeps only the lead seat’s approvals', async () => {
    const { tables, store } = fakeStore();
    tables.approvals.push(approval('lead', later(1)));
    tables.approvals.push(approval('second', later(2), { body: 'Approved.\n\n<!-- openadlc-seat:second-reviewer -->' }));
    tables.approvals.push(approval('person', later(3), { login: 'orzelig', body: 'LGTM' }));
    tables.now = new Date(NOW.getTime() + 60_000);
    const { events } = await readHistory(store);
    expect(events.map((event) => [event.id, event.bot, event.text])).toEqual([['pull_request.lead_approved:lead', 'lead-reviewer', 'lead-reviewer approved #412']]);
    // With no lead in the rules, no approval is the lead's.
    tables.facts = { ...FACTS, leadSeat: null };
    expect((await readHistory(store)).events).toEqual([]);
  });

  it('times a release at its publishing and links it to its release', async () => {
    const { tables, store } = fakeStore();
    tables.releases.push(release('run-1', later(5)));
    tables.now = new Date(NOW.getTime() + 60_000);
    const { events } = await readHistory(store);
    expect(events).toEqual([
      {
        id: 'release.published:run-1',
        type: 'release.published',
        at: later(5),
        bot: null,
        item: { ref: 'release:OpenADLC@v1.4.2', repo: '620legal/OpenADLC', url: 'https://github.com/620legal/OpenADLC/releases/tag/v1.4.2' },
        text: '620legal/OpenADLC v1.4.2 published, cut by @orzelig',
      },
    ]);
  });

  it('names the lead seat as the crew names it now', () => {
    expect(leadSeatOf(DEFAULT_REVIEW, FACTS.crew)).toBe('lead-reviewer');
    expect(leadSeatOf(DEFAULT_REVIEW, [{ name: 'Lucy', slot: 'lead-reviewer', githubLogin: null }])).toBe('Lucy');
  });

  it('is built nowhere but in board-events.ts', () => {
    // A writer that built its own event would be the emit ADR 0021 rules out.
    const root = join(import.meta.dirname, '..', '..', '..');
    const builds = /type:\s*'(task\.started|question\.asked|task\.capped|merged|pull_request\.(held|opened|lead_approved)|release\.published)'/;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', '.next', 'coverage'].includes(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && builds.test(readFileSync(path, 'utf8'))) found.push(path.slice(root.length + 1));
      }
    };
    for (const top of ['apps', 'packages']) walk(join(root, top));
    expect(found).toEqual([join('apps', 'bridge', 'src', 'board-events.ts')]);
  });
});

describe('the history', () => {
  it('pages back newest first, every event once, across ties at a page’s edge and a batch’s', async () => {
    const { tables, store } = fakeStore();
    // 250 tasks, three to each second, and 120 questions on the same seconds: well past a batch of 100 for each.
    for (let index = 0; index < 250; index += 1) tables.started.push(started(`t${String(index).padStart(3, '0')}`, later(-Math.floor(index / 3))));
    for (let index = 0; index < 120; index += 1) {
      tables.asked.push({ gateId: `g${String(index).padStart(3, '0')}`, at: later(-Math.floor(index / 2)), bot: 'builder', subjectRef: 'OpenADLC#227', question: 'q', options: [] });
    }
    for (const limit of [1, 7, 50, 200]) {
      const { events } = await everyPage(store, { limit });
      expect(events, `limit ${limit}`).toHaveLength(370);
      expect(new Set(events.map((event) => event.id)).size).toBe(370);
      const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1));
      expect(events.map((event) => event.id)).toEqual(sorted.map((event) => event.id));
    }
  });

  it('reaches back thirty days by the database’s clock, and no further', async () => {
    const { tables, store } = fakeStore();
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    tables.started.push(started('t-29', daysAgo(29)), started('t-31', daysAgo(31)));
    const page = await readHistory(store);
    expect(page.events.map((event) => event.id)).toEqual(['task.started:t-29']);
    expect(page.next).toBeNull();
    expect(page.floor).toBe(daysAgo(30));
    // A cursor older than the floor reads nothing.
    expect((await readHistory(store, { before: { at: daysAgo(31), id: 'x' } })).events).toEqual([]);
  });

  it('answers a next while there is more, and null at the floor', async () => {
    const { tables, store } = fakeStore();
    tables.started.push(started('a', later(-1)), started('b', later(-2)), started('c', later(-3)));
    const first = await readHistory(store, { limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(['task.started:a', 'task.started:b']);
    expect(first.next).toBe(`${later(-2)}~task.started:b`);
    const second = await readHistory(store, { limit: 2, before: { at: later(-2), id: 'task.started:b' } });
    expect(second.events.map((event) => event.id)).toEqual(['task.started:c']);
    expect(second.next).toBeNull();
  });

  it('filters by repository, which hides requests filed nowhere, and by seat', async () => {
    const { tables, store } = fakeStore();
    tables.started.push(started('in-repo', later(-1)), started('on-request', later(-2), 'request:ab12cd34'));
    tables.started.push({ ...started('reviewer', later(-3)), bot: 'lead-reviewer' });
    tables.merged.push({ moveId: 'by-person', at: later(-4), repoName: 'OpenADLC', issueNumber: 227, prNumber: 231, actor: 'orzelig', bot: null });
    const ids = async (options: { repo?: string; bot?: string }) => (await readHistory(store, options)).events.map((event) => event.id);
    expect(await ids({})).toHaveLength(4);
    expect(await ids({ repo: 'OpenADLC' })).toEqual(['task.started:in-repo', 'task.started:reviewer', 'merged:by-person']);
    expect(await ids({ repo: '620legal/OpenADLC' })).toEqual(['task.started:in-repo', 'task.started:reviewer', 'merged:by-person']);
    expect(await ids({ bot: 'builder' })).toEqual(['task.started:in-repo', 'task.started:on-request']);
    const none = await readHistory(store, { repo: 'elsewhere' });
    expect(none).toMatchObject({ events: [], next: null });
  });

  it('resolves a request older than the newest the facts list to its repository', async () => {
    const { tables, store } = fakeStore();
    tables.olderRequests = [{ id: 'cd34ef56-0000-0000-0000-000000000000', text: 'Older', repoId: 'r1', issueNumber: null, state: 'filed' }];
    tables.started.push(started('old', later(-1), 'request:cd34ef56'));
    const { events } = await readHistory(store, { repo: 'OpenADLC' });
    expect(events.map((event) => event.item)).toEqual([{ ref: 'request:cd34ef56', repo: '620legal/OpenADLC', url: null }]);
  });

  it('leaves out work on an issue labelled openadlc:ignore, as the stream does', async () => {
    const { tables, store } = fakeStore();
    tables.started.push(started('ignored', later(-1), 'OpenADLC#300'));
    expect((await readHistory(store)).events).toEqual([]);
  });
});

describe('the routes', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function serve(feed: BoardFeed, store: BoardEventStore): Promise<string> {
    const router = new Router();
    registerBoardEventRoutes(router, feed, store);
    server = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Reads the stream until `until` has been seen. */
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean): Promise<string> {
    const decoder = new TextDecoder();
    let text = '';
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('streams events as `event: board` frames, after a 200 with the event-stream type', async () => {
    const { tables, store } = fakeStore();
    const feed = new BoardFeed(store, 1_000_000);
    const base = await serve(feed, store);
    const response = await fetch(`${base}/v1/board/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    expect(await readUntil(reader, (text) => text.includes('retry: 1000'))).toContain('retry: 1000');

    tables.started.push(started('t9', later(1)));
    await feed.probe();
    const frame = await readUntil(reader, (text) => text.includes('\n\n'));
    expect(frame).toMatch(/^event: board\nid: task\.started:t9\ndata: /);
    const data = JSON.parse(/data: (.*)\n/.exec(frame)![1]!) as BoardEvent;
    expect(Object.keys(data).sort()).toEqual(['at', 'bot', 'id', 'item', 'text', 'type']);
    expect(Object.keys(data.item).sort()).toEqual(['ref', 'repo', 'url']);
    expect(data.text).not.toMatch(/\n/);
    await reader.cancel();
    await vi.waitFor(() => expect(feed.watching).toBe(false));
  });

  it('pings every 25 seconds, so a quiet stream can be told from a dead one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { store } = fakeStore();
    const feed = new BoardFeed(store, 1_000_000);
    const base = await serve(feed, store);
    const response = await fetch(`${base}/v1/board/events`);
    const reader = response.body!.getReader();
    await readUntil(reader, (text) => text.includes('retry: 1000'));
    vi.advanceTimersByTime(25_000);
    expect(await readUntil(reader, (text) => text.includes(': ping'))).toContain(': ping\n\n');
    await reader.cancel();
  });

  it('lists the live tasks, leaving out ignored work', async () => {
    const { tables, store } = fakeStore();
    tables.live = [
      { id: 'q', bot: 'builder', kind: 'implement', skill: null, subjectRef: 'OpenADLC#227', state: 'queued', since: later(0), costUsd: 0, capUsd: 15 },
      { id: 'r', bot: 'builder', kind: 'implement', skill: null, subjectRef: 'OpenADLC#227', state: 'running', since: later(1), costUsd: 1.2, capUsd: 15 },
      { id: 'p', bot: 'reviewer', kind: 'review', skill: null, subjectRef: 'OpenADLC#231', state: 'paused', since: later(2), costUsd: 0.5, capUsd: 5 },
      { id: 'i', bot: 'builder', kind: 'implement', skill: null, subjectRef: 'OpenADLC#300', state: 'running', since: later(3), costUsd: 0, capUsd: 15 },
    ];
    const base = await serve(new BoardFeed(store, 1_000_000), store);
    const body = (await (await fetch(`${base}/v1/board/tasks`)).json()) as { tasks: { id: string; state: string }[] };
    expect(body.tasks.map((task) => [task.id, task.state])).toEqual([
      ['q', 'queued'],
      ['r', 'running'],
      ['p', 'paused'],
    ]);
  });

  it('answers a page of the history as events, next and floor, with the filters and cursor it was sent', async () => {
    const { tables, store } = fakeStore();
    tables.started.push(started('a', later(-1)), started('b', later(-2)), started('c', later(-3), 'request:ab12cd34'));
    const base = await serve(new BoardFeed(store, 1_000_000), store);
    const first = await fetch(`${base}/v1/board/events/history?limit=1`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as { events: BoardEvent[]; next: string | null; floor: string };
    expect(Object.keys(page).sort()).toEqual(['events', 'floor', 'next']);
    expect(page.events.map((event) => event.id)).toEqual(['task.started:a']);
    const rest = (await (await fetch(`${base}/v1/board/events/history?repo=OpenADLC&bot=builder&before=${encodeURIComponent(page.next!)}`)).json()) as { events: BoardEvent[]; next: string | null };
    expect(rest.events.map((event) => event.id)).toEqual(['task.started:b']);
    expect(rest.next).toBeNull();
  });

  it('refuses a limit or a cursor it cannot read, saying what to send', async () => {
    const { store } = fakeStore();
    const base = await serve(new BoardFeed(store, 1_000_000), store);
    for (const limit of ['0', '201', 'x', '1.5']) {
      const response = await fetch(`${base}/v1/board/events/history?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('limit must be a whole number from 1 to 200');
    }
    for (const before of ['nonsense', '2026-11-02T00:00:00.000Z', '2026-11-02~task.started:a', '~x']) {
      const response = await fetch(`${base}/v1/board/events/history?before=${encodeURIComponent(before)}`);
      expect(response.status, before).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/^before must be the next value/);
    }
  });

  it('is a user’s to read, as the live feed is', () => {
    expect(ROUTE_ROLES['GET /v1/board/events/history']).toBe('user');
    expect(ROUTE_ROLES['GET /v1/board/events']).toBe('user');
  });
});
