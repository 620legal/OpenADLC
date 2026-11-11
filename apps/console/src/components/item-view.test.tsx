import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ItemView as ItemData, WaitChain, WaitEnd } from '@/lib/api';
import { endWords, rootButton } from '@/lib/card-status';
import { addressedRole, itemComposer, itemEntries, roleTabs, speakerLabel, writeToRoles } from '@/lib/item';
import { RoleProvider } from './app-header';
import { ItemView, WaitBlock } from './item-view';

vi.mock('@/app/actions', () => ({ linkToItem: vi.fn(), unlinkFromItem: vi.fn(), mergeItem: vi.fn(), sendItemMessage: vi.fn(), answerGate: vi.fn(), retryTask: vi.fn(), sendMessage: vi.fn(), stopTask: vi.fn(), killSession: vi.fn(), restartBot: vi.fn() }));

/**
 * A work item's view: one conversation for the request, its issue and its
 * pull request, every entry headed by the role and seat that said it, and a
 * tab for each role, even when seats share a GitHub account. Two reviewers on one GitHub
 * account were one handle in the console; here they are two tabs.
 */

const NOW = '2026-09-30T12:00:00.000Z';

const ITEM: ItemData = {
  key: 'api#12',
  subjects: ['request:a4b02784', 'api#12', 'api#31'],
  title: 'Record the model per review',
  repo: 'api',
  stage: 'review',
  costUsd: 1.25,
  request: { id: 'a4b02784-3ae8', subject: 'request:a4b02784', text: 'Record which model reviewed each round', context: null, requestedBy: 'jane@acme.test', state: 'filed', createdAt: '2026-09-30T09:00:00.000Z' },
  issue: { number: 12, title: 'Record the model per review', url: 'https://github.com/acme/api/issues/12', stage: 'review' },
  pullRequest: { number: 31, url: 'https://github.com/acme/api/pull/31' },
  roles: [
    { role: 'intake', label: 'intake', seats: [{ bot: 'intake', slot: 'intake', githubLogin: 'acme-crew', sharedAccount: true }] },
    { role: 'review_lead', label: 'lead reviewer', seats: [{ bot: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: 'acme-reviewer', sharedAccount: true }] },
    { role: 'review_second', label: 'second reviewer', seats: [{ bot: 'second-reviewer', slot: 'second-reviewer', githubLogin: 'acme-reviewer', sharedAccount: true }] },
  ],
  timeline: [
    { id: 'm-1', kind: 'bot', author: 'intake', text: 'Filed it as #12.', note: null, payload: null, githubUrl: null, at: '2026-09-30T09:10:00.000Z', subjectRef: 'request:a4b02784', role: 'intake', seat: 'intake', bot: 'intake' },
    { id: 'm-2', kind: 'bot', author: 'lead-reviewer', text: 'Store it per round.', note: null, payload: null, githubUrl: null, at: '2026-09-30T10:10:00.000Z', subjectRef: 'api#31', role: 'review_lead', seat: 'lead-reviewer', bot: 'lead-reviewer' },
    { id: 'm-3', kind: 'gate', author: 'second-reviewer', text: 'Per round, or per task?', note: null, payload: { gateId: 'g-2', options: ['per round', 'per task'] }, githubUrl: null, at: '2026-09-30T10:20:00.000Z', subjectRef: 'api#31', role: 'review_second', seat: 'second-reviewer', bot: 'second-reviewer' },
  ],
  openGates: [
    { id: 'g-2', question: 'Per round, or per task?', options: ['per round', 'per task'], addressedTo: null, githubCommentUrl: null, subjectRef: 'api#31', role: 'review_second', seat: 'second-reviewer', bot: 'second-reviewer' },
  ],
  tasks: [
    { id: 'k-2', bot: 'second-reviewer', seat: 'second-reviewer', role: 'review_second', kind: 'review', state: 'paused', round: 1, subjectRef: 'api#31', startedAt: '2026-09-30T10:15:00.000Z', endedAt: null, exitReason: null, tmuxSession: 'second-reviewer-7', branch: null, costUsd: 0.5 },
  ],
  attachments: [],
  // As the bridge routes it: the second reviewer spoke last.
  routes: {
    '': { kind: 'post', bot: 'second-reviewer', role: 'review_second', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31 },
    intake: { kind: 'post', bot: 'intake', role: 'intake', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12 },
    review_lead: { kind: 'post', bot: 'lead-reviewer', role: 'review_lead', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31 },
    review_second: { kind: 'post', bot: 'second-reviewer', role: 'review_second', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31 },
  },
};

function render(role: 'admin' | 'user' = 'admin', item: ItemData = ITEM): string {
  return renderToStaticMarkup(
    <RoleProvider role={role}>
      <ItemView subject="api#12" initial={item} now={NOW} />
    </RoleProvider>,
  ).replace(/<!-- -->/g, '');
}

describe('a work item’s view', () => {
  it('has a tab for each role on it, so two seats on one account are two tabs', () => {
    const html = render();
    expect([...html.matchAll(/data-role-tab="([^"]+)"/g)].map((match) => match[1])).toEqual(['intake', 'review_lead', 'review_second']);
    expect(roleTabs(ITEM).filter((tab) => tab.shared).map((tab) => tab.label)).toEqual(['intake', 'lead reviewer', 'second reviewer']);
  });

  it('heads every entry with the role and the account, not the account alone', () => {
    const html = render();
    expect(html).toContain('lead reviewer · acme-reviewer');
    expect(html).toContain('second reviewer · acme-reviewer');
    expect(speakerLabel(ITEM, ITEM.timeline[0]!)).toBe('intake · acme-crew');
  });

  it('shows the request, its issue and its pull request, the stage and the cost', () => {
    const html = render();
    expect(html).toContain('Record which model reviewed each round');
    expect(html).toContain('Issue #12');
    expect(html).toContain('Pull request #31');
    expect(html).toContain('Review');
    expect(html).toContain('$1.25 so far');
  });

  it('offers each running task’s computer and terminal, labelled by role and account as the conversation names it, to an admin only', () => {
    expect(render('admin')).toContain('Computer · second reviewer · acme-reviewer');
    expect(render('admin')).toContain('Terminal · second reviewer · acme-reviewer');
    expect(render('user')).not.toContain('Computer ·');
  });

  it('does not say a default seat’s role twice', () => {
    const builder: ItemData = {
      ...ITEM,
      roles: [{ role: 'implement', label: 'builder', seats: [{ bot: 'builder', slot: 'builder', githubLogin: null, sharedAccount: false }] }],
      tasks: [{ ...ITEM.tasks[0]!, id: 'k-3', bot: 'builder', seat: 'builder', role: 'implement', tmuxSession: 'builder-3' }],
    };
    expect(render('admin', builder)).toContain('Computer · builder');
    expect(render('admin', builder)).not.toContain('builder · builder');
  });

  it('filters a role’s tab to what was said in that role', () => {
    expect(itemEntries(ITEM, { now: NOW, role: 'review_lead', timeZone: 'UTC' }).filter((entry) => entry.kind === 'bubble').map((entry) => entry.key)).toEqual(['m-2']);
  });
});

describe('a work item’s key and links', () => {
  const NUMBERED: ItemData = {
    ...ITEM,
    workItem: { number: 128, key: '620legal-128', mergedFrom: null },
    links: [
      { kind: 'request', repo: null, number: null, ref: 'request:a4b02784', title: 'Record which model reviewed', state: 'open', stage: null, url: null, linkedBy: null },
      { kind: 'issue', repo: 'api', number: 12, ref: 'api#12', title: 'Record the model per review', state: 'open', stage: 'review', url: 'https://github.com/acme/api/issues/12', linkedBy: null },
      { kind: 'pull', repo: 'web', number: 7, ref: 'web#7', title: 'Show the model on the page', state: 'merged', stage: 'done', url: 'https://github.com/acme/web/pull/7', linkedBy: 'jane@acme.test' },
    ],
  };

  it('says the key with a link to copy, and every link with its repository, state and stage', () => {
    const html = render('user', NUMBERED);
    expect(html).toMatch(/data-item-key="true"[^>]*>620legal-128<\/span>/);
    expect(html).toContain('Copy link');
    const links = html.slice(html.indexOf('aria-label="Linked to this work item"'));
    expect(links).toContain('data-link="web#7"');
    expect(links).toContain('Show the model on the page');
    expect(links).toMatch(/merged · Done · linked by/);
    expect(links).toMatch(/open · Review/);
  });

  it('offers Link, Unlink and Merge to an admin only, and no Unlink on a request', () => {
    const admin = render('admin', NUMBERED);
    expect(admin).toContain('placeholder="owner/repo#number"');
    expect(admin).toContain('placeholder="Merge into key"');
    expect(admin.match(/>Unlink</g)).toHaveLength(2);
    const user = render('user', NUMBERED);
    for (const control of ['owner/repo#number', 'Merge into key', '>Unlink<']) expect(user).not.toContain(control);
  });

  it('shows no key or links before the install is numbered', () => {
    const html = render('admin', ITEM);
    expect(html).not.toContain('data-item-key');
    expect(html).not.toContain('Linked to this work item');
  });
});

describe('an item’s pause, play next and cancel', () => {
  it('are offered while it is in flight, and not on finished work, as on the board', () => {
    expect(render()).toContain('data-issue-controls');
    // A shipped item's cancel said it would close its merged pull request "unmerged".
    for (const stage of ['merged', 'done']) {
      const finished = render('admin', { ...ITEM, stage, issue: { ...ITEM.issue!, stage } });
      expect(finished).not.toContain('data-issue-controls');
      expect(finished).not.toContain('Cancel work');
    }
  });

  it('are not offered on an issue known only by its link, which the board has no row for, though it is drawn', () => {
    // `W-140`'s api#77, open on GitHub before OpenADLC read it: the bridge refuses its controls.
    const linkOnly = render('admin', { ...ITEM, stage: 'intake', issue: { number: 77, title: 'An old report', url: 'https://github.com/acme/api/issues/77', stage: 'intake', onBoard: false } });
    expect(linkOnly).toContain('Issue #77');
    expect(linkOnly).not.toContain('data-issue-controls');
    expect(linkOnly).not.toContain('Cancel work');
    // An older bridge says nothing of it: the issue is the board's.
    expect(render('admin', { ...ITEM, issue: { ...ITEM.issue!, onBoard: undefined } })).toContain('data-issue-controls');
  });
});

describe('where the item’s box sends a message', () => {
  it('answers the one open question, by its id', () => {
    expect(itemComposer(ITEM, {})).toMatchObject({ mode: 'answer', gateId: 'g-2' });
  });

  it('asks which question first when two are open, and sends nothing until one is picked', () => {
    const two = { ...ITEM, openGates: [...ITEM.openGates, { ...ITEM.openGates[0]!, id: 'g-1', role: 'review_lead', bot: 'lead-reviewer', seat: 'lead-reviewer' }] };
    expect(itemComposer(two, {})).toMatchObject({ mode: 'pick', gateId: null });
    expect(itemComposer(two, { picked: 'g-1' })).toMatchObject({ mode: 'answer', gateId: 'g-1' });
    // A role's tab answers that role's question.
    expect(itemComposer(two, { role: 'review_lead' })).toMatchObject({ mode: 'answer', gateId: 'g-1' });
  });

  it('with nothing open, names the seat and the place the bridge will send it to', () => {
    const quiet = { ...ITEM, openGates: [] };
    expect(itemComposer(quiet, { role: 'review_lead' }).helper).toBe('To the lead reviewer (acme-reviewer), posted on pull request #31 as a comment');
    expect(itemComposer(quiet, { role: 'intake' }).helper).toBe('To the intake (acme-crew), posted on #12 as a comment');
    // The second reviewer spoke last, so the conversation's message is theirs,
    // on the pull request — not "whoever is working on it", on the issue.
    expect(itemComposer(quiet, {})).toEqual({ mode: 'send', gateId: null, helper: 'To the second reviewer (acme-reviewer), posted on pull request #31 as a comment' });
  });

  it('says the lead reviewer and the pull request while the builder’s patch runs, when the reviewer spoke last', () => {
    const lead = { ...ITEM, openGates: [], routes: { '': ITEM.routes!['review_lead']! } };
    expect(itemComposer(lead, {}).helper).toBe('To the lead reviewer (acme-reviewer), posted on pull request #31 as a comment');
  });

  it('says what sending it starts, or that it starts nothing and why, after where it goes', () => {
    const builder = { kind: 'post' as const, bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue' as const, number: 12 };
    const starting = { openGates: [], routes: { '': { ...builder, start: { kind: 'starts' as const, what: 'a patch round on pull request #31' } } } };
    expect(itemComposer(starting, {}).helper).toBe('To the builder (acme-crew), posted on #12 as a comment; starts a patch round on pull request #31');
    const held = { openGates: [], routes: { '': { ...builder, start: { kind: 'nothing' as const, why: 'api#12 is held by jane; resume it on its card to let work start' } } } };
    expect(itemComposer(held, {}).helper).toBe('To the builder (acme-crew), posted on #12 as a comment; nothing starts: api#12 is held by jane; resume it on its card to let work start');
  });

  it('names whom the conversation writes to, and offers the other roles the bridge names in pipeline order', () => {
    // The role that acts next comes last in the routes when no tab names it.
    const routes = { ...ITEM.routes!, '': { kind: 'post' as const, bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue' as const, number: 12 }, implement: { kind: 'post' as const, bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue' as const, number: 12 } };
    expect(addressedRole({ routes })).toBe('implement');
    expect(writeToRoles({ ...ITEM, routes }).map((one) => one.label)).toEqual(['intake', 'builder', 'lead reviewer', 'second reviewer']);
    // One role to write to is said by the box's label, with nothing to pick.
    expect(writeToRoles({ ...ITEM, routes: { '': routes[''], implement: routes.implement } })).toEqual([]);
    expect(addressedRole({ routes: { '': { kind: 'refused', error: 'nobody' } } })).toBeNull();
  });

  it('says a message on a deploy of a commit is kept in OpenADLC, not posted on GitHub', () => {
    const commit = {
      openGates: [],
      routes: { '': { kind: 'post' as const, bot: 'sre', role: 'deploy', handle: 'acme-crew', subject: 'api@3f2c1a9', on: 'openadlc' as const, number: null } },
    };
    expect(itemComposer(commit, {}).helper).toBe('To the SRE (acme-crew), kept in OpenADLC, not posted on GitHub');
  });

  it('asks for a role, and sends nothing, when the bridge would have nobody to send it to', () => {
    const nobody = {
      openGates: [],
      routes: { '': { kind: 'refused' as const, error: 'nobody has worked on this item yet, so there is no one to send it to; pick a role to write to' } },
    };
    expect(itemComposer(nobody, {})).toEqual({
      mode: 'pick',
      gateId: null,
      helper: 'Nobody has worked on this item yet, so there is no one to send it to; pick a role to write to.',
    });
  });
});

/**
 * Why it isn't moving: a waiting item's sheet says its whole wait, one step a
 * line, ending in what a person can do and the board card's own button to do it.
 */
describe('why an item isn’t moving', () => {
  const approval: WaitEnd = { kind: 'person', ref: 'api#22', action: 'approve', number: 30, attentionId: 'approval:api#30@jane', url: 'https://github.com/acme/api/pull/30' };
  const chain = (end: WaitEnd, behind = 4): WaitChain => ({
    links: [
      { from: 'api#12', to: 'api#20', kind: 'dependency' },
      { from: 'api#20', to: 'api#21', kind: 'lease' },
      { from: 'api#21', to: 'api#22', kind: 'stack' },
    ],
    end,
    behind,
  });
  const urlOf = (ref: string) => (ref === 'api#40' ? 'https://github.com/acme/api/issues/40' : null);
  const block = (waitChain: WaitChain | null | undefined, root?: Parameters<typeof WaitBlock>[0]['root']) =>
    renderToStaticMarkup(<WaitBlock view={{ repo: 'api', ...(waitChain === undefined ? {} : { waitChain }) }} root={root} />).replace(/<!-- -->/g, '');
  const lines = (html: string) => [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((match) => match[1]!);
  const words = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

  it('draws each link and the person’s end, one line each, in order, every card a link to its sheet', () => {
    const html = block(chain(approval), (card, wait) => rootButton(card, wait, new Set(), urlOf));
    expect(words(html)).toContain("Why it isn't moving");
    const drawn = lines(html);
    expect(drawn.map(words)).toEqual([
      '#12 waits for #20 to ship first.',
      '#20 waits for #21 to let go of files they both change.',
      '#21 is stacked on #22 and waits for it to merge.',
      // The end, with its button.
      '#22 waits on you: approve #30.Open #30',
    ]);
    const hrefs = (one: string) => [...one.matchAll(/href="(\/items\/[^"]+)"/g)].map((match) => match[1]);
    expect(drawn.map(hrefs)).toEqual([
      ['/items/api%2312', '/items/api%2320'],
      ['/items/api%2320', '/items/api%2321'],
      ['/items/api%2321', '/items/api%2322'],
      ['/items/api%2322'],
    ]);
  });

  it('carries the board’s root button at the end: the same label, going to the same place', () => {
    const shown = new Set(['approval:api#30@jane']);
    const inStrip = rootButton({ repo: 'api' }, chain(approval), shown, urlOf)!;
    expect(inStrip).toEqual({ label: 'Show in Needs you', scrollTo: 'approval:api#30@jane' });
    const there = lines(block(chain(approval), (card, wait) => rootButton(card, wait, shown, urlOf))).at(-1)!;
    expect(there).toContain(`data-root="${inStrip.scrollTo}"`);
    expect(words(there)).toMatch(new RegExp(`${inStrip.label}$`));

    const onGitHub = rootButton({ repo: 'api' }, chain(approval), new Set(), urlOf)!;
    expect(onGitHub).toEqual({ label: 'Open #30', url: 'https://github.com/acme/api/pull/30' });
    const away = lines(block(chain(approval), (card, wait) => rootButton(card, wait, new Set(), urlOf))).at(-1)!;
    expect(away).toContain(`href="${onGitHub.url}"`);
    expect(words(away)).toMatch(/Open #30$/);
    // With no board to ask (the item's own page), the end's own address.
    expect(block(chain(approval))).toContain('href="https://github.com/acme/api/pull/30"');
  });

  it('says how many items wait behind the one action', () => {
    expect(words(block(chain(approval, 1)))).toContain('1 item waits behind this one action.');
    expect(words(block(chain(approval, 4)))).toContain('4 items wait behind this one action.');
  });

  it.each<[string, WaitEnd]>([
    ['a closed dependency', { kind: 'dead', ref: 'api#40', why: 'closed' }],
    ['a loop', { kind: 'dead', ref: 'api#21', why: 'loop', loop: ['api#21', 'api#22'] }],
    ['a wait followed no further', { kind: 'deep', ref: 'api#40' }],
    ['a wait that clears by itself', { kind: 'self', ref: 'api#22', words: 'which is running now' }],
  ])('ends %s in the board’s words, with no button', (_name, end) => {
    const html = block(chain(end), (card, wait) => rootButton(card, wait, new Set(['approval:api#30@jane']), urlOf));
    expect(words(lines(html).at(-1)!)).toBe(endWords({ repo: 'api' }, chain(end)).text);
    expect(html).not.toContain('data-root');
    expect(html).not.toContain('behind this one action');
  });

  it('draws nothing for an item that does not wait', () => {
    expect(block(null)).toBe('');
    expect(block(undefined)).toBe('');
    expect(render('admin', { ...ITEM, waitChain: null })).not.toContain('Why it isn');
    expect(render('admin', ITEM)).not.toContain('Why it isn');
  });

  it('is drawn on the sheet above the conversation while the item waits', () => {
    const html = render('admin', { ...ITEM, waitChain: chain(approval) });
    expect(html).toContain('data-wait-block');
    expect(html.indexOf('data-wait-block')).toBeLessThan(html.indexOf('Filed it as #12.'));
  });
});
