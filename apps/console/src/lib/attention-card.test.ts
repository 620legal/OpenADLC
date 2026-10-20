import { describe, expect, it } from 'vitest';
import type { AttentionItem } from './api';
import { faceActions, groupOf, hasMore, plainDetail } from './attention-card';

const ITEM: AttentionItem = {
  id: 'task:t-1',
  kind: 'task_failed',
  headline: 'The builder (janedoe-builds) could not finish the change',
  subject: { repo: 'api', number: 16, title: 'Let the board filter by label', ref: 'api#16', url: null },
  bot: null,
  since: '2026-09-29T10:00:00.000Z',
  detail: 'Engine claude is not available on this host.',
  actions: [{ kind: 'retry_task', label: 'Try again', taskId: 't-1' }],
};

describe('a Needs-you card’s face', () => {
  it('says the detail without its markdown, so two lines cut a sentence', () => {
    expect(plainDetail('**Fix it.**\n\n1. Open [the page](https://example.com).\n2. Run `make ci`.')).toBe(
      'Fix it. Open the page. Run make ci.',
    );
  });

  it('offers the first action, and none for a question answered by its choices', () => {
    expect(faceActions(ITEM)[0]).toEqual({ kind: 'retry_task', label: 'Try again', taskId: 't-1' });
    expect(
      faceActions({ ...ITEM, kind: 'question', question: { gateId: 'g', options: ['yes', 'no'] }, actions: [{ kind: 'answer', label: 'Something else…', bot: 'b' }] }),
    ).toEqual([]);
  });

  it('has nothing more when its face is all of it', () => {
    expect(hasMore(ITEM)).toBe(false);
  });

  it('has more for a long detail, the raw reason, members, other buttons, or choices past three', () => {
    expect(hasMore({ ...ITEM, detail: 'x '.repeat(100) })).toBe(true);
    expect(hasMore({ ...ITEM, raw: 'hostd refused: 500' })).toBe(true);
    expect(hasMore({ ...ITEM, members: [{ ...ITEM, id: 'a' } as never, { ...ITEM, id: 'b' } as never] })).toBe(true);
    expect(hasMore({ ...ITEM, actions: [...ITEM.actions, { kind: 'stop_task', label: 'Stop', taskId: 't-1' }] })).toBe(true);
    const question = { ...ITEM, kind: 'question' as const, actions: [{ kind: 'answer' as const, label: 'Something else…', bot: 'b' }] };
    expect(hasMore({ ...question, question: { gateId: 'g', options: ['a', 'b', 'c'] } })).toBe(false);
    expect(hasMore({ ...question, question: { gateId: 'g', options: ['a', 'b', 'c', 'd'] } })).toBe(true);
  });
});

describe('a promote held for a person', () => {
  it('has both its choices on the card', () => {
    const held = {
      id: 'promote:app@abc1234',
      kind: 'promote_held' as const,
      headline: 'app@abc1234 waits for you to release it to production',
      subject: { repo: 'app', number: null, title: null, ref: null, url: null },
      bot: null,
      since: '2026-09-24T11:59:00.000Z',
      detail: 'Held.',
      actions: [
        { kind: 'promote_release' as const, label: 'Release to production', repo: 'app', sha: 'abc1234' },
        { kind: 'promote_automatic' as const, label: 'Switch to automatic delivery', repo: 'app', sha: 'abc1234' },
      ],
    };
    expect(faceActions(held).map((action) => action.label)).toEqual(['Release to production', 'Switch to automatic delivery']);
    expect(groupOf(held)).toBe('work');
  });
});

describe('a signing key OpenADLC did not register', () => {
  const card = {
    ...ITEM,
    id: 'check:signing-key:account:abner620legal',
    kind: 'check_failed' as const,
    actions: [
      { kind: 'signing_key_revoke' as const, label: 'Revoke key 6', login: 'abner620legal', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_dismiss' as const, label: 'Key 6 is used elsewhere', login: 'abner620legal', keyId: 6, title: 'laptop' },
      { kind: 'signing_key_revoke' as const, label: 'Revoke key 8', login: 'abner620legal', keyId: 8, title: null },
      { kind: 'signing_key_dismiss' as const, label: 'Key 8 is used elsewhere', login: 'abner620legal', keyId: 8, title: null },
      { kind: 'signing_key_undo' as const, label: 'Count key 4 again', login: 'abner620legal', keyId: 4, title: null },
      { kind: 'open_url' as const, label: 'Open the account’s keys', url: 'https://github.com/settings/keys' },
      { kind: 'recheck' as const, label: 'Check again', checkId: 'signing-key' },
    ],
  };

  it('has the first key’s Revoke and Dismiss on the card, and the rest behind Show more', () => {
    expect(faceActions(card).map((action) => action.label)).toEqual(['Revoke key 6', 'Key 6 is used elsewhere']);
    expect(hasMore(card)).toBe(true);
  });

  it('leads with Dismiss where the check offered no Revoke', () => {
    const blocked = { ...card, actions: card.actions.filter((action) => action.kind !== 'signing_key_revoke') };
    expect(faceActions(blocked).map((action) => action.label)).toEqual(['Key 6 is used elsewhere']);
  });
});

describe('an unsigned post’s card', () => {
  const unsigned: AttentionItem = {
    ...ITEM,
    kind: 'check_failed',
    actions: [
      { kind: 'open_url', label: 'Open the post', url: 'https://github.com/exampleco/api/pull/31#pullrequestreview-77' },
      { kind: 'acknowledge', label: 'This was me', checkId: 'unattributed-post', occurrence: 'post:77' },
      { kind: 'incident', label: 'What to do' },
    ],
    incident: {
      repo: 'exampleco/api',
      login: 'janedoe-reviews',
      seat: null,
      did: 'review',
      postUrl: null,
      target: null,
      counted: true,
      mode: 'audit',
    },
  };

  it('offers This was me, the post and What to do, in that order', () => {
    expect(faceActions(unsigned).map((action) => action.label)).toEqual(['This was me', 'Open the post', 'What to do']);
  });

  it('always has more: its steps', () => {
    expect(hasMore({ ...unsigned, detail: 'Short.' })).toBe(true);
  });
});

describe('a detail built to be slow', () => {
  it('reads eighty thousand characters of brackets and line breaks at once', () => {
    const started = performance.now();
    plainDetail('[\n'.repeat(40_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});
