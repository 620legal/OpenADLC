import type { BotRole } from './types.js';

/**
 * The line every piece of text OpenADLC posts to GitHub starts with.
 *
 * With seats sharing GitHub accounts, every issue, comment and review
 * the crew writes is by the same user, and GitHub's own attribution says
 * nothing about which stage wrote it. So OpenADLC says it, first:
 * `**OpenADLC_exampleco · design agent**`, or just `**OpenADLC_exampleco**` in the
 * platform's own voice. It is for people to read; what OpenADLC itself trusts
 * about who wrote something comes from `whoWrote`, not from this line.
 *
 * The invisible tag after it is what makes the header recognisable: adding it
 * twice, or stripping it from what the console shows, cannot mistake a bold
 * first line somebody wrote for OpenADLC's.
 */
export const HEADER_TAG = '<!-- fleetadlc-header -->';

/** What each stage is called in the header. The automation bot speaks as the platform, with no stage. */
export const STAGE_LABEL: Readonly<Record<BotRole, string | null>> = {
  intake: 'intake agent',
  spec: 'design agent',
  implement: 'build agent',
  review_lead: 'lead review agent',
  review_second: 'second review agent',
  review_security: 'security review agent',
  qa: 'QA agent',
  deploy: 'ship agent',
  automation: null,
};

/** The install's name when nobody has set one: `OpenADLC_<organization>`, or plain `OpenADLC`. */
export function defaultInstallName(organization: string | null | undefined): string {
  const org = (organization ?? '').trim();
  return org ? `OpenADLC_${org}` : 'OpenADLC';
}

/** The header for a seat of this role, or for the platform itself (`null`). */
export function headerFor(installName: string, role: BotRole | null): string {
  const stage = role ? STAGE_LABEL[role] : null;
  const name = installName.trim() || 'OpenADLC';
  return `**${stage ? `${name} · ${stage}` : name}**${HEADER_TAG}`;
}

// `fleet-header` is the tag posts carried before the rename; theirs is read too.
const LEADING_HEADER = /^\*\*[^\n]*\*\*<!-- fleet(?:adlc)?-header -->[ \t]*\n*/;

/** Whether a body already starts with an OpenADLC header. */
export function hasHeader(body: string): boolean {
  return LEADING_HEADER.test(body);
}

/**
 * The body with `header` first. A body that already has an OpenADLC header keeps
 * its own — a comment posted again, or a status issue rewritten every run, is
 * not headed twice.
 */
export function withHeader(body: string, header: string): string {
  if (hasHeader(body)) return body;
  return body.trim().length > 0 ? `${header}\n\n${body}` : header;
}

/** A seat tag at the end of a post, with nothing after it but the signature `signBody` puts there. */
const SEAT_TAG = /<!-- fleet(?:adlc)?-seat:([a-z0-9][a-z0-9._-]*) -->\s*(?:<!-- fleet(?:adlc)?-sig:[^>]*-->\s*)?$/i;

/** The signature at the end of a post, whose payload names the seat it was signed for. */
const SIGNED_SEAT = /<!-- fleet(?:adlc)?-sig:v1\.[a-z0-9]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+ -->\s*$/;

function tagOf(body: string): string | null {
  return SEAT_TAG.exec(body)?.[1]?.toLowerCase() ?? null;
}

/**
 * Which seat wrote a post: the tag at its end, `<!-- fleetadlc-seat:builder -->`,
 * or, on a post that has none, the seat its signature was made for.
 *
 * Seats that share a GitHub account post as one user, so the account says
 * nothing about which of them wrote a review; this does. It is put on by what
 * posts — the bridge's client and the session's `gh` — not asked of the model.
 * Read alone it is a seat's word (`whoWrote` says `via: 'marker'`);
 * `verifyBody` checks that it and the signature agree, which is what the
 * bridge goes by for the lead and a blocking seat on a shared account, and for
 * every crew post with signatures enforced.
 *
 * Only the end counts. This read the first tag anywhere in the body, and a
 * review that quoted one was taken for another seat's: on a real install the lead
 * reviewer explained a bug by quoting `<!-- fleetadlc-seat:intake -->`, so its own
 * tag was never added (a tag was "already there"), the review read as the
 * intake seat's, and its task was failed as having "ended without posting its
 * review" eleven seconds after posting it. That review, and any other posted
 * before the fix, has no tag of its own but is signed, which is how it is
 * still counted for the seat that wrote it.
 */
export function seatOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const tagged = tagOf(body);
  if (tagged) return tagged;
  const signed = SIGNED_SEAT.exec(body)?.[1];
  if (!signed) return null;
  try {
    const seat = (JSON.parse(Buffer.from(signed, 'base64url').toString('utf8')) as { seat?: unknown }).seat;
    return typeof seat === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(seat) ? seat.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Tags a post with the seat that wrote it, at its end. An end that already
 * names this seat is kept; one that names another seat is replaced, with any
 * signature after it. Keeping any tag let a session on an account the
 * reviewers share post a body ending in the lead's tag through OpenADLC's own
 * `gh`, and have it signed. A tag the body quotes earlier is left alone.
 */
export function withSeat(body: string, seat: string): string {
  const own = seat.toLowerCase();
  const tagged = tagOf(body);
  if (tagged === own) return body;
  const bare = tagged ? body.replace(SEAT_TAG, '') : body;
  return `${bare.trimEnd()}\n\n<!-- fleetadlc-seat:${own} -->`;
}

/** The seat the tag at the end of a post names, without falling back to its signature as `seatOf` does. */
export function seatTagOf(body: string | null | undefined): string | null {
  return body ? tagOf(body) : null;
}
