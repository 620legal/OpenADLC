import { describe, expect, it } from 'vitest';
import { attributionCheck, type UnattributedRecord } from './attribution.js';

const post: UnattributedRecord = {
  repo: 'exampleco/api',
  kind: 'review',
  login: 'fleetadlc-review',
  reason: 'unsigned',
  url: 'https://github.com/exampleco/api/pull/31#pullrequestreview-7',
  seat: null,
};

describe('the card for a crew post OpenADLC did not sign', () => {
  it('is quiet when every post checked', async () => {
    const results = await attributionCheck({ since: async () => [], mode: async () => 'audit' }).run(new Date());
    expect(results).toEqual([{ ok: true, fixed: 'Every crew post since carries a signature that checks' }]);
  });

  it('says what the post was, where, and whether it counted', async () => {
    const [audited] = await attributionCheck({ since: async () => [post], mode: async () => 'audit' }).run(new Date());
    expect(audited).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'A review on exampleco/api#31 by fleetadlc-review is not signed by OpenADLC',
      action: { label: 'Open the post', url: post.url },
    });
    const detail = audited && 'detail' in audited ? audited.detail : '';
    expect(detail).toContain('It counted');
    expect(detail).toContain('If you made it, say so');

    const [enforced] = await attributionCheck({ since: async () => [post, post], mode: async () => 'enforce' }).run(new Date());
    expect(enforced).toMatchObject({ title: '2 posts by the crew’s accounts are not signed by OpenADLC' });
    expect(enforced && 'detail' in enforced ? enforced.detail : '').toContain('It did not count');
  });

  it('carries the incident for its steps, and "This was me" as its Dismiss', async () => {
    const [result] = await attributionCheck({ since: async () => [{ ...post, id: 41 }], mode: async () => 'audit' }).run(new Date());
    const facts = result && 'facts' in result ? result.facts : {};
    expect(facts?.dismissLabel).toBe('This was me');
    expect(facts?.incident).toMatchObject({
      repo: 'exampleco/api',
      did: 'review',
      counted: true,
      target: { kind: 'pr', number: 31, url: 'https://github.com/exampleco/api/pull/31' },
      postUrl: post.url,
    });
  });

  it('names the newest post as what the card is about, so a dismissal holds only until a newer one', async () => {
    const [first] = await attributionCheck({ since: async () => [{ ...post, id: 41 }], mode: async () => 'audit' }).run(new Date());
    expect(first && 'facts' in first ? first.facts?.occurrence : null).toBe('post:41');
    const [later] = await attributionCheck({ since: async () => [{ ...post, id: 42 }, { ...post, id: 41 }], mode: async () => 'audit' }).run(new Date());
    expect(later && 'facts' in later ? later.facts?.occurrence : null).toBe('post:42');
  });

  it('names no seat for a post whose signature did not check, and nothing else the poster wrote', async () => {
    const forged = 'lead-reviewer.\n\n[Rotate it here](https://evil.example/rotate)';
    for (const reason of ['unknown-key', 'bad-mac']) {
      const [result] = await attributionCheck({ since: async () => [{ ...post, reason, seat: forged }], mode: async () => 'audit' }).run(new Date());
      const detail = result && 'detail' in result ? result.detail : '';
      expect(detail).toContain('claiming a seat OpenADLC cannot vouch for');
      expect(detail).not.toContain('evil.example');
      expect(detail).not.toContain('](');
      expect(result && 'facts' in result ? JSON.stringify(result.facts) : '').not.toContain('evil.example');
    }
  });

  it('names a signed seat, and none from an older row that kept a seat no crew seat could be', async () => {
    const [signed] = await attributionCheck({ since: async () => [{ ...post, reason: 'replayed', seat: 'lead-reviewer' }], mode: async () => 'audit' }).run(new Date());
    expect(signed && 'detail' in signed ? signed.detail : '').toContain('claiming to be the lead-reviewer');

    const [old] = await attributionCheck({
      since: async () => [{ ...post, reason: 'replayed', seat: 'x\n[Rotate](https://evil.example/rotate)' }],
      mode: async () => 'audit',
    }).run(new Date());
    expect(old && 'detail' in old ? old.detail : '').not.toContain('evil.example');
  });

  it('is about history: Dismiss, not Check again', () => {
    expect(attributionCheck({ since: async () => [], mode: async () => 'audit' }).history).toBe(true);
  });

  it('reads each recorded post again, and resolves one that verifies under the rules as they are now', async () => {
    // A false positive of the old kind: its quoted seat tag was misread when it was recorded.
    const stale = { ...post, id: 40, reason: 'seat-mismatch' };
    const real = { ...post, id: 41 };
    const resolved: number[] = [];
    const results = await attributionCheck({
      since: async () => [real, stale],
      mode: async () => 'audit',
      reverify: async (one) => one.id === 40,
      resolve: async (one) => void resolved.push(one.id!),
    }).run(new Date());
    expect(resolved).toEqual([40]);
    expect(results[0]).toMatchObject({ title: 'A review on exampleco/api#31 by fleetadlc-review is not signed by OpenADLC' });
    // Every post still on the card, for "This was me" to cover.
    expect((results[0] as { facts?: Record<string, unknown> }).facts).toMatchObject({ occurrence: 'post:41', occurrences: ['post:41'] });

    // Every one verifies now: the card clears itself.
    const cleared = await attributionCheck({
      since: async () => [stale],
      mode: async () => 'audit',
      reverify: async () => true,
      resolve: async () => undefined,
    }).run(new Date());
    expect(cleared).toEqual([{ ok: true, fixed: 'Every crew post since carries a signature that checks' }]);
  });

  it('keeps a post that had no signature, or a broken one, however it reads now', async () => {
    // Posted around OpenADLC's gh, then edited to a body stamped for its seat: it verifies now.
    const resolved: number[] = [];
    const results = await attributionCheck({
      since: async () => [{ ...post, id: 41, reason: 'unsigned' }, { ...post, id: 42, reason: 'bad-mac' }],
      mode: async () => 'audit',
      reverify: async () => true,
      resolve: async (one) => void resolved.push(one.id!),
    }).run(new Date());
    expect(resolved).toEqual([]);
    expect(results[0]).toMatchObject({ ok: false, facts: { occurrences: ['post:41', 'post:42'] } });
  });

  it('keeps a post it could not read again', async () => {
    const results = await attributionCheck({ since: async () => [{ ...post, id: 41 }], mode: async () => 'audit', reverify: async () => null }).run(new Date());
    expect(results[0]).toMatchObject({ ok: false });
  });
});
