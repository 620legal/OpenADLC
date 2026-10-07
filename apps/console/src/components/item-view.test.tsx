import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ItemView as ItemData } from '@/lib/api';
import { itemComposer, itemEntries, roleTabs, speakerLabel } from '@/lib/item';
import { RoleProvider } from './app-header';
import { ItemView } from './item-view';

vi.mock('@/app/actions', () => ({ sendItemMessage: vi.fn(), answerGate: vi.fn(), retryTask: vi.fn(), sendMessage: vi.fn(), stopTask: vi.fn(), killSession: vi.fn(), restartBot: vi.fn() }));

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

  it('says a message on a deploy of a commit is kept in OpenADLC, not posted on GitHub', () => {
    const commit = {
      openGates: [],
      routes: { '': { kind: 'post' as const, bot: 'sre', role: 'deploy', handle: 'acme-crew', subject: 'api@3f2c1a9', on: 'fleetadlc' as const, number: null } },
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
