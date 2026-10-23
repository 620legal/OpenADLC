import { describe, expect, it } from 'vitest';
import { withHeader, withSeat } from './stamp.js';
import { bodyHash, newSigningKey, normalizeBody, SIGNED_BODY_MAX, signBody, signedHead, verifyBody } from './signature.js';

const key = newSigningKey();
const fields = { seat: 'lead-reviewer', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 };
const post = withSeat(withHeader('Looks right.', '**OpenADLC_exampleco · lead review agent**<!-- openadlc-header -->'), 'lead-reviewer');

describe('a signed post', () => {
  it('checks, and says who signed it for what', () => {
    const signed = signBody(post, fields, key);
    const verdict = verifyBody(signed, [key]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload).toMatchObject({ seat: 'lead-reviewer', task: 't-1', repo: 'exampleco/api', kind: 'review', n: 7 });
    expect(signed.startsWith(`${post}\n\n<!-- openadlc-sig:`)).toBe(true);
  });

  it('still checks after GitHub turns its line endings round or trims it', () => {
    const signed = signBody(post, fields, key);
    expect(verifyBody(`${signed.replace(/\n/g, '\r\n')}\n`, [key]).ok).toBe(true);
  });

  it('does not check once the body is changed — a word, the header, or the seat tag', () => {
    const signed = signBody(post, fields, key);
    expect(verifyBody(signed.replace('Looks right.', 'Looks wrong.'), [key])).toMatchObject({ ok: false, reason: 'body-changed' });
    expect(verifyBody(signed.replace('lead review agent', 'build agent'), [key])).toMatchObject({ ok: false, reason: 'body-changed' });
  });

  it('does not check when its seat tag names another seat than its signature', () => {
    const other = signBody(withSeat('Looks right.', 'second-reviewer'), fields, key);
    expect(verifyBody(other, [key])).toMatchObject({ ok: false, reason: 'seat-mismatch' });
  });

  it('does not check under another key, or with its signature forged', () => {
    const signed = signBody(post, fields, key);
    expect(verifyBody(signed, [newSigningKey()])).toMatchObject({ ok: false, reason: 'unknown-key' });
    const forged = signed.replace(/\.([A-Za-z0-9_-]+) -->$/, '.AAAA -->');
    expect(verifyBody(forged, [key])).toMatchObject({ ok: false, reason: 'bad-mac' });
  });

  it('is unsigned when it carries none, and a second signing replaces the first', () => {
    expect(verifyBody(post, [key])).toEqual({ ok: false, reason: 'unsigned' });
    const twice = signBody(signBody(post, fields, key), fields, key);
    expect(twice.match(/openadlc-sig:/g)).toHaveLength(1);
    expect(verifyBody(twice, [key]).ok).toBe(true);
  });

  it('hashes the body without its signature', () => {
    expect(bodyHash(signBody(post, fields, key))).toBe(bodyHash(post));
  });
});

describe('a signed review’s head', () => {
  // `h` is a hash of the body, not a commit: until a review was signed with
  // its head, nothing in it said which head it was of but GitHub's
  // `commit_id`, which GitHub moved onto a later head on 620legal/OpenADLC#118.
  const A = 'b7890794b365dd3ec75b81f761f1889dfb11674a';
  const B = '692cd1f88f3e45093ad9ba4e68e84d590af3b595';

  it('is the one it was signed with, under the signature', () => {
    const verdict = verifyBody(signBody(post, { ...fields, head: A }, key), [key]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.head).toBe(A);
      expect(verdict.payload.h).toBe(bodyHash(post));
      expect(signedHead(verdict.payload)).toBe(A);
    }
  });

  it('does not check once the head is changed', () => {
    const signed = signBody(post, { ...fields, head: A }, key);
    const [, payload] = /openadlc-sig:v1\.[a-z0-9]+\.([A-Za-z0-9_-]+)\./.exec(signed)!;
    const said = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
    expect(said.head).toBe(A);
    const moved = Buffer.from(JSON.stringify({ ...said, head: B })).toString('base64url');
    expect(verifyBody(signed.replace(payload!, moved), [key])).toMatchObject({ ok: false, reason: 'bad-mac' });
  });

  it('is none for a review signed without one, or a head that is no commit', () => {
    const verdict = verifyBody(signBody(post, fields, key), [key]);
    expect(verdict.ok && 'head' in verdict.payload).toBe(false);
    expect(signedHead(verdict.payload)).toBeNull();
    expect(signedHead({ head: 'head' })).toBeNull();
    expect(signedHead({ head: A.toUpperCase() })).toBeNull();
    expect(signedHead(null)).toBeNull();
  });
});

describe('a signature made before the rename to OpenADLC', () => {
  it('still verifies, because the bridge reads its history from posts that carry one', () => {
    // Signed as it was then: the old seat tag in the body, the old prefix on the signature.
    const fields = { seat: 'lead-reviewer', task: 't1', repo: 'acme/web', kind: 'review' };
    const signed = signBody('A review.\n\n<!-- fleet-seat:lead-reviewer -->', fields, key);
    const old = signed.replace('<!-- openadlc-sig:', '<!-- fleet-sig:');
    expect(verifyBody(old, [key])).toMatchObject({ ok: true, payload: { seat: 'lead-reviewer' } });
  });
});

describe('a long run of newlines or spaces', () => {
  // Each of these took seconds on a 60,000-character run: a crew session could
  // post one and stall the bridge on every webhook and merge-line pass.
  const runs = {
    newlines: `x${'\n'.repeat(64 * 1024)}y`,
    spaces: `x${' '.repeat(64 * 1024)}y`,
    tabs: `x${'\t'.repeat(64 * 1024)}y`,
    'trailing newlines': `x${'\n'.repeat(64 * 1024)}`,
  };

  it.each(Object.entries(runs))('is signed, verified and normalised quickly: %s', (_name, body) => {
    const started = performance.now();
    verifyBody(body.slice(0, SIGNED_BODY_MAX), [key]);
    signBody(body, fields, key);
    normalizeBody(body);
    withSeat(body, 'builder');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('is read as unsigned past GitHub’s limit, signed or not', () => {
    const signed = signBody(`${'x'.repeat(SIGNED_BODY_MAX)}`, fields, key);
    expect(signed.length).toBeGreaterThan(SIGNED_BODY_MAX);
    expect(verifyBody(signed, [key])).toEqual({ ok: false, reason: 'unsigned' });
  });
});

describe('the body a signature is made for', () => {
  it('is normalised as it was, so signatures already posted still check', () => {
    // Hashed by the regex version this replaced.
    const body = 'Looks right.  \t\r\n\tindented line \t \n  \n<!-- openadlc-sig:v1.abc.def.ghi -->\nlast \u00a0\t';
    expect(normalizeBody(body)).toBe('Looks right.\n\tindented line\n\n\nlast');
    expect(bodyHash(body)).toBe('DOMwz61Ryg1XHs9PHaH87dhdkVMttmu2un7-PQ9W0mI');
  });
});
