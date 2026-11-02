import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryNotifyStore, Notifier } from '../../notify.js';
import { notificationsCheck } from './notifications.js';

/**
 * The check reads the last send and never sends: a check that sent its own
 * test every five minutes would buzz a phone all day.
 */
const SET_AT = '2026-11-02T00:00:00.000Z';

function notifier(options: { stored?: boolean; env?: string } = {}) {
  const store = memoryNotifyStore(
    options.stored
      ? { settings: { notifyTransport: JSON.stringify({ kind: 'slack', setAt: SET_AT, setBy: 'janedoe' }) }, target: 'https://hooks.slack.com/services/T/B/secret' }
      : {},
  );
  const built = new Notifier({ notifyWebhook: options.env ?? '', consoleUrl: 'http://127.0.0.1:47300' } as never, store);
  return { store, check: notificationsCheck(built) };
}

const delivery = (fields: Record<string, unknown>) => ({ event: 'test', transport: 'slack', source: 'settings', setAt: SET_AT, ok: true, status: 200, error: null, ...fields });

const fetchSpy = vi.spyOn(globalThis, 'fetch');
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('whether notifications reach a person', () => {
  it('passes with nothing set up: notifications are optional', async () => {
    const [result] = await notifier().check.run(new Date());
    expect(result?.ok).toBe(true);
  });

  it('fails as a warning while nothing has been sent since it was set', async () => {
    const [result] = await notifier({ stored: true }).check.run(new Date());
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'Notifications are set up but have not been proved',
      action: { href: '/settings/notifications' },
    });
  });

  it('fails while the newest send did not get through, saying what it answered', async () => {
    const { store, check } = notifier({ stored: true });
    await store.record('notify.delivery', delivery({}));
    await store.record('notify.delivery', delivery({ event: 'gate_opened', ok: false, status: 404, error: 'Not Found' }));
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({ ok: false, severity: 'warning', title: 'The last notification did not reach Slack' });
    expect(result && 'detail' in result ? result.detail : '').toContain('It answered 404: Not Found');
  });

  it('passes once the newest send got through, and says so', async () => {
    const { store, check } = notifier({ stored: true });
    await store.record('notify.delivery', delivery({ ok: false, status: 500 }));
    await store.record('notify.delivery', delivery({ event: 'gate_opened' }));
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({ ok: true, fixed: 'Notifications are reaching you again' });
  });

  it('ignores a send from before the transport was changed', async () => {
    const { store, check } = notifier({ stored: true });
    await store.record('notify.delivery', delivery({ setAt: '2026-11-01T00:00:00.000Z' }));
    const [result] = await check.run(new Date());
    expect(result?.ok).toBe(false);
  });

  it('has no answer for the environment’s webhook before anything is sent', async () => {
    const [result] = await notifier({ env: 'https://hooks.example.com/x' }).check.run(new Date());
    expect(result?.ok).toBeNull();
  });

  it('judges the environment’s webhook by its newest send', async () => {
    const { store, check } = notifier({ env: 'https://hooks.example.com/x' });
    await store.record('notify.delivery', delivery({ source: 'env', setAt: null, transport: 'webhook', ok: false, status: null, error: 'ECONNREFUSED' }));
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({ ok: false, title: 'The last notification did not reach your webhook' });
  });
});
