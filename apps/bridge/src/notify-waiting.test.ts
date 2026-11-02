import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from './attention.js';
import { memoryNotifyStore, Notifier } from './notify.js';
import { WaitingNotices } from './notify-waiting.js';

/**
 * A pull request waiting on a person and a review that stopped are read from
 * Needs you and sent once per occurrence: one id at one `since`.
 */
const CONSOLE = 'http://127.0.0.1:47300';

function item(fields: Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'kind'>): AttentionItem {
  return {
    headline: 'Pull request #12 waits for you to merge it',
    subject: { repo: 'openadlc', number: 12, title: null, ref: 'openadlc#12', url: null, item: 'openadlc#9' },
    bot: null,
    since: '2026-11-02T10:00:00.000Z',
    detail: '',
    actions: [{ kind: 'open_url', label: 'Merge it on GitHub', url: 'https://github.com/x/openadlc/pull/12' }] as never,
    ...fields,
  };
}

const MERGE = item({ id: 'merge:openadlc#12', kind: 'merge_waiting' });
const STALL = item({
  id: 'stall:openadlc#14',
  kind: 'review_stalled',
  headline: 'The review of pull request #14 stopped',
  actions: [{ kind: 'open_thread', label: 'Open the review', bot: 'lead' }] as never,
  subject: { repo: 'openadlc', number: 14, title: null, ref: 'openadlc#14', url: null, item: 'openadlc#13' },
});

function setUp(initial: AttentionItem[], options: { seen?: boolean } = {}) {
  const store = memoryNotifyStore();
  const notifier = new Notifier({ notifyWebhook: '', consoleUrl: CONSOLE } as never, store);
  const send = vi.spyOn(notifier, 'send');
  let items = initial;
  const notices = new WaitingNotices({ notifier, items: async () => items, consoleUrl: CONSOLE, say: () => undefined });
  const ready = options.seen === false ? Promise.resolve() : notices.pass().then(() => send.mockClear());
  return { store, send, notices, ready, set: (next: AttentionItem[]) => (items = next) };
}

describe('the merge-waiting and review-stopped notifications', () => {
  it('sends nothing on an install’s first look, and records what already waits', async () => {
    const { store, send, notices } = setUp([MERGE, STALL], { seen: false });
    await notices.pass();
    expect(send).not.toHaveBeenCalled();
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'notify.merge_waiting', payload: { item: `${MERGE.id}@${MERGE.since}`, baseline: true } }),
        expect.objectContaining({ type: 'notify.review_stalled', payload: { item: `${STALL.id}@${STALL.since}`, baseline: true } }),
      ]),
    );
    // And the next look does not send them either.
    await notices.pass();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a new waiting merge once, however many looks see it', async () => {
    const { send, notices, ready, set } = setUp([]);
    await ready;
    set([MERGE]);
    await notices.pass();
    await notices.pass();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      event: 'merge_waiting',
      to: null,
      item: `${MERGE.id}@${MERGE.since}`,
      text: 'Pull request #12 waits for you to merge it. Merge it on GitHub.',
      link: `${CONSOLE}/?item=openadlc%239`,
    });
  });

  it('sends it again when the same pull request waits again', async () => {
    const { send, notices, ready, set } = setUp([MERGE]);
    await ready;
    set([{ ...MERGE, since: '2026-11-02T12:00:00.000Z' }]);
    await notices.pass();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says what to do about a stopped review and links to its work item', async () => {
    const { send, notices, ready, set } = setUp([]);
    await ready;
    set([STALL]);
    await notices.pass();
    const sent = send.mock.calls[0]![0];
    expect(sent.event).toBe('review_stalled');
    expect(sent.text).toBe('The review of pull request #14 stopped. Open the review.');
    expect(sent.link).toBe(`${CONSOLE}/?item=openadlc%2313`);
  });

  it('ignores every other kind on the board', async () => {
    const { send, notices, ready, set } = setUp([]);
    await ready;
    set([item({ id: 'gate:1', kind: 'question' }), item({ id: 'check:host', kind: 'check_failed' })]);
    await notices.pass();
    expect(send).not.toHaveBeenCalled();
  });

  it('records each, so a restart sends nothing twice', async () => {
    const { store, ready, set, notices } = setUp([]);
    await ready;
    set([MERGE]);
    await notices.pass();

    const again = new Notifier({ notifyWebhook: '', consoleUrl: CONSOLE } as never, store);
    const send = vi.spyOn(again, 'send');
    await new WaitingNotices({ notifier: again, items: async () => [MERGE], consoleUrl: CONSOLE }).pass();
    expect(send).not.toHaveBeenCalled();
  });

  it('carries on after a look that failed', async () => {
    const say = vi.fn();
    const notices = new WaitingNotices({
      notifier: new Notifier({ notifyWebhook: '', consoleUrl: CONSOLE } as never, memoryNotifyStore()),
      items: async () => {
        throw new Error('the database blinked');
      },
      consoleUrl: CONSOLE,
      say,
    });
    await expect(notices.pass()).resolves.toBe(0);
    expect(say).toHaveBeenCalledWith(expect.stringContaining('the database blinked'));
  });
});
