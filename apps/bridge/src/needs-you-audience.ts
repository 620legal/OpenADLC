import { people as peopleStore, settings } from '@openadlc/db';
import { costCapAnswer, parsePersonRoles, personRoleByName, personRoleLabel, viewPersonRoles } from '@openadlc/shared';
import type { AttentionItem, AttentionKind } from './attention.js';

/**
 * Who a Needs-you item is for (ADR 0035): a person role's holders, the
 * approvers, one person, the admins, or everyone when that comes to nobody.
 *
 * Worked out on every read from who is in People and who holds which role
 * now, and never stored: moving a person into or out of a role changes what
 * they see on their next load, without rewriting a single item. The one fact
 * kept is the role a question names, fixed when its gate opens
 * (`gates.person_role`).
 *
 * Only what reaches a person is routed: their list, its badge and their
 * notifications. Who may answer is not (`mayAnswerGates`, the answer routes),
 * and anyone with access still opens an item by its link.
 */

export type AudienceFor = 'role' | 'approvers' | 'admins' | 'person' | 'everyone';

export interface Audience {
  for: AudienceFor;
  /** As a card says it: `Legal`, `approvers`, `admins`, a person's name, or `everyone`. */
  name: string;
  /** The people it reaches, by person id; empty for everyone. */
  people: string[];
  /** Why it is for everyone, when it fell back there: "no one holds Legal yet". */
  why?: string;
  /**
   * Worked out on a pass whose read of People or the roles failed: from the
   * last read that worked, or, with none, the admins' alone. Such a pass
   * sends no routed notification and mentions nobody (`mayNotify`).
   */
  unread?: true;
}

/** How each kind finds its audience. */
type Rule = 'question' | 'merge' | 'approvers' | 'admins' | 'engineering';

/**
 * Every kind's rule: a new kind does not compile until it is given one, as
 * with its group (`GROUP`). The crew's own work is Engineering's, an approval
 * is the approvers' whatever their role, and what is wrong with the install
 * itself is the admins'.
 */
export const AUDIENCE: Record<AttentionKind, Rule> = {
  question: 'question',
  merge_waiting: 'merge',
  promote_held: 'approvers',
  plan_change_waiting: 'approvers',
  review_stalled: 'engineering',
  send_back_held: 'engineering',
  task_failed: 'engineering',
  triage_failed: 'engineering',
  unowned_issues: 'engineering',
  dependency_abandoned: 'engineering',
  resume_waiting: 'engineering',
  stack_held: 'engineering',
  check_failed: 'admins',
  check_fixed: 'admins',
  engine_update_failed: 'admins',
  self_update_failed: 'admins',
  design_memory_superseded: 'admins',
  work_stuck: 'admins',
};

/** A person as routing reads them. */
export interface AudiencePerson {
  id: string;
  name?: string | null;
  email: string | null;
  githubLogin: string | null;
  consoleRole: 'admin' | 'user' | null;
  approves: boolean;
}

/** The install's people and its roles, with each role's members as person ids still in People. */
export interface AudienceFacts {
  people: readonly AudiencePerson[];
  roles: readonly { id: string; name: string; members: readonly string[] }[];
  /**
   * Set when this pass could not read them: `last` is the last read that
   * worked, `none` means there has been none, and `people` and `roles` are
   * empty. Absent, they were read now.
   */
  unread?: 'last' | 'none';
}

/** What a question's gate says about whom it is for. */
export interface QuestionRouting {
  /** The role's id, resolved when the gate opened; null when it named none the install had. */
  personRole?: string | null;
  /** The role's name as the bot wrote it. */
  personRoleAsked?: string | null;
  /** A plan change: the approvers decide it. */
  planChange?: boolean;
  /** A task at its cost cap: money is the admins'. */
  costCap?: boolean;
}

const ENGINEERING = 'engineering';

function everyone(why: string): Audience {
  return { for: 'everyone', name: 'everyone', people: [], why };
}

function roleAudience(roleId: string | null | undefined, asked: string | null | undefined, facts: AudienceFacts): Audience {
  // A gate that opened while the roles could not be read kept only the name
  // it asked for, so it is found by that name: left at no id, a Legal question
  // asked during an outage would have said "no role here is called Legal",
  // and been everyone's, for good.
  const role = roleId ? facts.roles.find((one) => one.id === roleId) : personRoleByName(asked, facts.roles);
  if (!role) {
    const named = asked?.trim();
    return everyone(named ? `no role here is called ${named}` : 'the question names no role');
  }
  const known = new Set(facts.people.map((person) => person.id));
  const people = role.members.filter((id) => known.has(id));
  return people.length > 0 ? { for: 'role', name: role.name, people } : everyone(`no one holds ${role.name} yet`);
}

function approvers(facts: AudienceFacts): Audience {
  const people = facts.people.filter((person) => person.approves).map((person) => person.id);
  return people.length > 0 ? { for: 'approvers', name: 'approvers', people } : everyone('no one approves yet');
}

function admins(facts: AudienceFacts): Audience {
  const people = facts.people.filter((person) => person.consoleRole === 'admin').map((person) => person.id);
  return people.length > 0 ? { for: 'admins', name: 'admins', people } : everyone('no one is an admin yet');
}

/** Whether a gate is the one a task at its cost cap asks (`costCapGate`), told by its choices. */
export function isCostCapGate(options: readonly string[]): boolean {
  return costCapAnswer(options[1] ?? '', options) !== null;
}

/**
 * How many open questions are in one person's Needs you: the board's
 * `waitingOnYou`. Read from the gates, as the board reads them, by the same
 * rule as their cards.
 */
export function openGatesFor(
  identity: string,
  gates: readonly { id: string; options: readonly string[]; personRole?: string | null; personRoleAsked?: string | null }[],
  facts: AudienceFacts,
  planChanges: ReadonlySet<string>,
  consoleRole: ConsoleRole = null,
): number {
  const viewer = viewerOf(identity, facts);
  return gates.filter((gate) => {
    const audience = questionAudience({ ...gate, planChange: planChanges.has(gate.id), costCap: isCostCapGate(gate.options) }, facts);
    return visibleTo(viewer, { audience }, consoleRole);
  }).length;
}

/**
 * With no read of People and the roles yet, whom an item is for cannot be
 * told, and widening it to everyone because a read failed would show a Legal
 * question to everyone it was kept from. So it is the admins', known by the
 * console role a viewer signed in with (`visibleTo`), until a read works.
 */
const ADMINS_UNREAD: Audience = { for: 'admins', name: 'admins', people: [], unread: true };

function marked(audience: Audience, facts: AudienceFacts): Audience {
  if (!facts.unread) return audience;
  return facts.unread === 'none' ? { ...ADMINS_UNREAD } : { ...audience, unread: true };
}

/** A question's audience, from what its gate says: the same for its card, its comment and its notification. */
export function questionAudience(routing: QuestionRouting, facts: AudienceFacts): Audience {
  if (routing.planChange) return marked(approvers(facts), facts);
  if (routing.costCap) return marked(admins(facts), facts);
  return marked(roleAudience(routing.personRole, routing.personRoleAsked, facts), facts);
}

/** An item's audience, read from its kind and what it carries. */
export function audienceOf(item: Pick<AttentionItem, 'kind' | 'question' | 'awaiting'>, facts: AudienceFacts): Audience {
  return marked(kindAudience(item, facts), facts);
}

function kindAudience(item: Pick<AttentionItem, 'kind' | 'question' | 'awaiting'>, facts: AudienceFacts): Audience {
  switch (AUDIENCE[item.kind]) {
    case 'question':
      return questionAudience(item.question ?? {}, facts);
    case 'merge': {
      // A pull request waiting on one person's approval is theirs; one
      // waiting for a person to merge it is the crew's work, Engineering's.
      const login = item.awaiting?.login.toLowerCase();
      if (!login) return roleAudience(ENGINEERING, 'Engineering', facts);
      const person = facts.people.find((one) => one.githubLogin?.toLowerCase() === login);
      return person ? { for: 'person', name: personRoleLabel(person), people: [person.id] } : approvers(facts);
    }
    case 'approvers':
      return approvers(facts);
    case 'admins':
      return admins(facts);
    case 'engineering':
      return roleAudience(ENGINEERING, 'Engineering', facts);
  }
}

/**
 * Every item with its audience. A local install has one console identity, so
 * everything is that person's and nothing is routed: its items carry none.
 */
export function withAudiences(items: readonly AttentionItem[], facts: AudienceFacts, local: boolean): AttentionItem[] {
  if (local) return [...items];
  return items.map((item) => ({ ...item, audience: audienceOf(item, facts) }));
}

/** The person signed in to the console, by their email; null when People has nobody by it. */
export function viewerOf(identity: string, facts: AudienceFacts): AudiencePerson | null {
  const email = normalized(identity);
  if (!email) return null;
  return facts.people.find((person) => person.email !== null && normalized(person.email) === email) ?? null;
}

function normalized(email: string): string {
  return email.trim().replace(/^accounts\.google\.com:/i, '').replace(/^user:/i, '').trim().toLowerCase();
}

/** The console role a viewer signed in with, as the router gives it; null when unknown. */
export type ConsoleRole = 'admin' | 'user' | null;

/**
 * Whether an item is in a viewer's Needs you: one for everyone, or for no one
 * in particular, is everyone's. One that is the admins' because People could
 * not be read is in the list of whoever signed in as an admin.
 */
export function visibleTo(viewer: Pick<AudiencePerson, 'id'> | null, item: Pick<AttentionItem, 'audience'>, consoleRole: ConsoleRole = null): boolean {
  const audience = item.audience;
  if (!audience || audience.for === 'everyone') return true;
  if (audience.unread && audience.for === 'admins' && audience.people.length === 0) return consoleRole === 'admin';
  return viewer !== null && audience.people.includes(viewer.id);
}

/**
 * Whether a notification, or a mention, may go out about an item on this
 * pass: not when it is routed and who it is routed to was not read now. It
 * goes out on a later pass that reads them.
 */
export function mayNotify(audience: Audience | null | undefined): boolean {
  return !audience?.unread || audience.for === 'everyone';
}

/** The people a notification about an item goes to, each on their own channel; undefined when it is for everyone. */
export function routedPeople(item: Pick<AttentionItem, 'audience'>): string[] | undefined {
  const audience = item.audience;
  return audience && audience.for !== 'everyone' && audience.people.length > 0 ? [...audience.people] : undefined;
}

/**
 * Keeps the last read of People and the roles that worked, and gives it, so
 * marked, when a read fails: a database hiccup must not hand a Legal question
 * to everyone, nor hide an approval from the approvers. With no read yet the
 * facts say so (`unread: 'none'`), and items are the admins' alone.
 */
export function lastGoodAudienceFacts(
  read: () => Promise<AudienceFacts>,
  say: (line: string) => void = console.warn,
): () => Promise<AudienceFacts> {
  let last: AudienceFacts | null = null;
  return async () => {
    try {
      const fresh = await read();
      last = fresh;
      return fresh;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      say(`[bridge] could not read People and the roles for Needs you, so ${last ? 'the last read is used' : 'routed items are the admins’ alone'}: ${why}`);
      return last ? { ...last, unread: 'last' } : { people: [], roles: [], unread: 'none' };
    }
  };
}

/** People, and the roles with their members still in it, read now; throws when either cannot be. */
export async function readFreshAudienceFacts(): Promise<AudienceFacts> {
  const [people, raw] = await Promise.all([peopleStore.listPeople(), settings.getSetting('personRoles')]);
  const ids = people.map((person) => person.id);
  return {
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      githubLogin: person.githubLogin,
      consoleRole: person.consoleRole,
      approves: person.approves,
    })),
    roles: viewPersonRoles(parsePersonRoles(raw), ids),
  };
}

/**
 * The facts read once per request, and the last read that worked when one
 * fails (`lastGoodAudienceFacts`). One for the bridge, so the gates, the list
 * and the notifications share what was last read.
 */
export const readAudienceFacts = lastGoodAudienceFacts(readFreshAudienceFacts);
