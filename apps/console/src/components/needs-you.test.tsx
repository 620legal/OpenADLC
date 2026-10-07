import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import { adminOnly, keyOf, NeedsYou, Recoveries } from './needs-you';
import type { AttentionItem } from '@/lib/api';

/** What the card sent the gate-answer route. */
const answers = vi.hoisted(() => [] as { gateId: string; answer: string }[]);
/** What was run again, and what was dismissed. */
const pressed = vi.hoisted(() => ({ retried: [] as string[], stopped: [] as string[], dismissed: [] as string[] }));

vi.mock('@/app/actions', () => ({
  answerGate: vi.fn(async (gateId: string, answer: string) => {
    answers.push({ gateId, answer });
    return { ok: true };
  }),
  retryTriage: vi.fn(async () => ({ ok: true })),
  abandonRequest: vi.fn(async () => ({ ok: true })),
  retryTask: vi.fn(async (taskId: string) => {
    pressed.retried.push(taskId);
    return { ok: true };
  }),
  stopTask: vi.fn(async (taskId: string) => {
    pressed.stopped.push(taskId);
    return { ok: true };
  }),
  stopTasks: vi.fn(async (taskIds: string[]) => {
    pressed.stopped.push(...taskIds);
    return { ok: true };
  }),
  dismissTasks: vi.fn(async (tasks: { taskId: string; occurrence: string }[]) => {
    pressed.dismissed.push(...tasks.map((task) => `task:${task.taskId}@${task.occurrence}`));
    return { ok: true };
  }),
  dismissNotice: vi.fn(async (checkId: string) => {
    pressed.dismissed.push(checkId);
    return { ok: true };
  }),
  acknowledgeNotice: vi.fn(async (checkId: string, occurrence: string) => {
    pressed.dismissed.push(`${checkId}@${occurrence}`);
    return { ok: true };
  }),
  recheckHealth: vi.fn(async () => ({ ok: true })),
  decideUnowned: vi.fn(async () => ({ ok: true })),
}));

/**
 * The hooks as the plain functions a first drawing sees: the state each
 * starts with, and a transition that runs its work. Drawing to markup is
 * unchanged by them; they let a card be called as the function it is and its
 * buttons pressed, which the console has no browser in its tests to do.
 */
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
  useTransition: () => [false, (work: () => unknown) => void work()],
  useRef: (initial: unknown) => ({ current: initial }),
  // No provider above a card called as a function: the context's default, an admin.
  useContext: (context: { _currentValue: unknown }) => context._currentValue,
}));

beforeEach(() => {
  answers.length = 0;
  pressed.retried.length = 0;
  pressed.stopped.length = 0;
  pressed.dismissed.length = 0;
});

type Pressable = ReactElement<{ onClick?: () => void; children?: ReactNode }>;

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** Every button drawn, each component called for what it draws. */
function buttonsIn(node: ReactNode): Pressable[] {
  if (Array.isArray(node)) return node.flatMap(buttonsIn);
  if (!isValidElement(node)) return [];
  // A card's sheet is closed until Show more opens it; its buttons are
  // pressed in the DOM tests (needs-you-dom.test.tsx).
  if (node.type === Dialog) return [];
  if (typeof node.type === 'function') return buttonsIn((node.type as (props: object) => ReactNode)(node.props as object));
  const own = node.type === 'button' ? [node as Pressable] : [];
  return [...own, ...buttonsIn((node.props as { children?: ReactNode }).children)];
}

function press(buttons: Pressable[], label: string): void {
  const button = buttons.find((one) => textOf(one) === label);
  if (!button) throw new Error(`no button says ${label}: ${buttons.map(textOf).join(', ')}`);
  button.props.onClick?.();
}

const ITEM: AttentionItem = {
  id: 'gate:gate-3',
  kind: 'approval',
  headline: 'Ready to ship, waiting for your OK',
  subject: { repo: 'fleetadlc', number: 14, title: 'Add a health endpoint to the API', ref: 'fleetadlc#14', url: null },
  bot: { name: 'tessexampleco', slot: 'sre', role: 'deploy', roleLabel: 'SRE', githubLogin: 'tessexampleco' },
  since: '2026-09-24T11:46:00.000Z',
  detail: 'Promote 3f2a1b0c to production?',
  actions: [
    { kind: 'approve', label: 'Ship it', gateId: 'gate-3', answer: 'ship it' },
    { kind: 'open_thread', label: 'Review', bot: 'tessexampleco' },
    { kind: 'open_url', label: 'Pull request', url: 'https://github.com/janedoe/fleetadlc/pull/31' },
  ],
};

function needs(items: AttentionItem[]): string {
  return renderToStaticMarkup(<NeedsYou items={items} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} />).replace(
    /<!-- -->/g,
    '',
  );
}

describe('what needs you', () => {
  it('offers the first action on the card’s face, and the rest behind Show more', () => {
    const html = needs([ITEM]);
    expect(html).toContain('Ready to ship, waiting for your OK');
    expect(html).toContain('14 min ago');
    expect(html).toMatch(/<span class="text-dim">#14 <\/span>Add a health endpoint to the API/);
    expect(html).toMatch(/<button type="button" class="[^"]*bg-body[^"]*">Ship it<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Show more<\/button>/);
    // The others are in the sheet, which is closed.
    expect(html).not.toContain('>Review<');
    expect(html).not.toContain('Pull request');
  });

  it('asks an admin what to do about issues OpenADLC will not take on its own, with all three choices on the card', () => {
    // Filed by an old crew account with no access, they were skipped in silence.
    const UNOWNED: AttentionItem = {
      id: 'unowned:testbed',
      kind: 'unowned_issues',
      group: 'work',
      headline: 'testbed: 2 issues OpenADLC won’t take on its own',
      subject: { repo: 'testbed', number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: '#3 Add hello.mjs; #7 Add rub.html. Their authors (@outside-author) have no access to the repository.',
      actions: [
        { kind: 'unowned_intake', label: 'Send to intake', repo: 'testbed', numbers: [3, 7] },
        { kind: 'unowned_ignore', label: 'Ignore', repo: 'testbed', numbers: [3, 7] },
        { kind: 'unowned_close', label: 'Close', repo: 'testbed', numbers: [3, 7] },
      ],
    };
    const html = needs([UNOWNED]);
    expect(html).toContain('2 issues OpenADLC won’t take on its own');
    for (const label of ['Send to intake', 'Ignore', 'Close']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));

    // An admin's to press, as the bridge enforces: a user's card shows none of them.
    for (const action of UNOWNED.actions) expect(adminOnly(action)).toBe(true);
  });

  it('offers an admin both ways out of a promote held for a person, on the card', () => {
    const HELD: AttentionItem = {
      id: 'promote:testbed@abc1234def',
      kind: 'promote_held',
      group: 'work',
      headline: 'testbed@abc1234 waits for you to release it to production',
      subject: { repo: 'testbed', number: null, title: null, ref: null, url: 'https://github.com/janedoe/testbed/commit/abc1234def' },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: "GitHub's plan cannot hold a production reviewer here, so OpenADLC holds the promote until you release it.",
      actions: [
        { kind: 'promote_release', label: 'Release to production', repo: 'testbed', sha: 'abc1234def' },
        { kind: 'promote_automatic', label: 'Switch to automatic delivery', repo: 'testbed', sha: 'abc1234def' },
      ],
    };
    const html = needs([HELD]);
    for (const label of ['Release to production', 'Switch to automatic delivery']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
    // An admin's to press, as the bridge enforces: a user's card shows neither.
    for (const action of HELD.actions) expect(adminOnly(action)).toBe(true);
  });

  it('shows three on the board, and links to all of them', () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...ITEM, id: `gate:${n}` }));
    const html = needs(many);
    expect(html.match(/<article/g)).toHaveLength(3);
    expect(html).toMatch(/<a [^>]*href="\/needs-you"[^>]*>See all 5 →<\/a>/);
  });

  it('shows a weekly engine update that did not go in, with the way to it in settings', () => {
    const failed: AttentionItem = {
      id: 'engine-update',
      kind: 'engine_update_failed',
      headline: 'The engine update did not go in',
      subject: { repo: null, number: null, title: 'The bots are still on the engines they had', ref: null, url: null },
      bot: null,
      since: '2026-09-24T10:30:00.000Z',
      detail: 'The candidate image did not build.',
      actions: [{ kind: 'open_page', label: 'See the engine updates', href: '/settings#engine-updates' }],
    };
    const html = needs([failed]);
    expect(html).toMatch(/<article[^>]*class="[^"]*border-alarm/);
    expect(html).toContain('The bots are still on the engines they had');
    expect(html).toMatch(/<a class="[^"]*bg-body[^"]*" href="\/settings#engine-updates">See the engine updates<\/a>/);
    expect(html).not.toContain('target="_blank"');
  });

  it('says a design that superseded what a repository had decided, as a notice with the comment and Settings', () => {
    const superseded: AttentionItem = {
      id: 'design-memory:api#12:2026-09-24T10:30:00.000Z',
      kind: 'design_memory_superseded',
      group: 'work',
      headline: 'The design memory of api changed',
      subject: { repo: 'api', number: 12, title: 'Cost per round', ref: 'api#12', url: null },
      bot: null,
      since: '2026-09-24T10:30:00.000Z',
      detail: '“Log what helps” replaces “Never log credentials”. Nothing waits on this; revert it in Settings if it is wrong.',
      actions: [
        { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/acme/api/issues/12#issuecomment-9' },
        { kind: 'open_page', label: 'Design memory', href: '/settings/repositories/api#api-memory' },
      ],
    };
    const html = needs([superseded]);
    expect(html).toContain('The design memory of api changed');
    expect(html).toContain('href="https://github.com/acme/api/issues/12#issuecomment-9"');
    // Nothing is stopped by it, so it is not drawn as an alarm.
    expect(html).not.toMatch(/<article[^>]*class="[^"]*border-alarm/);
  });

  it('draws nothing at all when nothing is waiting', () => {
    expect(needs([])).toBe('');
  });
});

/**
 * One question at a time, offered as choices where it can be, always with room
 * to answer in your own words instead.
 */
describe('a question that needs you', () => {
  const QUESTION: AttentionItem = {
    id: 'gate:gate-7',
    kind: 'question',
    headline: 'ottoexampleco has a question',
    subject: { repo: 'fleetadlc-testbed', number: null, title: 'Create html hello world and a readme file.', ref: null, url: null },
    bot: { name: 'ottoexampleco', slot: 'intake', role: 'intake', roleLabel: 'intake', githubLogin: 'ottoexampleco' },
    since: '2026-09-24T11:58:00.000Z',
    detail: 'Where should the page go?',
    actions: [{ kind: 'answer', label: 'Something else…', bot: 'ottoexampleco' }],
    question: { gateId: 'gate-7', options: ['index.html at the repository root', 'A different path'] },
  };

  it('shows what it asks about — intake’s draft — on the card, before the question', () => {
    const html = needs([
      {
        ...QUESTION,
        detail: 'Here’s what I’ll file. OK?',
        question: { gateId: 'gate-7', options: ['OK, file it', 'Change something'] },
        context: 'Here is the issue I would file.\n\n**Title:** Add an ASCII banner to README.md',
      },
    ]);
    expect(html).toContain('data-clamp="context"');
    expect(html).toContain('Add an ASCII banner to README.md');
    expect(html.indexOf('Add an ASCII banner')).toBeLessThan(html.indexOf('Here’s what I’ll file. OK?'));
  });

  it('offers its choices to answer it from the card, and something else, with the question standing out', () => {
    const html = needs([QUESTION]);

    expect(html).toMatch(/<p data-clamp="detail" class="[^"]*line-clamp-2[^"]*font-semibold[^"]*">Where should the page go\?<\/p>/);
    expect([...html.matchAll(/<button type="button"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual([
      'index.html at the repository root',
      'A different path',
      'Something else…',
    ]);
    // The choices are what to press; nothing else on the card is set as the one to press.
    expect(html).not.toMatch(/<button[^>]*bg-body/);
    // Something else goes with the choices, set apart from them, not below them as one more.
    expect(html).toMatch(
      /<div role="group" aria-label="Choices"[^>]*>(?:<button type="button"[^>]*>[^<]+<\/button>){2}<button type="button" class="[^"]*border-dashed[^"]*">Something else…<\/button><\/div>/,
    );
  });

  it('answers with the choice pressed, through the gate-answer route, and says something else in the thread, ready to type', async () => {
    const opened: unknown[] = [];
    const buttons = buttonsIn(
      <NeedsYou items={[QUESTION]} now="2026-09-24T12:00:00.000Z" onOpenBot={(bot, how) => opened.push({ bot, ...how })} />,
    );

    press(buttons, 'A different path');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answers).toEqual([{ gateId: 'gate-7', answer: 'A different path' }]);
    expect(opened).toEqual([]);

    press(buttons, 'Something else…');
    expect(opened).toEqual([{ bot: 'ottoexampleco', compose: true }]);
    expect(answers).toHaveLength(1);
  });

  it('is answered in the thread, ready to type, when it is open and has no choices to offer', () => {
    const open: AttentionItem = {
      ...QUESTION,
      detail: 'What should the page say?',
      actions: [{ kind: 'answer', label: 'Answer', bot: 'ottoexampleco' }],
      question: { gateId: 'gate-7', options: [] },
    };
    const html = needs([open]);

    expect([...html.matchAll(/<button type="button"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1])).toEqual(['Answer']);
    expect(html).toMatch(/<button type="button" class="[^"]*bg-body[^"]*">Answer<\/button>/);

    const opened: unknown[] = [];
    press(buttonsIn(<NeedsYou items={[open]} now="2026-09-24T12:00:00.000Z" onOpenBot={(bot, how) => opened.push({ bot, ...how })} />), 'Answer');
    expect(opened).toEqual([{ bot: 'ottoexampleco', compose: true }]);
    expect(answers).toEqual([]);
  });
});

/**
 * A failed task's card says why in words with the thing to do, keeps what
 * arrived behind "Details", and runs the work again from Try again. A failing
 * health check is a card with its one button; something fixed is a line, said
 * once, that nobody is counted as waiting on.
 */
describe('a failed task and the health checks, on the board', () => {
  const FAILED: AttentionItem = {
    id: 'task:task-iris',
    kind: 'task_failed',
    headline: 'irisexampleco could not finish its review',
    subject: { repo: 'fleetadlc-testbed', number: 2, title: 'Add a health endpoint', ref: 'fleetadlc-testbed#2', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/2' },
    bot: { name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', roleLabel: 'second reviewer', githubLogin: 'irisexampleco' },
    since: '2026-09-24T11:48:00.000Z',
    detail: 'Grok — SuperGrok, the xAI subscription irisexampleco thinks with, is signed out. Sign it in again on the accounts step, then try again.',
    raw: 'hostd refused: POST http://127.0.0.1:47312/tasks → 500: { "error": "You are not authenticated" }',
    actions: [
      { kind: 'open_page', label: 'Sign in again', href: '/onboarding?step=accounts' },
      { kind: 'retry_task', label: 'Try again', taskId: 'task-iris' },
      { kind: 'stop_task', label: 'Stop', taskId: 'task-iris' },
      { kind: 'open_thread', label: 'Open thread', bot: 'irisexampleco' },
    ],
  };

  it('names the subject by its title, says what to do first, and keeps the rest for Show more', () => {
    const html = needs([FAILED]);
    expect(html).toMatch(/<span class="text-dim">#2 <\/span>Add a health endpoint/);
    expect(html).toMatch(/<a class="[^"]*bg-body[^"]*" href="\/onboarding\?step=accounts">Sign in again<\/a>/);
    expect(html).toMatch(/<p data-clamp="detail" class="[^"]*line-clamp-2/);
    expect(html).toContain('>Show more<');
    // The raw reason and the other buttons are in the sheet.
    expect(html).not.toContain('47312');
    expect(html).not.toContain('>Try again<');
  });

  it('shows a failing check red when it stops work and amber when it does not, with its one button', () => {
    const blocking: AttentionItem = {
      id: 'check:app-permissions:git_signing_ssh_public_keys',
      kind: 'check_failed',
      severity: 'blocking',
      headline: 'The OpenADLC app does not have “SSH signing keys”',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:30:00.000Z',
      detail: 'Add “SSH signing keys” on the app’s permissions page, under Account permissions, as Read and write.',
      actions: [{ kind: 'open_url', label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' }],
    };
    const warning: AttentionItem = { ...blocking, id: 'check:token-expiry', severity: 'warning', headline: 'The OpenADLC app’s user tokens never expire' };

    const html = needs([blocking, warning]);
    const cards = html.split('<article').slice(1);
    expect(cards[0]).toMatch(/^[^>]* class="[^"]*border-alarm/);
    expect(cards[1]).toMatch(/^[^>]* class="[^"]*border-attention/);
    expect(cards[0]).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/fleetadlc-janedoe\/permissions" target="_blank"[^>]*>Open the app’s permissions/);
  });

  it('hands over the command for what only a shell can do', () => {
    const hostd: AttentionItem = {
      id: 'check:hostd',
      kind: 'check_failed',
      severity: 'blocking',
      headline: 'OpenADLC’s host service is not answering',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:55:00.000Z',
      detail: 'Start OpenADLC again on the machine it runs on.',
      actions: [{ kind: 'run_command', label: 'Run fleetadlc up', command: 'fleetadlc up' }],
    };
    expect(needs([hostd])).toMatch(/<button type="button" title="click to copy"[^>]*><span[^>]*>fleetadlc up<\/span>/);
  });

  it('offers its fix on the card, and Check again in its sheet', () => {
    const permissions: AttentionItem = {
      id: 'check:app-permissions:deployments',
      kind: 'check_failed',
      severity: 'blocking',
      headline: 'The OpenADLC app does not have “Deployments”',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:55:00.000Z',
      detail: 'Add “Deployments” on the app’s permissions page.',
      actions: [
        { kind: 'open_url', label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
        { kind: 'recheck', label: 'Check again', checkId: 'app-permissions' },
      ],
    };
    const html = needs([permissions]);
    expect(html).toContain('Open the app’s permissions');
    expect(html).toContain('>Show more<');
    expect(html).not.toContain('>Check again<');
  });

  it('leaves what was fixed off the board, counted as nothing waiting, with the heading leading to where it is', async () => {
    const fixed: AttentionItem = {
      id: 'fixed:webhook',
      kind: 'check_fixed',
      headline: 'GitHub is delivering again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'webhook' }],
    };

    const alone = needs([fixed]);
    // On the Needs you page, behind the header's chip and this heading: a line
    // of it here, under nothing to do, read as one more thing.
    expect(alone).not.toContain('recovered in the last day');
    expect(alone).not.toContain('GitHub is delivering again');
    expect(alone).not.toContain('<article');
    expect(alone).toMatch(/text-attention">0<\/span>/);
    expect(alone).toContain('<a class="hover:underline" href="/needs-you">Needs you</a>');

    const withCard = needs([ITEM, fixed]);
    expect(withCard).toMatch(/text-attention">1<\/span>/);
  });

  it('clears every recovery on the board at once, grouped by the bot each is about', async () => {
    const { groupRecoveries, recoveryCheckIds } = await import('./needs-you');
    const forBuilder: AttentionItem = {
      id: 'fixed:bot-sign-in:bot-builder',
      kind: 'check_fixed',
      headline: 'fleetadlc-atlas-janedoe can sign in again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'Builder', githubLogin: 'fleetadlc-atlas-janedoe' },
      since: '2026-09-24T11:00:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'bot-sign-in:bot-builder' }],
    };
    const alsoForBuilder: AttentionItem = {
      ...forBuilder,
      id: 'fixed:bot-access:bot-builder',
      headline: 'fleetadlc-atlas-janedoe is in janedoe/fleetadlc-testbed',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'bot-access:bot-builder' }],
    };
    const noBot: AttentionItem = {
      id: 'fixed:webhook',
      kind: 'check_fixed',
      headline: 'GitHub is delivering again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'webhook' }],
    };

    const groups = groupRecoveries([forBuilder, alsoForBuilder, noBot]);
    expect(groups).toEqual([
      { name: 'fleetadlc-atlas-janedoe', items: [forBuilder, alsoForBuilder] },
      { name: 'OpenADLC', items: [noBot] },
    ]);
    expect(recoveryCheckIds([forBuilder, alsoForBuilder, noBot])).toEqual(['bot-sign-in:bot-builder', 'bot-access:bot-builder', 'webhook']);
  });

  it('clears a failed task whose work landed by its task, with the end the person saw', async () => {
    const { recoveryCheckIds, recoveryTasks } = await import('./needs-you');
    const landed: AttentionItem = {
      id: 'landed:task-rev',
      kind: 'check_fixed',
      headline: 'fleetadlc#193 landed or was closed, so the second reviewer no longer has to finish its review',
      subject: { repo: 'fleetadlc', number: 193, title: null, ref: 'fleetadlc#193', url: null },
      bot: null,
      since: '2026-09-24T11:00:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-rev', occurrence: '2026-09-24T11:00:00.000Z' }] }],
    };
    expect(recoveryCheckIds([landed])).toEqual([]);
    expect(recoveryTasks([landed])).toEqual([{ taskId: 'task-rev', occurrence: '2026-09-24T11:00:00.000Z' }]);
  });

  it('presses "Clear all" and dismisses every recovery on the board at once', async () => {
    const forBuilder: AttentionItem = {
      id: 'fixed:bot-sign-in:bot-builder',
      kind: 'check_fixed',
      headline: 'fleetadlc-atlas-janedoe can sign in again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: { name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'Builder', githubLogin: 'fleetadlc-atlas-janedoe' },
      since: '2026-09-24T11:00:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'bot-sign-in:bot-builder' }],
    };
    const webhook: AttentionItem = {
      id: 'fixed:webhook',
      kind: 'check_fixed',
      headline: 'GitHub is delivering again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'webhook' }],
    };

    // The harness's `useState` mock never toggles, so the list is opened by
    // passing `open`, the way a real click on "Show" would leave it.
    const buttons = buttonsIn(<Recoveries items={[forBuilder, webhook]} now="2026-09-24T12:00:00.000Z" open />);
    press(buttons, 'Clear all');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pressed.dismissed).toEqual(['bot-sign-in:bot-builder', 'webhook']);
  });

  it('says whether the recovered list is open, for anyone not reading it by eye', () => {
    const html = renderToStaticMarkup(<Recoveries items={[]} now="2026-09-24T12:00:00.000Z" />);
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('a notice with nothing to fix', () => {
  const UNSIGNED: AttentionItem = {
    id: 'check:unattributed-post',
    kind: 'check_failed',
    headline: 'A post by irisexampleco in janedoe/api is not signed by OpenADLC',
    subject: { repo: null, number: null, title: null, ref: null, url: null },
    bot: null,
    since: '2026-09-24T11:50:00.000Z',
    detail: 'The latest, a comment: it has no signature.',
    actions: [
      { kind: 'open_url', label: 'Open the post', url: 'https://github.com/janedoe/api/issues/3#issuecomment-1' },
      { kind: 'acknowledge', label: 'Dismiss', checkId: 'unattributed-post', occurrence: 'post:41' },
    ],
  };

  it('is dismissed for the occurrence it shows', async () => {
    pressed.dismissed.length = 0;
    press(buttonsIn(<NeedsYou items={[UNSIGNED]} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} />), 'Dismiss');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pressed.dismissed).toEqual(['unattributed-post@post:41']);
  });
});

describe('which button is running', () => {
  it('keys each request’s Abandon apart, so only the one pressed says Abandoning', () => {
    const one = keyOf({ kind: 'abandon_request', label: 'Abandon', requestId: 'a4b02784' });
    expect(one).toBe('abandon_request:a4b02784');
    expect(one).not.toBe(keyOf({ kind: 'abandon_request', label: 'Abandon', requestId: 'b5c13895' }));
    expect(adminOnly({ kind: 'abandon_request', label: 'Abandon', requestId: 'a4b02784' })).toBe(false);
  });

  it('is one Dismiss or Stop all, not every button of its kind', () => {
    const dismissOne = keyOf({ kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-iris', occurrence: 'a' }] });
    const dismissOther = keyOf({ kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-lead', occurrence: 'b' }] });
    expect(dismissOne).not.toBe(dismissOther);

    const stop = keyOf({ kind: 'stop_task', label: 'Stop', taskId: 'task-iris' });
    const stopAll = keyOf({ kind: 'stop_task', label: 'Stop all', taskId: 'task-iris', taskIds: ['task-iris', 'task-lead'] });
    expect(stop).toBe('stop_task:task-iris');
    expect(stopAll).not.toBe(stop);
  });
});
