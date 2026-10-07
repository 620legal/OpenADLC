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
