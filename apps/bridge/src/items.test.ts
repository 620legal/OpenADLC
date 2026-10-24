import { describe, expect, it } from 'vitest';
import type { Gate, Message } from '@openadlc/shared';
import { actsNext, controlRefusal, itemKey, itemOf, itemView, linkStage, lonePullRefusal, messageRoutes, ownSubjects, parseItemKey, routeItemMessage, type ItemBot, type ItemTaskRow } from './items.js';

describe('a work item key', () => {
  it('names the number whatever its prefix or case, and is display only', () => {
    for (const key of ['620legal-128', 'W-128', 'w-128', '128', ' 620LEGAL-128 ', 'old-org-name-128']) expect(parseItemKey(key), key).toBe(128);
    expect(itemKey(128, '620legal')).toBe('620legal-128');
    expect(itemKey(128, null)).toBe('W-128');
    expect(itemKey(128, '  ')).toBe('W-128');
  });

  it('is never a subject: a repository and number, a request, or a deploy of a commit', () => {
    for (const subject of ['api#12', 'request:a4b02784', 'api@3f2c1a9', 'W-0', 'W-', 'testing', '', 'acme/api-12']) expect(parseItemKey(subject), subject).toBeNull();
  });
});

describe('where a linked thing stands', () => {
  const issues = [{ repoName: 'api', number: 12, prNumber: 31, stage: 'build' as const }];
  it('is its issue’s stage, its pull request’s issue’s, else Review while open and Done once closed', () => {
    expect(linkStage({ kind: 'issue', repo: 'api', number: 12, state: 'open' }, issues)).toBe('build');
    expect(linkStage({ kind: 'pull', repo: 'api', number: 31, state: 'open' }, issues)).toBe('build');
    expect(linkStage({ kind: 'pull', repo: 'web', number: 31, state: 'open' }, issues)).toBe('review');
    expect(linkStage({ kind: 'pull', repo: 'api', number: 40, state: 'closed' }, issues)).toBe('done');
    expect(linkStage({ kind: 'issue', repo: 'web', number: 3, state: 'open' }, issues)).toBe('intake');
    expect(linkStage({ kind: 'request', repo: null, number: null, state: 'open' }, issues, { issueNumber: null, state: 'questions' })).toBe('intake');
    expect(linkStage({ kind: 'request', repo: null, number: null, state: 'open' }, issues, { issueNumber: 12, state: 'filed' })).toBeNull();
  });
});

/**
 * A work item is one request, the issue it became and that issue's pull
 * request. A person answered intake about one request in a panel that held
 * three others, and read a reviewer's remarks under the reviewer rather than
 * under the work. Each request is its own conversation, and each role its own
 * tab, even when seats share a GitHub account; these are the rules that keep
 * each piece of work its own conversation.
 */

const REPOS = [{ id: 'repo-1', name: 'api', fullName: 'acme/api' }];
const ISSUE = { repoId: 'repo-1', repoName: 'api', number: 12, prNumber: 31, title: 'Record the model per review', stage: 'review' as const, url: 'https://github.com/acme/api/issues/12' };
const FILED = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Record which model reviewed\nwith detail', repoId: 'repo-1', issueNumber: 12, state: 'filed' };
const OPEN = { id: 'c0ffee00-1111-4222-8333-944445555666', text: 'A page that says hello', repoId: 'repo-1', issueNumber: null, state: 'questions' };
const FACTS = { issues: [ISSUE], requests: [FILED, OPEN], repos: REPOS };

describe('which item a subject belongs to', () => {
  it('is the same item from the request, the issue and its pull request', () => {
    const fromRequest = itemOf('request:a4b02784', FACTS);
    const fromIssue = itemOf('api#12', FACTS);
    const fromPull = itemOf('api#31', FACTS);

    for (const item of [fromRequest, fromIssue, fromPull]) {
      expect(item?.key).toBe('api#12');
      expect(item?.subjects.sort()).toEqual(['api#12', 'api#31', 'request:a4b02784']);
      expect(item?.refs).toEqual({ request: 'request:a4b02784', issue: 'api#12', pullRequest: 'api#31' });
      expect(item?.request?.id).toBe(FILED.id);
    }
  });

  it('is the request itself before an issue exists', () => {
    const item = itemOf('request:c0ffee00', FACTS);
    expect(item).toMatchObject({ key: 'request:c0ffee00', subjects: ['request:c0ffee00'], issue: null, pr: null, repo: 'api' });
  });

  it('is nothing for a request prefix two requests share, rather than a guess', () => {
    const twin = { ...OPEN, id: 'a4b0ffff-0000-4000-8000-000000000000' };
    expect(itemOf('request:a4b0', { ...FACTS, requests: [FILED, twin] })).toBeNull();
    expect(itemOf('request:a4b02784', { ...FACTS, requests: [FILED, twin] })?.key).toBe('api#12');
  });

  it('is nothing for a request this install never saw', () => {
    expect(itemOf('request:deadbeef', FACTS)).toBeNull();
  });

  it('lets a deploy of a commit stand alone, joined to no issue', () => {
    expect(itemOf('api#testing@a1b2c3d4', FACTS)).toMatchObject({ key: 'api#testing@a1b2c3d4', subjects: ['api#testing@a1b2c3d4'], repo: 'api', issue: null });
    expect(itemOf('api@3f2c1a9', FACTS)?.subjects).toEqual(['api@3f2c1a9']);
  });

  it('keeps an issue the board has no row for yet as its own item, with the request filed as it', () => {
    const item = itemOf('api#40', { ...FACTS, requests: [{ ...OPEN, issueNumber: 40, state: 'filed' }] });
    expect(item?.key).toBe('api#40');
    expect(item?.subjects.sort()).toEqual(['api#40', 'request:c0ffee00']);
  });
});

const BOTS: ItemBot[] = [
  { id: 'b-intake', name: 'intake', slot: 'intake', role: 'intake', githubLogin: 'acme-crew' },
  { id: 'b-builder', name: 'builder', slot: 'builder', role: 'implement', githubLogin: 'acme-crew' },
  { id: 'b-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: 'acme-reviewer' },
  { id: 'b-second', name: 'second-reviewer', slot: 'second-reviewer', role: 'review_second', githubLogin: 'acme-reviewer' },
  { id: 'b-solo', name: 'janebot', slot: 'security-reviewer', role: 'review_security', githubLogin: 'janebot' },
];

function message(id: string, threadId: string, at: string, kind: Message['kind'] = 'bot'): Message {
  return { id, threadId, kind, author: 'x', text: id, note: null, payload: null, githubUrl: null, at };
}

function task(id: string, botId: string, subjectRef: string, state: ItemTaskRow['state'], createdAt: string): ItemTaskRow {
  return { id, botId, kind: 'review', subjectRef, state, round: 1, startedAt: createdAt, endedAt: null, exitReason: null, tmuxSession: `${botId}-1`, branch: null, costUsd: 0.5, createdAt };
}

function gate(id: string, threadId: string, taskId: string | null = null): Gate {
  return { id, taskId, threadId, question: 'Which?', options: [], state: 'open', answer: null, answeredBy: null, answeredAt: null, githubCommentUrl: null, addressedTo: null };
}

describe('the item as the console shows it', () => {
  const item = itemOf('api#12', FACTS)!;
  const threads = [
    { id: 't-intake', bot_id: 'b-intake', subject_ref: 'request:a4b02784', role: 'intake', seat: 'intake' },
    { id: 't-lead', bot_id: 'b-lead', subject_ref: 'api#31', role: 'review_lead', seat: 'lead-reviewer' },
    { id: 't-second', bot_id: 'b-second', subject_ref: 'api#31', role: 'review_second', seat: 'second-reviewer' },
    // Another item's thread, read by mistake, is not this item's.
    { id: 't-other', bot_id: 'b-intake', subject_ref: 'request:c0ffee00', role: 'intake', seat: 'intake' },
  ];
  const view = itemView({
    item,
    repo: REPOS[0]!,
    bots: BOTS,
    threads,
    messages: [message('m3', 't-second', '2026-09-30T10:03:00Z'), message('m1', 't-intake', '2026-09-30T10:01:00Z'), message('m2', 't-lead', '2026-09-30T10:02:00Z'), message('mx', 't-other', '2026-09-30T10:04:00Z')],
    gates: [gate('g-lead', 't-lead'), gate('g-other', 't-other')],
    tasks: [task('k1', 'b-lead', 'api#31', 'done', '2026-09-30T10:00:00Z'), task('k2', 'b-second', 'api#31', 'running', '2026-09-30T10:05:00Z')],
  });

  it('is the whole conversation in order, each entry labelled by the role and seat that said it', () => {
    expect(view.timeline.map((entry) => [entry.id, entry.role, entry.seat, entry.subjectRef])).toEqual([
      ['m1', 'intake', 'intake', 'request:a4b02784'],
      ['m2', 'review_lead', 'lead-reviewer', 'api#31'],
      ['m3', 'review_second', 'second-reviewer', 'api#31'],
    ]);
  });

  it('lists each role in pipeline order, with two seats on one account as two roles that say so', () => {
    expect(view.roles.map((role) => [role.role, role.label, role.seats.map((seat) => [seat.slot, seat.sharedAccount])])).toEqual([
      ['intake', 'intake', [['intake', true]]],
      ['review_lead', 'lead reviewer', [['lead-reviewer', true]]],
      ['review_second', 'second reviewer', [['second-reviewer', true]]],
    ]);
  });

  it('keeps only its own open questions, and its tasks newest first with their own session', () => {
    expect(view.openGates.map((one) => [one.id, one.role, one.bot, one.subjectRef])).toEqual([['g-lead', 'review_lead', 'lead-reviewer', 'api#31']]);
    expect(view.tasks.map((one) => [one.id, one.role, one.tmuxSession])).toEqual([
      ['k2', 'review_second', 'b-second-1'],
      ['k1', 'review_lead', 'b-lead-1'],
    ]);
    expect(view).toMatchObject({ key: 'api#12', title: 'Record the model per review', stage: 'review', costUsd: 1, pullRequest: { number: 31, url: 'https://github.com/acme/api/pull/31' } });
  });

  it('offers no Approve on a plan change already approved that waits on other work, and offers it again once adding the paths failed', () => {
    // #27 on 2026-10-22: the thread and the item view still offered Approve,
    // and it was approved three times.
    const planChange = { ...gate('g-lead', 't-lead'), options: ['Approve', 'Refuse'] };
    const read = (held: { approvedBy: string; blockedBy: number[]; failed?: string } | null) =>
      itemView({ item, repo: REPOS[0]!, bots: BOTS, threads, messages: [], gates: [{ ...planChange, held }], tasks: [] }).openGates[0];

    expect(read({ approvedBy: 'janedoe', blockedBy: [71] })).toMatchObject({ options: ['Refuse'], held: { blockedBy: [71] } });
    expect(read({ approvedBy: 'janedoe', blockedBy: [], failed: 'not connected' })?.options).toEqual(['Approve', 'Refuse']);
    expect(read(null)?.options).toEqual(['Approve', 'Refuse']);
  });

  it('takes the role from the thread, not the bot it is with now', () => {
    // A seat moved to another role keeps what it said in the old one.
    const moved = itemView({
      item,
      repo: REPOS[0]!,
      bots: BOTS.map((bot) => (bot.id === 'b-lead' ? { ...bot, role: 'review_security' as const } : bot)),
      threads,
      messages: [message('m2', 't-lead', '2026-09-30T10:02:00Z')],
      gates: [],
      tasks: [],
    });
    expect(moved.timeline[0]?.role).toBe('review_lead');
  });
});

describe('the plan changes on an item that no person approved (#77)', () => {
  const item = itemOf('api#12', FACTS)!;
  const threads = [{ id: 't-lead', bot_id: 'b-lead', subject_ref: 'api#31', role: 'review_lead', seat: 'lead-reviewer' }];
  const asked = (id: string, payload: Record<string, unknown>) => ({ ...message(id, 't-lead', '2026-09-30T10:02:00Z'), kind: 'gate' as const, payload: { gateId: `g-${id}`, ...payload } });

  it('lists each one the designer or a standing approval approved, for a person to refuse, and not one taken back', () => {
    const view = itemView({
      item,
      repo: REPOS[0]!,
      bots: BOTS,
      threads,
      messages: [
        asked('m1', { planChange: { paths: ['a/b.ts'], reason: 'r' }, decided: { by: 'designer', seat: 'architect', reason: 'named', at: '2026-09-30T10:03:00Z' } }),
        asked('m2', { planChange: { paths: ['a/c.ts'], reason: 'r' }, decided: { by: 'standing_approval', setBy: 'orzelig', reason: 'r', at: '2026-09-30T10:04:00Z' } }),
        asked('m3', { planChange: { paths: ['a/d.ts'], reason: 'r' }, decided: { by: 'designer', seat: 'architect', at: 't' }, takenBack: { by: 'orzelig', at: 't' } }),
        asked('m4', { planChange: { paths: ['a/e.ts'], reason: 'r' } }),
      ],
      gates: [],
      tasks: [],
    });
    expect(view.settledPlanChanges).toEqual([
      { gateId: 'g-m1', paths: ['a/b.ts'], decidedBy: 'designer', by: 'architect', at: '2026-09-30T10:03:00Z' },
      { gateId: 'g-m2', paths: ['a/c.ts'], decidedBy: 'standing_approval', by: 'orzelig', at: '2026-09-30T10:04:00Z' },
    ]);
  });
});

describe('where a message written on an item goes', () => {
  const item = itemOf('api#12', FACTS)!;
  const base = { timeline: [], tasks: [], stage: 'review' as const };
  const leadGate = { ...gate('g-lead', 't-lead'), subjectRef: 'api#31', role: 'review_lead', bot: 'lead-reviewer', seat: 'lead-reviewer' };
  const secondGate = { ...gate('g-second', 't-second'), subjectRef: 'api#31', role: 'review_second', bot: 'second-reviewer', seat: 'second-reviewer' };

  it('answers the one question open on it', () => {
    expect(routeItemMessage({ ...base, openGates: [leadGate] }, item, BOTS, {})).toEqual({ kind: 'gate', gate: leadGate });
  });

  it('refuses to guess between two questions, and answers the one picked', () => {
    const two = { ...base, openGates: [leadGate, secondGate] };
    expect(routeItemMessage(two, item, BOTS, {})).toMatchObject({ kind: 'refused', status: 409, error: expect.stringMatching(/pick the question you're answering/) });
    expect(routeItemMessage(two, item, BOTS, { gateId: 'g-second' })).toEqual({ kind: 'gate', gate: secondGate });
    expect(routeItemMessage(two, item, BOTS, { role: 'review_lead' })).toEqual({ kind: 'gate', gate: leadGate });
  });

  it('refuses a question on another item', () => {
    const elsewhere = { ...gate('g-x', 't-x'), subjectRef: 'api#99', role: 'intake', bot: 'intake', seat: 'intake' };
    expect(routeItemMessage({ ...base, openGates: [elsewhere] }, item, BOTS, { gateId: 'g-x' })).toMatchObject({ kind: 'refused', status: 409 });
  });

  it('goes to the role’s seat that last spoke, about the pull request for a reviewer and the issue otherwise', () => {
    const timeline = [{ ...message('m2', 't-lead', '2026-09-30T10:02:00Z'), subjectRef: 'api#31', role: 'review_lead', seat: 'lead-reviewer', bot: 'lead-reviewer' }];
    expect(routeItemMessage({ ...base, timeline, openGates: [] }, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'lead-reviewer', subject: 'api#31' });
    expect(routeItemMessage({ ...base, timeline, openGates: [] }, item, BOTS, { role: 'implement' })).toMatchObject({ kind: 'post', bot: 'builder', subject: 'api#12' });
  });

  it('goes to the request before the issue exists', () => {
    const request = itemOf('request:c0ffee00', FACTS)!;
    expect(routeItemMessage({ timeline: [], tasks: [], stage: 'intake', openGates: [] }, request, BOTS, {})).toMatchObject({ kind: 'post', bot: 'intake', subject: 'request:c0ffee00' });
  });
});

describe('whom a message from the conversation goes to', () => {
  // core#5 on 2026-10-24: #7's CI was red, the fix was the builder's, and the
  // conversation's message went to the lead reviewer, who had spoken last.
  const item = itemOf('api#12', FACTS)!;
  const lead = { ...message('m2', 't-lead', '2026-09-30T10:02:00Z'), subjectRef: 'api#31', role: 'review_lead', seat: 'lead-reviewer', bot: 'lead-reviewer' };

  it('is the builder on a pull request in Review whose CI is red, though the lead reviewer spoke last', () => {
    const view = { timeline: [lead], tasks: [], stage: 'review' as const, openGates: [], ciRed: true };
    expect(actsNext(view, BOTS)).toBe('implement');
    expect(routeItemMessage(view, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'builder', role: 'implement', subject: 'api#12' });
    // Green, or not known, it is the lead's, as the stage's role.
    expect(routeItemMessage({ ...view, ciRed: false }, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'lead-reviewer', subject: 'api#31' });
    expect(routeItemMessage({ ...view, ciRed: null }, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'lead-reviewer' });
  });

  it('is the role that works the stage, not the role that last spoke', () => {
    const view = { timeline: [lead], tasks: [], stage: 'build' as const, openGates: [] };
    expect(routeItemMessage(view, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'builder', role: 'implement', subject: 'api#12' });
    // A stage nobody works, or whose role the crew has no seat in: whoever last spoke, as before.
    expect(routeItemMessage({ ...view, stage: 'done' }, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'lead-reviewer' });
    expect(actsNext({ stage: 'spec' }, BOTS)).toBeNull();
  });

  it('is offered by its role beside the tabs’, with what sending it starts', () => {
    const roles = [{ role: 'review_lead', label: 'lead reviewer', seats: [] }];
    const view = { timeline: [lead], tasks: [], stage: 'review' as const, openGates: [], roles, ciRed: true };
    const said: { role: string; bot: string }[] = [];
    const routes = messageRoutes(view, item, BOTS, (route) => {
      said.push(route);
      return route.role === 'implement' ? { kind: 'starts', what: 'a patch round on pull request #31' } : { kind: 'nothing', why: 'its review is already under way' };
    });
    expect(Object.keys(routes)).toEqual(['', 'review_lead', 'implement']);
    expect(routes['']).toEqual({
      kind: 'post',
      bot: 'builder',
      role: 'implement',
      handle: 'acme-crew',
      subject: 'api#12',
      on: 'issue',
      number: 12,
      start: { kind: 'starts', what: 'a patch round on pull request #31' },
    });
    expect(routes['review_lead']).toMatchObject({ bot: 'lead-reviewer', start: { kind: 'nothing', why: 'its review is already under way' } });
    expect(said).toContainEqual({ role: 'implement', bot: 'builder' });
  });
});

describe('where the item’s box says a message goes, before it is sent', () => {
  const item = itemOf('api#12', FACTS)!;
  const roles = [
    { role: 'implement', label: 'builder', seats: [] },
    { role: 'review_lead', label: 'lead reviewer', seats: [] },
  ];
  const lead = { ...message('m2', 't-lead', '2026-09-30T10:02:00Z'), subjectRef: 'api#31', role: 'review_lead', seat: 'lead-reviewer', bot: 'lead-reviewer' };
  const patching = { id: 'k-patch', bot: 'builder', seat: 'builder', role: 'implement', kind: 'patch', state: 'running', round: 2, subjectRef: 'api#12', startedAt: null, endedAt: null, exitReason: null, tmuxSession: 'builder-2', branch: null, costUsd: 0 } as const;

  it('is the lead reviewer on the pull request when the reviewer spoke last, though the builder’s patch is running', () => {
    const view = { timeline: [lead], tasks: [patching], stage: 'review' as const, openGates: [], roles };
    const routes = messageRoutes(view, item, BOTS);
    expect(routes['']).toEqual({ kind: 'post', bot: 'lead-reviewer', role: 'review_lead', handle: 'acme-reviewer', subject: 'api#31', on: 'pull_request', number: 31 });
    // The same answer the send takes.
    expect(routeItemMessage(view, item, BOTS, {})).toMatchObject({ kind: 'post', bot: 'lead-reviewer', subject: 'api#31' });
    expect(routes['implement']).toEqual({ kind: 'post', bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12 });
    expect(Object.keys(routes)).toEqual(['', 'implement', 'review_lead']);
  });

  it('leaves the open questions to the console, and still says where a message would go', () => {
    const asked = { ...gate('g-lead', 't-lead'), subjectRef: 'api#31', role: 'review_lead', bot: 'lead-reviewer', seat: 'lead-reviewer' };
    const routes = messageRoutes({ timeline: [lead], tasks: [], stage: 'review', openGates: [asked], roles }, item, BOTS);
    expect(routes['']).toMatchObject({ kind: 'post', bot: 'lead-reviewer', on: 'pull_request' });
  });

  it('is kept in OpenADLC for a deploy of a commit, which GitHub has no page for', () => {
    const commit = itemOf('api@3f2c1a9', FACTS)!;
    const routes = messageRoutes({ timeline: [], tasks: [], stage: 'merged', openGates: [], roles: [] }, commit, [...BOTS, { id: 'b-deploy', name: 'deployer', slot: 'deployer', role: 'deploy', githubLogin: 'acme-crew' }]);
    expect(routes['']).toEqual({ kind: 'post', bot: 'deployer', role: 'deploy', handle: 'acme-crew', subject: 'api@3f2c1a9', on: 'openadlc', number: null });
  });

  it('is the request’s thread before the issue exists', () => {
    const request = itemOf('request:c0ffee00', FACTS)!;
    expect(messageRoutes({ timeline: [], tasks: [], stage: 'intake', openGates: [], roles: [] }, request, BOTS)['']).toMatchObject({ on: 'request', subject: 'request:c0ffee00', number: null });
  });

  it('says why when nobody has worked on it, rather than naming a destination', () => {
    const routes = messageRoutes({ timeline: [], tasks: [], stage: null, openGates: [], roles: [] }, item, BOTS);
    expect(routes['']).toEqual({ kind: 'refused', error: expect.stringMatching(/nobody has worked on this item yet.*pick a role/) });
  });

  it('offers every role the crew has to pick when nobody has worked on it, each saying where it would go', () => {
    // It asked to "pick a role to write to", and an item nobody had worked on had no role tab to pick.
    const crew = [...BOTS, { id: 'b-auto', name: 'acme-automation', slot: 'automation', role: 'automation' as const, githubLogin: 'acme-automation' }];
    const routes = messageRoutes({ timeline: [], tasks: [], stage: null, openGates: [], roles: [] }, item, crew);
    // Not the automation account's, which reads no message.
    expect(Object.keys(routes)).toEqual(['', 'intake', 'implement', 'review_lead', 'review_second', 'review_security']);
    expect(routes['implement']).toEqual({ kind: 'post', bot: 'builder', role: 'implement', handle: 'acme-crew', subject: 'api#12', on: 'issue', number: 12 });
    expect(routes['review_lead']).toMatchObject({ kind: 'post', bot: 'lead-reviewer', on: 'pull_request', number: 31 });
    // A role a tab already names is not offered twice.
    const tabbed = messageRoutes({ timeline: [], tasks: [], stage: null, openGates: [], roles: [{ role: 'implement', label: 'builder', seats: [] }] }, item, BOTS);
    expect(Object.keys(tabbed)).toEqual(['', 'implement', 'intake', 'review_lead', 'review_second', 'review_security']);
  });

  it('asks for no role when the crew has none a message can go to', () => {
    const alone = [{ id: 'b-auto', name: 'acme-automation', slot: 'automation', role: 'automation' as const, githubLogin: 'acme-automation' }];
    const routes = messageRoutes({ timeline: [], tasks: [], stage: null, openGates: [], roles: [] }, item, alone);
    expect(Object.keys(routes)).toEqual(['']);
    expect(routes['']).toEqual({ kind: 'refused', error: 'nobody has worked on this item yet, and the crew has no seat that reads a message; add one in Settings → Crew' });
  });
});

describe('holding, putting next or cancelling a pull request alone on its item', () => {
  const pull = (state: 'open' | 'closed' | 'merged') => ({
    key: 'api#40',
    issue: null,
    request: null,
    pr: 40,
    repo: 'api',
    links: [{ kind: 'pull' as const, repo: 'api', number: 40, ref: 'api#40', title: 'A fix', state, stage: null, url: null, linkedBy: null }],
  });

  it('refuses a merged one as merged work, before anything is stopped, whether GitHub or the link says so', () => {
    expect(lonePullRefusal(pull('open'), true)).toMatch(/already merged, so it cannot be cancelled/);
    expect(lonePullRefusal(pull('merged'), null)).toMatch(/already merged/);
  });

  it('refuses an open one, which has no issue to hold or close', () => {
    expect(lonePullRefusal(pull('open'), false)).toMatch(/pull request with no issue/);
    expect(lonePullRefusal(pull('open'), null)).toMatch(/pull request with no issue/);
  });

  it('leaves an issue or a request alone', () => {
    expect(lonePullRefusal({ ...pull('merged'), issue: { number: 12 } as never }, true)).toBeNull();
    expect(lonePullRefusal({ ...pull('open'), pr: null }, null)).toBeNull();
  });
});

describe('what an item’s pause, next and cancel act on', () => {
  it('is its own issue, its pull request and its requests, never a second link', () => {
    const item = itemOf('api#12', FACTS)!;
    const linked = { ...item, subjects: [...item.subjects, 'api#15', 'web#3'] };
    expect(ownSubjects(linked).sort()).toEqual(['api#12', 'api#31', 'request:a4b02784']);
    // A deploy of a commit is its own subject.
    expect(ownSubjects(itemOf('api@3f2c1a9', FACTS)!)).toEqual(['api@3f2c1a9']);
  });

  it('is refused for an issue the board has no row for, though a pull is linked beside it', () => {
    const link = (state: 'open' | 'closed') => ({ kind: 'issue' as const, repo: 'api', number: 77, ref: 'api#77', title: 'An old report', state, stage: null, url: null, linkedBy: null });
    const item = { key: 'api#77', issue: null, request: null, pr: 40, repo: 'api', links: [], issueLink: link('closed') };
    // Not "a pull request with no issue": it has one, which the board has not read.
    expect(controlRefusal(item, false)).toMatch(/^api#77 was closed before OpenADLC read it/);
    expect(controlRefusal({ ...item, issueLink: link('open') }, false)).toMatch(/^api#77 is not on the board yet/);
    expect(controlRefusal({ ...item, issue: { number: 77 } as never }, false)).toBeNull();
    expect(controlRefusal({ ...item, issueLink: null }, false)).toMatch(/pull request with no issue/);
  });
});
