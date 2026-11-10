import { leases, listEventsOfType, mergeLines } from '@openadlc/db';
import { hasAbandonedLabel, hasPausedLabel, sameLogin } from '@openadlc/shared';
import { heldForPerson } from './merge-line.js';
import { heldStacks, stackLinks, stackWaitsOn, type HeldStack, type StackLink } from './stacking.js';
import type { CardWaiting, WaitingReason } from './waiting.js';
import {
  issueForSubject,
  PERSON_ASKED_AGAIN,
  PERSON_AWAITED,
  REVIEW_ROUND_OPENED,
  REVIEW_STALLED,
  REVIEW_SUBMITTED_ON,
  standingStalls,
  type IssueFacts,
  type TaskFacts,
} from './work.js';

/**
 * A waiting card's wait, followed to its root: the one thing that has to
 * happen before it, and every card behind it, goes on.
 *
 * A card said what it waited on one step deep. On 2026-10-30 #216 and #214
 * waited for the build slot; the paused #217 held it, waiting for files #207
 * held; #207's pull request was stacked on #206's; and #206's waited for a
 * person's approval. Four cards sat for hours, only the last link was a
 * person's to do, and no card said so.
 *
 * Followed from live state, in the board's read and Needs you's alike, from
 * the same reads (`readWaitFacts`) and the same pure functions, and stored
 * nowhere: a stored chain would be stale the moment a lease moved (ADR 0023).
 */

/** How many links a chain is followed before it stops with the last node it reached. */
export const MAX_WAIT_DEPTH = 12;

/**
 * A plan change a person approved that waits for other work to let go of its
 * paths (`Gates.approve`, `leases.listHeldPlanChanges`): its gate stays open,
 * and `blockedBy` is the issues holding them. `failed` is why adding them
 * failed once nothing held them, when it did.
 */
export interface HeldPlanChange {
  gateId: string;
  paths: string[];
  approvedBy: string;
  blockedBy: number[];
  failed?: string;
}

type Events = readonly { at: string; payload: unknown }[];

/**
 * What following a wait reads beyond the cards and their tasks: what Needs
 * you alone read before, so the board and Needs you follow a wait on the same
 * facts. Each part absent holds nothing.
 */
export interface WaitFacts {
  /** Approved plan changes whose gate stays open until other work lets go of their paths. */
  heldPlanChanges?: readonly HeldPlanChange[];
  /** Pull requests the merge line holds for a person, and why (`heldForPerson`). */
  heldMerges?: readonly { repo: string; prNumber: number; reason: string; since: string }[];
  /** The people asked to approve again (`PERSON_ASKED_AGAIN`), and the reviews people submitted (`REVIEW_SUBMITTED_ON`). */
  personAsks?: Events;
  personReviews?: Events;
  /** The people crew pull requests wait on for a first approval (`PERSON_AWAITED`), and the review rounds opened (`REVIEW_ROUND_OPENED`). */
  personAwaits?: Events;
  roundsOpened?: Events;
  /** The stacked changes OpenADLC holds (`heldStacks`). */
  heldStacks?: readonly HeldStack[];
  /** Every stack of a repository with an issue in Build or Review (`stackLinks`); which still wait is `stackWaitsOn`'s. */
  stackLinks?: readonly StackLink[];
  /**
   * The review loops that stopped (`REVIEW_STALLED`), over the same window as
   * the asks and awaits. The board read its own 30 days of them for a card's
   * stall line, and a chain on those ended at a `stall:` item Needs you, on 7,
   * did not have.
   */
  stallEvents?: Events;
}

/** A person asked to approve a pull request again (`PERSON_ASKED_AGAIN`), as its card reads it. */
export interface PersonAsk {
  repo: string;
  pr: number;
  issue: number | null;
  login: string;
  /** The head they are asked to approve. */
  head: string;
  /** The head their approval was submitted on, when that is known. */
  approvedOn: string | null;
  /** The commit GitHub shows their approval on. */
  shownOn: string | null;
  at: string;
}

export function personAskFrom(event: { at: string; payload: unknown }): PersonAsk | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const { repo, pr, login, head } = payload;
  if (typeof repo !== 'string' || typeof pr !== 'number' || typeof login !== 'string' || typeof head !== 'string') return null;
  const commit = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    repo,
    pr,
    issue: typeof payload.issue === 'number' ? payload.issue : null,
    login,
    head,
    approvedOn: commit(payload.approvedOn),
    shownOn: commit(payload.shownOn),
    at: event.at,
  };
}

/**
 * The people still asked to approve a pull request again, by `repo#pr` and
 * login: the newest ask of each, while the pull request's issue is in Review
 * when the board has it, and the person has given no verdict on it since — an
 * approval, which counts, or a request for changes (`REVIEW_SUBMITTED_ON`). A
 * pull request that closed is the caller's to leave out.
 */
export function standingPersonAsks(
  asks: Events,
  reviews: Events,
  issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'stage'>[],
): Map<string, PersonAsk> {
  const newest = new Map<string, PersonAsk>();
  for (const event of asks) {
    const ask = personAskFrom(event);
    if (!ask) continue;
    const key = `${ask.repo}#${ask.pr}@${ask.login.toLowerCase()}`;
    const seen = newest.get(key);
    if (!seen || Date.parse(ask.at) > Date.parse(seen.at)) newest.set(key, ask);
  }
  const standing = new Map<string, PersonAsk>();
  for (const [key, ask] of newest) {
    const issue = (ask.issue !== null ? issues.find((one) => one.repoName === ask.repo && one.number === ask.issue) : undefined) ?? issueForSubject(`${ask.repo}#${ask.pr}`, issues);
    if (issue && issue.stage !== 'review') continue;
    if (!answeredSince(reviews, `${ask.repo}#${ask.pr}`, ask.login, ask.at)) standing.set(key, { ...ask, issue: issue?.number ?? ask.issue });
  }
  return standing;
}

/** Whether `login` gave a verdict on the pull request after `at`: an approval, or a request for changes (`REVIEW_SUBMITTED_ON`). */
function answeredSince(reviews: Events, subjectRef: string, login: string, at: string): boolean {
  return reviews.some((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return (
      payload.subjectRef === subjectRef &&
      typeof payload.login === 'string' &&
      sameLogin(payload.login, login) &&
      (payload.state === 'approved' || payload.state === 'changes_requested') &&
      Date.parse(event.at) > Date.parse(at)
    );
  });
}

/** A person a crew pull request waits on for a first approval (`PERSON_AWAITED`), as its card reads it. */
export interface PersonAwait {
  repo: string;
  pr: number;
  issue: number;
  login: string;
  /** The head the lead approved, which they are asked to approve. */
  head: string;
  /** The Human review paths it touches that name them; none when they could not be read. */
  paths: string[];
  /**
   * The crew's reviews on the head as the wait was recorded (`crewReviewsOn`);
   * null on a wait recorded before they were, whose card links to GitHub instead.
   */
  reviews: PersonAwaitReview[] | null;
  at: string;
}

/** One crew review a wait carries, as its card shows it. */
export interface PersonAwaitReview {
  login: string;
  seat: string | null;
  state: string;
  summary: string;
  url: string;
}

function awaitReviewsOf(value: unknown): PersonAwaitReview[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((one): PersonAwaitReview[] => {
    const review = (one ?? {}) as Record<string, unknown>;
    const { login, state, summary, url } = review;
    if (typeof login !== 'string' || typeof state !== 'string' || typeof summary !== 'string' || typeof url !== 'string') return [];
    return [{ login, seat: typeof review.seat === 'string' ? review.seat : null, state, summary, url }];
  });
}

export function personAwaitFrom(event: { at: string; payload: unknown }): PersonAwait | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const { repo, pr, issue, login, head } = payload;
  if (typeof repo !== 'string' || typeof pr !== 'number' || typeof issue !== 'number' || typeof login !== 'string' || typeof head !== 'string') return null;
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((path): path is string => typeof path === 'string') : [];
  return { repo, pr, issue, login, head, paths, reviews: awaitReviewsOf(payload.reviews), at: event.at };
}

/**
 * The people a crew pull request still waits on for a first approval, by
 * `repo#pr` and login: the newest wait on each, while the issue is in Review
 * when the board has it — a merge, a close and a send back to Build each move
 * it out — the person has given no verdict on it since, and no review round
 * opened after it on another head. A new round is a new diff, which the lead's
 * approval the wait rested on is not of; the next wait is recorded when the lead approves
 * that. A pull request that closed is the caller's to leave out.
 */
export function standingPersonAwaits(
  awaits: Events,
  reviews: Events,
  rounds: Events,
  issues: readonly Pick<IssueFacts, 'repoName' | 'number' | 'prNumber' | 'stage'>[],
): Map<string, PersonAwait> {
  const newest = new Map<string, PersonAwait>();
  for (const event of awaits) {
    const wait = personAwaitFrom(event);
    if (!wait) continue;
    const key = `${wait.repo}#${wait.pr}@${wait.login.toLowerCase()}`;
    const seen = newest.get(key);
    if (!seen || Date.parse(wait.at) > Date.parse(seen.at)) newest.set(key, wait);
  }
  const standing = new Map<string, PersonAwait>();
  for (const [key, wait] of newest) {
    const ref = `${wait.repo}#${wait.pr}`;
    const issue = issues.find((one) => one.repoName === wait.repo && one.number === wait.issue);
    if (issue && issue.stage !== 'review') continue;
    if (answeredSince(reviews, ref, wait.login, wait.at)) continue;
    // Only a round on another head ends the wait. A duplicate delivery, or a
    // reopen or ready_for_review on the awaited head, records a round with the
    // same sha, and awaitPeople does not record that head again, so clearing on
    // it left review-gate saying `waiting on @login` with no card.
    const reopened = rounds.some((event) => {
      const round = (event.payload ?? {}) as Record<string, unknown>;
      return round.subjectRef === ref && typeof round.sha === 'string' && round.sha !== wait.head && Date.parse(event.at) > Date.parse(wait.at);
    });
    if (!reopened) standing.set(key, wait);
  }
  return standing;
}

/** Runs a read, and holds nothing when it fails, a table not there yet included. */
function quietly<T>(read: () => Promise<T>, empty: T): Promise<T> {
  return (async () => read())().catch(() => empty);
}

/**
 * The reads `WaitFacts` holds, each only when something could make it say
 * anything: the plan changes held only while a gate is open, the reviews and
 * rounds only while a person was asked or awaited, OpenADLC's stack holds only
 * while an issue is labelled `openadlc:paused`, and the stacks only of the
 * repositories with an issue in Build or Review. A read that fails holds
 * nothing, as `readAttention`'s own did.
 */
export async function readWaitFacts(
  issues: readonly IssueFacts[],
  gates: readonly unknown[],
  since: Date,
): Promise<Required<WaitFacts>> {
  const paused = issues.filter((issue) => hasPausedLabel(issue.labels));
  const stacked = [...new Set(issues.filter((issue) => issue.stage === 'build' || issue.stage === 'review').map((issue) => issue.repoId))];
  const [personAsks, personAwaits, stallEvents, heldPlanChanges, line, holds, links] = await Promise.all([
    quietly(() => listEventsOfType(PERSON_ASKED_AGAIN, since), []),
    quietly(() => listEventsOfType(PERSON_AWAITED, since), []),
    quietly(() => listEventsOfType(REVIEW_STALLED, since), []),
    gates.length > 0
      ? quietly(
          async () =>
            (await leases.listHeldPlanChanges()).flatMap(({ gateId, request }): HeldPlanChange[] =>
              request.held
                ? [
                    {
                      gateId,
                      paths: request.paths,
                      approvedBy: request.held.approvedBy,
                      blockedBy: request.held.blockedBy,
                      ...(request.held.failed !== undefined ? { failed: request.held.failed } : {}),
                    },
                  ]
                : [],
            ),
          [] as HeldPlanChange[],
        )
      : Promise.resolve([] as HeldPlanChange[]),
    quietly(() => mergeLines.line(), []),
    paused.length > 0 ? quietly(() => heldStacks(paused), [] as HeldStack[]) : Promise.resolve([] as HeldStack[]),
    stacked.length > 0 ? quietly(() => stackLinks(stacked), [] as StackLink[]) : Promise.resolve([] as StackLink[]),
  ]);
  const awaiting = personAwaits.some((event) => personAwaitFrom(event));
  const [personReviews, roundsOpened] = await Promise.all([
    personAsks.some((event) => personAskFrom(event)) || awaiting ? quietly(() => listEventsOfType(REVIEW_SUBMITTED_ON, since), []) : Promise.resolve([]),
    // A newer round is a new diff, which the lead's approval a wait rested on is not of.
    awaiting ? quietly(() => listEventsOfType(REVIEW_ROUND_OPENED, since), []) : Promise.resolve([]),
  ]);
  const heldMerges = line
    .map((entry) => ({ entry, reason: heldForPerson(entry) }))
    .filter((one): one is { entry: (typeof one)['entry']; reason: string } => one.reason !== null)
    .map(({ entry, reason }) => ({ repo: entry.repoName, prNumber: entry.prNumber, reason, since: entry.enteredAt }));
  return { heldPlanChanges, heldMerges, personAsks, personReviews, personAwaits, roundsOpened, heldStacks: holds, stackLinks: links, stallEvents };
}

/** What a person does at a chain's root: answer a question, merge or approve a pull request, decide on a stalled review, resume a hold, triage a parked issue, or what `words` says. */
export type PersonAction = 'answer' | 'merge' | 'approve' | 'review' | 'resume' | 'triage' | 'other';

/** A wait on a person, on the card (`on`, `repo#n`) whose work it holds. */
export interface PersonWait {
  on: string;
  /** The Needs you item that says the same (`attentionItems`'s id for it); null when none does. */
  attentionId: string | null;
  action: PersonAction;
  /** The pull request a merge, an approval or a review is on; else the issue's own number. */
  number: number;
  /** Where it is done: the pull request, the question's comment, the issue. */
  url: string | null;
  /** What to do, for `other`, in a few words: "raise the monthly cap". */
  words?: string;
}

export interface PersonWaitInput extends WaitFacts {
  issues: readonly IssueFacts[];
  tasks: readonly Pick<TaskFacts, 'id' | 'subjectRef' | 'createdAt'>[];
  /** The open gates; a gate without its id names no item. */
  gates: readonly { id?: string; taskId: string | null; githubCommentUrl?: string | null }[];
  repos: readonly { name: string; fullName?: string }[];
  /** The issues and pull requests GitHub says are closed, by ref, which Needs you leaves out. Absent, none. */
  closed?: ReadonlySet<string>;
}

/**
 * Every wait on a person, each with the id `attentionItems` gives the Needs
 * you item for the same fact, so a chain's root names the card a person acts
 * on: `gate:` for a question (not an approved plan change, which waits on
 * other work), `merge:`, `approve-again:`, `approval:`, `stall:`,
 * `stack-hold:` and `parked:`. The same rules as those items, read from the
 * same facts; `attention.test.ts` holds the two to one id.
 */
export function personWaitsOf(input: PersonWaitInput): PersonWait[] {
  const nodeOf = (subjectRef: string): string => {
    const issue = issueForSubject(subjectRef, input.issues);
    return issue ? `${issue.repoName}#${issue.number}` : subjectRef;
  };
  const fullNameOf = (repo: string) => input.repos.find((one) => one.name === repo)?.fullName;
  const pullUrl = (repo: string, pr: number): string | null => {
    const fullName = fullNameOf(repo);
    return fullName ? `https://github.com/${fullName}/pull/${pr}` : null;
  };
  const waits: PersonWait[] = [];

  const heldGates = new Set((input.heldPlanChanges ?? []).filter((held) => !held.failed && held.blockedBy.length > 0).map((held) => held.gateId));
  for (const gate of input.gates) {
    if (!gate.id || heldGates.has(gate.id)) continue;
    const task = input.tasks.find((one) => one.id === gate.taskId);
    const issue = task ? issueForSubject(task.subjectRef, input.issues) : null;
    if (!issue) continue;
    waits.push({ on: `${issue.repoName}#${issue.number}`, attentionId: `gate:${gate.id}`, action: 'answer', number: issue.number, url: gate.githubCommentUrl ?? issue.url });
  }

  for (const held of input.heldMerges ?? []) {
    waits.push({ on: nodeOf(`${held.repo}#${held.prNumber}`), attentionId: `merge:${held.repo}#${held.prNumber}`, action: 'merge', number: held.prNumber, url: pullUrl(held.repo, held.prNumber) });
  }

  const askedAgain = new Set<string>();
  for (const [key, ask] of standingPersonAsks(input.personAsks ?? [], input.personReviews ?? [], input.issues)) {
    const ref = `${ask.repo}#${ask.pr}`;
    if (input.closed?.has(ref) || !fullNameOf(ask.repo)) continue;
    askedAgain.add(key);
    waits.push({ on: nodeOf(ask.issue ? `${ask.repo}#${ask.issue}` : ref), attentionId: `approve-again:${key}`, action: 'approve', number: ask.pr, url: pullUrl(ask.repo, ask.pr) });
  }
  for (const [key, wait] of standingPersonAwaits(input.personAwaits ?? [], input.personReviews ?? [], input.roundsOpened ?? [], input.issues)) {
    if (input.closed?.has(`${wait.repo}#${wait.pr}`) || askedAgain.has(key) || !fullNameOf(wait.repo)) continue;
    waits.push({ on: nodeOf(`${wait.repo}#${wait.issue}`), attentionId: `approval:${key}`, action: 'approve', number: wait.pr, url: pullUrl(wait.repo, wait.pr) });
  }

  for (const [key, stall] of standingStalls(input.stallEvents ?? [], input.issues, input.tasks)) {
    if (input.closed?.has(key)) continue;
    waits.push({ on: nodeOf(stall.issue ? `${stall.repo}#${stall.issue}` : key), attentionId: `stall:${key}`, action: 'review', number: stall.pr, url: pullUrl(stall.repo, stall.pr) });
  }

  for (const held of input.heldStacks ?? []) {
    const issue = input.issues.find((one) => one.repoName === held.repo && one.number === held.issue);
    if (!issue || !hasPausedLabel(issue.labels) || issue.stage === 'merged' || issue.stage === 'done') continue;
    const base = input.issues.find((one) => one.repoId === issue.repoId && one.number === held.on);
    if (!held.needsPerson && base && !hasAbandonedLabel(base.labels)) continue;
    const key = `${held.repo}#${held.issue}`;
    waits.push({ on: key, attentionId: `stack-hold:${key}`, action: 'resume', number: issue.number, url: issue.url });
  }

  for (const issue of input.issues) {
    if (!issue.labels.includes('needs-triage') || issue.stage === 'merged' || issue.stage === 'done') continue;
    const key = `${issue.repoName}#${issue.number}`;
    waits.push({ on: key, attentionId: `parked:${key}`, action: 'triage', number: issue.number, url: issue.url });
  }
  return waits;
}

/** How one card waits on the next. */
export type WaitLinkKind = 'dependency' | 'concurrency' | 'seat' | 'turn' | 'lease' | 'plan_change' | 'stack';

export interface WaitLink {
  /** `repo#n`, both. */
  from: string;
  to: string;
  kind: WaitLinkKind;
}

/**
 * Where following a wait ended: a person's action; something that clears by
 * itself (`words`, a clause: "which is running now"); something nobody can
 * clear — a loop, a dependency closed without merging or ignored and closed
 * other than completed, one outside the install; or `deep`, the last node
 * reached at `MAX_WAIT_DEPTH` links.
 */
export type WaitEnd =
  | {
      kind: 'person';
      ref: string;
      action: PersonAction;
      number: number;
      attentionId: string | null;
      url: string | null;
      words?: string;
      /** A person outside the crew is who it waits on, not you: an `openadlc:ignore` dependency still open. */
      outside?: true;
    }
  | { kind: 'self'; ref: string; words: string }
  | { kind: 'dead'; ref: string; why: 'loop' | 'abandoned' | 'closed' | 'outside'; loop?: string[] }
  | { kind: 'deep'; ref: string };

export interface WaitChain {
  /** The links followed from the card, in order. */
  links: WaitLink[];
  end: WaitEnd;
  /** How many cards' chains end at the same root, this card's included. */
  behind: number;
}

export interface FollowInput {
  /** Every issue read: the cards, and what they wait on. */
  issues: readonly IssueFacts[];
  /** Why each card with nothing going on it waits (`waitingOf`). */
  waiting: ReadonlyMap<string, CardWaiting>;
  tasks: readonly Pick<TaskFacts, 'id' | 'subjectRef' | 'state'>[];
  /** The waits on a person (`personWaitsOf`). */
  persons: readonly PersonWait[];
  gates: readonly { id?: string; taskId: string | null }[];
  heldPlanChanges?: readonly HeldPlanChange[];
  heldStacks?: readonly HeldStack[];
  stackLinks?: readonly StackLink[];
  /** The refs of the cards a chain is worked out for, in board order; absent, every issue's. */
  cards?: readonly string[];
}

/** An end of a node, or a link from it, with the end already known for a link to something that will not move. */
type Option = { end: WaitEnd } | { link: WaitLink; fixed?: WaitEnd };

/**
 * Which end a chain keeps when a node offers several: the one somebody can
 * act on first. A dependency built outside the crew is someone's to finish,
 * but not the reader's, so any wait on you outranks it.
 */
const rank = (end: WaitEnd): number => (end.kind === 'person' ? (end.outside ? 1 : 0) : { dead: 2, deep: 3, self: 4 }[end.kind]);

/** What a person does about a wait `waitingOf` names on the card itself, or null for one that is no person's. */
function personOfReason(reason: WaitingReason, issue: IssueFacts, ref: string): Omit<Extract<WaitEnd, { kind: 'person' }>, 'kind' | 'ref'> | null {
  const at = { number: issue.number, url: issue.url };
  const other = (words: string) => ({ action: 'other' as const, attentionId: null, ...at, words });
  switch (reason.kind) {
    case 'held':
      return { action: 'resume', attentionId: null, ...at };
    case 'triage':
      return { action: 'triage', attentionId: `parked:${ref}`, ...at };
    case 'not_ready':
      return other(`put start:now on #${issue.number}`);
    case 'for_person':
      return other(`take #${issue.number} on: it is left for a person`);
    case 'paused':
      return other(`resume work (${reason.words})`);
    case 'not_staffed':
      return other(`move #${issue.number} on by hand`);
    case 'no_seat':
      return other(`add a ${reason.role} seat on Crew`);
    case 'cap':
      return other('raise the monthly cap');
    case 'seat_paused':
      return other(`resume ${reason.seat.name} on Crew`);
    case 'blocked':
      return other(reason.instruction.replace(/[.!?]+\s*$/, ''));
    case 'no_dispatcher':
      return other('start the dispatcher');
    default:
      return null;
  }
}

/** What a node is doing when nothing else says, as the clause of a self end. */
function stageWords(issue: IssueFacts | undefined): string {
  switch (issue?.stage) {
    case undefined:
      return 'which is not on the board';
    case 'intake':
      return 'which is in intake';
    case 'spec':
      return 'which is in design';
    case 'build':
      return 'which is in build';
    case 'review':
      return 'which is in review';
    case 'merged':
      return 'which merged and waits to ship';
    default:
      return 'which is done';
  }
}

/**
 * Each card's wait followed to one root, by the card's ref. Only a card whose
 * root is reached through at least one link has a chain: one that waits on
 * nothing, on itself, or has work going is left out, and its card says what
 * it said.
 *
 * A node's options, in order: its own wait on a person; its work going now;
 * its links — a dependency, the holders of the build slot or the seat it
 * waits for, the cards before it in line, the issues holding its files, those
 * holding the paths of its approved plan change, the one it was stacked on —
 * and then what `waitingOf` says clears by itself. The best end is kept,
 * person > dead > deep > self, a person outside the crew under any wait on
 * you, and the first offered on a tie, so a node's own end beats one behind
 * it.
 *
 * Depth first, with the path walked: a link back onto it is a loop, which
 * nobody's action ends. A memo for each walk keeps what a node was followed
 * to and from how deep, and is dropped after it, so a loop seen from one card
 * never colours another's walk. Past `MAX_WAIT_DEPTH` links it stops, with
 * the last node reached. A node is followed again only when it is reached
 * nearer the card than before: memoed once, a node first reached at the
 * limit said `deep` from a link one step from the card, and the person behind
 * it was lost. Its depth only falls, so each node is followed at most
 * `MAX_WAIT_DEPTH + 1` times and any input terminates.
 */
export function followWaits(input: FollowInput): Map<string, WaitChain> {
  const byRef = new Map<string, IssueFacts>(input.issues.map((issue) => [`${issue.repoName}#${issue.number}`, issue]));
  const nodeOf = (subjectRef: string): string | null => {
    const issue = issueForSubject(subjectRef, input.issues);
    return issue ? `${issue.repoName}#${issue.number}` : null;
  };
  const personsOn = new Map<string, PersonWait[]>();
  for (const wait of input.persons) personsOn.set(wait.on, [...(personsOn.get(wait.on) ?? []), wait]);
  const tasksOn = new Map<string, Pick<TaskFacts, 'id' | 'subjectRef' | 'state'>[]>();
  for (const task of input.tasks) {
    const node = nodeOf(task.subjectRef);
    if (node) tasksOn.set(node, [...(tasksOn.get(node) ?? []), task]);
  }
  // The paths an approved plan change waits for, by the card its task is on.
  const planHolds = new Map<string, number[]>();
  for (const held of input.heldPlanChanges ?? []) {
    if (held.failed || held.blockedBy.length === 0) continue;
    const gate = input.gates.find((one) => one.id === held.gateId);
    const task = gate?.taskId ? input.tasks.find((one) => one.id === gate.taskId) : undefined;
    const node = task ? nodeOf(task.subjectRef) : null;
    if (node) planHolds.set(node, [...(planHolds.get(node) ?? []), ...held.blockedBy]);
  }
  // OpenADLC's own hold on a stacked change waits on what it was built on, not on a person, unless it says so.
  const heldForBase = new Set(
    (input.heldStacks ?? [])
      .filter((held) => !held.needsPerson)
      .map((held) => `${held.repo}#${held.issue}`)
      .filter((ref) => !(input.persons.some((wait) => wait.on === ref && wait.attentionId === `stack-hold:${ref}`))),
  );

  const optionsOf = (ref: string): Option[] => {
    const issue = byRef.get(ref);
    if (!issue) return [{ end: { kind: 'self', ref, words: stageWords(undefined) } }];
    const options: Option[] = [];
    const link = (to: string, kind: WaitLinkKind, fixed?: WaitEnd): Option => ({ link: { from: ref, to, kind }, ...(fixed ? { fixed } : {}) });
    const inRepo = (number: number) => `${issue.repoName}#${number}`;

    for (const wait of personsOn.get(ref) ?? []) {
      options.push({ end: { kind: 'person', ref, action: wait.action, number: wait.number, attentionId: wait.attentionId, url: wait.url, ...(wait.words ? { words: wait.words } : {}) } });
    }
    const reason = input.waiting.get(ref)?.reason;
    const own = reason && !(reason.kind === 'held' && heldForBase.has(ref)) ? personOfReason(reason, issue, ref) : null;
    if (own) options.push({ end: { kind: 'person', ref, ...own } });

    const going = (tasksOn.get(ref) ?? []).filter((task) => task.state === 'running' || task.state === 'queued');
    if (going.length > 0) options.push({ end: { kind: 'self', ref, words: going.some((task) => task.state === 'running') ? 'which is running now' : 'which is queued to start' } });

    switch (reason?.kind) {
      case 'dependency':
        for (const on of reason.on) {
          const to = on.target ?? on.ref;
          if (on.abandoned) options.push(link(to, 'dependency', { kind: 'dead', ref: to, why: 'abandoned' }));
          else if (on.ignored?.state === 'closed' && on.ignored.stateReason !== 'completed') options.push(link(to, 'dependency', { kind: 'dead', ref: to, why: 'closed' }));
          else if (!on.target) options.push(link(to, 'dependency', { kind: 'dead', ref: to, why: 'outside' }));
          // A person's, built outside the crew: whoever builds it is who it waits on.
          else if (on.ignored) options.push(link(to, 'dependency', { kind: 'person', ref: to, action: 'other', number: on.number, attentionId: null, url: byRef.get(to)?.url ?? null, outside: true }));
          else options.push(link(on.target, 'dependency'));
        }
        break;
      case 'concurrency':
      case 'seat':
        for (const holder of reason.holders) {
          const to = nodeOf(holder.ref);
          if (to) options.push(link(to, reason.kind));
          // A request's triage holds the seat: it has no card to follow.
          else options.push(link(holder.ref, reason.kind, { kind: 'self', ref: holder.ref, words: holder.state === 'running' ? 'which is running now' : holder.state === 'queued' ? 'which is queued to start' : 'which is paused' }));
        }
        break;
      case 'turn':
        for (const after of reason.after) options.push(link(after, 'turn'));
        break;
      case 'lease':
        for (const number of reason.on) options.push(link(inRepo(number), 'lease'));
        break;
      default:
        break;
    }
    for (const number of planHolds.get(ref) ?? []) options.push(link(inRepo(number), 'plan_change'));
    if (issue.stage === 'build' || issue.stage === 'review') {
      for (const stack of input.stackLinks ?? []) {
        if (stack.repoId !== issue.repoId || stack.issue !== issue.number) continue;
        const dependency = input.issues.find((one) => one.repoId === stack.repoId && one.number === stack.onIssue) ?? null;
        const on = stackWaitsOn(stack, dependency);
        if (on !== null) options.push(link(inRepo(on), 'stack'));
      }
    }

    if (reason?.kind === 'free') options.push({ end: { kind: 'self', ref, words: 'which is next in line' } });
    if (reason?.kind === 'host') options.push({ end: { kind: 'self', ref, words: 'which waits for a host with room' } });
    if (reason?.kind === 'leased' && reason.merged) options.push({ end: { kind: 'self', ref, words: 'which merged and waits for its verification' } });
    if (options.length === 0) options.push({ end: { kind: 'self', ref, words: stageWords(issue) } });
    return options;
  };

  type Walked = { links: WaitLink[]; end: WaitEnd };
  const walk = (root: string): Walked => {
    const memo = new Map<string, { walked: Walked; depth: number }>();
    const path: string[] = [];
    const visit = (ref: string, depth: number): Walked => {
      const seen = memo.get(ref);
      if (seen && seen.depth <= depth) return seen.walked;
      path.push(ref);
      let best: Walked | null = null;
      for (const option of optionsOf(ref)) {
        let walked: Walked;
        if ('end' in option) walked = { links: [], end: option.end };
        else if (option.fixed) walked = { links: [option.link], end: option.fixed };
        else if (depth >= MAX_WAIT_DEPTH) walked = { links: [], end: { kind: 'deep', ref } };
        else if (path.includes(option.link.to)) walked = { links: [option.link], end: { kind: 'dead', ref: option.link.to, why: 'loop', loop: path.slice(path.indexOf(option.link.to)) } };
        else {
          const next = visit(option.link.to, depth + 1);
          walked = { links: [option.link, ...next.links], end: next.end };
        }
        if (!best || rank(walked.end) < rank(best.end)) best = walked;
      }
      path.pop();
      memo.set(ref, { walked: best!, depth });
      return best!;
    };
    return visit(root, 0);
  };

  const cards = input.cards ?? [...byRef.keys()];
  const walked = new Map<string, Walked>();
  for (const ref of cards) {
    // Work going on it is what its card says, whatever waits behind that.
    if (!byRef.has(ref) || (tasksOn.get(ref) ?? []).some((task) => task.state === 'running' || task.state === 'queued')) continue;
    const chain = walk(ref);
    if (chain.links.length > 0) walked.set(ref, chain);
  }
  const rootOf = (end: WaitEnd): string => (end.kind === 'person' && end.attentionId ? end.attentionId : `${end.kind}:${end.ref}`);
  const behind = new Map<string, number>();
  for (const chain of walked.values()) behind.set(rootOf(chain.end), (behind.get(rootOf(chain.end)) ?? 0) + 1);
  return new Map([...walked].map(([ref, chain]) => [ref, { ...chain, behind: behind.get(rootOf(chain.end)) ?? 1 }]));
}
