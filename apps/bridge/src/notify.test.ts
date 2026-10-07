import { describe, expect, it, vi } from 'vitest';
import { isNotifiable, itemLink, NOTIFIABLE, Notifier } from './notify.js';

/**
 * Three things are worth interrupting someone for and, just as deliberately,
 * nothing else. That second half is the part worth pinning: a
 * platform that notifies on everything is one whose notifications are ignored,
 * including the ones that mattered. The one addition since is a thing only a
 * person can do that has gone undone and stops work — a failing health check,
 * sent once and again a day later, and its all-clear to whoever was told.
 */
const configWith = (notifyWebhook: string) =>
  ({ notifyWebhook, consoleUrl: 'http://127.0.0.1:47300' }) as never;

describe('only a few things are worth a notification', () => {
  it('is a gate, the spending warning and a waiting promote, and a check a person has to act on', () => {
    expect([...NOTIFIABLE].sort()).toEqual([
      'cap_warning',
      'check_failing',
      'check_fixed',
      'gate_opened',
      'promote_waiting',
    ]);
  });

  it('refuses anything else, rather than quietly sending it', () => {
    expect(isNotifiable('task_started')).toBe(false);
    expect(isNotifiable('pr_opened')).toBe(false);
    expect(isNotifiable('gate_answered')).toBe(false);
  });

  it('will not send an event it does not recognise even when asked directly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const notifier = new Notifier(configWith('https://hooks.example.invalid/x'));

    const outcome = await notifier.send({
      event: 'gate_answered' as never,
      to: 'janedoe',
      text: 'answered',
      link: 'http://127.0.0.1:47300/',
    });

    expect(outcome).toBe('refused');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('an install with no transport carries on', () => {
  it('logs the intent rather than failing', async () => {
    const notifier = new Notifier(configWith(''));
    const outcome = await notifier.send({
      event: 'gate_opened',
      to: 'janedoe',
      text: 'waiting on an answer',
      link: 'http://127.0.0.1:47300/?bot=mira',
    });

    // Logged, not sent and not refused: the path stays exercised in development
    // rather than lying dormant until the day somebody configures it.
    expect(outcome).toBe('logged');
  });

  it('does not fail the caller when the transport is down', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const notifier = new Notifier(configWith('https://hooks.example.invalid/x'));

    // The gate is already on GitHub and on the board. A transport that is down
    // must not take the platform with it.
    await expect(
      notifier.send({ event: 'gate_opened', to: null, text: 'x', link: 'y' }),
    ).resolves.toBe('logged');
    fetchSpy.mockRestore();
  });
});

describe('a link about a piece of work opens its item', () => {
  it('names the subject, which any member of the item resolves from', () => {
    // A question about a request opened the intake bot's panel, with every
    // other request intake had worked on in it. Each request is its own conversation.
    expect(itemLink('http://127.0.0.1:47300/', 'fleetadlc#12')).toBe('http://127.0.0.1:47300/?item=fleetadlc%2312');
    expect(itemLink('http://127.0.0.1:47300', 'request:a4b02784')).toBe('http://127.0.0.1:47300/?item=request%3Aa4b02784');
  });
});
