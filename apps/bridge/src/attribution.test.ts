import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@fleetadlc/github';
import { withSeat } from '@fleetadlc/shared';

const bound = new Map<string, string>();
const recorded: { reason: string; seat: string | null; bodySha256?: string | null; login?: string; url?: string | null }[] = [];
const audited: string[] = [];
const auditedPayloads: Record<string, unknown>[] = [];
// What the database is told to refuse, as Postgres refuses a NUL in text and jsonb.
const failWrites = { record: false, audit: false };

vi.mock('@fleetadlc/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleetadlc/db')>();
  return {
    ...actual,
    attributions: {
      bindNonce: vi.fn(async (input: { nonce: string; boundTo: string }) => {
        if (!bound.has(input.nonce)) bound.set(input.nonce, input.boundTo);
        return bound.get(input.nonce) === input.boundTo;
      }),
      recordUnattributed: vi.fn(async (input: { reason: string; seat: string | null; bodySha256: string | null; login: string; url: string | null }) => {
        recorded.push({ reason: input.reason, seat: input.seat, bodySha256: input.bodySha256, login: input.login, url: input.url });
        if (failWrites.record || JSON.stringify(input).includes('\\u0000')) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
      }),
    },
    audit: vi.fn(async (input: { action: string; actor: string; payload?: Record<string, unknown> }) => {
      audited.push(input.action);
      auditedPayloads.push({ actor: input.actor, ...input.payload });
      if (failWrites.audit || JSON.stringify(input).includes('\\u0000')) throw new Error('unsupported Unicode escape sequence');
    }),
  };
});

const { Attribution, bodyDigest, postPath, postTarget } = await import('./attribution.js');

function memoryStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: async (ref) => values.get(ref) ?? null,
    set: async (ref, value) => void values.set(ref, value),
    delete: async (ref) => void values.delete(ref),
    list: async () => [...values.keys()],
  } as SecretStore;
}

const crew = [
  { name: 'builder', githubLogin: 'fleetadlc-crew' },
  { name: 'lead-reviewer', githubLogin: 'fleetadlc-review' },
  { name: 'second-reviewer', githubLogin: 'fleetadlc-review' },
];

const review = (body: string, id = 1, number = 7) => ({
  repo: 'exampleco/api',
  kind: 'review',
  id,
  number,
  login: 'fleetadlc-review',
  body,
  url: 'https://github.com/exampleco/api/pull/7#pullrequestreview-1',
});

describe('checking what the crew posts', () => {
  beforeEach(() => {
    bound.clear();
    recorded.length = 0;
    audited.length = 0;
    auditedPayloads.length = 0;
    failWrites.record = false;
    failWrites.audit = false;
  });

  it('counts a post the task’s session had signed, as the seat and the task it was signed for', async () => {
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign(withSeat('Looks right.', 'lead-reviewer'), {
      seat: 'lead-reviewer',
      task: 't-1',
      repo: 'exampleco/api',
      kind: 'review',
      n: 7,
    });
    expect(await attribution.check(review(body), crew, 'enforce')).toEqual({ counts: true, verified: true, seat: 'lead-reviewer', task: 't-1', reason: null });
    expect(recorded).toEqual([]);
  });

  it('records an unsigned one, counts it while only auditing, and not once enforcing', async () => {
    const attribution = new Attribution(memoryStore());
    expect(await attribution.check(review('Looks right.'), crew, 'audit')).toMatchObject({ counts: true, verified: false, reason: 'unsigned' });
    expect(await attribution.check(review('Looks right.', 2), crew, 'enforce')).toMatchObject({ counts: false, reason: 'unsigned' });
    expect(recorded.map((one) => one.reason)).toEqual(['unsigned', 'unsigned']);
    expect(audited).toEqual(['attribution.unverified', 'attribution.unverified']);
    // With the body it had, so reading it again can tell an edit from the post that was made.
    expect(recorded[0]?.bodySha256).toBe(bodyDigest('Looks right.'));
    expect(bodyDigest('Looks right, edited.')).not.toBe(recorded[0]?.bodySha256);
  });

  it('knows a signed post copied onto a second one, and one signed for another pull request', async () => {
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign('Looks right.', { seat: 'lead-reviewer', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    expect((await attribution.check(review(body, 1), crew, 'enforce')).counts).toBe(true);
    // The same review again — a redelivery or an edit — is still its own.
    expect((await attribution.check(review(body, 1), crew, 'enforce')).counts).toBe(true);
    expect(await attribution.check(review(body, 2), crew, 'enforce')).toMatchObject({ counts: false, reason: 'replayed' });
    expect(await attribution.check(review(body, 3, 8), crew, 'enforce')).toMatchObject({ counts: false, reason: 'wrong-target' });
  });

  it('keeps no seat from a signature that did not check, nor one no crew seat could be', async () => {
    const attribution = new Attribution(memoryStore());
    const stranger = new Attribution(memoryStore());
    const forged = 'lead-reviewer.\n\n[Rotate it here](https://evil.example/rotate)';
    const body = await stranger.sign('Looks right.', { seat: forged, task: null, repo: 'exampleco/api', kind: 'review', n: 7 });
    expect(await attribution.check(review(body), crew, 'audit')).toMatchObject({ reason: 'unknown-key', seat: null });
    expect(recorded[0]?.seat).toBeNull();
    expect(auditedPayloads[0]?.seat).toBeNull();

    // A signature that checks, for another pull request: its seat is OpenADLC's word, when it is a plain name.
    const signed = await attribution.sign('Fine.', { seat: 'lead-reviewer', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    expect(await attribution.check(review(signed, 2, 8), crew, 'audit')).toMatchObject({ reason: 'wrong-target', seat: 'lead-reviewer' });
    const odd = await attribution.sign('Fine.', { seat: 'Lead Reviewer!', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    expect(await attribution.check(review(odd, 3, 8), crew, 'audit')).toMatchObject({ reason: 'wrong-target', seat: null });
  });

  it('writes the record and the audit entry with control characters taken out, whatever the post carried', async () => {
    const attribution = new Attribution(memoryStore());
    const signed = await attribution.sign('Fine.', { seat: 'lead-reviewer\u0000', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    const post = { ...review(signed, 4, 8), url: 'https://github.com/exampleco/api/pull/8\u0000\u001b[2J' };
    await attribution.check(post, crew, 'audit');
    expect(recorded).toEqual([expect.objectContaining({ reason: 'wrong-target', seat: null, login: 'fleetadlc-review', url: 'https://github.com/exampleco/api/pull/8[2J' })]);
    expect(auditedPayloads).toEqual([expect.objectContaining({ actor: 'fleetadlc-review', seat: null })]);
    expect(audited).toEqual(['attribution.unverified']);
  });

  it('says so when the record or the audit entry cannot be written, naming the post, and still answers', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failWrites.record = true;
    failWrites.audit = true;
    const attribution = new Attribution(memoryStore());
    expect(await attribution.check(review('Looks right.', 9), crew, 'audit')).toMatchObject({ counts: true, reason: 'unsigned' });
    expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(/could not record the unsigned exampleco\/api review 9/),
      expect.stringMatching(/could not audit the unsigned exampleco\/api review 9/),
    ]);
    errors.mockRestore();
  });

  it('leaves a person’s post alone', async () => {
    const attribution = new Attribution(memoryStore());
    expect(await attribution.check({ ...review('LGTM'), login: 'janedoe' }, crew, 'enforce')).toEqual({ counts: true, verified: false, seat: null, task: null, reason: null });
    expect(recorded).toEqual([]);
  });

  it('keeps one key across restarts, and still checks what an old key signed after a rotation', async () => {
    const store = memoryStore();
    const first = new Attribution(store);
    const body = await first.sign('Looks right.', { seat: 'lead-reviewer', task: null, repo: 'exampleco/api', kind: 'review', n: 7 });
    const again = new Attribution(store);
    expect((await again.check(review(body), crew, 'enforce')).verified).toBe(true);
    const rotated = await again.rotate();
    expect(rotated.kid).not.toBe(rotated.retiredKid);
    expect(Date.parse(rotated.checksUntil!) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect((await again.check(review(body, 1), crew, 'enforce')).verified).toBe(true);
    expect((await new Attribution(store).check(review(body, 1), crew, 'enforce')).verified).toBe(true);
  });

  it('stops checking the old key and every earlier one at once after a leak', async () => {
    const store = memoryStore();
    const attribution = new Attribution(store);
    const oldest = await attribution.sign('Looks right.', { seat: 'lead-reviewer', task: null, repo: 'exampleco/api', kind: 'review', n: 7 });
    await attribution.rotate();
    const older = await attribution.sign('Fine.', { seat: 'lead-reviewer', task: null, repo: 'exampleco/api', kind: 'review', n: 7 });
    expect((await attribution.check(review(oldest, 1), crew, 'enforce')).verified).toBe(true);

    const rotated = await attribution.rotate({ dropOld: true });

    expect(rotated.checksUntil).toBeNull();
    expect(await attribution.keyring()).toHaveLength(1);
    for (const one of [attribution, new Attribution(store)]) {
      expect((await one.check(review(oldest, 1), crew, 'enforce')).verified).toBe(false);
      expect((await one.check(review(older, 2), crew, 'enforce')).verified).toBe(false);
    }
    const fresh = await attribution.sign('Now.', { seat: 'lead-reviewer', task: null, repo: 'exampleco/api', kind: 'review', n: 7 });
    expect((await new Attribution(store).check(review(fresh, 3), crew, 'enforce')).verified).toBe(true);
  });

  it('keeps only the reviews that count toward the gate', async () => {
    const attribution = new Attribution(memoryStore());
    const signed = await attribution.sign('Fine.', { seat: 'second-reviewer', task: 't-2', repo: 'exampleco/api', kind: 'review', n: 7 });
    const reviews = [
      { user: 'fleetadlc-review', body: signed },
      { user: 'fleetadlc-review', body: 'Fine, posted with curl.' },
      { user: 'janedoe', body: 'LGTM' },
    ];
    expect(await attribution.countable(reviews, crew, 'audit')).toHaveLength(3);
    expect((await attribution.countable(reviews, crew, 'enforce')).map((one) => one.user)).toEqual(['fleetadlc-review', 'janedoe']);
  });
});

describe('the reviews a merge may count', () => {
  beforeEach(() => {
    bound.clear();
  });

  const approval = (id: number, body: string) => ({ id, user: 'fleetadlc-review', body, state: 'APPROVED' });

  it('keeps a review signed for a review on this pull request, and a person’s', async () => {
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign(withSeat('Approved.', 'second-reviewer'), { seat: 'second-reviewer', task: 't-2', repo: 'exampleco/api', kind: 'review', n: 7 });

    const kept = await attribution.reviewsThatCount('exampleco/api', 7, [approval(11, body), { id: 12, user: 'janedoe', body: 'LGTM', state: 'APPROVED' }], crew);

    expect(kept.map((one) => one.id)).toEqual([11, 12]);
  });

  it('counts a review the webhook bound under GitHub’s casing when the merge asks with the stored name', async () => {
    // The delivery always arrives first and used to bind the nonce to
    // `Acme/api`. The repository row says `acme/api`. An exact key then
    // dropped the approval, and in audit mode no crew pull request merged.
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign(withSeat('Approved.', 'second-reviewer'), { seat: 'second-reviewer', task: 't-2', repo: 'Acme/api', kind: 'review', n: 7 });

    expect((await attribution.reviewsThatCount('Acme/api', 7, [approval(41, body)], crew)).map((one) => one.id)).toEqual([41]);
    expect((await attribution.reviewsThatCount('acme/api', 7, [approval(41, body)], crew)).map((one) => one.id)).toEqual([41]);
  });

  it('refuses another seat’s signed text posted again as an approval here, from a comment or another pull request', async () => {
    // A seat on a shared account copies second-reviewer's signed words into an
    // approval of its own: its signature and seat tag check, and nothing else does.
    const attribution = new Attribution(memoryStore());
    const signed = (fields: { kind: string; n: number; repo: string }) =>
      attribution.sign(withSeat('Approved.', 'second-reviewer'), { seat: 'second-reviewer', task: 't-2', ...fields });

    const fromComment = await signed({ kind: 'comment', n: 7, repo: 'exampleco/api' });
    const fromElsewhere = await signed({ kind: 'review', n: 99, repo: 'exampleco/other' });
    expect(await attribution.reviewsThatCount('exampleco/api', 7, [approval(21, fromComment), approval(22, fromElsewhere)], crew)).toEqual([]);
  });

  it('refuses the same signed review a second time under another review, and keeps the first on every read', async () => {
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign(withSeat('Approved.', 'second-reviewer'), { seat: 'second-reviewer', task: 't-2', repo: 'exampleco/api', kind: 'review', n: 7 });

    expect((await attribution.reviewsThatCount('exampleco/api', 7, [approval(31, body)], crew)).map((one) => one.id)).toEqual([31]);
    expect((await attribution.reviewsThatCount('exampleco/api', 7, [approval(31, body), approval(32, body)], crew)).map((one) => one.id)).toEqual([31]);
  });
});

describe('a recorded post, read again', () => {
  beforeEach(() => {
    bound.clear();
    recorded.length = 0;
  });

  it('verifies when it is signed and on its target, and records nothing either way', async () => {
    const attribution = new Attribution(memoryStore());
    const body = await attribution.sign(withSeat('Looks right.', 'lead-reviewer'), { seat: 'lead-reviewer', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    expect(await attribution.verifies(review(body))).toBe(true);
    expect(await attribution.verifies(review('Looks right.', 2))).toBe(false);
    expect(await attribution.verifies({ ...review(body, 3), number: 8 })).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('is found on GitHub by what it is and where it is shown', () => {
    expect(postTarget('https://github.com/exampleco/api/pull/7#pullrequestreview-1')).toEqual({ kind: 'pr', number: 7 });
    expect(postTarget('https://github.com/exampleco/api/issues/12#issuecomment-5')).toEqual({ kind: 'issue', number: 12 });
    expect(postTarget(null)).toBeNull();
    const at = { repo: 'exampleco/api', objectId: '99', url: 'https://github.com/exampleco/api/pull/7#pullrequestreview-99' };
    expect(postPath({ ...at, kind: 'comment' })).toBe('/repos/exampleco/api/issues/comments/99');
    expect(postPath({ ...at, kind: 'review' })).toBe('/repos/exampleco/api/pulls/7/reviews/99');
    expect(postPath({ ...at, kind: 'pr' })).toBe('/repos/exampleco/api/pulls/7');
    expect(postPath({ ...at, kind: 'review', url: null })).toBeNull();
  });
});
