import { sameLogin } from './checks.js';
import { seatOf } from './stamp.js';

/** What `whoWrote` needs to know about each seat. */
export interface CrewMember {
  name: string;
  slot?: string;
  githubLogin: string | null;
}

/**
 * Who wrote something on GitHub, as far as OpenADLC can tell.
 *
 * `person` is anybody whose login is none of the crew's accounts. `fleetadlc` is
 * one of the crew's accounts; `bot` is the seat that wrote it when that can be
 * told — always on an account only one seat uses, and on a shared account only
 * from the comment's own marker. A seat named by a marker on a shared account
 * is only the marker's word: this reads no signature. Where it matters the
 * bridge checks one: the lead's and a blocking seat's reviews on a shared
 * account count only when `Attribution.reviewsThatCount` passes them
 * (`checkedForSharedSeats` in apps/bridge/src/automation.ts), and with
 * signatures enforced every crew post is checked (`Attribution.countable`).
 */
export type Authorship<M extends CrewMember = CrewMember> =
  | { kind: 'person'; login: string | null }
  | {
      kind: 'fleetadlc';
      login: string;
      bot: M | null;
      /** More than one seat signs in as this account. */
      shared: boolean;
    };

/** Whether a login is one of the accounts the crew signs in as. */
export function isFleetLogin(crew: readonly { githubLogin: string | null }[], login: string | null | undefined): boolean {
  return crew.some((member) => sameLogin(member.githubLogin, login));
}

/**
 * Who wrote a comment, review, issue or pull request.
 *
 * Every check that asked "is this author one of the bots, and which?" compared
 * the login with each bot's, and took the first match. On an install where
 * seats share an account, the first match is whichever seat sorts first — so
 * the author checks are here, in one place, where the account and the seat are
 * two different questions.
 */
export function whoWrote<M extends CrewMember>(
  login: string | null | undefined,
  crew: readonly M[],
  marker?: { bot?: string | null } | null,
): Authorship<M> {
  const seats = crew.filter((member) => sameLogin(member.githubLogin, login));
  if (!login || seats.length === 0) return { kind: 'person', login: login ?? null };

  if (seats.length === 1) {
    return { kind: 'fleetadlc', login, bot: seats[0] ?? null, shared: false };
  }

  const named = marker?.bot?.toLowerCase();
  const bot = named ? (seats.find((seat) => seat.name.toLowerCase() === named || seat.slot?.toLowerCase() === named) ?? null) : null;
  return { kind: 'fleetadlc', login, bot, shared: true };
}

/**
 * Which of `seats` wrote one of `posts` — reviews, usually.
 *
 * The reviewers share one account, so a review by that account is not a review
 * by each of them: one approval would have counted as all three. A post counts
 * for the seat it names (`withSeat`); on an account only one seat uses, the
 * account says which.
 */
export function seatsThatPosted<M extends CrewMember>(
  posts: readonly { user: string | null; body?: string | null }[],
  crew: readonly M[],
  seats: readonly string[],
): string[] {
  const wrote = new Set<string>();
  for (const post of posts) {
    const author = whoWrote(post.user, crew, { bot: seatOf(post.body) });
    if (author.kind === 'fleetadlc' && author.bot) wrote.add(author.bot.name);
  }
  return seats.filter((seat) => wrote.has(seat));
}

/**
 * Whether a post is `seat`'s own, given the account it signs in as: posted by
 * that account and naming no other seat. One naming no seat at all is taken
 * as the seat's, as it was before posts named one.
 */
export function postedBySeat(
  post: { user: string | null; body?: string | null },
  login: string | null | undefined,
  seat: string | null | undefined,
): boolean {
  if (!sameLogin(post.user, login)) return false;
  const named = seatOf(post.body);
  return !named || !seat || named === seat.toLowerCase();
}

/**
 * Of `seats`, those whose latest verdict asks for changes.
 *
 * A review gate that only asked whether each reviewer had posted went green
 * over two reviews requesting changes — on a repository with no ruleset to
 * hold the merge, a green gate is what a person merges on. Posts come in the
 * order GitHub lists them, oldest first; a comment is no verdict, and a
 * dismissed review no longer asks for anything.
 */
export function seatsAskingForChanges<M extends CrewMember>(
  posts: readonly { user: string | null; body?: string | null; state?: string | null }[],
  crew: readonly M[],
  seats: readonly string[],
): string[] {
  const latest = new Map<string, string>();
  for (const post of posts) {
    const state = (post.state ?? '').toUpperCase();
    if (!state || state === 'COMMENTED' || state === 'PENDING') continue;
    const author = whoWrote(post.user, crew, { bot: seatOf(post.body) });
    if (author.kind === 'fleetadlc' && author.bot) latest.set(author.bot.name, state);
  }
  return seats.filter((seat) => latest.get(seat) === 'CHANGES_REQUESTED');
}
