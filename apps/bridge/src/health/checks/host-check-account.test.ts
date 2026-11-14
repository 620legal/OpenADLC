import { describe, expect, it, vi } from 'vitest';
import type { HostCheckAccountProbe } from '../../hostd-client.js';
import { hostCheckAccountCheck } from './host-check-account.js';

const ACCOUNT = 'openadlc-hostcheck';

function check(probe: HostCheckAccountProbe | Error, wanted = true) {
  const reader = {
    wanted: vi.fn(async () => wanted),
    probe: vi.fn(async () => {
      if (probe instanceof Error) throw probe;
      return probe;
    }),
  };
  return { run: () => hostCheckAccountCheck(reader).run(new Date('2026-11-14T10:00:00Z')), reader };
}

describe('the account host checks run as (#327)', () => {
  it('asks nothing of the machine while no repository has a host check', async () => {
    const { run, reader } = check({ ok: true, account: ACCOUNT, uid: 502, home: '/Users/openadlc-hostcheck' }, false);
    await expect(run()).resolves.toEqual([]);
    expect(reader.probe).not.toHaveBeenCalled();
  });

  it('passes when the account exists, hostd can run as it, and it reads none of the install', async () => {
    const { run } = check({ ok: true, account: ACCOUNT, uid: 502, home: '/Users/openadlc-hostcheck' });
    await expect(run()).resolves.toEqual([expect.objectContaining({ ok: true })]);
  });

  it('fails while the account is missing, with the steps', async () => {
    const { run } = check({ ok: false, account: ACCOUNT, problem: 'no_account', detail: `there is no account named ${ACCOUNT} on this machine` });
    const [result] = await run();
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('docs/self-hosting.md#host-checks'), action: { url: expect.stringContaining('#host-checks') } });
  });

  it('fails while hostd has no sudo rule to run as it', async () => {
    const { run } = check({ ok: false, account: ACCOUNT, problem: 'no_sudo', detail: `hostd cannot run a command as ${ACCOUNT} without a password` });
    const [result] = await run();
    expect(result).toMatchObject({ ok: false, title: 'hostd cannot run a command as the host check account', detail: expect.stringContaining('sudo rule') });
  });

  it('fails while it can read OPENADLC_HOME, with the command that stops it', async () => {
    const { run } = check({ ok: false, account: ACCOUNT, problem: 'can_read', path: '/Users/jane/.openadlc', detail: `${ACCOUNT} can read /Users/jane/.openadlc` });
    const [result] = await run();
    expect(result).toMatchObject({ ok: false, title: 'The host check account can read /Users/jane/.openadlc', action: { command: 'chmod 700 /Users/jane/.openadlc' } });
  });

  it('fails for root, or hostd’s own user, which are no account of its own', async () => {
    const { run } = check({ ok: false, account: 'root', problem: 'not_dedicated', detail: 'root is root, which can read everything; make an account of its own' });
    const [result] = await run();
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('OPENADLC_HOST_CHECK_ACCOUNT') });
  });

  it('gives no answer when hostd cannot be asked, rather than a card for something it does not know', async () => {
    const { run } = check(new Error('hostd is not answering'));
    await expect(run()).resolves.toEqual([{ ok: null, reason: expect.stringContaining('hostd is not answering') }]);
  });
});
