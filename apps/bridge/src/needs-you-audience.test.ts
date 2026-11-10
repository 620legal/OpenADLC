import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from './attention.js';
import { AUDIENCE, audienceOf, openGatesFor, questionAudience, routedPeople, viewerOf, visibleTo, withAudiences, type AudienceFacts } from './needs-you-audience.js';

const A = { id: 'p-alice', name: 'Alice', email: 'alice@example.com', githubLogin: 'alice', consoleRole: 'user' as const, approves: false };
const B = { id: 'p-bob', name: 'Bob', email: 'bob@example.com', githubLogin: 'bob', consoleRole: 'user' as const, approves: false };
const ADMIN = { id: 'p-ada', name: 'Ada', email: 'ada@example.com', githubLogin: null, consoleRole: 'admin' as const, approves: true };

const FACTS: AudienceFacts = {
  people: [A, B, ADMIN],
  roles: [
    { id: 'product', name: 'Product', members: [] },
    { id: 'legal', name: 'Legal', members: ['p-alice'] },
    { id: 'engineering', name: 'Engineering', members: ['p-bob'] },
  ],
};

function item(kind: AttentionKind, extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `${kind}:1`,
    kind,
    headline: 'h',
    subject: { repo: null, number: null, title: null, ref: null, url: null, item: null },
    bot: null,
    since: '2026-11-10T00:00:00.000Z',
    detail: 'd',
    actions: [],
    ...extra,
  };
}

const question = (extra: Partial<NonNullable<AttentionItem['question']>>) =>
  item('question', { question: { gateId: 'g-1', options: ['yes', 'no'], ...extra } });

describe('who a Needs-you item is for', () => {
  it('gives a question that names a held role to that role’s people only', () => {
    expect(audienceOf(question({ personRole: 'legal', personRoleAsked: 'Legal' }), FACTS)).toEqual({ for: 'role', name: 'Legal', people: ['p-alice'] });
  });

  it('falls back to everyone, saying why, for no role, an unknown role, or a role nobody holds', () => {
    expect(audienceOf(question({}), FACTS)).toEqual({ for: 'everyone', name: 'everyone', people: [], why: 'the question names no role' });
    expect(audienceOf(question({ personRole: null, personRoleAsked: 'Privacy' }), FACTS).why).toBe('no role here is called Privacy');
    expect(audienceOf(question({ personRole: 'product', personRoleAsked: 'product' }), FACTS).why).toBe('no one holds Product yet');
    // A custom role deleted after its gate opened is no role here either.
    expect(audienceOf(question({ personRole: 'pr_0000abcd', personRoleAsked: 'Privacy' }), FACTS).why).toBe('no role here is called Privacy');
  });

  it('gives a plan change to the approvers and a cost-cap question to the admins, whatever role it names', () => {
    expect(audienceOf(question({ planChange: true, personRole: 'legal' }), FACTS)).toEqual({ for: 'approvers', name: 'approvers', people: ['p-ada'] });
    expect(audienceOf(question({ costCap: true }), FACTS)).toEqual({ for: 'admins', name: 'admins', people: ['p-ada'] });
    expect(audienceOf(item('promote_held'), FACTS).for).toBe('approvers');
    expect(audienceOf(item('plan_change_waiting'), FACTS).for).toBe('approvers');
    expect(audienceOf(item('promote_held'), { ...FACTS, people: [A, B] }).why).toBe('no one approves yet');
  });

  it('gives what is wrong with the install to the admins, and the crew’s work to Engineering', () => {
    for (const kind of ['check_failed', 'check_fixed', 'engine_update_failed', 'self_update_failed', 'design_memory_superseded', 'work_stuck'] as const) {
      expect(audienceOf(item(kind), FACTS), kind).toEqual({ for: 'admins', name: 'admins', people: ['p-ada'] });
    }
    for (const kind of ['task_failed', 'triage_failed', 'review_stalled', 'send_back_held', 'unowned_issues', 'dependency_abandoned', 'resume_waiting', 'stack_held'] as const) {
      expect(audienceOf(item(kind), FACTS), kind).toEqual({ for: 'role', name: 'Engineering', people: ['p-bob'] });
    }
    expect(audienceOf(item('task_failed'), { ...FACTS, roles: FACTS.roles.map((role) => ({ ...role, members: [] })) }).why).toBe('no one holds Engineering yet');
  });

  it('gives a pull request waiting on one person’s approval to them, or the approvers when People has no one by that login', () => {
    expect(audienceOf(item('merge_waiting', { awaiting: { login: 'Alice', again: false, paths: [] } }), FACTS)).toEqual({ for: 'person', name: 'Alice', people: ['p-alice'] });
    expect(audienceOf(item('merge_waiting', { awaiting: { login: 'carol', again: true, paths: [] } }), FACTS).for).toBe('approvers');
    expect(audienceOf(item('merge_waiting'), FACTS)).toEqual({ for: 'role', name: 'Engineering', people: ['p-bob'] });
  });

  it('gives every kind a rule', () => {
    expect(Object.keys(AUDIENCE).sort()).toContain('question');
    for (const rule of Object.values(AUDIENCE)) expect(['question', 'merge', 'approvers', 'admins', 'engineering']).toContain(rule);
  });

  it('leaves a member who is no longer in People out of a role', () => {
    const facts = { ...FACTS, roles: [{ id: 'legal', name: 'Legal', members: ['p-gone'] }] };
    expect(questionAudience({ personRole: 'legal' }, facts).why).toBe('no one holds Legal yet');
  });
});

describe('whose list an item is in', () => {
  const legal = { audience: audienceOf(question({ personRole: 'legal' }), FACTS) };
  const unrouted = { audience: audienceOf(question({}), FACTS) };
  const system = { audience: audienceOf(item('check_failed'), FACTS) };

  it('finds the viewer by the email they signed in with', () => {
    expect(viewerOf('Alice@Example.com', FACTS)?.id).toBe('p-alice');
    expect(viewerOf('accounts.google.com:bob@example.com', FACTS)?.id).toBe('p-bob');
    expect(viewerOf('nobody@example.com', FACTS)).toBeNull();
  });

  it('shows a routed item to its people only, and one for everyone to all', () => {
    expect(visibleTo(A, legal)).toBe(true);
    expect(visibleTo(B, legal)).toBe(false);
    // An admin is not given another role's question for being an admin.
    expect(visibleTo(ADMIN, legal)).toBe(false);
    expect(visibleTo(ADMIN, system)).toBe(true);
    expect(visibleTo(A, system)).toBe(false);
    for (const viewer of [A, B, ADMIN, null]) expect(visibleTo(viewer, unrouted)).toBe(true);
    expect(visibleTo(null, legal)).toBe(false);
  });

  it('routes nothing on a local install, where everything is the one person’s', () => {
    const items = [question({ personRole: 'legal' }), item('check_failed')];
    expect(withAudiences(items, FACTS, true).every((one) => one.audience === undefined)).toBe(true);
    expect(withAudiences(items, FACTS, false).map((one) => one.audience?.for)).toEqual(['role', 'admins']);
  });

  it('notifies a routed item’s people and leaves one for everyone to the install’s channel', () => {
    expect(routedPeople(legal)).toEqual(['p-alice']);
    expect(routedPeople(unrouted)).toBeUndefined();
    expect(routedPeople({})).toBeUndefined();
  });

  it('counts only the viewer’s open questions on the board, and every unrouted one', () => {
    const gates = [
      { id: 'g-legal', options: ['yes'], personRole: 'legal', personRoleAsked: 'Legal' },
      { id: 'g-none', options: ['yes'] },
      { id: 'g-plan', options: ['Approve', 'Refuse'] },
    ];
    const plans = new Set(['g-plan']);
    expect(openGatesFor('alice@example.com', gates, FACTS, plans)).toBe(2);
    expect(openGatesFor('bob@example.com', gates, FACTS, plans)).toBe(1);
    expect(openGatesFor('ada@example.com', gates, FACTS, plans)).toBe(2);
  });

  it('follows who holds a role now, with the item unchanged', () => {
    const gate = question({ personRole: 'legal' });
    const moved: AudienceFacts = { ...FACTS, roles: [{ id: 'legal', name: 'Legal', members: ['p-bob'] }] };
    expect(visibleTo(A, { audience: audienceOf(gate, FACTS) })).toBe(true);
    expect(visibleTo(A, { audience: audienceOf(gate, moved) })).toBe(false);
    expect(visibleTo(B, { audience: audienceOf(gate, moved) })).toBe(true);
  });
});
