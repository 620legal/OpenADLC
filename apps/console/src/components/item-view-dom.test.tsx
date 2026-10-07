// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemView as ItemData } from '@/lib/api';
import { RECONNECT_FIRST_MS } from '@/lib/use-event-stream';

/**
 * A work item's box, in a DOM: what a person writes is sent with the id of
 * the question it answers. Without it the bridge answers "the one question
 * open", which with two open is a guess it refuses, and a choice pressed on a
 * question reached whichever question the bot happened to ask last.
 */

const sent = vi.hoisted(() => [] as { subject: string; input: Record<string, unknown> }[]);
vi.mock('@/app/actions', () => ({
  sendItemMessage: vi.fn(async (subject: string, input: Record<string, unknown>) => (sent.push({ subject, input }), { ok: true })),
  answerGate: vi.fn(),
  retryTask: vi.fn(),
  sendMessage: vi.fn(),
  stopTask: vi.fn(),
  killSession: vi.fn(),
  restartBot: vi.fn(),
}));

function gate(id: string, role: string, bot: string, question: string) {
  return { id, question, options: ['Yes', 'No'], addressedTo: null, githubCommentUrl: null, subjectRef: 'api#31', role, seat: bot, bot };
}

const ITEM: ItemData = {
  key: 'api#12',
  subjects: ['api#12', 'api#31'],
  title: 'Record the model per review',
  repo: 'api',
  stage: 'review',
  costUsd: 0,
  request: null,
  issue: { number: 12, title: 'Record the model per review', url: null, stage: 'review' },
  pullRequest: { number: 31, url: null },
  roles: [
    { role: 'review_lead', label: 'lead reviewer', seats: [{ bot: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'acme-reviewer', sharedAccount: true }] },
    { role: 'review_second', label: 'second reviewer', seats: [{ bot: 'second-reviewer', slot: 'second-reviewer', githubLogin: 'acme-reviewer', sharedAccount: true }] },
  ],
  timeline: [],
  openGates: [gate('g-lead', 'review_lead', 'lead-reviewer', 'Merge the migration first?'), gate('g-second', 'review_second', 'second-reviewer', 'Per round, or per task?')],
  tasks: [],
  attachments: [],
};

let root: Root;
let container: HTMLElement;
let item: ItemData;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent.length = 0;
  item = ITEM;
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...within.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function type(text: string): Promise<void> {
  const area = container.querySelector('textarea')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(): Promise<void> {
  const { ItemView } = await import('./item-view');
  await act(async () => root.render(<ItemView subject="api#12" initial={item} now="2026-09-30T12:00:00.000Z" />));
  await settle();
}

describe('the item’s box', () => {
  it('sends nothing while two questions are open and none is picked, then sends the picked one’s id', async () => {
    await mount();
    expect(container.querySelector('textarea')!.disabled).toBe(true);
    expect(container.querySelector('[data-composer-helper]')!.textContent).toContain('pick the one you are answering');

    const second = container.querySelector('[data-question="g-second"]')!;
    await act(async () => button('Answer in my own words', second).click());
    await type('Per round, and say which model.');
    await act(async () => button('Answer').click());
    await settle();

    expect(sent).toEqual([{ subject: 'api#12', input: { text: 'Per round, and say which model.', gateId: 'g-second', role: null } }]);
  });

  it('sends a choice pressed on a question with that question’s id', async () => {
    await mount();
    await act(async () => button('Yes', container.querySelector('[data-question="g-lead"]')!).click());
    await settle();
    expect(sent).toEqual([{ subject: 'api#12', input: { text: 'Yes', gateId: 'g-lead', role: null } }]);
  });

  it('answers the one open question by its id, with nothing to pick', async () => {
    item = { ...ITEM, openGates: [ITEM.openGates[1]!] };
    await mount();
    await type('Per task.');
    await act(async () => button('Answer').click());
    await settle();
    expect(sent).toEqual([{ subject: 'api#12', input: { text: 'Per task.', gateId: 'g-second', role: null } }]);
  });
});

/** An EventSource the test drives: each one made, and the events it is sent. */
class FakeEventSource {
  static made: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((one) => one !== listener));
  }
  emit(type: string, readyState?: number): void {
    if (readyState !== undefined) this.readyState = readyState;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe('reading the item again', () => {
  it('ignores an older read that answers after a newer one', async () => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const held: ((body: ItemData) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => held.push((body) => resolve(Response.json(body))))),
    );
    await mount();

    // Two changes in quick succession: two reads, out at once.
    await act(async () => FakeEventSource.made[0]!.emit('changed'));
    await act(async () => FakeEventSource.made[0]!.emit('changed'));
    expect(held).toHaveLength(2);

    // The newer read answers first: the lead's question has been answered.
    const answered = { ...ITEM, openGates: [ITEM.openGates[1]!] };
    await act(async () => held[1]!(answered));
    await settle();
    expect(container.querySelector('[data-question="g-lead"]')).toBeNull();

    // The older one answers last, from before the answer, and is not drawn.
    await act(async () => held[0]!(ITEM));
    await settle();
    expect(container.querySelector('[data-question="g-lead"]')).toBeNull();
    expect(container.querySelector('[data-question="g-second"]')).not.toBeNull();
  });
});

describe('the item’s stream, after the bridge restarts', () => {
  it('is opened again once the browser has given it up, reads the item again, and stops saying it is not updating', async () => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ((reads += 1), Response.json(item))),
    );
    await mount();
    await act(async () => FakeEventSource.made[0]!.emit('open', FakeEventSource.OPEN));
    await settle();
    expect(reads).toBe(1);

    // The browser's own retry was answered 502, and it closed the stream.
    await act(async () => FakeEventSource.made[0]!.emit('error', FakeEventSource.CLOSED));
    expect(container.textContent).toContain('Not updating on its own right now');

    await act(async () => new Promise((resolve) => setTimeout(resolve, RECONNECT_FIRST_MS + 50)));
    expect(FakeEventSource.made).toHaveLength(2);
    expect(FakeEventSource.made[1]!.url).toBe('/api/item/api%2312/stream');
    await act(async () => FakeEventSource.made[1]!.emit('open', FakeEventSource.OPEN));
    await settle();
    expect(reads).toBe(2);
    expect(container.textContent).not.toContain('Not updating on its own right now');
  });
});
