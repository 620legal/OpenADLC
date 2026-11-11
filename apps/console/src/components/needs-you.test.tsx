import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import { adminOnly, HeldMergePanel, HeldPromotePanel, HumanReviewDecisionPanel, keyOf, NeedsYou, OthersWaitingList, Recoveries } from './needs-you';
import type { AttentionItem } from '@/lib/api';

/** What the card sent the gate-answer route. */
const answers = vi.hoisted(() => [] as { gateId: string; answer: string }[]);
/** What was run again, what was dismissed, and which signing keys were acted on. */
const pressed = vi.hoisted(() => ({ retried: [] as string[], stopped: [] as string[], dismissed: [] as string[], revoked: [] as string[] }));
/** What a held Human-review approval's buttons asked the bridge. */
const decided = vi.hoisted(() => [] as { what: string; subject: string; input: Record<string, unknown> }[]);

vi.mock('@/app/actions', () => ({
  approveHumanReview: vi.fn(async (subject: string, input: Record<string, unknown>) => {
    decided.push({ what: 'approve', subject, input });
    return { ok: true, flow: { flowId: 'f', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } };
  }),
  rejectHumanReview: vi.fn(async (subject: string, input: Record<string, unknown>) => {
    decided.push({ what: 'reject', subject, input });
    return { ok: true, sentBack: true };
  }),
  readReviewRequest: vi.fn(async () => ({ ok: false, error: 'not read in a test' })),
  remindHumanReview: vi.fn(async (subject: string, input: Record<string, unknown>) => {
    decided.push({ what: 'remind', subject, input });
    return { ok: true, reminded: { at: '2026-09-24T12:00:00.000Z', by: 'Ana' }, remindAfter: '2026-09-24T13:00:00.000Z' };
  }),
  sendItemMessage: vi.fn(async (subject: string, input: Record<string, unknown>) => {
    decided.push({ what: 'discuss', subject, input });
    return { ok: true };
  }),
  mergeHeld: vi.fn(async (subject: string, input: Record<string, unknown>) => {
    decided.push({ what: 'merge', subject, input });
    return { ok: true, flow: { flowId: 'f', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } };
  }),
  leaveAttention: vi.fn(async (id: string) => {
    decided.push({ what: 'leave', subject: id, input: {} });
    return { ok: true };
  }),
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
  dismissDesignMemoryNotice: vi.fn(async (repo: string, issue: number, occurrence: string) => {
    pressed.dismissed.push(`design-memory:${repo}#${issue}@${occurrence}`);
    return { ok: true };
  }),
  recheckHealth: vi.fn(async () => ({ ok: true })),
  decideUnowned: vi.fn(async () => ({ ok: true })),
  dismissSigningKey: vi.fn(async (login: string, keyId: number) => {
    pressed.dismissed.push(`key:${login}:${keyId}`);
    return { ok: true };
  }),
  undismissSigningKey: vi.fn(async (login: string, keyId: number) => {
    pressed.dismissed.push(`undo:${login}:${keyId}`);
    return { ok: true };
  }),
  revokeSigningKey: vi.fn(async (login: string, keyId: number) => {
    pressed.revoked.push(`${login}:${keyId}`);
    return { ok: true };
  }),
}));

/** Who the console says the viewer is: an admin, unless a test says otherwise. */
const role = vi.hoisted(() => ({ value: 'admin' as 'admin' | 'user' }));
vi.mock('@/components/app-header', async (original) => ({
  ...(await original<typeof import('./app-header')>()),
  useRole: () => role.value,
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
  // Called as a function there is no tree to number ids from.
  useId: () => ':id:',
  // Nothing runs after a first drawing: a sign-in's flow is read only in a browser.
  useEffect: () => undefined,
  // No provider above a card called as a function: the context's default, an admin.
  useContext: (context: { _currentValue: unknown }) => context._currentValue,
}));

/**
 * A card's pull panel, as its read answered: drawn to markup no effect runs,
 * so the real one stays loading and its buttons are never there to place.
 * The buttons are the panel's own (`PullActionsView`); only the read is not.
 */
const pullRead = vi.hoisted(() => ({ subjects: [] as string[] }));
vi.mock('@/components/pull-panel', async (original) => {
  const panel = await original<typeof import('./pull-panel')>();
  const command = { comment: '', reviewers: [] as string[], offered: true, state: 'ready' as const };
  const view = {
    repo: 'www',
    number: 46,
    url: 'https://github.com/620legal/www/pull/46',
    open: true,
    head: 'a'.repeat(40),
    checks: { 'visual-review': 'failure' },
    commands: [
      { ...command, name: 'approve-pages', label: 'Approve pages', by: 'reviewer', unblocks: 'visual-review' },
      { ...command, name: 'preview', label: 'Preview', by: 'anyone', unblocks: null },
    ],
    outputs: [],
    errors: [],
  } as import('@/lib/api').PullView;
  return {
    ...panel,
    PullActions: ({ subject }: { subject: string }) => {
      pullRead.subjects.push(subject);
      return <panel.PullActionsView view={view} pending={null} onPress={() => undefined} />;
    },
  };
});

beforeEach(() => {
  pullRead.subjects.length = 0;
  answers.length = 0;
  pressed.retried.length = 0;
  pressed.stopped.length = 0;
  pressed.dismissed.length = 0;
  pressed.revoked.length = 0;
  decided.length = 0;
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
  subject: { repo: 'openadlc', number: 14, title: 'Add a health endpoint to the API', ref: 'openadlc#14', url: null },
  bot: { name: 'tessexampleco', slot: 'sre', role: 'deploy', roleLabel: 'SRE', githubLogin: 'tessexampleco' },
  since: '2026-09-24T11:46:00.000Z',
  detail: 'Promote 3f2a1b0c to production?',
  actions: [
    { kind: 'approve', label: 'Ship it', gateId: 'gate-3', answer: 'ship it' },
    { kind: 'open_thread', label: 'Review', bot: 'tessexampleco' },
    { kind: 'open_url', label: 'Pull request', url: 'https://github.com/janedoe/openadlc/pull/31' },
  ],
};

/** A design memory supersede's card, as the bridge draws it. */
const SUPERSEDED: AttentionItem = {
  id: 'design-memory:api#12:2026-09-24T10:30:00.000Z',
  kind: 'design_memory_superseded',
  group: 'system',
  headline: 'The design memory of api changed',
  subject: { repo: 'api', number: 12, title: 'Cost per round', ref: 'api#12', url: null },
  bot: null,
  since: '2026-09-24T10:30:00.000Z',
  detail: '“Never log credentials” was replaced by “Log what helps”, unopposed at the move to build. Nothing waits on this; revert it in Settings if it is wrong.',
  actions: [
    { kind: 'dismiss_notice', label: 'Dismiss', notice: 'design-memory:api#12', repo: 'api', issue: 12, occurrence: '2026-09-24T10:30:00.000Z' },
    { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/acme/api/issues/12#issuecomment-9' },
    { kind: 'open_page', label: 'Design memory', href: '/settings/repositories/api#api-memory' },
  ],
};

/** Waiting on others, which the board's strip leaves out, drawn on its own. */
function others(items: AttentionItem[]): string {
  return renderToStaticMarkup(<OthersWaitingList items={items} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} />).replace(/<!-- -->/g, '');
}

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

  it('puts a held pull request’s declared commands before "Merge it on GitHub", and only where its repository declares them', () => {
    // 620legal/OpenADLC#207: the card offered only the merge, which skipped
    // the page sign-off the red visual-review waited for.
    const MERGE: AttentionItem = {
      id: 'merge:www#46',
      kind: 'merge_waiting',
      group: 'work',
      headline: 'Pull request #46 waits for you to merge it',
      subject: { repo: 'www', number: 12, title: 'New pricing page', ref: 'www#12', url: 'https://github.com/620legal/www/pull/46' },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'ci and review-gate passed, but OpenADLC did not merge it, because visual-review failed on the head.',
      actions: [{ kind: 'open_url', label: 'Merge it on GitHub', url: 'https://github.com/620legal/www/pull/46' }],
    };
    const declared = needs([{ ...MERGE, pull: { repo: 'www', number: 46 } }]);
    // The card reads the pull it is about, not its item's.
    expect(pullRead.subjects).toEqual(['www#46']);
    const approve = declared.indexOf('data-pull-command="approve-pages"');
    const preview = declared.indexOf('data-pull-command="preview"');
    expect(approve).toBeGreaterThan(-1);
    expect(approve).toBeLessThan(preview);
    expect(preview).toBeLessThan(declared.indexOf('Merge it on GitHub'));

    const plain = needs([MERGE]);
    expect(plain).not.toContain('data-pull-actions');
    expect(plain).toContain('Merge it on GitHub');
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

  it('offers Revoke and Dismiss for a signing key OpenADLC did not register, admins only, the other keys behind Show more', async () => {
    const KEYS: AttentionItem = {
      id: 'check:signing-key:account:openadlc-vega-janedoe',
      kind: 'check_failed',
      severity: 'warning',
      headline: 'openadlc-vega-janedoe has 2 signing keys OpenADLC did not register',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'GitHub lists keys on openadlc-vega-janedoe that are no seat’s (laptop, id 6; id 8).',
      actions: [
        { kind: 'signing_key_revoke', label: 'Revoke key 6', login: 'openadlc-vega-janedoe', keyId: 6, title: 'laptop' },
        { kind: 'signing_key_dismiss', label: 'Key 6 is used elsewhere', login: 'openadlc-vega-janedoe', keyId: 6, title: 'laptop' },
        { kind: 'signing_key_revoke', label: 'Revoke key 8', login: 'openadlc-vega-janedoe', keyId: 8, title: null },
        { kind: 'signing_key_dismiss', label: 'Key 8 is used elsewhere', login: 'openadlc-vega-janedoe', keyId: 8, title: null },
        { kind: 'signing_key_undo', label: 'Count key 4 again', login: 'openadlc-vega-janedoe', keyId: 4, title: null },
        { kind: 'open_url', label: 'Open the account’s keys', url: 'https://github.com/settings/keys' },
        { kind: 'recheck', label: 'Check again', checkId: 'signing-key' },
      ],
    };
    const html = needs([KEYS]);
    for (const label of ['Revoke key 6', 'Key 6 is used elsewhere']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
    // The second key's buttons and the undo wait in the sheet.
    expect(html).not.toContain('Revoke key 8');
    expect(html).toContain('Show more');
    // An admin's to press, as the bridge enforces; and each key's button runs apart from the next key's.
    for (const action of KEYS.actions.filter((one) => one.kind.startsWith('signing_key'))) expect(adminOnly(action)).toBe(true);
    expect(keyOf(KEYS.actions[1]!)).not.toBe(keyOf(KEYS.actions[3]!));

    // Dismiss asks nothing further; Revoke confirms first, in the DOM tests.
    press(buttonsIn(<NeedsYou items={[KEYS]} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} />), 'Key 6 is used elsewhere');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pressed.dismissed).toEqual(['key:openadlc-vega-janedoe:6']);
    expect(pressed.revoked).toEqual([]);
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

  it('says a design that superseded what a repository had decided, as a notice with Dismiss, the comment and Settings', () => {
    const html = needs([SUPERSEDED]);
    expect(html).toContain('The design memory of api changed');
    expect(html).toContain('href="https://github.com/acme/api/issues/12#issuecomment-9"');
    expect(html).toMatch(/<button[^>]*>Dismiss<\/button>/);
    // Nothing is stopped by it, so it is not drawn as an alarm.
    expect(html).not.toMatch(/<article[^>]*class="[^"]*border-alarm/);
  });

  it('dismisses a supersede’s card by its repository, issue and the event it shows, for anyone signed in', async () => {
    press(buttonsIn(<NeedsYou items={[SUPERSEDED]} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} />), 'Dismiss');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pressed.dismissed).toEqual(['design-memory:api#12@2026-09-24T10:30:00.000Z']);
    // The bridge lets a user dismiss it, as it does the bridge gap's report.
    expect(adminOnly(SUPERSEDED.actions[0]!)).toBe(false);
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
    subject: { repo: 'openadlc-testbed', number: null, title: 'Create html hello world and a readme file.', ref: null, url: null },
    bot: { name: 'ottoexampleco', slot: 'intake', role: 'intake', roleLabel: 'intake', githubLogin: 'ottoexampleco' },
    since: '2026-09-24T11:58:00.000Z',
    detail: 'Where should the page go?',
    actions: [{ kind: 'answer', label: 'Something else…', bot: 'ottoexampleco' }],
    question: { gateId: 'gate-7', options: ['index.html at the repository root', 'A different path'] },
  };

  it('says whom it is for under the headline, and why when it fell back to everyone', () => {
    const legal = needs([{ ...QUESTION, audience: { for: 'role', name: 'Legal', people: ['p-a'] } }]);
    expect(legal).toMatch(/<p data-audience[^>]*>For Legal<\/p>/);
    const everyone = needs([{ ...QUESTION, audience: { for: 'everyone', name: 'everyone', people: [], why: 'no one holds Legal yet' } }]);
    expect(everyone).toContain('For everyone: no one holds Legal yet');
    // A local install's items carry no audience, and say nothing of one.
    expect(needs([QUESTION])).not.toContain('data-audience');
  });

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

  it('says what is being decided above the question, and what each choice leads to under it', () => {
    const html = needs([
      {
        ...QUESTION,
        question: {
          gateId: 'gate-7',
          options: ['index.html at the repository root', 'A different path'],
          decision: 'Where the site is served from, which the deploy reads.',
          consequences: ['The page is served at /', ''],
        },
      },
    ]);
    expect(html).toMatch(/<p data-decision[^>]*>Where the site is served from, which the deploy reads\.<\/p>/);
    expect(html.indexOf('data-decision')).toBeLessThan(html.indexOf('data-clamp="detail"'));
    // Under its own choice, and none under a choice the bot said nothing about.
    expect(html).toMatch(/<span>index\.html at the repository root<\/span><span data-consequence[^>]*>The page is served at \/<\/span>/);
    expect(html).toMatch(/<button type="button"[^>]*>A different path<\/button>/);
    expect(html.match(/data-consequence/g)).toHaveLength(1);
  });

  it('is drawn exactly as before without them, or with consequences that do not pair with its choices', () => {
    const before = needs([QUESTION]);
    expect(before).not.toContain('data-decision');
    expect(before).not.toContain('data-consequence');
    expect(needs([{ ...QUESTION, question: { ...QUESTION.question!, decision: '', consequences: ['only one'] } }])).toBe(before);
  });

  it('answers with the choice’s own words, never its consequence', async () => {
    const buttons = buttonsIn(
      <NeedsYou
        items={[{ ...QUESTION, question: { ...QUESTION.question!, consequences: ['Served at /', 'Served elsewhere'] } }]}
        now="2026-09-24T12:00:00.000Z"
        onOpenBot={() => undefined}
      />,
    );
    press(buttons, 'A different pathServed elsewhere');
    await vi.waitFor(() => expect(answers).toEqual([{ gateId: 'gate-7', answer: 'A different path' }]));
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
    subject: { repo: 'openadlc-testbed', number: 2, title: 'Add a health endpoint', ref: 'openadlc-testbed#2', url: 'https://github.com/janedoe/openadlc-testbed/pull/2' },
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
      actions: [{ kind: 'open_url', label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/openadlc-janedoe/permissions' }],
    };
    const warning: AttentionItem = { ...blocking, id: 'check:token-expiry', severity: 'warning', headline: 'The OpenADLC app’s user tokens never expire' };

    const html = needs([blocking, warning]);
    const cards = html.split('<article').slice(1);
    expect(cards[0]).toMatch(/^[^>]* class="[^"]*border-alarm/);
    expect(cards[1]).toMatch(/^[^>]* class="[^"]*border-attention/);
    expect(cards[0]).toMatch(/<a href="https:\/\/github.com\/settings\/apps\/openadlc-janedoe\/permissions" target="_blank"[^>]*>Open the app’s permissions/);
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
      actions: [{ kind: 'run_command', label: 'Run openadlc up', command: 'openadlc up' }],
    };
    expect(needs([hostd])).toMatch(/<button type="button" title="click to copy"[^>]*><span[^>]*>openadlc up<\/span>/);
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
        { kind: 'open_url', label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/openadlc-janedoe/permissions' },
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
      headline: 'openadlc-atlas-janedoe can sign in again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: { name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'Builder', githubLogin: 'openadlc-atlas-janedoe' },
      since: '2026-09-24T11:00:00.000Z',
      detail: '',
      actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'bot-sign-in:bot-builder' }],
    };
    const alsoForBuilder: AttentionItem = {
      ...forBuilder,
      id: 'fixed:bot-access:bot-builder',
      headline: 'openadlc-atlas-janedoe is in janedoe/openadlc-testbed',
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
      { name: 'openadlc-atlas-janedoe', items: [forBuilder, alsoForBuilder] },
      { name: 'OpenADLC', items: [noBot] },
    ]);
    expect(recoveryCheckIds([forBuilder, alsoForBuilder, noBot])).toEqual(['bot-sign-in:bot-builder', 'bot-access:bot-builder', 'webhook']);
  });

  it('clears a failed task whose work landed by its task, with the end the person saw', async () => {
    const { recoveryCheckIds, recoveryTasks } = await import('./needs-you');
    const landed: AttentionItem = {
      id: 'landed:task-rev',
      kind: 'check_fixed',
      headline: 'openadlc#193 landed or was closed, so the second reviewer no longer has to finish its review',
      subject: { repo: 'openadlc', number: 193, title: null, ref: 'openadlc#193', url: null },
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
      headline: 'openadlc-atlas-janedoe can sign in again',
      subject: { repo: null, number: null, title: null, ref: null, url: null },
      bot: { name: 'openadlc-atlas-janedoe', slot: 'builder', role: 'implement', roleLabel: 'Builder', githubLogin: 'openadlc-atlas-janedoe' },
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

/**
 * The root of a wait says what doing it lets go on: on 2026-10-30 four cards
 * waited behind #206's approval, and its card said nothing of them.
 */
describe('what an item unblocks', () => {
  const ROOT: AttentionItem = {
    id: 'approval:openadlc#213@orzelig',
    kind: 'merge_waiting',
    headline: "Pull request #213 waits for @orzelig's approval",
    subject: { repo: 'openadlc', number: 206, title: 'Stack the base', ref: 'openadlc#206', url: null, item: 'openadlc#206' },
    bot: null,
    since: '2026-09-24T11:00:00.000Z',
    detail: 'The lead approved abc1234.',
    actions: [{ kind: 'open_url', label: 'Review it on GitHub', url: 'https://github.com/janedoe/openadlc/pull/213/files' }],
    unblocks: {
      count: 4,
      items: [207, 217, 216, 214].map((number) => ({ ref: `openadlc#${number}`, repo: 'openadlc', number, title: `Issue ${number}` })),
    },
  };

  it('lists the cards waiting behind it, each opening its card', () => {
    const html = needs([ROOT]);
    expect(html).toContain('data-unblocks');
    expect(html.replace(/<[^>]+>/g, '')).toContain('4 items wait on this: #207, #217, #216, #214.');
    expect(html).toContain('href="/?item=openadlc%23207"');

    const opened: string[] = [];
    const buttons = buttonsIn(<NeedsYou items={[ROOT]} now="2026-09-24T12:00:00.000Z" onOpenBot={() => undefined} onOpenItem={(item) => opened.push(item)} />);
    press(buttons, '#216');
    expect(opened).toEqual(['openadlc#216']);
  });

  it('says nothing of it when nothing waits behind it', () => {
    const { unblocks: _none, ...alone } = ROOT;
    expect(needs([alone])).not.toContain('data-unblocks');
  });
});

/**
 * A held Human-review approval, decided from its card (#254): what the change
 * does, why the person is asked, what the reviewers found and a link to the
 * diff, and Approve, Reject and Discuss with what each does next.
 */
describe('a held Human-review approval', () => {
  const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
  const decision = {
    repo: 'openadlc',
    pr: 40,
    head: HEAD,
    login: 'janedoe',
    change: 'Limit each client to 60 requests a minute.',
    why: "The lead approved 692cd1f. It changes `infra/`, which AGENTS.md's Human review names @janedoe for, so OpenADLC does not merge it until @janedoe approves it.",
    reviews: [{ login: 'reviewer-bot', seat: 'lead-reviewer', state: 'approved', summary: 'The limit is per client.', url: 'https://github.com/janedoe/openadlc/pull/40#pullrequestreview-5' }],
    prUrl: 'https://github.com/janedoe/openadlc/pull/40',
    diffUrl: 'https://github.com/janedoe/openadlc/pull/40/files',
    next: {
      approve: 'Posts your approval of 692cd1f on GitHub as @janedoe, after you approve a one-time code. OpenADLC merges it once CI passes.',
      reject: 'Sends it back to the builder with your reason. The lead reviews the fix, and you are asked again.',
      discuss: 'Sends your message to the lead reviewer, or the builder, who answers on the pull request. The decision stays open.',
    },
  };
  const HELD = (over: Partial<typeof decision> & { yours?: boolean; notYours?: string; settingsUrl?: string } = {}): AttentionItem => ({
    id: 'approval:openadlc#40@janedoe',
    kind: 'merge_waiting',
    headline: "Pull request #40 waits for @janedoe's approval",
    subject: { repo: 'openadlc', number: 39, title: 'Rate-limit', ref: 'openadlc#39', url: null, item: 'openadlc#39' },
    bot: null,
    since: '2026-09-24T11:00:00.000Z',
    detail: 'The lead approved 692cd1f.',
    actions: [
      { kind: 'human_review_approve', label: 'Approve', subject: 'openadlc#40', login: 'janedoe', head: HEAD },
      { kind: 'human_review_reject', label: 'Reject', subject: 'openadlc#40', login: 'janedoe', head: HEAD },
      { kind: 'human_review_discuss', label: 'Discuss', subject: 'openadlc#40', login: 'janedoe', head: HEAD },
      { kind: 'open_url', label: 'Review it on GitHub', url: 'https://github.com/janedoe/openadlc/pull/40/files' },
    ],
    awaiting: { login: 'janedoe', again: false, paths: ['infra/'] },
    decision: { ...decision, ...over },
  });
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

  it('describes the decision: what it does, why you, what the reviewers found, the diff, and what each button does next', () => {
    const html = needs([HELD({ yours: true })]);
    const text = words(html);
    expect(text).toContain('What it does: Limit each client to 60 requests a minute.');
    expect(text).toContain("Why you are asked: The lead approved 692cd1f. It changes infra/ , which AGENTS.md's Human review names @janedoe for");
    expect(text).toContain('lead-reviewer approved');
    expect(text).toContain('The limit is per client.');
    expect(html).toContain('href="https://github.com/janedoe/openadlc/pull/40/files"');
    expect(text).toContain(decision.next.approve);
    expect(text).toContain(decision.next.reject);
    // Discuss says one line beside it; what it does in full opens with its box.
    expect(text).toContain('Discuss Ask the lead reviewer or the builder.');
    expect(text).not.toContain(decision.next.discuss);
    expect([...html.matchAll(/data-decide="(\w+)"/g)].map((match) => match[1])).toEqual(['approve', 'reject', 'discuss']);
  });

  it('leads with the item’s title and says whose approval it waits for under it, the headline left to pushes (#308)', () => {
    const text = words(needs([HELD({ yours: true })]));
    expect(text).toContain('#39 Rate-limit Waits for your approval');
    expect(text).not.toContain("Pull request #40 waits for @janedoe's approval");
    expect(words(others([HELD({ yours: false, waitsOnOther: true } as never)]))).toContain("openadlc#39 Rate-limit Waits for @janedoe's approval");
  });

  it('says Why it waits on someone else’s card, names the person once, and drops the line that said whose it is', () => {
    const html = others([
      HELD({
        yours: false,
        waitsOnOther: true,
        whyWaits: 'The lead approved 692cd1f. It changes `infra/`, so OpenADLC does not merge it until they approve it.',
        notYours: "This is @janedoe's to decide; you can Discuss it.",
      } as never),
    ]);
    const text = words(html);
    expect(text).toContain('Why it waits: The lead approved 692cd1f.');
    expect(text).not.toContain('Why you are asked');
    expect(text).not.toContain("This is @janedoe's to decide");
    // An older bridge sends no whyWaits: its why, under the same lead.
    expect(words(others([HELD({ yours: false, waitsOnOther: true } as never)]))).toContain(
      "Why it waits: The lead approved 692cd1f. It changes infra/ , which AGENTS.md's Human review names @janedoe",
    );
  });

  it('opens Discuss’s box with what it does in full', () => {
    const html = words(renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: true })} initialStep={{ kind: 'discuss', text: '', role: 'review_lead' }} />));
    expect(html).toContain(decision.next.discuss);
  });

  // A review's summary is its markdown: on the card it showed `**`, `##` and backticks, and the why its backticks (#306).
  it('shows a review’s markdown as formatted words in three lines, and the why’s path as code', () => {
    const review = { ...decision.reviews[0]!, summary: '## Verdict\n**Approve.** The fix in `cap.ts` holds.\n- one\n- two' };
    const html = renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: true, reviews: [review], why: 'It changes `content/x.md`, so @janedoe decides.' })} />);
    const reviewHtml = /<li data-review="true">([\s\S]*?)<\/li>/.exec(html)![1]!;
    const said = words(reviewHtml);
    for (const word of ['Verdict', 'Approve.', 'cap.ts', 'one', 'two']) expect(said).toContain(word);
    expect(said).not.toMatch(/[*#`]/);
    expect(reviewHtml).not.toMatch(/<(?:ul|li|p|h\d)\b/);
    expect(reviewHtml).toMatch(/<code [^>]*>cap\.ts<\/code>/);
    expect(reviewHtml).toMatch(/<span data-summary="true" class="[^"]*line-clamp-3/);

    const why = /<p data-why="[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1]!;
    expect(why).toMatch(/<code [^>]*>content\/x\.md<\/code>/);
    expect(why).not.toContain('`');
  });

  it('gives anyone else Discuss alone, and says whose it is', () => {
    const html = needs([HELD({ yours: false, notYours: "This is @janedoe's to decide; you can Discuss it." })]);
    expect([...html.matchAll(/data-decide="(\w+)"/g)].map((match) => match[1])).toEqual(['discuss']);
    expect(words(html)).toContain("This is @janedoe's to decide; you can Discuss it.");
    // A bridge that does not say whose it is: not yours.
    expect([...needs([HELD()]).matchAll(/data-decide="(\w+)"/g)].map((match) => match[1])).toEqual(['discuss']);
  });

  it('points a person with no linked account to where to link it', () => {
    const html = needs([HELD({ yours: false, notYours: 'You have not linked a GitHub account. Link it in Settings → Your GitHub account.', settingsUrl: '/settings#your-github' })]);
    expect(html).toContain('href="/settings#your-github"');
    expect(words(html)).toContain('Link your GitHub account');
  });

  it('links to the reviews on GitHub when none were recorded with the wait', () => {
    const html = needs([HELD({ yours: true, reviews: null as never })]);
    expect(words(html)).toContain('Read the reviews on GitHub');
  });

  it('asks the bridge to approve the head shown, as the person it waits on', () => {
    press(buttonsIn(<HumanReviewDecisionPanel item={HELD({ yours: true })} />), `Approve${decision.next.approve}`);
    expect(decided).toEqual([{ what: 'approve', subject: 'openadlc#40', input: { head: HEAD, login: 'janedoe' } }]);
  });

  it('holds Send it back until the reason has text', () => {
    const empty = renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: true })} initialStep={{ kind: 'reject', reason: '  ' }} />);
    expect(empty).toMatch(/<button type="submit" disabled=""[^>]*>Send it back<\/button>/);
    const written = renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: true })} initialStep={{ kind: 'reject', reason: 'Keep the old timeout.' }} />);
    expect(written).not.toMatch(/disabled=""[^>]*>Send it back/);
  });

  it('addresses Discuss to the lead reviewer by default, with the builder to pick', () => {
    const html = renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: false })} initialStep={{ kind: 'discuss', text: '', role: 'review_lead' }} />);
    expect(html).toContain('<option value="review_lead" selected="">the lead reviewer</option>');
    expect(html).toContain('<option value="implement">the builder</option>');
  });

  it('keeps the decision buttons off the generic row: only the way to GitHub is beside them', () => {
    const html = needs([HELD({ yours: true })]);
    expect(html.match(/Review it on GitHub/g)).toHaveLength(1);
    expect(html).not.toContain('data-clamp="detail"');
  });

  describe('for a login People does not have (#307)', () => {
    const MISSING = (): AttentionItem => ({ ...HELD({ yours: false }), audience: { for: 'approvers', name: 'admins and approvers', people: ['p-ada'], notInPeople: 'janedoe', admins: ['p-ada'] } });
    const NOW = '2026-09-24T12:00:00.000Z';
    const at = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();

    it('says why it came to the admins and approvers, and takes an admin to Settings → People', () => {
      const html = needs([MISSING()]);
      expect(words(html)).toContain('@janedoe is not in People, so this came to the admins and approvers.');
      expect(html).toContain('href="/settings#people"');
      expect(words(html)).toContain('Add @janedoe in Settings → People');
    });

    it('gives anyone who is not an admin the sentence alone', () => {
      role.value = 'user';
      try {
        const html = needs([MISSING()]);
        expect(words(html)).toContain('@janedoe is not in People, so this came to the admins and approvers.');
        expect(html).not.toContain('href="/settings#people"');
      } finally {
        role.value = 'admin';
      }
    });

    it('says whether GitHub has asked the person, and since when, as the card read it', () => {
      const view = { login: 'janedoe', request: { state: 'requested' as const, since: at(180) }, reminded: null, remindAfter: null };
      const html = words(renderToStaticMarkup(<HumanReviewDecisionPanel item={MISSING()} now={NOW} initialRequest={{ kind: 'read', view }} />));
      expect(html).toContain('GitHub asked @janedoe to review 3 h ago.');
      const none = words(renderToStaticMarkup(<HumanReviewDecisionPanel item={MISSING()} now={NOW} initialRequest={{ kind: 'read', view: { ...view, request: { state: 'none' } } }} />));
      expect(none).toContain('GitHub has no review request out to @janedoe.');
    });

    it('offers Remind to anyone but the person, and asks the bridge to remind the login', () => {
      press(buttonsIn(<HumanReviewDecisionPanel item={MISSING()} now={NOW} />), 'Remind @janedoe');
      expect(decided).toEqual([{ what: 'remind', subject: 'openadlc#40', input: { login: 'janedoe' } }]);
      const theirs = renderToStaticMarkup(<HumanReviewDecisionPanel item={HELD({ yours: true })} now={NOW} />);
      expect(theirs).not.toContain('data-remind-button');
    });

    it('says who reminded them and when, and holds Remind off until the hour is up', () => {
      const view = { login: 'janedoe', request: { state: 'requested' as const, since: at(5) }, reminded: { at: at(5), by: 'Ana' }, remindAfter: at(-55) };
      const html = renderToStaticMarkup(<HumanReviewDecisionPanel item={MISSING()} now={NOW} initialRequest={{ kind: 'read', view }} />);
      expect(words(html)).toContain('Reminded 5 min ago by Ana.');
      expect(html).toMatch(/<button type="button" data-remind-button="true" disabled=""[^>]*>Remind @janedoe<\/button>/);
      expect(words(html)).toContain('You can remind them again at');
      expect(words(html)).toContain('in 55 min.');
      const open = renderToStaticMarkup(<HumanReviewDecisionPanel item={MISSING()} now={NOW} initialRequest={{ kind: 'read', view: { ...view, reminded: { at: at(70), by: 'Ana' }, remindAfter: null } }} />);
      expect(open).not.toMatch(/data-remind-button="true" disabled=""/);
    });

    describe('an admin’s, who can add the person (ADR 0059)', () => {
      const AUDIENCE = { for: 'approvers' as const, name: 'admins and approvers', people: ['p-ada', 'p-bo'], notInPeople: 'janedoe', admins: ['p-ada'] };
      const ADMINS = (): AttentionItem => ({
        ...HELD({ yours: false, addToPeople: true, whyWaits: 'The lead approved 692cd1f. It changes `infra/`, so OpenADLC does not merge it until they approve it.' } as never),
        audience: AUDIENCE,
      });
      const APPROVERS = (): AttentionItem => ({
        ...HELD({ yours: false, waitsOnOther: true, notYours: "This is @janedoe's to decide; you can Discuss it." } as never),
        audience: AUDIENCE,
      });

      it('leads with a link to Settings → People, ahead of Remind and Discuss, and says it once', () => {
        const html = needs([ADMINS()]);
        const first = /<a [^>]*data-add-person-button="true"[^>]*>([^<]*)<\/a>/.exec(html);
        expect(first?.[0]).toContain('href="/settings#people"');
        expect(first?.[1]).toBe('Add @janedoe to People so this goes to them');
        const at = (mark: string) => html.indexOf(mark);
        expect(at('data-add-person-button')).toBeLessThan(at('data-remind-button'));
        expect(at('data-remind-button')).toBeLessThan(at('data-decide="discuss"'));
        // The audience line's own link would say it a second time.
        expect(html).not.toContain('data-add-person="true"');
        expect(words(html)).toContain('@janedoe is not in People, so this came to the admins and approvers.');
        expect(words(html)).toContain('Why it waits: The lead approved 692cd1f.');
        expect(html).not.toContain('data-not-yours');
      });

      it('is under Work and counted for the admin, and under Waiting on others, not counted, for an approver', async () => {
        const { waitingCount } = await import('@/lib/api');
        expect(needs([ADMINS()])).toContain('data-add-person-button');
        expect(others([ADMINS()])).toBe('');
        expect(waitingCount([ADMINS()])).toBe(1);

        expect(words(others([APPROVERS()]))).toContain("Waiting on others Decisions that are someone else's.");
        expect(others([APPROVERS()])).not.toContain('data-add-person-button');
        expect(waitingCount([APPROVERS()])).toBe(0);
      });

      it('keeps the button in the sheet, which draws the same panel', () => {
        const html = renderToStaticMarkup(<HumanReviewDecisionPanel item={ADMINS()} now={NOW} full />);
        expect(html).toContain('data-add-person-button');
      });
    });

    it('draws no Remind on a bridge from before it, which has no route for it', () => {
      const html = renderToStaticMarkup(<HumanReviewDecisionPanel item={MISSING()} now={NOW} initialRequest={{ kind: 'failed', why: 'not found', older: true }} />);
      expect(html).not.toContain('data-remind-button');
      expect(words(html)).toContain('OpenADLC could not read whether GitHub asked @janedoe: not found.');
    });
  });
});

describe('a held merge, decided from the card (ADR 0037)', () => {
  const HEAD = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';
  const next = {
    merge: "Merges 692cd1f into main on GitHub as you (@janedoe), after you approve a one-time code. GitHub's branch rules still apply; if GitHub refuses, nothing changes.",
    leave: 'Takes it off Needs you for everyone it is shown to. It comes back when the pull request gets a new commit, a new review, or a new reason it is held. Nothing on GitHub changes.',
    discuss: 'Sends your message to the lead reviewer, or the builder, who answers on the pull request. It stays held.',
  };
  const why = 'ci and review-gate passed, but OpenADLC did not merge it, because it is behind main.';
  const HELD = (over: { merge?: { merge: true } | { merge: false; why: string }; yours?: boolean; whyNot?: string; settingsUrl?: string } = {}): AttentionItem => {
    const merge = over.merge ?? { merge: true };
    return {
      id: 'merge:www#46',
      kind: 'merge_waiting',
      group: 'work',
      headline: 'Pull request #46 is held for a person: merge it, leave it, or discuss it',
      subject: { repo: 'www', number: 12, title: 'New pricing page', ref: 'www#12', url: 'https://github.com/620legal/www/pull/46' },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: why,
      actions: [
        ...(merge.merge ? [{ kind: 'held_merge_merge' as const, label: 'Merge', subject: 'www#46', head: HEAD }] : []),
        { kind: 'held_merge_leave', label: 'Leave it', subject: 'www#46', head: HEAD },
        { kind: 'held_merge_discuss', label: 'Discuss', subject: 'www#46', head: HEAD },
        { kind: 'open_url', label: 'Open on GitHub', url: 'https://github.com/620legal/www/pull/46' },
      ],
      heldMerge: {
        repo: 'www',
        pr: 46,
        head: HEAD,
        why,
        merge,
        next,
        prUrl: 'https://github.com/620legal/www/pull/46',
        ...(over.yours !== undefined ? { yours: over.yours } : {}),
        ...(over.whyNot ? { whyNot: over.whyNot } : {}),
        ...(over.settingsUrl ? { settingsUrl: over.settingsUrl } : {}),
      },
    };
  };
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  const decides = (html: string) => [...html.matchAll(/data-decide="(\w+)"/g)].map((match) => match[1]);

  it('says why it is held, what each button does next, and offers Merge to a viewer who may press it', () => {
    const html = needs([HELD({ yours: true })]);
    const text = words(html);
    expect(text).toContain(`Why it waits for a person: ${why}`);
    for (const said of Object.values(next)) expect(text).toContain(said);
    expect(decides(html)).toEqual(['merge', 'leave', 'discuss']);
    expect(html.match(/Open on GitHub/g)).toHaveLength(1);
    expect(html).not.toContain('data-clamp="detail"');
  });

  it('offers no Merge over a failed required check, and says why', () => {
    const html = needs([HELD({ yours: true, merge: { merge: false, why: 'There is no Merge: a required check has not passed on this head. Open it on GitHub, or Discuss it.' } })]);
    expect(decides(html)).toEqual(['leave', 'discuss']);
    expect(words(html)).toContain('There is no Merge: a required check has not passed on this head.');
    expect(html).toContain('Open on GitHub');
  });

  it('offers no Merge while a Human-review approval is awaited, and names who decides it', () => {
    const html = needs([HELD({ yours: true, merge: { merge: false, why: "There is no Merge: this waits for @orzelig's approval under AGENTS.md's Human review, which is decided on its own card." } })]);
    expect(decides(html)).toEqual(['leave', 'discuss']);
    expect(words(html)).toContain("@orzelig's approval under AGENTS.md's Human review");
  });

  it('offers no Merge to someone GitHub does not let merge, and says why, or where to link an account', () => {
    const refused = needs([HELD({ yours: false, whyNot: '@sam cannot merge in 620legal/www (GitHub says read); someone who can merges it.' })]);
    expect(decides(refused)).toEqual(['leave', 'discuss']);
    expect(words(refused)).toContain('GitHub says read');
    const unlinked = needs([HELD({ yours: false, whyNot: 'You have not linked a GitHub account. Link it in Settings → Your GitHub account.', settingsUrl: '/settings#your-github' })]);
    expect(unlinked).toContain('href="/settings#your-github"');
    // A bridge that does not say: no Merge.
    expect(decides(needs([HELD()]))).toEqual(['leave', 'discuss']);
  });

  it('asks the bridge to merge the head shown, and to leave it', () => {
    press(buttonsIn(<HeldMergePanel item={HELD({ yours: true })} />), `Merge${next.merge}`);
    press(buttonsIn(<HeldMergePanel item={HELD({ yours: true })} />), `Leave it${next.leave}`);
    expect(decided).toEqual([
      { what: 'merge', subject: 'www#46', input: { head: HEAD } },
      { what: 'leave', subject: 'merge:www#46', input: {} },
    ]);
  });

  it('shows the code to approve while the Merge waits for the person', () => {
    const html = renderToStaticMarkup(<HeldMergePanel item={HELD({ yours: true })} initialStep={{ kind: 'signing', flowId: 'f', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }} />);
    expect(html).toContain('ABCD-1234');
    expect(words(html)).toContain('692cd1f is merged once you do');
  });
});

describe('a held promote, decided from the card (ADR 0037)', () => {
  const SHA = 'abc1234def567890abc1234def567890abc12345';
  const HELD: AttentionItem = {
    id: `promote:testbed@${SHA}`,
    kind: 'promote_held',
    group: 'work',
    headline: 'Release testbed@abc1234 to production?',
    subject: { repo: 'testbed', number: null, title: null, ref: null, url: null },
    bot: null,
    since: '2026-09-24T11:59:00.000Z',
    detail: 'Held.',
    actions: [
      { kind: 'promote_release', label: 'Release', repo: 'testbed', sha: SHA },
      { kind: 'promote_keep_holding', label: 'Keep holding', repo: 'testbed', sha: SHA },
      { kind: 'promote_discuss', label: 'Discuss', repo: 'testbed', sha: SHA, subject: 'testbed#40' },
      { kind: 'promote_automatic', label: 'Switch to automatic delivery', repo: 'testbed', sha: SHA },
    ],
    heldPromote: {
      repo: 'testbed',
      sha: SHA,
      pr: 40,
      what: 'Releases abc1234 (pull request #40: Rate-limit) from testing to production. Its smoke passed on testing.',
      why: "testbed's delivery rules say a person approves each production deploy. GitHub’s plan cannot hold a production reviewer here.",
      next: {
        release: 'Starts the production deploy of abc1234 now.',
        keepHolding: 'Leaves the promote held and takes it off Needs you for everyone it is shown to. Nothing deploys. It comes back only when another commit waits for production.',
        discuss: 'Sends your message to the lead reviewer of pull request #40, who answers there. The promote stays held.',
        automatic: 'Switches the repository to automatic delivery: a soak on testing, the smoke, and an automatic rollback if production fails.',
      },
    },
  };
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

  it('reads as a decision: what it releases, why, and Release, Keep holding and Discuss, each with what it does next', () => {
    const html = needs([HELD]);
    const text = words(html);
    expect(text).toContain('What it releases: Releases abc1234 (pull request #40: Rate-limit)');
    expect(text).toContain("Why it waits for a person: testbed's delivery rules say a person approves each production deploy.");
    for (const said of Object.values(HELD.heldPromote!.next)) expect(text).toContain(said!);
    // Release and the switch stay the card's own buttons, as they were.
    for (const label of ['Release', 'Switch to automatic delivery']) expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${label}</button>`));
    expect([...html.matchAll(/data-decide="(\w+)"/g)].map((match) => match[1])).toEqual(['keep', 'discuss']);
  });

  it('keeps it held, and discusses it on its pull request', () => {
    press(buttonsIn(<HeldPromotePanel item={HELD} />), `Keep holding${HELD.heldPromote!.next.keepHolding}`);
    expect(decided).toEqual([{ what: 'leave', subject: `promote:testbed@${SHA}`, input: {} }]);
  });
});
