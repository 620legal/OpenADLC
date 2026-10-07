// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, ThreadTopic, ThreadView } from '@/lib/api';
import { RECONNECT_FIRST_MS } from '@/lib/use-event-stream';

/**
 * A bot's panel in a DOM: the conversation on screen is the one for the
 * subject the Show list names, however the reads for each answer, so a reply
 * goes where the person thinks it goes.
 */

const actions = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  answerGate: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));
vi.mock('@/app/actions', () => ({
  sendMessage: actions.sendMessage,
  answerGate: actions.answerGate,
  retryTask: vi.fn(),
  stopTask: vi.fn(),
  killSession: vi.fn(),
  restartBot: vi.fn(),
  restartTaskFresh: vi.fn(),
  requestAttachToken: vi.fn(),
}));

const NOW = '2026-09-30T12:00:00.000Z';

const BUILDER = {
  name: 'builder',
  slot: 'builder',
  displayName: 'builder',
  role: 'implement',
  engine: 'claude',
  model: 'newest:opus',
  status: 'running',
  container: 'bot-builder',
  githubLogin: 'exampleco-builder',
  authorization: 'active',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
  task: null,
  lastTask: null,
} as unknown as CrewMember;

const topic = (number: number): ThreadTopic =>
  ({ ref: `web#${number}`, kind: 'issue', repo: 'web', title: `Issue ${number}`, issue: { number, url: null }, pullRequest: null, request: null }) as ThreadTopic;
const TOPICS = [topic(1), topic(2)];

/** The thread as the bridge reads it for one subject, or for everything. */
function threadFor(subject: string | null): ThreadView {
  const message = (ref: string, text: string) => ({ id: `m-${ref}`, kind: 'bot' as const, author: 'builder', text, note: null, payload: null, githubUrl: null, at: NOW, subjectRef: ref });
  return {
    bot: { name: 'builder', displayName: 'builder', role: 'implement', engine: 'claude', container: 'bot-builder', status: 'running' },
    subjects: TOPICS.map((one) => one.ref),
    topics: TOPICS,
    messages:
      subject === 'web#1'
        ? [message('web#1', 'Should I drop the old column?')]
        : subject === 'web#2'
          ? [message('web#2', 'The form is wired up.')]
          : [message('web#1', 'Should I drop the old column?'), message('web#2', 'The form is wired up.')],
    openGate: subject === 'web#1' ? { id: 'g-1', question: 'Should I drop the old column?', options: [], addressedTo: null, githubCommentUrl: null } : null,
  };
}

/** Reads of web#1, held until the test lets them answer. */
let heldOne: { release: () => void; signal: AbortSignal | null }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  heldOne = [];
  actions.sendMessage.mockClear();
  actions.answerGate.mockClear();
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const parsed = new URL(url, 'http://console.test');
      if (parsed.pathname === '/api/thread/builder') {
        const subject = parsed.searchParams.get('subject');
        const answer = () => Response.json(threadFor(subject));
        if (subject !== 'web#1') return Promise.resolve(answer());
        // As a browser's fetch does: an abort rejects it.
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal ?? null;
          signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          heldOne.push({ release: () => resolve(answer()), signal });
        });
      }
      if (parsed.pathname === '/api/sessions/builder') return Promise.resolve(Response.json({ stored: [] }));
      return Promise.resolve(Response.json({ accounts: [] }));
    }),
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

async function show(subject: string): Promise<void> {
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = subject;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('a bot’s panel, as the Show list changes', () => {
  it('keeps the subject it shows when a read for the one before answers last, and a reply goes to that subject', async () => {
    const { ThreadPanel } = await import('./thread-panel');
    await act(async () => root.render(<ThreadPanel bot="builder" member={BUILDER} onClose={() => undefined} now={NOW} />));
    await settle();

    await show('web#1');
    expect(heldOne).toHaveLength(1);
    await show('web#2');
    expect(container.textContent).toContain('The form is wired up.');

    // The read for web#1 was let go when web#2's started.
    expect(heldOne[0]!.signal?.aborted).toBe(true);
    await act(async () => heldOne[0]!.release());
    await settle();
    expect(container.querySelector('select')!.value).toBe('web#2');
    expect(container.textContent).toContain('The form is wired up.');
    expect(container.textContent).not.toContain('Should I drop the old column?');
    // Being let go is not a failure to say.
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.textContent).not.toContain('not answering');

    const area = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'No, never drop it');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Send')!;
    await act(async () => send.click());
    await settle();
    expect(actions.sendMessage).toHaveBeenCalledWith('builder', 'No, never drop it', 'web#2');
    expect(actions.answerGate).not.toHaveBeenCalled();
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
  emit(type: string, readyState?: number): void {
    if (readyState !== undefined) this.readyState = readyState;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe('a bot’s panel, after the bridge restarts', () => {
  it('opens its stream again once the browser has given it up, reads the thread again, and stops saying it is not updating', async () => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const { ThreadPanel } = await import('./thread-panel');
    await act(async () => root.render(<ThreadPanel bot="builder" member={BUILDER} onClose={() => undefined} now={NOW} />));
    await settle();
    const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/thread/builder')).length;
    const before = reads();

    // The browser's own retry was answered 502, and it closed the stream.
    await act(async () => FakeEventSource.made[0]!.emit('error', FakeEventSource.CLOSED));
    expect(container.textContent).toContain('Not updating on its own right now');

    await act(async () => new Promise((resolve) => setTimeout(resolve, RECONNECT_FIRST_MS + 50)));
    expect(FakeEventSource.made).toHaveLength(2);
    expect(FakeEventSource.made[1]!.url).toBe('/api/thread/builder/stream');
    await act(async () => FakeEventSource.made[1]!.emit('open', FakeEventSource.OPEN));
    await settle();
    expect(reads()).toBe(before + 1);
    expect(container.textContent).not.toContain('Not updating on its own right now');

    // Closing the panel closes the stream, and nothing opens another.
    await act(async () => FakeEventSource.made[1]!.emit('error', FakeEventSource.CLOSED));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => new Promise((resolve) => setTimeout(resolve, RECONNECT_FIRST_MS * 2 + 50)));
    expect(FakeEventSource.made).toHaveLength(2);
    expect(FakeEventSource.made[1]!.closed).toBe(true);
  });
});
