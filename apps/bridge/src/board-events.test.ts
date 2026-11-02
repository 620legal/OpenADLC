import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskedRow, HeldAuditRow, LiveTaskRow, MergedRow, StartedRow } from '@openadlc/db';
import { BoardFeed, liveTaskView, oneLine, registerBoardEventRoutes, toBoardEvent, type BoardEvent, type BoardEventStore, type BoardFacts, type LineEntry } from './board-events.js';
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
};

/** A store whose tables a test writes to, read the way the real one reads: everything at or after `since`. */
function fakeStore() {
  const tables = {
    now: NOW,
    started: [] as StartedRow[],
    asked: [] as AskedRow[],
    merged: [] as MergedRow[],
    held: [] as HeldAuditRow[],
    line: [] as LineEntry[],
    live: [] as LiveTaskRow[],
    facts: FACTS,
    failing: false,
    factsFailing: false,
  };
  const since = <T extends { at: string }>(rows: T[], from: Date): T[] => {
    if (tables.failing) throw new Error('connection terminated');
    return rows.filter((row) => Date.parse(row.at) >= from.getTime());
  };
  const store: BoardEventStore = {
    dbNow: async () => tables.now,
    startedSince: async (from) => since(tables.started, from),
    askedSince: async (from) => since(tables.asked, from),
    mergedSince: async (from) => since(tables.merged, from),
    heldAuditSince: async (from) => since(tables.held, from),
    liveTasks: async () => tables.live,
    mergeLine: async () => tables.line,
    facts: async () => {
      if (tables.factsFailing) throw new Error('connection terminated');
      return tables.facts;
    },
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
    tables.asked.push({ gateId: 'g1', at: later(2), bot: 'system-engineer', subjectRef: 'OpenADLC#227', question: 'Store it per round,\nor per call?' });
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
    tables.asked.push({ gateId: 'g-late', at: later(15), bot: 'builder', subjectRef: 'OpenADLC#227', question: 'Late?' });
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
    const event = toBoardEvent({ type: 'question.asked', row: { gateId: 'g', at: NOW.toISOString(), bot: 'x', subjectRef: 'request:ab12cd34', question: 'a\n\nb '.repeat(200) } }, FACTS);
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
});
