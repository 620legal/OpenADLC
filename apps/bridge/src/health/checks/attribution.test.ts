import { describe, expect, it } from 'vitest';
import {
  attributionCheck,
  refusalFor,
  refusalsFromEvents,
  stampRefusedCheck,
  type StampRefusal,
  type UnattributedReader,
  type UnattributedRecord,
} from './attribution.js';

const post: UnattributedRecord = {
  repo: 'exampleco/api',
  kind: 'review',
  login: 'openadlc-review',
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
      title: 'A review on exampleco/api#31 by openadlc-review is not signed by OpenADLC',
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
    expect(results[0]).toMatchObject({ title: 'A review on exampleco/api#31 by openadlc-review is not signed by OpenADLC' });
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

describe('the card for a crew post OpenADLC refused to sign', () => {
  // 620legal/www#12: a revert task's comment on its own pull request, refused
  // by the stamp route, posted unsigned by OpenADLC's gh.
  const NOW = new Date('2026-10-28T12:00:00.000Z');
  const BODY = 'b'.repeat(64);
  const unsigned: UnattributedRecord = {
    id: 42,
    repo: '620legal/www',
    kind: 'comment',
    login: 'openadlc-ship',
    reason: 'unsigned',
    url: 'https://github.com/620legal/www/pull/12#issuecomment-5',
    seat: null,
    bodySha256: BODY,
    at: '2026-10-28T11:00:05.000Z',
  };
  const REASON = 'a task on www@20b84446 may sign a post only on its own issue or pull request, not #12';
  const refusal: StampRefusal = {
    at: '2026-10-28T11:00:00.000Z',
    taskId: 'task-revert',
    taskKind: 'deploy',
    subjectType: 'merge',
    seat: 'ship',
    login: 'OpenADLC-Ship',
    repo: '620legal/WWW',
    number: 12,
    kind: 'comment',
    status: 403,
    reason: REASON,
    bodySha256: BODY,
    clearedAt: null,
  };
  const reader = (refusals: StampRefusal[], posts: UnattributedRecord[] = [unsigned]): UnattributedReader => ({
    since: async () => posts,
    refusals: async () => refusals,
    mode: async () => 'audit',
  });

  it('names OpenADLC’s refusal and its reason, with no This was me and no Dismiss', async () => {
    const [result] = await stampRefusedCheck(reader([refusal])).run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'OpenADLC could not sign the ship’s comment on 620legal/www#12',
      action: { label: 'Open the post', url: unsigned.url },
    });
    const detail = result && 'detail' in result ? result.detail : '';
    expect(detail).toContain(REASON);
    expect(detail).toContain('not because anyone used the account by hand');
    const facts = (result && 'facts' in result ? result.facts : {}) ?? {};
    expect(facts.dismissLabel).toBeUndefined();
    expect(facts.dismissable).toBe(false);
    expect(facts.occurrence).toBe('post:42');
    expect(facts.incident).toMatchObject({ refusal: { reason: REASON, seat: 'ship', taskId: 'task-revert', status: 403 }, counted: true });
  });

  it('takes the post off the account’s card', async () => {
    expect(await attributionCheck(reader([refusal])).run(NOW)).toEqual([{ ok: true, fixed: 'Every crew post since carries a signature that checks' }]);
  });

  it('clears once a task of that kind signs again, and the post does not go back to the account’s card', async () => {
    const cleared = reader([{ ...refusal, clearedAt: '2026-10-28T11:30:00.000Z' }]);
    expect(await stampRefusedCheck(cleared).run(NOW)).toEqual([{ ok: true, fixed: 'OpenADLC signs the crew’s posts it refused before' }]);
    expect(await attributionCheck(cleared).run(NOW)).toMatchObject([{ ok: true }]);
  });

  it('leaves a post with another body, another number or another account on the account’s card, as before', async () => {
    for (const other of [{ bodySha256: 'c'.repeat(64) }, { number: 13 }, { login: 'openadlc-review' }, { repo: '620legal/api' }]) {
      const refusals = [{ ...refusal, ...other }];
      expect(await stampRefusedCheck(reader(refusals)).run(NOW)).toMatchObject([{ ok: true }]);
      const [account] = await attributionCheck(reader(refusals)).run(NOW);
      expect(account).toMatchObject({ ok: false, facts: { dismissLabel: 'This was me' } });
    }
  });

  it('matches no refusal made after the post, and none with no body', async () => {
    expect(refusalFor(unsigned, [{ ...refusal, at: '2026-10-28T11:00:06.000Z' }])).toBeNull();
    expect(refusalFor({ ...unsigned, bodySha256: null }, [refusal])).toBeNull();
    expect(refusalFor(unsigned, [{ ...refusal, bodySha256: null }])).toBeNull();
    // A refusal that named no number matches the post wherever it was.
    expect(refusalFor(unsigned, [{ ...refusal, number: null }])).toMatchObject({ taskId: 'task-revert' });
  });

  it('reads refusals from their events, each cleared by the first signing of its kind after it', () => {
    const refused = [
      { at: '2026-10-28T11:00:00.000Z', payload: { taskId: 'task-revert', taskKind: 'deploy', subjectType: 'merge', seat: 'ship', login: 'openadlc-ship', repo: '620legal/www', number: 12, kind: 'comment', status: 403, reason: REASON, bodySha256: BODY } },
    ];
    expect(refusalsFromEvents(refused, [])).toEqual([{ ...refusal, login: 'openadlc-ship', repo: '620legal/www' }]);
    const signed = [
      // Before the refusal, and of another subject type: neither clears it.
      { at: '2026-10-28T10:00:00.000Z', payload: { taskId: 'task-a', taskKind: 'deploy', subjectType: 'merge' } },
      { at: '2026-10-28T11:10:00.000Z', payload: { taskId: 'task-b', taskKind: 'deploy', subjectType: 'issue' } },
      { at: '2026-10-28T11:40:00.000Z', payload: { taskId: 'task-d', taskKind: 'deploy', subjectType: 'merge' } },
      { at: '2026-10-28T11:20:00.000Z', payload: { taskId: 'task-c', taskKind: 'deploy', subjectType: 'merge' } },
    ];
    expect(refusalsFromEvents(refused, signed)[0]?.clearedAt).toBe('2026-10-28T11:20:00.000Z');
  });
});
