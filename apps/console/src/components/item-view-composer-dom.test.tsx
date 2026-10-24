// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemView as ItemData } from '@/lib/api';
import type { AttachmentState } from './attachment-drop';

/**
 * A work item's message box in a DOM: one send per message however fast the
 * keys are pressed, the files attached kept across tabs, and what was typed
 * kept when the console does not answer.
 */

const sending = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  /** Each call waits for this, so a test can press again while one is in flight. */
  gate: null as Promise<void> | null,
  reject: false,
}));
vi.mock('@/app/actions', () => ({
  sendItemMessage: vi.fn(async (_subject: string, input: Record<string, unknown>) => {
    sending.sent.push(input);
    if (sending.gate) await sending.gate;
    if (sending.reject) throw new Error('Failed to find Server Action');
    return { ok: true };
  }),
  answerGate: vi.fn(),
  retryTask: vi.fn(),
  sendMessage: vi.fn(),
  stopTask: vi.fn(),
  killSession: vi.fn(),
  restartBot: vi.fn(),
}));

/** The file box, as the real one behaves: what it holds is its own, and a new one starts empty. */
const boxes = vi.hoisted(() => ({ mounted: 0 }));
vi.mock('@/components/attachment-drop', () => ({
  AttachmentDrop: ({ onChange }: { onChange: (state: AttachmentState) => void }) => {
    const [ids, setIds] = useState<string[]>([]);
    useEffect(() => {
      boxes.mounted += 1;
    }, []);
    useEffect(() => onChange({ ids, busy: false }), [ids, onChange]);
    return (
      <button type="button" data-attach onClick={() => setIds(['file-1'])}>
        attach a file
      </button>
    );
  },
}));

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
  roles: [{ role: 'review_lead', label: 'lead reviewer', seats: [{ bot: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'acme-reviewer', sharedAccount: true }] }],
  timeline: [
    { id: 'm-1', kind: 'bot', author: 'lead-reviewer', text: 'Store it per round.', note: null, payload: null, githubUrl: null, at: '2026-09-30T10:10:00.000Z', subjectRef: 'api#31', role: 'review_lead', seat: 'lead-reviewer', bot: 'lead-reviewer' },
  ],
  openGates: [],
  tasks: [],
  attachments: [],
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sending.sent.length = 0;
  sending.gate = null;
  sending.reject = false;
  boxes.mounted = 0;
  window.sessionStorage.clear();
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(ITEM)));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

async function mount(): Promise<void> {
  const { ItemView } = await import('./item-view');
  await act(async () => root.render(<ItemView subject="api#12" initial={ITEM} now="2026-09-30T12:00:00.000Z" />));
  await settle();
}

function composer(): HTMLTextAreaElement {
  return container.querySelector('textarea')!;
}

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text);
    composer().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function commandEnter(): Promise<void> {
  await act(async () => {
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  });
}

describe('sending from an item', () => {
  it('sends once when Cmd+Enter is pressed again before the first send is answered', async () => {
    await mount();
    await type('Per round, please.');
    let release!: () => void;
    sending.gate = new Promise((resolve) => (release = resolve));
    await commandEnter();
    await commandEnter();
    await act(async () => release());
    await settle();
    expect(sending.sent).toHaveLength(1);
  });

  it('keeps the files attached when the person switches tabs, and sends them', async () => {
    await mount();
    expect(boxes.mounted).toBe(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-attach]')!.click());
    await type('The screenshot shows it.');

    // Radix moves between tabs on mousedown.
    const tab = [...container.querySelectorAll('[role="tab"]')].find((one) => one.textContent?.includes('lead reviewer'))!;
    await act(async () => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    expect(tab.getAttribute('aria-selected')).toBe('true');
    // One file box for every tab: a new one on each switch started empty.
    expect(boxes.mounted).toBe(1);

    await commandEnter();
    await settle();
    expect(sending.sent).toEqual([expect.objectContaining({ text: 'The screenshot shows it.', attachments: ['file-1'] })]);
  });

  it('says the console did not answer and keeps what was typed, rather than losing the page', async () => {
    await mount();
    await type('Per round, please.');
    sending.reject = true;
    await commandEnter();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the console did not take that');
    expect(composer().value).toBe('Per round, please.');
  });

  it('puts back a draft the page held before it was loaded again', async () => {
    await mount();
    await type('Half of a thought');
    act(() => root.unmount());

    root = createRoot(container);
    await mount();
    expect(composer().value).toBe('Half of a thought');
  });
});

describe('writing on an item nobody has worked on yet', () => {
  // The box said "pick a role to write to", and an item with no role yet had no role tab to pick.
  const NOBODY = 'nobody has worked on this item yet, so there is no one to send it to; pick a role to write to';
  const FRESH: ItemData = {
    ...ITEM,
    stage: null,
    roles: [],
    timeline: [],
    routes: {
      '': { kind: 'refused', error: NOBODY },
      spec: { kind: 'post', bot: 'designer', role: 'spec', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12 },
      implement: { kind: 'post', bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12 },
    },
  };

  async function open(item: ItemData): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(item)));
    const { ItemView } = await import('./item-view');
    await act(async () => root.render(<ItemView subject="api#12" initial={item} now="2026-09-30T12:00:00.000Z" />));
    await settle();
  }

  const picker = () => container.querySelector('[data-role-picker]');
  const pick = (label: string) => [...(picker()?.querySelectorAll('button') ?? [])].find((one) => one.textContent === label)!;
  const helper = () => container.querySelector('[data-composer-helper]')?.textContent;

  it('offers the crew’s roles to pick, and sends to the one picked', async () => {
    await open(FRESH);
    expect(container.querySelectorAll('[data-role-tab]')).toHaveLength(0);
    expect(composer().disabled).toBe(true);
    expect(helper()).toContain('pick a role to write to');
    expect([...picker()!.querySelectorAll('button')].map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([
      ['system engineer', 'false'],
      ['builder', 'false'],
    ]);

    await act(async () => pick('builder').click());
    expect(pick('builder').getAttribute('aria-pressed')).toBe('true');
    expect(composer().disabled).toBe(false);
    expect(container.querySelector('label')?.textContent).toBe('Message the builder');
    expect(helper()).toBe('To the builder (acme-crew), posted on #12 as a comment');

    await type('Keep the old column too.');
    await commandEnter();
    await settle();
    expect(sending.sent).toEqual([expect.objectContaining({ text: 'Keep the old column too.', role: 'implement' })]);
  });

  it('asks for no role when there is none to pick, and offers no picker from a bridge that names no routes', async () => {
    const none = 'nobody has worked on this item yet, and the crew has no seat that reads a message; add one in Settings → Crew';
    await open({ ...FRESH, routes: { '': { kind: 'refused', error: none } } });
    expect(picker()).toBeNull();
    expect(helper()).not.toContain('pick a role');

    act(() => root.unmount());
    root = createRoot(container);
    await open(ITEM);
    expect(picker()).toBeNull();
  });
});

describe('writing from the conversation of an item someone works on', () => {
  // core#5 on 2026-10-24: #7's CI was red and the fix was the builder's; the
  // box sent the message to the lead reviewer, who had spoken last, said only
  // where it was posted, and nothing started.
  const PATCH = { kind: 'starts' as const, what: 'a patch round on pull request #31' };
  const UNDER_WAY = { kind: 'nothing' as const, why: 'its review of pull request #31 is already under way' };
  const RED: ItemData = {
    ...ITEM,
    ciRed: true,
    roles: [
      { role: 'implement', label: 'builder', seats: [{ bot: 'builder', slot: 'builder', githubLogin: 'acme-crew', sharedAccount: false }] },
      ...ITEM.roles,
    ],
    routes: {
      '': { kind: 'post', bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12, start: PATCH },
      review_lead: { kind: 'post', bot: 'lead-reviewer', role: 'review_lead', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31, start: UNDER_WAY },
      implement: { kind: 'post', bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12, start: PATCH },
    },
  };

  async function open(item: ItemData): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(item)));
    const { ItemView } = await import('./item-view');
    await act(async () => root.render(<ItemView subject="api#12" initial={item} now="2026-09-30T12:00:00.000Z" />));
    await settle();
  }

  const chips = () => [...(container.querySelector('[data-role-picker]')?.querySelectorAll('button') ?? [])];
  const chip = (label: string) => chips().find((one) => one.textContent === label)!;
  const helper = () => container.querySelector('[data-composer-helper]')?.textContent;
  const label = () => container.querySelector('label')?.textContent;

  it('is addressed to the role that acts next, says so, and says what sending it starts', async () => {
    await open(RED);
    expect(label()).toBe('Message the builder');
    expect(chips().map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([
      ['builder', 'true'],
      ['lead reviewer', 'false'],
    ]);
    expect(helper()).toBe('To the builder (acme-crew), posted on #12 as a comment; starts a patch round on pull request #31');

    await type('Make the scope check accept any heading level, in this PR.');
    await commandEnter();
    await settle();
    // Left to the bridge, which routes it to the same role by the same rule.
    expect(sending.sent).toEqual([expect.objectContaining({ text: 'Make the scope check accept any heading level, in this PR.', gateId: null, role: null })]);
  });

  it('says before it is sent that a message to another role starts nothing, and why', async () => {
    await open(RED);
    await act(async () => chip('lead reviewer').click());
    expect(label()).toBe('Message the lead reviewer');
    expect(chip('lead reviewer').getAttribute('aria-pressed')).toBe('true');
    expect(chip('builder').getAttribute('aria-pressed')).toBe('false');
    expect(helper()).toBe(
      'To the lead reviewer (acme-reviewer), posted on pull request #31 as a comment; nothing starts: its review of pull request #31 is already under way',
    );

    await type('Look again.');
    await commandEnter();
    await settle();
    expect(sending.sent).toEqual([expect.objectContaining({ text: 'Look again.', role: 'review_lead' })]);
  });

  it('answers the question of the role picked, whose task waits on it, rather than writing to it', async () => {
    const asks = (id: string, role: string, bot: string, question: string) => ({
      id,
      question,
      options: [],
      addressedTo: null,
      githubCommentUrl: null,
      subjectRef: role === 'implement' ? 'api#12' : 'api#31',
      role,
      seat: bot,
      bot,
    });
    const waiting: ItemData = {
      ...RED,
      openGates: [asks('g-lead', 'review_lead', 'lead-reviewer', 'Per round?'), asks('g-builder', 'implement', 'builder', 'Which heading levels?')],
    };
    await open(waiting);
    // Two questions open and none picked: the bridge would not guess, and the box is to nobody yet.
    expect(composer().disabled).toBe(true);
    expect(chips().map((one) => one.getAttribute('aria-pressed'))).toEqual(['false', 'false']);

    await act(async () => chip('builder').click());
    expect(chip('builder').getAttribute('aria-pressed')).toBe('true');
    expect(label()).toBe('Your answer');
    expect(helper()).toBe('Answers the builder’s question: “Which heading levels?”');
    await type('Any of them.');
    await commandEnter();
    await settle();
    // The answer resumes the builder's task; nothing new is started beside it.
    expect(sending.sent).toEqual([expect.objectContaining({ text: 'Any of them.', gateId: 'g-builder', role: 'implement' })]);
  });
});
