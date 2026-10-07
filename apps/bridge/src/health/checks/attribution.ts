import { UNVERIFIED_REASON } from '@fleetadlc/shared';
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
}

export interface UnattributedReader {
  /** Crew posts whose signature did not check, seen since `since`, newest first. */
  since(since: Date): Promise<UnattributedRecord[]>;
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
      const recorded = await reader.since(new Date(now.getTime() - windowMs));
      // Read again side by side, not one after another: a bad day can list fifty.
      const verified = await Promise.all(
        recorded.map((post) => (reader.reverify && post.id !== undefined ? reader.reverify(post).catch(() => null) : Promise.resolve(null))),
      );
      const found: UnattributedRecord[] = [];
      for (const [index, post] of recorded.entries()) {
        if (verified[index] === true && RULES_CAN_FLIP.has(post.reason)) {
          await reader.resolve?.(post).catch(() => undefined);
          continue;
        }
        found.push(post);
      }
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
      const incident: UnsignedIncident = {
        repo: latest.repo,
        login: latest.login,
        seat,
        did,
        postUrl: latest.url,
        target: target
          ? { ...target, url: `https://github.com/${latest.repo}/${target.kind === 'pr' ? 'pull' : 'issues'}/${target.number}` }
          : null,
        counted: !enforced,
        mode,
      };
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
