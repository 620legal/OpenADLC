import { createHash } from 'node:crypto';
import { attributions, audit } from '@fleetadlc/db';
import { getSecretStore, type SecretStore } from '@fleetadlc/github';
import {
  UNVERIFIED_REASON,
  isFleetLogin,
  newSigningKey,
  signBody,
  verifyBody,
  type SignedFields,
  type SigningKey,
  type SignaturePayload,
} from '@fleetadlc/shared';

/**
 * The bridge's half of signed posts (packages/shared/src/signature.ts): it
 * holds the key, signs, and checks what GitHub sends back.
 *
 * The key is a secret like any other, made the first time one is needed. A
 * replaced key keeps checking for `RETIRED_FOR_MS`, so a post signed just
 * before a rotation is not suddenly a stranger's.
 */

const KEY_REF = 'attribution-key';
const RETIRED_FOR_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredKeys {
  current: SigningKey;
  retired: (SigningKey & { retiredAt: string })[];
}

/**
 * What a post from a crew account is, once checked. `mode` is the install's
 * `attributionMode`: `audit` records what fails and counts it anyway, as posts
 * were counted before there were signatures; `enforce` counts only what checks.
 */
export type AttributionMode = 'audit' | 'enforce';

export function attributionModeOf(value: string | null | undefined): AttributionMode {
  return value === 'enforce' ? 'enforce' : 'audit';
}

export interface CheckedPost {
  repo: string;
  /** `comment`, `review`, `issue`, `pr`. */
  kind: string;
  /** GitHub's id of the comment, review, issue or pull request. */
  id: string | number;
  /** The issue or pull request number it is on. */
  number: number | null;
  login: string;
  body: string | null;
  url?: string | null;
}

/** A repository's full name as a key: GitHub treats it as case-insensitive. */
function canonicalRepo(repo: string): string {
  return repo.toLowerCase();
}

export class Attribution {
  private keys: StoredKeys | null = null;

  constructor(private readonly store: SecretStore = getSecretStore()) {}

  private async loaded(): Promise<StoredKeys> {
    if (this.keys) return this.keys;
    const raw = await this.store.get(KEY_REF);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredKeys;
      const cutoff = Date.now() - RETIRED_FOR_MS;
      this.keys = { current: parsed.current, retired: (parsed.retired ?? []).filter((key) => Date.parse(key.retiredAt) >= cutoff) };
      return this.keys;
    }
    this.keys = { current: newSigningKey(), retired: [] };
    await this.store.set(KEY_REF, JSON.stringify(this.keys));
    return this.keys;
  }

  /** Every key that still checks, the current one first. */
  async keyring(): Promise<SigningKey[]> {
    const keys = await this.loaded();
    return [keys.current, ...keys.retired];
  }

  /**
   * Of `posts`, those that count: all of them in `audit` mode; in `enforce`,
   * a person's always and the crew's only when their signature checks.
   */
  async countable<P extends { user: string | null; body?: string | null }>(
    posts: readonly P[],
    crew: readonly { githubLogin: string | null }[],
    mode: AttributionMode,
  ): Promise<P[]> {
    if (mode !== 'enforce') return [...posts];
    const keys = await this.keyring();
    return posts.filter((post) => !isFleetLogin(crew, post.user) || verifyBody(post.body, keys).ok);
  }

  /**
   * Of a pull request's reviews, those a merge may count, with signatures
   * enforced: a person's always, and a crew account's only when its signature
   * checks, was made for a review (`kind: review`) on this pull request of this
   * repository, and its nonce is this review's — bound to its id the first
   * time it is seen, here or on the webhook, and refused on any other.
   *
   * `countable` checks the signature alone, which a seat on a shared account
   * could satisfy by posting another seat's signed text — from a comment on any
   * pull request — as an approval here. The review id binds the verdict too:
   * a copy is another review, and its nonce is already someone else's.
   */
  async reviewsThatCount<R extends { id: number; user: string | null; body?: string | null }>(
    repo: string,
    prNumber: number,
    reviews: readonly R[],
    crew: readonly { githubLogin: string | null }[],
  ): Promise<R[]> {
    const keys = await this.keyring();
    const kept: R[] = [];
    for (const review of reviews) {
      if (!isFleetLogin(crew, review.user)) {
        kept.push(review);
        continue;
      }
      const verdict = verifyBody(review.body, keys);
      if (!verdict.ok) continue;
      const payload = verdict.payload;
      if (payload.kind !== 'review' || payload.n !== prNumber || payload.repo?.toLowerCase() !== repo.toLowerCase()) continue;
      // The nonce is bound to the repository's name. The webhook sees GitHub's
      // canonical casing and the merge line sees the name stored on the row;
      // those differ when the owner was typed in another case, and an exact
      // key then dropped every approval. The key is the lower-case name.
      const key = canonicalRepo(repo);
      const boundTo = `${key}:review:${review.id}`;
      const mine = await attributions.bindNonce({ nonce: payload.nonce, seat: payload.seat, taskId: payload.task, repo: key, kind: 'review', boundTo });
      if (mine) kept.push(review);
    }
    return kept;
  }

  /**
   * A new key to sign with. On a routine rotation the old one keeps checking
   * for `RETIRED_FOR_MS`. After a leak (`dropOld`) the old key and every key
   * retired before it stop checking at once: a leaked key that still checked
   * for a month would let whoever holds it sign as the crew for that month.
   *
   * Through the running bridge only (`POST /v1/attribution/rotate`): this
   * instance keeps the ring in memory, so a key written to the store behind
   * its back would not be signed or checked with until a restart.
   */
  async rotate(options: { dropOld?: boolean } = {}): Promise<{ kid: string; retiredKid: string; checksUntil: string | null }> {
    const keys = await this.loaded();
    const now = Date.now();
    this.keys = {
      current: newSigningKey(),
      retired: options.dropOld ? [] : [{ ...keys.current, retiredAt: new Date(now).toISOString() }, ...keys.retired],
    };
    await this.store.set(KEY_REF, JSON.stringify(this.keys));
    return {
      kid: this.keys.current.kid,
      retiredKid: keys.current.kid,
      checksUntil: options.dropOld ? null : new Date(now + RETIRED_FOR_MS).toISOString(),
    };
  }

  /** Signs as `seat`, for `task` when a task's session asked. */
  async sign(body: string, fields: SignedFields): Promise<string> {
    return signBody(body, fields, (await this.loaded()).current);
  }

  /** A signer for one seat's client, with the key already in hand: `GitHubClient`'s `sign`. */
  async signerFor(seat: string): Promise<(body: string, post: { repo: string; kind: string; n?: number | null }) => string> {
    const key = (await this.loaded()).current;
    return (body, post) => signBody(body, { seat, task: null, repo: post.repo, kind: post.kind, n: post.n ?? null }, key);
  }

  /**
   * Whether a post verifies under the rules as they are now: its signature,
   * its target, and its nonce bound to it. For a post recorded as not signed
   * by OpenADLC, read again from GitHub; nothing is recorded here, so a post
   * that still fails is not recorded twice.
   */
  async verifies(post: CheckedPost): Promise<boolean> {
    const keys = await this.loaded();
    const verdict = verifyBody(post.body, [keys.current, ...keys.retired]);
    if (!verdict.ok) return false;
    const payload = verdict.payload;
    if (payload.n && post.number && payload.n !== post.number) return false;
    if (payload.repo && payload.repo.toLowerCase() !== post.repo.toLowerCase()) return false;
    const key = canonicalRepo(post.repo);
    return attributions.bindNonce({
      nonce: payload.nonce,
      seat: payload.seat,
      taskId: payload.task,
      repo: key,
      kind: post.kind,
      boundTo: `${key}:${post.kind}:${post.id}`,
    });
  }

  /**
   * Checks a post by one of the crew's accounts, records a failure, and says
   * whether it counts. A person's post is not OpenADLC's to check and always
   * counts; so does anything when the database cannot be asked, rather than
   * holding the pipeline on a check that could not run.
   */
  async check(
    post: CheckedPost,
    crew: readonly { name: string; githubLogin: string | null }[],
    mode: AttributionMode,
  ): Promise<{ counts: boolean; verified: boolean; seat: string | null; task: string | null; reason: string | null }> {
    if (!isFleetLogin(crew, post.login)) return { counts: true, verified: false, seat: null, task: null, reason: null };
    const keys = await this.loaded();
    const verdict = verifyBody(post.body, [keys.current, ...keys.retired]);

    let reason: keyof typeof UNVERIFIED_REASON | null = verdict.ok ? null : verdict.reason;
    const payload: SignaturePayload | undefined = verdict.payload;
    if (verdict.ok) {
      if (payload?.n && post.number && payload.n !== post.number) reason = 'wrong-target';
      else if (payload?.repo && payload.repo.toLowerCase() !== post.repo.toLowerCase()) reason = 'wrong-target';
      else {
        const key = canonicalRepo(post.repo);
        const mine = await attributions
          .bindNonce({
            nonce: verdict.payload.nonce,
            seat: verdict.payload.seat,
            taskId: verdict.payload.task,
            repo: key,
            kind: post.kind,
            boundTo: `${key}:${post.kind}:${post.id}`,
          })
          .catch(() => true);
        if (!mine) reason = 'replayed';
      }
    }

    // The task too: what only one task may post — a design's memory — is
    // judged by the task the signature names, not by the poster's word.
    if (!reason) return { counts: true, verified: true, seat: payload?.seat ?? null, task: payload?.task ?? null, reason: null };

    // The seat only of a signature that checked: for an unknown key or a bad
    // MAC it is whatever the poster wrote, and the card quoted it, a link
    // inside OpenADLC's own alert included. A NUL in it failed both writes,
    // silently, so the forged post left no trace.
    const seat = SIGNED_SEAT.has(reason) ? seatToRecord(payload?.seat, crew) : null;
    const login = withoutControls(post.login);
    const where = `${post.repo} ${post.kind} ${post.id}`;
    await attributions
      .recordUnattributed({
        repo: withoutControls(post.repo),
        kind: post.kind,
        objectId: String(post.id),
        login,
        reason,
        url: post.url ? withoutControls(post.url) : null,
        seat,
        bodySha256: bodyDigest(post.body),
      })
      .catch((error: unknown) => console.error(`[bridge] could not record the unsigned ${where}: ${messageOf(error)}`));
    await audit({
      actor: login,
      action: 'attribution.unverified',
      target: withoutControls(`${post.repo}#${post.number ?? ''}`),
      payload: { kind: post.kind, id: String(post.id), reason, seat, mode },
    }).catch((error: unknown) => console.error(`[bridge] could not audit the unsigned ${where}: ${messageOf(error)}`));
    console.warn(`[bridge] ${where} by ${login}: ${UNVERIFIED_REASON[reason]}`);
    return { counts: mode === 'audit', verified: false, seat, task: null, reason };
  }
}

/** The reasons a post fails with after its signature checked, so the seat it names is OpenADLC's own word. */
const SIGNED_SEAT: ReadonlySet<string> = new Set(['body-changed', 'seat-mismatch', 'replayed', 'wrong-target']);

/** A seat as OpenADLC names one: short, plain, and nothing a card could render as more than a name. */
const PLAIN_SEAT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The seat to keep for a post, or null: one of the crew's, or a plain short
 * name. Also what a card shows a recorded seat through, so a row written
 * before this check is shown the same way.
 */
export function seatToRecord(seat: string | null | undefined, crew: readonly { name: string }[] = []): string | null {
  if (!seat) return null;
  if (crew.some((bot) => bot.name === seat)) return seat;
  return PLAIN_SEAT.test(seat) ? seat : null;
}

/** Text with NUL and the other control characters taken out: Postgres refuses a NUL in `text` and in `jsonb`. */
export function withoutControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a post's body was, as a recorded post keeps it: the same body reads the same, and nothing of it is stored. */
export function bodyDigest(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

/** The issue or pull request a post is on, from where GitHub shows it: `…/pull/12#pullrequestreview-3`. */
export function postTarget(url: string | null | undefined): { kind: 'pr' | 'issue'; number: number } | null {
  const match = /\/(pull|issues)\/(\d+)/.exec(url ?? '');
  return match ? { kind: match[1] === 'pull' ? 'pr' : 'issue', number: Number(match[2]) } : null;
}

/** Where GitHub keeps a recorded post, by what it is: null when it cannot be said. */
export function postPath(post: { repo: string; kind: string; objectId: string; url: string | null }): string | null {
  const target = postTarget(post.url);
  switch (post.kind) {
    case 'comment':
      return `/repos/${post.repo}/issues/comments/${post.objectId}`;
    case 'review':
      return target ? `/repos/${post.repo}/pulls/${target.number}/reviews/${post.objectId}` : null;
    case 'issue':
      return target ? `/repos/${post.repo}/issues/${target.number}` : null;
    case 'pr':
      return target ? `/repos/${post.repo}/pulls/${target.number}` : null;
    default:
      return null;
  }
}
