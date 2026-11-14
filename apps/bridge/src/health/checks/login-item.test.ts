import { describe, expect, it, vi } from 'vitest';
import type { LoginItemState } from '@openadlc/shared';
import { defaultLoginItemReader, loginItemCheck } from './login-item.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const PLIST = '/Users/me/Library/LaunchAgents/dev.openadlc.up.default.plist';

function check(state: LoginItemState, wanted = true) {
  const inspect = vi.fn(async () => state);
  return {
    inspect,
    check: loginItemCheck({ wanted: () => wanted, inspect, command: () => 'openadlc up --login-item', user: () => 'me' }),
  };
}

describe('the login-item health check', () => {
  it('passes when the item is registered, naming where it is', async () => {
    const [result] = await check({ state: 'registered', path: PLIST }).check.run(NOW);
    expect(result).toMatchObject({ ok: true, says: PLIST });
  });

  it('notes a Linux unit without linger, which starts at the next login rather than at boot', async () => {
    const [result] = await check({ state: 'registered', path: '/u/openadlc-up-default.service', linger: false }).check.run(NOW);
    expect(result).toMatchObject({ ok: true, says: expect.stringContaining('loginctl enable-linger me') });
  });

  it('warns when it is missing, with the command to run', async () => {
    const [result] = await check({ state: 'missing', path: PLIST }).check.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      title: 'Nothing starts OpenADLC again after this computer restarts',
      action: { label: 'Run in a terminal', command: 'openadlc up --login-item' },
    });
  });

  it('warns when it is there but not loaded, with the command to run', async () => {
    const [result] = await check({ state: 'not-loaded', path: PLIST }).check.run(NOW);
    expect(result).toMatchObject({ ok: false, severity: 'warning', action: { command: 'openadlc up --login-item' } });
  });

  it('sends a login item turned off in macOS to the Login Items setting', async () => {
    const [result] = await check({ state: 'disabled', path: PLIST }).check.run(NOW);
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      action: { label: 'Open Login Items', url: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension' },
    });
    expect(result?.ok === false && result.detail).toContain('System Settings > General > Login Items');
  });

  it('warns when the item there starts another install, naming its home', async () => {
    const [result] = await check({ state: 'other-install', path: PLIST, home: '/Users/me/.openadlc-other' }).check.run(NOW);
    expect(result).toMatchObject({ ok: false, severity: 'warning' });
    expect(result?.ok === false && result.detail).toContain('/Users/me/.openadlc-other');
    expect(result?.ok === false && result.detail).toContain('OPENADLC_INSTALL_ID');
  });

  it('has no answer where nothing can hold one', async () => {
    expect(await check({ state: 'unsupported', reason: 'not here' }).check.run(NOW)).toEqual([{ ok: null, reason: 'not here' }]);
  });

  it('says nothing, and looks at nothing, for an install that opted out, so a card from before clears', async () => {
    const { check: off, inspect } = check({ state: 'missing', path: PLIST }, false);
    expect(await off.run(NOW)).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('is wanted only when up started the bridge with OPENADLC_LOGIN_ITEM=on', () => {
    expect(defaultLoginItemReader({ OPENADLC_LOGIN_ITEM: 'on' }).wanted()).toBe(true);
    expect(defaultLoginItemReader({ OPENADLC_LOGIN_ITEM: 'off' }).wanted()).toBe(false);
    // The compose stack and the cloud host never run up.
    expect(defaultLoginItemReader({}).wanted()).toBe(false);
  });
});
