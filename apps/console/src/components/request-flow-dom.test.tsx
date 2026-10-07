// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, ThreadView } from '@/lib/api';

/**
 * A request from being sent to being answered, in a DOM: the dialog
 * says where it went and what happens next, its card in Intake says where it
 * is, and its bot's thread shows every question the bot has open.
 */

const answered = vi.hoisted(() => [] as { gateId: string; answer: string }[]);
/** What the bridge answers the next request with, and what was sent. */
const filing = vi.hoisted(() => ({
  answer: { ok: true, bot: 'ottoexampleco', queued: false, position: null } as Record<string, unknown> | 'reject',
  sent: [] as Record<string, unknown>[],
}));
vi.mock('@/app/actions', () => ({
  fileRequest: vi.fn(async (input: Record<string, unknown>) => {
    filing.sent.push(input);
    if (filing.answer === 'reject') throw new Error('Failed to find Server Action');
    return filing.answer;
  }),
  answerGate: vi.fn(async (gateId: string, answer: string) => (answered.push({ gateId, answer }), { ok: true })),
  killSession: vi.fn(async () => ({ ok: true })),
  restartBot: vi.fn(async () => ({ ok: true })),
  retryTask: vi.fn(async () => ({ ok: true })),
  sendMessage: vi.fn(async () => ({ ok: true })),
  stopTask: vi.fn(async () => ({ ok: true })),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const INTAKE: CrewMember = {
  name: 'ottoexampleco',
  slot: 'intake',
  displayName: 'Intake',
  role: 'intake',
  engine: 'claude',
  model: 'newest:opus',
  status: 'stopped',
  container: 'bot-intake',
  githubLogin: 'ottoexampleco',
  authorization: 'active',
  tokenExpiresAt: null,
  now: 'nothing running',
  paused: false,
  sessions: [],
  task: null,
  lastTask: null,
};

const THREAD: ThreadView = {
  bot: { name: 'ottoexampleco', displayName: 'Intake', role: 'intake', engine: 'claude', container: 'bot-intake', status: 'idle' },
  subjects: ['request:aaaa1111', 'request:bbbb2222'],
  topics: [
    { ref: 'request:aaaa1111', kind: 'request', title: 'A hello world page', request: { id: 'aaaa1111', text: 'A hello world page', state: 'questions', issue: null } },
    { ref: 'request:bbbb2222', kind: 'request', title: 'A Tetris game', request: { id: 'bbbb2222', text: 'A Tetris game', state: 'questions', issue: null } },
  ] as never,
  messages: [],
  openGate: { id: 'gate-1', question: 'Where should the page go?', options: ['index.html', 'docs/'], addressedTo: null, githubCommentUrl: null },
  openGates: [
    { id: 'gate-1', question: 'Where should the page go?', options: ['index.html', 'docs/'], addressedTo: null, githubCommentUrl: null, subjectRef: 'request:aaaa1111' },
    { id: 'gate-2', question: 'Should it keep a high score?', options: ['Yes', 'No'], addressedTo: null, githubCommentUrl: null, subjectRef: 'request:bbbb2222' },
  ],
};

let reads: string[] = [];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  answered.length = 0;
  filing.sent.length = 0;
  filing.answer = { ok: true, bot: 'ottoexampleco', queued: false, position: null };
  reads = [];
  // A request being written is kept in the tab's session storage; each test starts with none.
  window.sessionStorage.clear();
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
      reads.push(path);
      const body = path.startsWith('/api/thread/') ? THREAD : path.startsWith('/api/sessions/') ? { stored: [] } : { accounts: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function button(label: string, within: ParentNode): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...within.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

describe('a bot’s thread', () => {
  it('answers once when Cmd+Enter is pressed again before the first answer is back', async () => {
    const { answerGate } = await import('@/app/actions');
    let release!: () => void;
    vi.mocked(answerGate).mockImplementationOnce(async (gateId: string, answer: string) => {
      answered.push({ gateId, answer });
      await new Promise<void>((resolve) => (release = resolve));
      return { ok: true };
    });
    const { ThreadPanel } = await import('./thread-panel');
    await act(async () => root.render(<ThreadPanel bot="ottoexampleco" member={INTAKE} onClose={() => undefined} now="2026-09-29T12:00:00.000Z" />));
    await settle();

    const area = container.querySelector('form textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'index.html');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let press = 0; press < 2; press++) {
      await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })));
    }
    await act(async () => release());
    await settle();
    expect(answered).toEqual([{ gateId: 'gate-1', answer: 'index.html' }]);
  });

  it('lists every question the bot has open, on any request, each answerable where it is, and the one on screen once', async () => {
    const { ThreadPanel } = await import('./thread-panel');
    await act(async () => root.render(<ThreadPanel bot="ottoexampleco" member={INTAKE} onClose={() => undefined} now="2026-09-29T12:00:00.000Z" />));
    await settle();

    const list = container.querySelector('[aria-label="Open questions"]')!;
    expect(list).not.toBeNull();
    expect(list.textContent).toContain('2 waiting for your answer');
    expect(list.textContent).toContain('one is below');
    // The one this view shows is its card below, not listed again.
    const questions = [...list.querySelectorAll('[data-question]')];
    expect(questions.map((one) => one.getAttribute('data-question'))).toEqual(['gate-2']);
    expect(container.textContent!.split('Where should the page go?')).toHaveLength(2);
    expect(questions[0]!.textContent).toContain('Should it keep a high score?');
    expect(questions[0]!.textContent).toContain('A Tetris game');

    // The second request's question, answered from here.
    await act(async () => button('Yes', questions[0]!).click());
    await settle();
    expect(answered).toEqual([{ gateId: 'gate-2', answer: 'Yes' }]);
  });

  it('keeps a question’s underscores and code as the bot wrote them', async () => {
    THREAD.openGates![1] = { ...THREAD.openGates![1]!, question: 'Keep `high_score` in snake_case?' };
    try {
      const { ThreadPanel } = await import('./thread-panel');
      await act(async () => root.render(<ThreadPanel bot="ottoexampleco" member={INTAKE} onClose={() => undefined} now="2026-09-29T12:00:00.000Z" />));
      await settle();
      const text = container.querySelector('[data-question="gate-2"] [data-question-text]')!;
      expect(text.textContent).toContain('high_score');
      expect(text.textContent).toContain('snake_case');
      expect(text.querySelector('code')?.textContent).toBe('high_score');
    } finally {
      THREAD.openGates![1] = { ...THREAD.openGates![1]!, question: 'Should it keep a high score?' };
    }
  });

  it('switches to the request a question is about in one click', async () => {
    const { ThreadPanel } = await import('./thread-panel');
    await act(async () => root.render(<ThreadPanel bot="ottoexampleco" member={INTAKE} onClose={() => undefined} now="2026-09-29T12:00:00.000Z" />));
    await settle();

    const second = container.querySelector('[data-question="gate-2"]')!;
    // A real button, big enough to tap on a phone.
    expect(button('Show it', second).className).toContain('min-h-11');
    await act(async () => button('Show it', second).click());
    await settle();
    expect(reads).toContain('/api/thread/ottoexampleco?subject=request%3Abbbb2222');
  });
});

// ---------------------------------------------------------------- sending

async function openDialog(): Promise<HTMLElement> {
  const { IntakeDialog } = await import('./intake-dialog');
  await act(async () => root.render(<IntakeDialog repos={['api', 'web']} defaultRepo="api" />));
  await act(async () => button('+ New request', container).click());
  return document.querySelector('[role="dialog"]') as HTMLElement;
}

async function type(dialog: HTMLElement, text: string): Promise<void> {
  const area = dialog.querySelector('textarea')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(label: string): Promise<void> {
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  await act(async () => button(label, dialog).click());
  await settle();
}

describe('sending a request', () => {
  it('says it was sent, where, and that intake is on it, with Send another, Open the conversation and Close', async () => {
    filing.answer = { ok: true, bot: 'ottoexampleco', subject: 'request:aaaa1111', queued: false, position: null };
    const dialog = await openDialog();
    await type(dialog, 'A hello world page\nWith a link back home.');
    await press('Send to intake');

    const shown = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(filing.sent).toEqual([expect.objectContaining({ text: 'A hello world page\nWith a link back home.', repo: 'api' })]);
    expect(shown.textContent).toContain('Sent: A hello world page → api');
    expect(shown.textContent).toContain('Intake is on it');
    // The form is gone: the confirmation stands in its place.
    expect(shown.querySelector('textarea')).toBeNull();
    // The request's own conversation, not the intake bot's thread of every request.
    const thread = [...shown.querySelectorAll('a')].find((link) => link.textContent === 'Open the conversation');
    expect(thread?.getAttribute('href')).toBe('/?item=request%3Aaaaa1111');
    expect(() => button('Close', shown)).not.toThrow();

    // Send another: a fresh, empty form.
    await press('Send another');
    const fresh = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(fresh.querySelector('textarea')?.value).toBe('');
    expect(fresh.textContent).not.toContain('Sent:');
  });

  it('asks for detail and files, and says the files never reach GitHub', async () => {
    // "One line is enough" got one line, and intake asked for the rest a
    // question at a time, as it should: one question per message.
    const dialog = await openDialog();
    expect(dialog.textContent).not.toContain('One line is enough');
    expect(dialog.textContent).toContain('Details');
    expect(dialog.textContent).toContain('screenshots, mockups or documents');
    expect(dialog.textContent).toContain('They are never posted to GitHub.');
    expect(dialog.querySelector('input[type="file"]')?.getAttribute('accept')).toContain('image/png');
  });

  it('says its place in line when the bridge queued it', async () => {
    filing.answer = { ok: true, bot: 'ottoexampleco', queued: true, position: 2 };
    const dialog = await openDialog();
    await type(dialog, 'A Tetris game');
    await press('Send to intake');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Queued (#2)');
  });

  it('sends and leaves an empty form open with Send & add another, saying in a line what went', async () => {
    filing.answer = { ok: true, bot: 'ottoexampleco', queued: true, position: 1 };
    const dialog = await openDialog();
    await type(dialog, 'A Tetris game');
    await press('Send & add another');

    const still = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(filing.sent).toHaveLength(1);
    expect(still.querySelector('textarea')?.value).toBe('');
    expect(still.querySelector('[role="status"]')?.textContent).toBe('Sent: A Tetris game → api · Queued (#1).');

    await type(still, 'A snake game');
    await press('Send & add another');
    expect(filing.sent.map((one) => one.text)).toEqual(['A Tetris game', 'A snake game']);
  });

  it('clears the line about the last one sent when the next is refused', async () => {
    filing.answer = { ok: true, bot: 'ottoexampleco', queued: true, position: 1 };
    const dialog = await openDialog();
    await type(dialog, 'A Tetris game');
    await press('Send & add another');
    filing.answer = { ok: false, error: 'intake is not signed in' };
    await type(document.querySelector('[role="dialog"]') as HTMLElement, 'A snake game');
    await press('Send & add another');
    const still = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(still.textContent).not.toContain('Sent: A Tetris game');
    expect(still.textContent).toContain('intake is not signed in');
  });

  it('keeps the form and what was typed when the bridge refuses it', async () => {
    filing.answer = { ok: false, error: 'no intake bot is configured' };
    const dialog = await openDialog();
    await type(dialog, 'A hello world page');
    await press('Send to intake');
    const still = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(still.textContent).toContain('no intake bot is configured');
    expect(still.querySelector('textarea')?.value).toBe('A hello world page');
  });

  it('keeps the form and what was typed when the console itself does not answer', async () => {
    // A restarted console, or a new build under an open tab: the call
    // rejected, and the page was replaced with an error screen.
    filing.answer = 'reject';
    const dialog = await openDialog();
    await type(dialog, 'A hello world page');
    await press('Send to intake');
    const still = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(still.textContent).toContain('the console did not take that');
    expect(still.querySelector('textarea')?.value).toBe('A hello world page');
  });

  it('puts back a request being written when the page is drawn again', async () => {
    let dialog = await openDialog();
    await type(dialog, 'A hello world page');
    act(() => root.unmount());
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    dialog = await openDialog();
    expect(dialog.querySelector('textarea')?.value).toBe('A hello world page');
  });
});

// ---------------------------------------------------------------- the Intake column

describe('a request’s card in Intake', () => {
  it('says where each request is: queued with its place, intake working, waiting for you, filed as a link', async () => {
    const { BoardView } = await import('./board-view');
    const { headerData } = await import('@/lib/header');
    const request = (id: string, extra: Record<string, unknown>) => ({
      repo: 'api',
      ref: `request:${id}`,
      title: `Request ${id}`,
      stage: 'intake',
      assignees: [],
      gateOpen: false,
      url: null,
      labels: [],
      updatedAt: '2026-09-29T11:50:00.000Z',
      request: true,
      costUsd: 0,
      active: [],
      last: null,
      ...extra,
    });
    const cards = [
      request('aaaa1111', { requestState: 'waiting', gateOpen: true }),
      request('bbbb2222', { requestState: 'working' }),
      request('cccc3333', { requestState: 'queued', queuePosition: 1 }),
      request('dddd4444', { requestState: 'filed', issueNumber: 42, url: 'https://github.com/exampleco/api/issues/42' }),
    ];
    const titles: Record<string, string> = { intake: 'Intake', spec: 'Design', build: 'Build', review: 'Review', merged: 'Ship', done: 'Done' };
    const board = {
      repo: 'all',
      repos: ['api'],
      columns: Object.keys(titles).map((stage) => ({ stage, title: titles[stage]!, mode: 'autonomous', bots: [], cards: stage === 'intake' ? cards : [] })),
      mergeLine: [],
      waitingOnYou: 1,
      working: 1,
      idle: 0,
    };
    const header = headerData({ repos: ['api'], crew: [INTAKE], budget: null, needsYou: 0 });
    await act(async () =>
      root.render(<BoardView board={board as never} crew={[INTAKE]} repo="all" header={header} attention={[]} now="2026-09-29T12:00:00.000Z" />),
    );
    await settle();

    const statuses = [...container.querySelectorAll('[data-status]')].map((one) => one.textContent);
    expect(statuses).toEqual(expect.arrayContaining(['Waiting for you', 'Intake working', 'Queued (#1)', 'Filed #42']));
    const filed = [...container.querySelectorAll('[data-status] a')].find((link) => link.textContent === 'Filed #42');
    expect(filed?.getAttribute('href')).toBe('https://github.com/exampleco/api/issues/42');
  });
});
