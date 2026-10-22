// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerGate, retryTask } from '@/app/actions';
import type { AttentionItem } from '@/lib/api';
import { headerData } from '@/lib/header';
import { NeedsYou } from './needs-you';
import { NeedsYouPage } from './needs-you-page';

/**
 * A Needs-you card in a DOM: its face, its sheet, and what pressing in the
 * sheet does. The card shows its headline, two lines of detail and the one
 * thing to press; Show more opens everything else beside the board.
 */

const pressed = vi.hoisted(() => ({
  retried: [] as string[],
  stopped: [] as string[],
  dismissedTasks: [] as string[],
  holdDismiss: null as (() => Promise<void>) | null,
  rechecked: [] as string[],
  abandoned: [] as string[],
  acknowledged: [] as string[],
  held: [] as string[],
  enforced: 0,
  keysRevoked: [] as string[],
  keysDismissed: [] as string[],
  keysUndone: [] as string[],
  settled: [] as string[],
}));
vi.mock('@/app/actions', () => ({
  answerGate: vi.fn(async () => ({ ok: true })),
  retryTriage: vi.fn(async () => ({ ok: true })),
  abandonRequest: vi.fn(async (requestId: string) => (pressed.abandoned.push(requestId), { ok: true })),
  retryTask: vi.fn(async (taskId: string) => (pressed.retried.push(taskId), { ok: true })),
  stopTask: vi.fn(async (taskId: string) => (pressed.stopped.push(taskId), { ok: true })),
  stopTasks: vi.fn(async (taskIds: string[]) => (pressed.stopped.push(...taskIds), { ok: true })),
  dismissTasks: vi.fn(async (tasks: { taskId: string; occurrence: string }[]) => {
    pressed.dismissedTasks.push(...tasks.map((task) => `${task.taskId}@${task.occurrence}`));
    if (pressed.holdDismiss) await pressed.holdDismiss();
    return { ok: true };
  }),
  dismissNotice: vi.fn(async () => ({ ok: true })),
  acknowledgeNotice: vi.fn(async (_checkId: string, occurrence: string) => (pressed.acknowledged.push(occurrence), { ok: true })),
  holdPull: vi.fn(async (repo: string, number: number) => (pressed.held.push(`${repo}#${number}`), { ok: true, autoMergeOff: true })),
  countOnlySignedPosts: vi.fn(async () => (pressed.enforced++, { ok: true })),
  recheckHealth: vi.fn(async (checkId: string) => (pressed.rechecked.push(checkId), { ok: true })),
  revokeSigningKey: vi.fn(async (login: string, keyId: number) => (pressed.keysRevoked.push(`${login}:${keyId}`), { ok: true })),
  dismissSigningKey: vi.fn(async (login: string, keyId: number) => (pressed.keysDismissed.push(`${login}:${keyId}`), { ok: true })),
  undismissSigningKey: vi.fn(async (login: string, keyId: number) => (pressed.keysUndone.push(`${login}:${keyId}`), { ok: true })),
  approveAll: vi.fn(async (gateId: string) => (pressed.settled.push(`approve-all:${gateId}`), { ok: true })),
  askDesigner: vi.fn(async (gateId: string) => (pressed.settled.push(`designer:${gateId}`), { ok: true })),
  turnOffApproveAll: vi.fn(async (subject: string) => (pressed.settled.push(`off:${subject}`), { ok: true })),
}));
const navigated = vi.hoisted(() => [] as string[]);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: (to: string) => void navigated.push(to) }) }));

const NOW = '2026-09-24T12:00:00.000Z';
const LONG = 'Grok — SuperGrok, the xAI subscription irisexampleco thinks with, is signed out. '.repeat(4) + 'Sign it in again on the accounts step, then try again.';

const FAILED: AttentionItem = {
  id: 'task:task-iris',
  kind: 'task_failed',
  headline: 'The second reviewer (irisexampleco) could not finish its review',
  subject: { repo: 'openadlc-testbed', number: 2, title: 'Add a health endpoint', ref: 'openadlc-testbed#2', url: null },
  bot: { name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer', githubLogin: 'irisexampleco' },
  since: '2026-09-24T11:48:00.000Z',
  detail: LONG,
  raw: 'hostd refused: POST http://127.0.0.1:47312/tasks → 500',
  actions: [
    { kind: 'open_page', label: 'Sign in again', href: '/onboarding?step=accounts' },
    { kind: 'retry_task', label: 'Try again', taskId: 'task-iris' },
    { kind: 'stop_task', label: 'Stop', taskId: 'task-iris' },
  ],
};

const GROUPED: AttentionItem = {
  ...FAILED,
  id: 'task-group:task:task-iris,task:task-lead',
  headline: 'The second reviewer (irisexampleco) could not finish its review (+1 more)',
  detail: 'Signed out.',
  raw: undefined,
  actions: [{ kind: 'recheck', label: 'Check again', checkId: 'model-account' }],
  members: [
    { id: 'task:task-iris', headline: 'The second reviewer (irisexampleco) could not finish its review', detail: 'Signed out.', subject: FAILED.subject, bot: FAILED.bot, since: FAILED.since, actions: [{ kind: 'retry_task', label: 'Try again', taskId: 'task-iris' }] },
    {
      id: 'task:task-lead',
      headline: 'The lead reviewer could not finish its review',
      detail: 'GitHub no longer accepts the lead reviewer’s sign-in.',
      subject: { repo: 'openadlc-testbed', number: 29, title: 'Rate-limit the webhook route', ref: 'openadlc-testbed#29', url: null },
      bot: null,
      since: '2026-09-24T11:40:00.000Z',
      actions: [
        { kind: 'open_page', label: 'Reconnect the lead reviewer', href: '/settings#github-accounts' },
        { kind: 'retry_task', label: 'Try again', taskId: 'task-lead' },
      ],
    },
  ],
};

const UNSIGNED: AttentionItem = {
  id: 'health:unattributed-post',
  kind: 'check_failed',
  headline: 'A review on exampleco/api#31 by janedoe-reviews is not signed by OpenADLC',
  subject: { repo: null, number: null, title: null, ref: null, url: null },
  bot: null,
  since: '2026-09-24T11:30:00.000Z',
  detail: 'It counted: this install still counts unsigned posts.',
  actions: [
    { kind: 'acknowledge', label: 'This was me', checkId: 'unattributed-post', occurrence: 'post:77' },
    { kind: 'open_url', label: 'Open the post', url: 'https://github.com/exampleco/api/pull/31#pullrequestreview-77' },
    { kind: 'incident', label: 'What to do' },
  ],
  incident: {
    repo: 'exampleco/api',
    login: 'janedoe-reviews',
    seat: 'lead-reviewer',
    did: 'review',
    postUrl: 'https://github.com/exampleco/api/pull/31#pullrequestreview-77',
    target: { kind: 'pr', number: 31, url: 'https://github.com/exampleco/api/pull/31' },
    counted: true,
    mode: 'audit',
  },
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pressed.retried.length = 0;
  pressed.stopped.length = 0;
  pressed.dismissedTasks.length = 0;
  pressed.holdDismiss = null;
  pressed.rechecked.length = 0;
  pressed.acknowledged.length = 0;
  pressed.held.length = 0;
  pressed.enforced = 0;
  pressed.keysRevoked.length = 0;
  pressed.keysDismissed.length = 0;
  pressed.keysUndone.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(items: AttentionItem[], onOpenBot: (bot: string, how?: { compose?: boolean }) => void = () => undefined): Promise<void> {
  await act(async () => root.render(<NeedsYou items={items} now={NOW} onOpenBot={onOpenBot} />));
}

/** Whether anything from `node` up to `card` could cut it off: a height bound, or hiding what overflows. */
function clippedWithin(node: Element, card: Element): boolean {
  for (let at: Element | null = node; at && at !== card.parentElement; at = at.parentElement) {
    if (/\b(max-h-|overflow-hidden|line-clamp-)/.test(at.getAttribute('class') ?? '')) return true;
  }
  return false;
}

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...within.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const sheet = (): HTMLElement | null => document.querySelector('[role="dialog"]');

describe('a Needs-you card', () => {
  it('clamps its detail to two lines, as plain words, and clips nothing else', async () => {
    await render([FAILED]);
    const card = container.querySelector('article')!;
    const detail = card.querySelector('[data-clamp="detail"]')!;
    expect(detail.className).toContain('line-clamp-2');
    expect(detail.textContent).toContain('Grok — SuperGrok');
    // Text is cut short; the card is not, so nothing below the text is hidden.
    expect(card.className).not.toMatch(/max-h-|overflow-hidden/);
    // The raw reason and the other buttons wait in the sheet.
    expect(card.textContent).not.toContain('47312');
    expect(() => button('Try again', card)).toThrow();
  });

  it('has no Show more when its face is all of it', async () => {
    await render([{ ...FAILED, detail: 'Signed out.', raw: undefined, actions: [FAILED.actions[0]!] }]);
    expect(() => button('Show more', container)).toThrow();
  });

  it('opens a sheet with the whole detail, the raw reason and every action, and runs Try again and Stop from it', async () => {
    await render([FAILED]);
    expect(sheet()).toBeNull();
    await click(button('Show more', container));

    const opened = sheet()!;
    expect(opened).not.toBeNull();
    expect(opened.textContent).toContain('Sign it in again on the accounts step, then try again.');
    expect(opened.textContent).toContain('hostd refused: POST http://127.0.0.1:47312/tasks');

    await click(button('Try again', opened));
    expect(pressed.retried).toEqual(['task-iris']);
    await click(button('Stop', opened));
    expect(pressed.stopped).toEqual(['task-iris']);
  });

  it('lists every member of a folded card in its sheet, each with its own actions, and the card’s Check again', async () => {
    await render([GROUPED]);
    const card = container.querySelector('article')!;
    // The members are not on the card's face.
    expect(card.textContent).not.toContain('Rate-limit the webhook route');

    await click(button('Show more', card));
    const opened = sheet()!;
    const affected = opened.querySelector('[aria-label="Affected"]')!;
    expect(affected.textContent).toContain('The lead reviewer could not finish its review');
    expect(affected.textContent).toContain('Rate-limit the webhook route');
    expect([...affected.querySelectorAll('a')].map((link) => link.textContent)).toContain('Reconnect the lead reviewer');

    // The second member's own retry, not the first's.
    const rows = [...affected.querySelectorAll('li')];
    await click(button('Try again', rows[1]!));
    expect(pressed.retried).toEqual(['task-lead']);

    await click(button('Check again', opened));
    expect(pressed.rechecked).toEqual(['model-account']);
  });
});

describe('an approved plan change waiting on another lease', () => {
  // #27 on 2026-10-22: approved, then shown with Approve and Refuse as if it
  // had not been, and approved twice more.
  const WAITING: AttentionItem = {
    id: 'plan-change:gate-27',
    kind: 'plan_change_waiting',
    headline: 'The builder (openadlc-atlas-janedoe) waits for #71 to let go of the approved paths',
    subject: { repo: 'openadlc', number: 27, title: 'Show work items', ref: 'openadlc#27', url: null },
    bot: { name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'builder', githubLogin: 'openadlc-atlas-janedoe' },
    since: '2026-09-24T11:40:00.000Z',
    detail: 'janedoe approved adding `packages/db/src/store/work-items.ts`. #71 (pull request #72) holds paths that overlap it, so the task stays paused.',
    actions: [
      { kind: 'open_url', label: 'Open pull request #72', url: 'https://github.com/janedoe/openadlc/pull/72' },
      { kind: 'open_thread', label: 'Open thread', bot: 'openadlc-atlas-janedoe' },
      { kind: 'answer_gate', label: 'Refuse', gateId: 'gate-27', answer: 'Refuse' },
    ],
  };

  it('has what it waits on on its face and nothing that answers it, and refuses only from its sheet', async () => {
    const { answerGate } = await import('@/app/actions');
    vi.mocked(answerGate).mockClear();
    await render([WAITING]);
    const card = container.querySelector('article')!;
    expect([...card.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Open pull request #72']);
    expect(() => button('Approve', card)).toThrow();
    expect(() => button('Refuse', card)).toThrow();

    await click(button('Show more', card));
    expect(() => button('Approve', sheet()!)).toThrow();
    await click(button('Refuse', sheet()!));
    expect(vi.mocked(answerGate)).toHaveBeenCalledWith('gate-27', 'Refuse');
  });

  it('turns approve all off from its sheet while it is on, as the question’s card does', async () => {
    // Approve all stays on while the approval waits, and approves the
    // builder's next request as it asks; the card had no way to stop it (#100).
    pressed.settled = [];
    await render([{ ...WAITING, actions: [...WAITING.actions, { kind: 'approve_all_off', label: 'Turn off approve all for #27', subject: 'openadlc#27' }] }]);
    const card = container.querySelector('article')!;
    expect(() => button('Turn off approve all for #27', card)).toThrow();
    await click(button('Show more', card));
    await click(button('Turn off approve all for #27', sheet()!));
    expect(pressed.settled).toEqual(['off:openadlc#27']);
  });
});

describe('a failed triage’s Dismiss and Abandon', () => {
  // Only Try again and Open thread: a request nobody wanted any more stood in
  // Needs you for a week, or was started again from the queue.
  const TRIAGE: AttentionItem = {
    id: 'request:a4b02784-3ae8-450b-abe9-0c93eb4d67dc',
    kind: 'triage_failed',
    headline: 'The intake bot (ottoexampleco) could not triage your request',
    subject: { repo: 'openadlc-testbed', number: null, title: 'Create html hello world', ref: null, url: null },
    bot: null,
    since: '2026-09-24T11:50:00.000Z',
    detail: 'Engine claude is not available on this host.',
    actions: [
      { kind: 'retry_triage', label: 'Try again', requestId: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc' },
      { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-intake', occurrence: '2026-09-24T11:50:00.000Z' }] },
      { kind: 'abandon_request', label: 'Abandon', requestId: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc' },
    ],
  };

  it('dismisses the triage from its sheet, and abandons the request only once it is confirmed', async () => {
    pressed.abandoned.length = 0;
    pressed.dismissedTasks.length = 0;
    await render([TRIAGE]);
    await click(button('Show more', container));

    await click(button('Dismiss', sheet()!));
    expect(pressed.dismissedTasks).toEqual(['task-intake@2026-09-24T11:50:00.000Z']);

    const confirm = vi.fn(() => false);
    const before = window.confirm;
    window.confirm = confirm;
    try {
      await click(button('Abandon', sheet()!));
      expect(confirm).toHaveBeenCalled();
      expect(pressed.abandoned).toEqual([]);
      confirm.mockReturnValue(true);
      await click(button('Abandon', sheet()!));
      expect(pressed.abandoned).toEqual(['a4b02784-3ae8-450b-abe9-0c93eb4d67dc']);
    } finally {
      window.confirm = before;
    }
  });
});

describe('a signing key OpenADLC did not register', () => {
  const KEYS: AttentionItem = {
    id: 'check:signing-key:account:abner620legal',
    kind: 'check_failed',
    severity: 'warning',
    headline: 'abner620legal has a signing key OpenADLC did not register',
    subject: { repo: null, number: null, title: null, ref: null, url: null },
    bot: null,
    since: '2026-09-24T11:59:00.000Z',
    detail:
      'GitHub lists a key on abner620legal that is no seat’s (laptop, id 6).\n\nDismissed as used elsewhere: openadlc-old, id 4 (by or@example.com, 2026-10-19).',
    actions: [
      { kind: 'signing_key_revoke', label: 'Revoke key', login: 'abner620legal', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_dismiss', label: 'Key is used elsewhere', login: 'abner620legal', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_undo', label: 'Count key 4 again', login: 'abner620legal', keyId: 4, title: null },
      { kind: 'open_url', label: 'Open the account’s keys', url: 'https://github.com/settings/keys' },
      { kind: 'recheck', label: 'Check again', checkId: 'signing-key' },
    ],
  };

  it('revokes the key only once it is confirmed, naming the key by its title', async () => {
    await render([KEYS]);
    const confirm = vi.fn((_message?: string) => false);
    const before = window.confirm;
    window.confirm = confirm;
    try {
      await click(button('Revoke key', container));
      expect(confirm.mock.calls[0]?.[0]).toContain('“laptop” (id 6)');
      expect(pressed.keysRevoked).toEqual([]);
      confirm.mockReturnValue(true);
      await click(button('Revoke key', container));
      expect(pressed.keysRevoked).toEqual(['abner620legal:6']);
    } finally {
      window.confirm = before;
    }
  });

  it('dismisses the key from its face, and takes a dismissal back from the undo in its sheet', async () => {
    await render([KEYS]);
    await click(button('Key is used elsewhere', container));
    expect(pressed.keysDismissed).toEqual(['abner620legal:6']);

    await click(button('Show more', container));
    await click(button('Count key 4 again', sheet()!));
    expect(pressed.keysUndone).toEqual(['abner620legal:4']);
  });
});

describe('a failed task card’s Dismiss and Stop all', () => {
  it('dismisses the task from its sheet with the end the person saw, without trying it again or stopping it', async () => {
    await render([{ ...FAILED, actions: [...FAILED.actions, { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-iris', occurrence: FAILED.since }] }] }]);
    await click(button('Show more', container));
    await click(button('Dismiss', sheet()!));
    expect(pressed.dismissedTasks).toEqual([`task-iris@${FAILED.since}`]);
    expect(pressed.retried).toEqual([]);
    expect(pressed.stopped).toEqual([]);
  });

  it('stops every member of a folded card, not only the newest, and dismisses every one', async () => {
    await render([
      {
        ...GROUPED,
        actions: [
          { kind: 'stop_task', label: 'Stop all', taskId: 'task-iris', taskIds: ['task-iris', 'task-lead'] },
          {
            kind: 'dismiss_task',
            label: 'Dismiss all',
            tasks: [
              { taskId: 'task-iris', occurrence: '2026-09-24T11:48:00.000Z' },
              { taskId: 'task-lead', occurrence: '2026-09-24T11:40:00.000Z' },
            ],
          },
        ],
      },
    ]);
    await click(button('Show more', container));
    await click(button('Stop all', sheet()!));
    expect(pressed.stopped).toEqual(['task-iris', 'task-lead']);
    await click(button('Dismiss all', sheet()!));
    expect(pressed.dismissedTasks).toEqual(['task-iris@2026-09-24T11:48:00.000Z', 'task-lead@2026-09-24T11:40:00.000Z']);
  });

  it('says Dismissing only on the card that was pressed', async () => {
    let release: () => void = () => undefined;
    pressed.holdDismiss = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    const one = { ...FAILED, id: 'task:task-iris', actions: [{ kind: 'dismiss_task' as const, label: 'Dismiss', tasks: [{ taskId: 'task-iris', occurrence: FAILED.since }] }] };
    const two = {
      ...FAILED,
      id: 'task:task-lead',
      headline: 'The lead reviewer could not finish its review',
      actions: [{ kind: 'dismiss_task' as const, label: 'Dismiss', tasks: [{ taskId: 'task-lead', occurrence: FAILED.since }] }],
    };
    await render([one, two]);
    const buttons = [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Dismiss');
    expect(buttons).toHaveLength(2);
    await click(buttons[0]!);
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels.filter((label) => label === 'Dismissing…')).toHaveLength(1);
    expect(labels.filter((label) => label === 'Dismiss')).toHaveLength(1);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const after = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(after.filter((label) => label === 'Dismiss')).toHaveLength(2);
  });
});

/**
 * A press shows at once, goes once, and changes the card from the answer.
 * #27's Approve answered after 30 seconds, and nothing on the card changed
 * meanwhile, so the person pressed it again and again (#76).
 */
describe('a press on a card', () => {
  const QUESTION: AttentionItem = {
    ...FAILED,
    id: 'question:g-27',
    kind: 'question',
    headline: 'The builder (irisexampleco) asks about #27',
    detail: 'Per round or per task?',
    raw: undefined,
    question: { gateId: 'g-27', options: ['per round', 'per task'] },
    actions: [{ kind: 'answer', label: 'Something else…', bot: 'irisexampleco' }],
  };

  /** An action that answers when the test says. */
  function held<T>(): { promise: Promise<T>; answer: (value: T) => Promise<void> } {
    let settle: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => (settle = resolve));
    return {
      promise,
      answer: (value) =>
        act(async () => {
          settle(value);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }),
    };
  }

  it('answers a question once, however often it is pressed while the answer is on its way', async () => {
    const sent = held<{ ok: boolean }>();
    vi.mocked(answerGate).mockClear().mockImplementationOnce(() => sent.promise);
    await render([QUESTION]);
    const card = container.querySelector('article')!;

    // Two presses inside one event's turn: React has not drawn the first yet.
    await act(async () => {
      button('per round', card).click();
      button('per round', card).click();
      button('per task', card).click();
    });

    expect(vi.mocked(answerGate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(answerGate)).toHaveBeenCalledWith('g-27', 'per round');
    expect(button('per round', card).disabled).toBe(true);
    expect(button('per round', card).getAttribute('aria-busy')).toBe('true');

    await sent.answer({ ok: true });

    // From the answer, before the board is read again without the card.
    expect(card.querySelector('[data-done]')?.textContent).toBe('Answered: per round. It goes on from here.');
    expect(button('per task', card).disabled).toBe(true);
    expect(vi.mocked(answerGate)).toHaveBeenCalledTimes(1);
  });

  it('says an answer that stopped the task as stopped, not as going on', async () => {
    vi.mocked(answerGate).mockClear().mockResolvedValueOnce({ ok: true, ended: true });
    await render([{ ...QUESTION, question: { gateId: 'g-27', options: ['Approve', 'Refuse'] } }]);
    const card = container.querySelector('article')!;

    await click(button('Refuse', card));

    expect(card.querySelector('[data-done]')?.textContent).toBe('Answered: Refuse. The task is stopped; its thread says why.');
  });

  it('says an answer that waits on other work, and leaves the choices to press', async () => {
    vi.mocked(answerGate).mockClear().mockResolvedValueOnce({ ok: true, held: true });
    await render([QUESTION]);
    const card = container.querySelector('article')!;

    await click(button('per round', card));

    expect(card.querySelector('[data-done]')?.textContent).toContain('It waits on other work before it goes on');
    expect(button('per task', card).disabled).toBe(false);
  });

  it('starts a task again once, however often Try again is pressed while it is on its way', async () => {
    const started = held<{ ok: boolean }>();
    vi.mocked(retryTask).mockClear().mockImplementationOnce(() => started.promise);
    await render([{ ...FAILED, actions: [{ kind: 'retry_task', label: 'Try again', taskId: 'task-iris' }] }]);
    const card = container.querySelector('article')!;

    await act(async () => {
      button('Try again', card).click();
      button('Try again', card).click();
    });

    expect(vi.mocked(retryTask)).toHaveBeenCalledTimes(1);
    expect(button('Starting…', card).disabled).toBe(true);

    await started.answer({ ok: true });

    expect(card.querySelector('[data-done]')?.textContent).toBe('Starting it again.');
  });

  it('says what the bridge refused, and lets it be pressed again', async () => {
    vi.mocked(answerGate).mockClear().mockResolvedValueOnce({ ok: false, error: 'that question was answered already by janedoe: per task' } as never);
    await render([QUESTION]);
    const card = container.querySelector('article')!;

    await click(button('per round', card));

    expect(card.textContent).toContain('that question was answered already by janedoe: per task');
    expect(card.querySelector('[data-done]')).toBeNull();
    expect(button('per round', card).disabled).toBe(false);
  });
});

describe('an unsigned-post card', () => {
  it('offers This was me, Open the post and What to do on its face, and What to do opens the steps', async () => {
    await render([UNSIGNED]);
    const card = container.querySelector('article')!;
    const labels = [...card.querySelectorAll('button, a')].map((one) => one.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(['This was me', 'Open the post', 'What to do']));
    expect(card.textContent).not.toContain('Check again');

    await click(button('What to do', card));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    expect(steps.querySelectorAll('ol > li')).toHaveLength(5);
    expect(steps.textContent).toContain('Make sure it wasn’t you.');
    expect(steps.textContent).toContain('docs/runbooks/unsigned-post.md');
    const hrefs = [...steps.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        'https://github.com/exampleco/api/pull/31',
        '/settings#github-accounts',
        'https://github.com/settings/apps/authorizations',
        'https://github.com/settings/tokens',
        '/settings#pause',
      ]),
    );
  });

  it('dismisses its post from step one of the sheet', async () => {
    await render([UNSIGNED]);
    await click(button('What to do', container));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    await click(button('This was me', steps));
    expect(pressed.acknowledged).toEqual(['post:77']);
  });

  it('holds the pull request it was on', async () => {
    await render([UNSIGNED]);
    await click(button('What to do', container));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    await click(button('Hold this PR', steps));
    // By its full name, which names one repository where a short one might name two.
    expect(pressed.held).toEqual(['exampleco/api#31']);
    expect(steps.textContent).toContain('Held: #31 is labelled needs-human, auto-merge is off');
  });

  it('says so when auto-merge could not be turned off, instead of claiming it was', async () => {
    const { holdPull } = await import('@/app/actions');
    vi.mocked(holdPull).mockResolvedValueOnce({ ok: true, autoMergeOff: false });
    await render([UNSIGNED]);
    await click(button('What to do', container));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    await click(button('Hold this PR', steps));
    expect(steps.textContent).toContain('auto-merge could not be turned off');
    expect(steps.textContent).not.toContain('auto-merge is off');
  });

  it('switches to counting only signed posts only once it is confirmed', async () => {
    await render([UNSIGNED]);
    await click(button('What to do', container));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    await click(button('Count only signed posts', steps));
    expect(pressed.enforced).toBe(0);
    await click(button('Not now', steps));
    await click(button('Count only signed posts', steps));
    await click(button('Yes, count only signed posts', steps));
    expect(pressed.enforced).toBe(1);
    expect(steps.textContent).toContain('This install counts only signed posts.');
  });

  it('has no Hold on an issue, and no switch when it already counts only signed posts', async () => {
    await render([
      {
        ...UNSIGNED,
        incident: { ...UNSIGNED.incident!, target: { kind: 'issue', number: 12, url: 'https://github.com/exampleco/api/issues/12' }, counted: false, mode: 'enforce' },
      },
    ]);
    await click(button('What to do', container));
    const steps = sheet()!.querySelector('[aria-label="What to do"]')!;
    expect(() => button('Hold this PR', steps)).toThrow();
    expect(() => button('Count only signed posts', steps)).toThrow();
    expect(steps.textContent).toContain('It did not count');
  });
});

describe('a card on a phone', () => {
  it('shows every button on a 300px card, wrapping them, with none of them clipped', async () => {
    // The unsigned-post card: This was me, Open the post, What to do and Show more.
    await render([{ ...UNSIGNED, detail: 'It counted: this install still counts unsigned posts. '.repeat(6) }]);
    const card = container.querySelector('article')!;
    const row = card.querySelector('[data-face="actions"]')!;
    expect(row.className).toContain('flex-wrap');
    const labels = [...row.querySelectorAll('button, a')].map((one) => one.textContent?.trim());
    expect(labels).toEqual(['This was me', 'Open the post', 'What to do', 'Show more']);
    for (const one of row.querySelectorAll('button, a')) expect(clippedWithin(one, card)).toBe(false);
  });

  it('never clips a question’s choices, Something else… or Show more', async () => {
    const question: AttentionItem = {
      ...FAILED,
      id: 'gate:g-1',
      kind: 'question',
      headline: 'The builder asks which way to take the migration, with a headline long enough to wrap twice',
      detail: 'Pick one. '.repeat(20),
      raw: undefined,
      question: { gateId: 'g-1', options: ['Keep the old column for a release, then drop it', 'Drop it now and backfill', 'Rename it in place', 'Something longer again'] },
      actions: [{ kind: 'answer', label: 'Something else…', bot: 'irisexampleco' }],
    };
    await render([question]);
    const card = container.querySelector('article')!;
    for (const label of ['Keep the old column for a release, then drop it', 'Something else…', 'Show more']) {
      expect(clippedWithin(button(label, card), card)).toBe(false);
    }
  });
});

describe('leaving the sheet for a thread', () => {
  it('closes the sheet when it opens the thread, and does not take focus back to Show more', async () => {
    const opened: string[] = [];
    await render(
      [{ ...FAILED, actions: [...FAILED.actions, { kind: 'open_thread', label: 'Open thread', bot: 'irisexampleco' }] }],
      (bot) => opened.push(bot),
    );
    const more = button('Show more', container);
    more.focus();
    await click(more);
    await click(button('Open thread', sheet()!));
    expect(sheet()).toBeNull();
    expect(opened).toEqual(['irisexampleco']);
    // Focus going back to the card would pull it away from the thread’s composer.
    expect(document.activeElement).not.toBe(more);
  });

  it('closes it for Something else… too', async () => {
    const opened: string[] = [];
    const question: AttentionItem = {
      ...FAILED,
      id: 'gate:g-2',
      kind: 'question',
      headline: 'Which way?',
      detail: 'Pick one.',
      raw: undefined,
      question: { gateId: 'g-2', options: ['a', 'b', 'c', 'd'] },
      actions: [{ kind: 'answer', label: 'Something else…', bot: 'irisexampleco' }],
    };
    await render([question], (bot) => opened.push(bot));
    await click(button('Show more', container));
    await click(button('Something else…', sheet()!));
    expect(sheet()).toBeNull();
    expect(opened).toEqual(['irisexampleco']);
  });
});

describe('where an unsigned post’s sheet opens', () => {
  it('opens at the steps from What to do, and at the top from Show more', async () => {
    await render([UNSIGNED]);
    await click(button('What to do', container));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('What to do');

    await click(button('Close', sheet()!));
    await click(button('Show more', container));
    expect(document.activeElement?.getAttribute('aria-label')).not.toBe('What to do');
    expect(sheet()!.contains(document.activeElement)).toBe(true);
  });

  it('has This was me once in the sheet, in step one', async () => {
    await render([UNSIGNED]);
    await click(button('What to do', container));
    const found = [...sheet()!.querySelectorAll('button')].filter((one) => one.textContent?.trim() === 'This was me');
    expect(found).toHaveLength(1);
    expect(found[0]!.closest('[aria-label="What to do"]')).not.toBeNull();
  });
});

const item = (id: string, kind: AttentionItem['kind'], group: 'work' | 'system', minutesAgo: number, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  kind,
  group,
  headline: `${kind} ${id}`,
  subject: { repo: null, number: null, title: null, ref: null, url: null },
  bot: null,
  since: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
  detail: 'Short.',
  actions: [],
  ...extra,
});

const MIXED: AttentionItem[] = [
  item('q-1', 'question', 'work', 2, { question: { gateId: 'g-1', options: ['yes', 'no'] } }),
  item('q-2', 'question', 'work', 30, { question: { gateId: 'g-2', options: ['left', 'right'] } }),
  item('t-1', 'task_failed', 'work', 50),
  item('c-1', 'check_failed', 'system', 1, { severity: 'blocking' }),
  item('c-2', 'check_failed', 'system', 5, { severity: 'warning' }),
  item('c-3', 'check_failed', 'system', 8, { severity: 'warning' }),
];

describe('the board’s strip of what needs you', () => {
  it('shows three at most, what stops work first and work before system, and links to all of them', async () => {
    await render(MIXED);
    const cards = [...container.querySelectorAll('article')].map((card) => card.getAttribute('data-card'));
    // Alarming first — the failed task, then the blocking check — then work before system.
    expect(cards).toEqual(['t-1', 'c-1', 'q-1']);
    const all = [...container.querySelectorAll('a')].find((link) => link.textContent?.includes('See all'));
    expect(all?.getAttribute('href')).toBe('/needs-you');
    expect(all?.textContent).toBe('See all 6 →');
    expect(container.textContent).toContain('3 work · 3 system');
  });
});

describe('the Needs-you page', () => {
  async function page(tab: 'work' | 'system'): Promise<void> {
    const header = headerData({ repos: [], crew: [], budget: null, needsYou: 6, attention: MIXED });
    await act(async () => root.render(<NeedsYouPage items={MIXED} crew={[]} header={header} now={NOW} tab={tab} />));
  }
  const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLElement[];
  const shown = () => [...document.querySelectorAll('[role="tabpanel"]:not([hidden]) article')].map((card) => card.getAttribute('data-card'));

  it('has a Work and a System tab, each with its count, and every item of the one showing', async () => {
    await page('work');
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Work 3', 'System 3']);
    expect(shown()).toEqual(['q-1', 'q-2', 't-1']);
  });

  it('switches to System, and opens on it from ?tab=system', async () => {
    await page('work');
    await act(async () => {
      tabs()[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    expect(shown()).toEqual(['c-1', 'c-2', 'c-3']);
    // Written back, so a reload or Back opens System again.
    expect(navigated.at(-1)).toBe('/needs-you?tab=system');

    // The page reads ?tab=system again; then a link to ?tab=work while here switches back.
    await page('system');
    await page('work');
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');

    await act(async () => root.unmount());
    root = createRoot(container);
    await page('system');
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(shown()).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('shows every question as its own card, none hidden', async () => {
    await page('work');
    const questions = shown().filter((id) => id?.startsWith('q-'));
    expect(questions).toEqual(['q-1', 'q-2']);
  });
});

describe('what a card opens', () => {
  const QUESTION: AttentionItem = {
    id: 'gate:g-1',
    kind: 'question',
    group: 'work',
    headline: 'The intake bot (ottoexampleco) has a question',
    // A request is no issue yet: no ref, and its item is how its own conversation is found.
    subject: { repo: 'api', number: null, title: 'A hello world page', ref: null, url: null, item: 'request:a4b02784' },
    bot: { name: 'ottoexampleco', slot: 'intake', role: 'intake', roleLabel: 'intake', githubLogin: 'ottoexampleco' },
    since: '2026-09-24T11:58:00.000Z',
    detail: 'Where should the page go?',
    actions: [{ kind: 'answer', label: 'Answer', bot: 'ottoexampleco' }],
    question: { gateId: 'g-1', options: [] },
  };

  it('opens a question about a piece of work as that work’s item, on the tab of the role that asked', async () => {
    // It opened the intake bot's panel, with every other request intake had
    // worked on beside it. Each request is its own conversation.
    const items: [string, string | null][] = [];
    const bots: string[] = [];
    await act(async () =>
      root.render(<NeedsYou items={[QUESTION]} now={NOW} onOpenBot={(bot) => bots.push(bot)} onOpenItem={(item, role) => items.push([item, role])} />),
    );
    await click(button('Answer', container));
    expect(items).toEqual([['request:a4b02784', 'intake']]);
    expect(bots).toEqual([]);
  });

  it('keeps a card about the install on the bot’s own panel', async () => {
    const items: string[] = [];
    const bots: string[] = [];
    const check: AttentionItem = {
      ...FAILED,
      id: 'health:sign-in',
      kind: 'check_failed',
      group: 'system',
      subject: { ...FAILED.subject, item: 'openadlc-testbed#2' },
      actions: [{ kind: 'open_thread', label: 'Open thread', bot: 'irisexampleco' }],
      raw: undefined,
      detail: 'Signed out.',
    };
    await act(async () => root.render(<NeedsYou items={[check]} now={NOW} onOpenBot={(bot) => bots.push(bot)} onOpenItem={(item) => items.push(item)} />));
    await click(button('Open thread', container));
    expect(bots).toEqual(['irisexampleco']);
    expect(items).toEqual([]);
  });
});

describe('a builder asking for more paths (#77)', () => {
  const ASKING: AttentionItem = {
    id: 'gate:g-1',
    kind: 'question',
    headline: 'The builder (atlas) has a question',
    subject: { repo: 'openadlc-testbed', number: 16, title: 'Let the board filter by label', ref: 'openadlc-testbed#16', url: null },
    bot: { name: 'atlas', slot: 'builder', role: 'implement', roleLabel: 'builder', githubLogin: 'atlas' },
    since: '2026-09-24T11:58:00.000Z',
    detail: 'Add `apps/hostd/src/x.ts` to this issue’s Expected paths?',
    question: { gateId: 'g-1', options: ['Approve', 'Refuse'] },
    actions: [
      { kind: 'approve_all', label: 'Approve, and any more paths for #16', gateId: 'g-1' },
      { kind: 'ask_designer', label: 'Ask the designer', gateId: 'g-1' },
      { kind: 'answer', label: 'Something else…', bot: 'atlas' },
      { kind: 'stop_task', label: 'Stop', taskId: 'task-b' },
      { kind: 'approve_all_off', label: 'Turn off approve all for #16', subject: 'openadlc-testbed#16' },
    ],
  };

  it('approves this and the rest of the work’s paths, or asks the designer, from the card', async () => {
    pressed.settled = [];
    await render([ASKING]);
    const card = container.querySelector('article')!;
    expect(button('Approve', card)).toBeTruthy();

    await click(button('Approve, and any more paths for #16', card));
    await click(button('Ask the designer', card));
    expect(pressed.settled).toEqual(['approve-all:g-1', 'designer:g-1']);
    // Neither is drawn as the one to press: the choices are.
    expect(button('Approve, and any more paths for #16', card).className).not.toContain('bg-body');
  });

  it('turns approve all off from its sheet', async () => {
    pressed.settled = [];
    await render([ASKING]);
    await click(button('Show more', container));
    await click(button('Turn off approve all for #16', sheet()!));
    expect(pressed.settled).toEqual(['off:openadlc-testbed#16']);
  });

  it('says what the bridge refused approve all with, on the card, when the builder cannot act', async () => {
    // The bridge's 409: the words to act on, said on the card the person pressed.
    const words = 'The builder is not connected to GitHub, so the Expected paths of openadlc-testbed#16 cannot be updated. Run: openadlc auth login --bot atlas';
    const { approveAll } = await import('@/app/actions');
    vi.mocked(approveAll).mockResolvedValueOnce({ ok: false, error: words });
    await render([ASKING]);
    const card = container.querySelector('article')!;

    await click(button('Approve, and any more paths for #16', card));

    expect([...card.querySelectorAll('[role="status"]')].map((line) => line.textContent)).toEqual([words]);
    // The question stays, to be answered once that is put right.
    expect(button('Approve', card).disabled).toBe(false);
  });
});
