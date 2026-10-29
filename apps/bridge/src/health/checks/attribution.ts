import { UNVERIFIED_REASON } from '@openadlc/shared';
import { postTarget, seatToRecord } from '../../attribution.js';
import type { CheckResult, HealthCheck } from '../types.js';
import { RECONNECT } from '../words.js';

/** A post the bridge recorded as not signed by OpenADLC, as the check reads it. */
export interface UnattributedRecord {
  id?: number;
  repo: string;
  kind: string;
  objectId?: string;
  login: string;
  reason: string;
  url: string | null;
  seat: string | null;
  /** The sha256 of its body when it was recorded; see `bodyDigest`. */
  bodySha256?: string | null;
  /** When it was recorded. */
  at?: string;
}

/** The event the stamp route records for a crew task's post it refused (`internal-api.ts`). */
export const STAMP_REFUSED = 'attribution.stamp_refused';
/** The event a task of a refused one's kind and subject type records when it signs again, which clears the refusal. */
export const STAMP_SIGNED = 'attribution.stamp_signed';

/**
 * Reads the refusals since a moment from their events, each cleared by the
 * first signing of its task kind and subject type after it.
 */
export function refusalsFromEvents(
  refused: readonly { at: string; payload: unknown }[],
  signed: readonly { at: string; payload: unknown }[],
): StampRefusal[] {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const out: StampRefusal[] = [];
  for (const event of refused) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const taskKind = text(payload.taskKind) ?? '';
    const subjectType = text(payload.subjectType);
    const at = Date.parse(event.at);
    const clearing = signed
      .filter((one) => {
        const fields = (one.payload ?? {}) as Record<string, unknown>;
        return fields.taskKind === taskKind && fields.subjectType === subjectType && Date.parse(one.at) > at;
      })
      .map((one) => one.at)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    out.push({
      at: event.at,
      taskId: text(payload.taskId) ?? '',
      taskKind,
      subjectType,
      seat: text(payload.seat),
      login: text(payload.login),
      repo: text(payload.repo),
      number: typeof payload.number === 'number' ? payload.number : null,
      kind: text(payload.kind) ?? 'post',
      status: typeof payload.status === 'number' ? payload.status : 0,
      reason: text(payload.reason) ?? '',
      bodySha256: text(payload.bodySha256),
      clearedAt: clearing[0] ?? null,
    });
  }
  return out;
}

/**
 * A crew task's post the bridge's stamp route refused to sign
 * (`attribution.stamp_refused`), which OpenADLC's gh then posted unsigned.
 */
export interface StampRefusal {
  at: string;
  taskId: string;
  taskKind: string;
  subjectType: string | null;
  seat: string | null;
  login: string | null;
  repo: string | null;
  number: number | null;
  kind: string;
  status: number;
  /** The stamp route's own words. */
  reason: string;
  bodySha256: string | null;
  /** When a task of the same kind, on the same kind of subject, signed again; null while it has not. */
  clearedAt: string | null;
}

export interface UnattributedReader {
  /** Crew posts whose signature did not check, seen since `since`, newest first. */
  since(since: Date): Promise<UnattributedRecord[]>;
  /** The stamp route's refusals since `since`, newest first. Absent where nothing records them. */
  refusals?(since: Date): Promise<StampRefusal[]>;
  /** `audit` or `enforce`; see the bridge's `src/attribution.ts`. */
  mode(): Promise<'audit' | 'enforce'>;
  /**
   * Reads the post again from GitHub and checks it under the rules as they
   * are now: true when it verifies with the body it was recorded with, false
   * when it does not or its body changed since, null when it could not be
   * read. Absent in a test with nothing to read.
   */
  reverify?(post: UnattributedRecord): Promise<boolean | null>;
  /** Marks a post that verifies after all as resolved, so it stops counting, and says so in the audit trail. */
  resolve?(post: UnattributedRecord): Promise<void>;
}

/** Which post a card is about: its row, or where it is when that is all the reader said. */
function occurrenceOf(post: { id?: number; url: string | null; repo: string; kind: string; login: string }): string {
  return post.id !== undefined ? `post:${post.id}` : `post:${post.url ?? `${post.repo}:${post.kind}:${post.login}`}`;
}

/**
 * Why a post failed that a change in how the rules are read can undo: those
 * are what reading it again may resolve. A post with no signature, or one
 * signed for a body it no longer has, is an incident whatever it says now: an
 * agent could stamp a harmless body for its seat and edit its earlier post to
 * it, and the record said everything was signed.
 */
export const RULES_CAN_FLIP: ReadonlySet<string> = new Set(['seat-mismatch', 'malformed', 'wrong-target']);

/** How far back a post that did not check keeps its card up. */
export const UNATTRIBUTED_WINDOW_MS = 24 * 60 * 60 * 1000;


/** What a post was, in a sentence: "a review", "a comment". */
const WHAT: Record<string, string> = { comment: 'comment', review: 'review', issue: 'issue', pr: 'pull request' };

/**
 * What the incident is about, for the card's sheet and its runbook
 * (`docs/runbooks/unsigned-post.md`): the post, what it was on, and whether
 * it counted — which is what decides how urgent the rest is.
 */
export interface UnsignedIncident {
  repo: string;
  login: string;
  seat: string | null;
  did: string;
  postUrl: string | null;
  /** The issue or pull request it was on, when its address says. */
  target: { kind: 'pr' | 'issue'; number: number; url: string } | null;
  /** Whether it counted: an install that only records unsigned posts counts them. */
  counted: boolean;
  mode: 'audit' | 'enforce';
  /** Set when OpenADLC refused to sign it: the post is OpenADLC's gap, not the account's. */
  refusal?: { reason: string; seat: string | null; taskId: string; status: number };
}

/**
 * How much earlier than the window a refusal is read: one made just before a
 * post at the window's edge still matches it.
 */
const REFUSAL_LEAD_MS = 60 * 60 * 1000;

/**
 * The refusal an unsigned post was, or null: the same repository, the same
 * account, the same body, and the same number when the refusal named one,
 * refused no later than the post was recorded. An open refusal wins over a
 * cleared one, newest first within each: seats on one account share a login,
 * and a cleared refusal of another task's shape would otherwise have taken the
 * post off this card while its own refusal was still open.
 */
export function refusalFor(post: UnattributedRecord, refusals: readonly StampRefusal[]): StampRefusal | null {
  if (!post.bodySha256) return null;
  const number = postTarget(post.url)?.number ?? null;
  const posted = post.at ? Date.parse(post.at) : null;
  let found: StampRefusal | null = null;
  for (const refusal of refusals) {
    if (!refusal.repo || refusal.repo.toLowerCase() !== post.repo.toLowerCase()) continue;
    if (!refusal.login || refusal.login.toLowerCase() !== post.login.toLowerCase()) continue;
    if (!refusal.bodySha256 || refusal.bodySha256 !== post.bodySha256) continue;
    if (refusal.number !== null && refusal.number !== number) continue;
    if (posted !== null && Date.parse(refusal.at) > posted) continue;
    if (!found || (found.clearedAt !== null && refusal.clearedAt === null)) found = refusal;
    else if ((found.clearedAt === null) === (refusal.clearedAt === null) && Date.parse(refusal.at) > Date.parse(found.at)) found = refusal;
  }
  return found;
}

/** The posts recorded in the window, and the refusals that could have been any of them. */
async function readPosts(reader: UnattributedReader, now: Date, windowMs: number): Promise<{ recorded: UnattributedRecord[]; refusals: StampRefusal[] }> {
  const start = now.getTime() - windowMs;
  const [recorded, refusals] = await Promise.all([
    reader.since(new Date(start)),
    reader.refusals ? reader.refusals(new Date(start - REFUSAL_LEAD_MS)).catch(() => []) : Promise.resolve([]),
  ]);
  return { recorded, refusals };
}

/**
 * The posts that still do not check: each read again under the rules as they
 * are now, and resolved when it verifies for a reason a reading of the rules
 * can undo (`RULES_CAN_FLIP`).
 */
async function stillUnsigned(reader: UnattributedReader, posts: readonly UnattributedRecord[]): Promise<UnattributedRecord[]> {
  // Read again side by side, not one after another: a bad day can list fifty.
  const verified = await Promise.all(
    posts.map((post) => (reader.reverify && post.id !== undefined ? reader.reverify(post).catch(() => null) : Promise.resolve(null))),
  );
  const found: UnattributedRecord[] = [];
  for (const [index, post] of posts.entries()) {
    if (verified[index] === true && RULES_CAN_FLIP.has(post.reason)) {
      await reader.resolve?.(post).catch(() => undefined);
      continue;
    }
    found.push(post);
  }
  return found;
}

/** The incident a post is, for the card's sheet. */
function incidentOf(post: UnattributedRecord, seat: string | null, mode: 'audit' | 'enforce'): UnsignedIncident {
  const target = postTarget(post.url);
  return {
    repo: post.repo,
    login: post.login,
    seat,
    did: WHAT[post.kind] ?? post.kind,
    postUrl: post.url,
    target: target ? { ...target, url: `https://github.com/${post.repo}/${target.kind === 'pr' ? 'pull' : 'issues'}/${target.number}` } : null,
    counted: mode !== 'enforce',
    mode,
  };
}

/**
 * Everything the crew's accounts posted in the last day carries a signature
 * that checks (packages/shared/src/signature.ts).
 *
 * One that does not was written around OpenADLC's `gh`, by something else signed
 * in as a crew account, or changed after it was posted — including one stage
 * editing another's post. Enforced, it counted for nothing; audited, it counted
 * anyway. Either way a person should know, and the card links the post.
 *
 * Every run reads each recorded post again and checks it under the rules as
 * they are now. A card said "its seat tag names a different seat than its
 * signature" for a day over posts that were fine, recorded before quoted seat
 * tags were read right, and Check again changed
 * nothing. A post that verifies now, with the body it was recorded with and
 * for a reason a reading of the rules can undo (`RULES_CAN_FLIP`), is resolved
 * and its card clears.
 *
 * Nothing a person does makes a post that did not check pass, so the card is
 * about history (`history`): it offers Dismiss, for the newest post, and the
 * two things to do about it, not Check again.
 *
 * A post OpenADLC itself refused to sign is not here, whether or not what
 * refused it has been put right since: it is `stampRefusedCheck`'s, and
 * shown here it would say someone used the account by hand.
 */
export function attributionCheck(reader: UnattributedReader, windowMs = UNATTRIBUTED_WINDOW_MS): HealthCheck {
  return {
    id: 'unattributed-post',
    proves: 'Everything the crew posted in the last day carries a signature that checks',
    how: 'reads the posts by crew accounts whose signature the bridge could not check when GitHub delivered them, and checks each again as it is now',
    everyMinutes: 5,
    steps: [],
    history: true,
    async run(now) {
      const { recorded, refusals } = await readPosts(reader, now, windowMs);
      const found = await stillUnsigned(
        reader,
        recorded.filter((post) => refusalFor(post, refusals) === null),
      );
      if (found.length === 0) return [{ ok: true, fixed: 'Every crew post since carries a signature that checks' }];
      const latest = found[0]!;
      const mode = await reader.mode();
      const enforced = mode === 'enforce';
      const reason = UNVERIFIED_REASON[latest.reason as keyof typeof UNVERIFIED_REASON] ?? latest.reason;
      const did = WHAT[latest.kind] ?? latest.kind;
      const target = postTarget(latest.url);
      const on = target ? ` on ${latest.repo}#${target.number}` : ` in ${latest.repo}`;
      // A seat from a signature that did not check is the poster's own words;
      // a row recorded before those stopped being kept may still hold one.
      const unvouched = latest.reason === 'unknown-key' || latest.reason === 'bad-mac';
      const seat = unvouched ? null : seatToRecord(latest.seat);
      const claim = unvouched ? ' claiming a seat OpenADLC cannot vouch for' : seat ? ` claiming to be the ${seat}` : '';
      const incident = incidentOf(latest, seat, mode);
      const result: CheckResult = {
        ok: false,
        severity: 'warning',
        title:
          found.length === 1
            ? `A ${did}${on} by ${latest.login} is not signed by OpenADLC`
            : `${found.length} posts by the crew’s accounts are not signed by OpenADLC`,
        detail:
          `The latest, a ${did}${on}${claim}: ${reason}. ` +
          (enforced
            ? 'It did not count: this install counts only what OpenADLC signed. '
            : 'It counted: this install records unsigned posts and still counts them. ') +
          'If you made it, say so; if not, What to do has the steps.',
        action: latest.url ? { label: 'Open the post', url: latest.url } : { label: 'Reconnect the account', href: RECONNECT },
        // What the card is about now: the newest post, and every post on it.
        // "This was me" covers them all, so the card comes back only for a
        // post nobody has dismissed, not when a newer one is resolved.
        facts: {
          count: found.length,
          latest: { ...latest, seat },
          occurrence: occurrenceOf(latest),
          occurrences: found.map(occurrenceOf),
          dismissLabel: 'This was me',
          incident,
        },
      };
      return [result];
    },
  };
}

/**
 * Every crew post OpenADLC refused to sign has had its cause put right.
 *
 * OpenADLC's gh posts a body the stamp route refused unsigned, and the
 * unattributed-post card then said the account was used around OpenADLC: on
 * 620legal/www#12 every post a revert task made on its own pull request was
 * refused, and the card asked a person whether it was them. A post that
 * matches a recorded refusal (`refusalFor`) is this card's instead, which
 * says OpenADLC could not sign it, and why.
 *
 * Nothing a person dismisses puts the cause right, so it offers no Dismiss
 * and no "This was me" (`dismissable: false`, which the acknowledge route
 * holds to). It clears when a task of the refused one's kind, on the same
 * kind of subject, signs again, or when the post leaves the window. It is a
 * check of its own rather than a second result of `unattributed-post`, whose
 * failing rows fold into one card with one acknowledgement.
 */
export function stampRefusedCheck(reader: UnattributedReader, windowMs = UNATTRIBUTED_WINDOW_MS): HealthCheck {
  return {
    id: 'unsigned-refused',
    proves: 'OpenADLC signs every post the crew made in the last day that it refused to sign before',
    how: 'matches the crew posts that went out unsigned against the posts the bridge refused to sign, by repository, account, number and body',
    everyMinutes: 5,
    steps: [],
    history: true,
    async run(now) {
      const { recorded, refusals } = await readPosts(reader, now, windowMs);
      const refusedOf = new Map<UnattributedRecord, StampRefusal>();
      for (const post of recorded) {
        const refusal = refusalFor(post, refusals);
        if (refusal && refusal.clearedAt === null) refusedOf.set(post, refusal);
      }
      const found = await stillUnsigned(reader, [...refusedOf.keys()]);
      if (found.length === 0) return [{ ok: true, fixed: 'OpenADLC signs the crew’s posts it refused before' }];
      const latest = found[0]!;
      const refusal = refusedOf.get(latest)!;
      const mode = await reader.mode();
      const seat = seatToRecord(refusal.seat);
      const incident: UnsignedIncident = {
        ...incidentOf(latest, seat, mode),
        refusal: { reason: refusal.reason, seat, taskId: refusal.taskId, status: refusal.status },
      };
      const on = incident.target ? ` on ${latest.repo}#${incident.target.number}` : ` in ${latest.repo}`;
      const whose = seat ? `the ${seat}’s ${incident.did}` : `a ${incident.did}`;
      const result: CheckResult = {
        ok: false,
        severity: 'warning',
        title: found.length === 1 ? `OpenADLC could not sign ${whose}${on}` : `OpenADLC could not sign ${found.length} of the crew’s posts`,
        detail:
          `The latest, ${whose}${on}, was refused: ${refusal.reason}. ` +
          (incident.counted
            ? 'It counted: this install records unsigned posts and still counts them. '
            : 'It did not count: this install counts only what OpenADLC signed. ') +
          'It went out unsigned because OpenADLC refused to sign it, not because anyone used the account by hand.',
        action: latest.url
          ? { label: 'Open the post', url: latest.url }
          : { label: 'Open the repository', url: incident.target?.url ?? `https://github.com/${latest.repo}` },
        // No dismissLabel: there is nothing for a person to own up to, and
        // nothing a dismissal would put right.
        facts: {
          count: found.length,
          latest: { ...latest, seat },
          occurrence: occurrenceOf(latest),
          occurrences: found.map(occurrenceOf),
          dismissable: false,
          incident,
        },
      };
      return [result];
    },
  };
}
