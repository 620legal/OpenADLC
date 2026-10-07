import { describe, expect, it } from 'vitest';
import type { Gate, Message } from '@fleetadlc/shared';
import { itemOf, itemView, messageRoutes, routeItemMessage, type ItemBot, type ItemTaskRow } from './items.js';

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
    expect(routes['']).toEqual({ kind: 'post', bot: 'deployer', role: 'deploy', handle: 'acme-crew', subject: 'api@3f2c1a9', on: 'fleetadlc', number: null });
  });

  it('is the request’s thread before the issue exists', () => {
    const request = itemOf('request:c0ffee00', FACTS)!;
    expect(messageRoutes({ timeline: [], tasks: [], stage: 'intake', openGates: [], roles: [] }, request, BOTS)['']).toMatchObject({ on: 'request', subject: 'request:c0ffee00', number: null });
  });

  it('says why when nobody has worked on it, rather than naming a destination', () => {
    const routes = messageRoutes({ timeline: [], tasks: [], stage: null, openGates: [], roles: [] }, item, BOTS);
    expect(routes['']).toEqual({ kind: 'refused', error: expect.stringMatching(/nobody has worked on this item yet.*pick a role/) });
  });
});

