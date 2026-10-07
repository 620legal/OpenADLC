import type { ItemGate, ItemRoute, ItemTask, ItemView } from './api';
import { ROLES } from './bot-label';
import { withoutComments } from './comments';
import { dayLabel, personName, sentenceFor, standsOut, timeOf, type Tone } from './thread';

/**
 * A work item as its view shows it: who said each thing, by role and seat;
 * which roles get a tab of their own; which tasks have a computer to look at;
 * and where a message written on it goes.
 *
 * Seats sharing one GitHub account are one handle on GitHub, so the handle
 * alone cannot say who spoke: the role does, and the handle is said beside it
 * ("lead reviewer · acme-reviewer"). The role comes from the bridge, which
 * kept it on each thread when it was opened (`apps/bridge/src/items.ts`).
 */

const BY_ROLE: Readonly<Record<string, { seat: string; label: string }>> = ROLES;

/**
 * A subject from a route's `[subject]` segment. `repo#12` and `request:a4b0`
 * travel encoded (`#` would end the path), and whether the segment arrives
 * decoded depends on how Next routed it, so one still encoded is decoded here
 * — once: a subject never contains `%` of its own.
 */
export function subjectFrom(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A role in words, "lead reviewer"; a role this console does not know is said as it is. */
export function roleWords(role: string | null | undefined): string {
  if (!role) return 'the crew';
  return BY_ROLE[role]?.label ?? role.replace(/_/g, ' ');
}

/** The account a seat posts as, or the seat itself before one is connected. */
export function seatHandle(view: Pick<ItemView, 'roles'>, role: string | null, seat: string | null, bot: string | null): string | null {
  const found = view.roles.find((one) => one.role === role)?.seats.find((one) => one.slot === seat || one.bot === bot);
  return found?.githubLogin ?? found?.bot ?? bot ?? seat;
}

/** "lead reviewer · acme-reviewer": what heads everything a seat said on an item. */
export function speakerLabel(view: Pick<ItemView, 'roles'>, entry: { role: string | null; seat: string | null; bot: string | null }): string {
  const handle = seatHandle(view, entry.role, entry.seat, entry.bot);
  const role = roleWords(entry.role);
  // A seat with no account yet is its own name, which for a default seat is
  // the role again: "builder · builder".
  return handle && handle !== role ? `${role} · ${handle}` : role;
}

/** One tab per role on the item, in pipeline order: two seats on one account are two tabs. */
export function roleTabs(view: Pick<ItemView, 'roles'>): { value: string; role: string; label: string; shared: boolean }[] {
  return view.roles.map((role) => ({
    value: `role:${role.role}`,
    role: role.role,
    label: roleWords(role.role),
    shared: role.seats.some((seat) => seat.sharedAccount),
  }));
}

/** A task whose computer is worth looking at: going now, in a session of its own. */
export function liveTasks(view: Pick<ItemView, 'tasks'>): ItemTask[] {
  return view.tasks.filter((task) => (task.state === 'running' || task.state === 'paused') && Boolean(task.tmuxSession));
}

/**
 * "lead reviewer · acme-reviewer": what a task's Computer and Terminal tabs
 * are labelled by, the way the conversation names the bot. By the seat, a
 * default seat said its role twice: "Computer · builder · builder".
 */
export function taskLabel(view: Pick<ItemView, 'roles'>, task: Pick<ItemTask, 'role' | 'seat' | 'bot'>): string {
  return speakerLabel(view, task);
}

export type ItemEntry =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'line'; key: string; time: string; text: string; note: string | null; tone: Tone; url: string | null; speaker: string }
  | {
      kind: 'bubble';
      key: string;
      time: string;
      who: 'bot' | 'person';
      /** "lead reviewer · acme-reviewer" for a bot; the person's name otherwise. */
      speaker: string;
      role: string | null;
      bot: string | null;
      text: string;
      note: string | null;
      url: string | null;
      /** A question a seat asked, open while it still waits. */
      question?: { gateId: string | null; options: string[]; open: boolean; githubUrl: string | null };
    };

function readable(text: string): string {
  return withoutComments(text).trim();
}

/**
 * The item's conversation in the order it happened, each entry headed by the
 * role and seat that said it. With `role`, only what was said in that role's
 * threads; a person's own words in those threads are kept, since they were
 * written to that role.
 */
export function itemEntries(
  view: Pick<ItemView, 'roles' | 'timeline' | 'openGates'>,
  input: { now: string; role?: string | null; timeZone?: string },
): ItemEntry[] {
  const entries: ItemEntry[] = [];
  const open = new Map(view.openGates.map((gate) => [gate.id, gate]));
  const shown = view.timeline.filter((message) => !input.role || message.role === input.role);
  const say = (ref: string) => ref;
  let lastDay: string | null = null;

  for (const message of shown) {
    const day = dayLabel(message.at, input.now, input.timeZone);
    if (day !== lastDay) {
      entries.push({ kind: 'day', key: `day-${message.id}`, label: day });
      lastDay = day;
    }
    const time = timeOf(message.at, input.timeZone);
    const speaker = speakerLabel(view, message);

    if (message.kind === 'sys' || message.kind === 'procs') {
      entries.push({ kind: 'line', key: message.id, time, ...sentenceFor(message, say), url: message.githubUrl, speaker });
      continue;
    }
    if (message.kind === 'you') {
      entries.push({
        kind: 'bubble',
        key: message.id,
        time,
        who: 'person',
        speaker: personName(message.author),
        role: message.role,
        bot: message.bot,
        text: readable(message.text),
        note: message.payload?.gateId ? `answered ${roleWords(message.role)}` : `to ${roleWords(message.role)}`,
        url: message.githubUrl,
      });
      continue;
    }
    const gateId = message.kind === 'gate' && typeof message.payload?.gateId === 'string' ? message.payload.gateId : null;
    const gate = gateId ? open.get(gateId) : undefined;
    const options = Array.isArray(message.payload?.options) ? (message.payload.options as unknown[]).map(String) : [];
    entries.push({
      kind: 'bubble',
      key: message.id,
      time,
      who: 'bot',
      speaker,
      role: message.role,
      bot: message.bot,
      text: readable(message.text),
      note: message.kind === 'gate' ? (gate ? 'waiting for your answer' : 'asked') : message.note,
      url: message.githubUrl,
      ...(message.kind === 'gate'
        ? { question: { gateId, options: gate?.options ?? options, open: Boolean(gate), githubUrl: gate?.githubCommentUrl ?? message.githubUrl } }
        : {}),
    });
  }
  return entries;
}

/** The questions open on the item, or on one role of it. */
export function questionsFor(view: Pick<ItemView, 'openGates'>, role?: string | null): ItemGate[] {
  return view.openGates.filter((gate) => !role || gate.role === role);
}

export interface ItemComposer {
  /** Answer `gateId`; send a message; or nothing yet, until a question or a role is picked. */
  mode: 'answer' | 'send' | 'pick';
  gateId: string | null;
  helper: string;
}

/** "posted on pull request #31 as a comment": where the bridge puts a message. */
function placeOf(route: Extract<ItemRoute, { kind: 'post' }>): string {
  switch (route.on) {
    case 'pull_request':
      return `posted on pull request #${route.number} as a comment`;
    case 'issue':
      return `posted on #${route.number} as a comment`;
    case 'request':
      return 'added to the request’s thread';
    default:
      return 'kept in OpenADLC, not posted on GitHub';
  }
}

/**
 * Where a message written on the item goes, said before it is sent, as the
 * bridge will route it: the picked question, else the one question open,
 * else the seat and place the bridge names for this tab (`view.routes`).
 * Two or more open and none picked is not sent at all — the bridge would
 * refuse to guess, so the box asks first; nor is a message the bridge would
 * refuse for want of a seat.
 *
 * The seat and place come from the bridge, worked out by the function its
 * send uses. Worked out here, the box said "to whoever is working on it, on
 * the issue" while the bridge posted on the pull request as the reviewer.
 */
export function itemComposer(
  view: Pick<ItemView, 'openGates' | 'routes'>,
  input: { role?: string | null; picked?: string | null },
): ItemComposer {
  const open = questionsFor(view, input.role);
  const picked = input.picked ? open.find((gate) => gate.id === input.picked) : undefined;
  const gate = picked ?? (open.length === 1 ? open[0] : undefined);
  if (gate) {
    return { mode: 'answer', gateId: gate.id, helper: `Answers the ${roleWords(gate.role)}’s question${standsOut(gate.question) ? `: “${gate.question.trim()}”` : ''}` };
  }
  if (open.length > 1) {
    return { mode: 'pick', gateId: null, helper: `${open.length} questions are open: pick the one you are answering above.` };
  }
  const route = view.routes?.[input.role ?? ''];
  if (!route) {
    // A bridge from before it said where; the role is all that is known.
    return { mode: 'send', gateId: null, helper: `To ${input.role ? `the ${roleWords(input.role)}` : 'whoever is working on it'}` };
  }
  if (route.kind === 'refused') {
    // "Nobody has worked on this item yet…; pick a role to write to": the tabs are above.
    return { mode: 'pick', gateId: null, helper: `${route.error.charAt(0).toUpperCase()}${route.error.slice(1)}.` };
  }
  return { mode: 'send', gateId: null, helper: `To the ${roleWords(route.role)} (${route.handle ?? route.bot}), ${placeOf(route)}` };
}
