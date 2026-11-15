import { describe, expect, it, vi } from 'vitest';
import type { ReleaseAccountProbe } from '../../hostd-client.js';
import { RELEASE_ACCOUNT_CHECK, releaseAccountCheck } from './release-account.js';

const ACCOUNT = 'openadlc-release';
const HOME = '/Users/openadlc-release';

function check(probe: ReleaseAccountProbe | null | Error, wanted?: string | null | Error) {
  const reader = {
    probe: vi.fn(async () => {
      if (probe instanceof Error) throw probe;
      return probe;
    }),
    ...(wanted === undefined
      ? {}
      : {
          wanted: vi.fn(async () => {
            if (wanted instanceof Error) throw wanted;
            return wanted;
          }),
        }),
  };
  return releaseAccountCheck(reader).run(new Date('2026-11-15T10:00:00Z'));
}

describe('the account releases are built in (#341)', () => {
  it('is its own check, which no walkthrough step waits on', () => {
    const made = releaseAccountCheck({ probe: async () => null });
    expect(made).toMatchObject({ id: RELEASE_ACCOUNT_CHECK, steps: [], everyMinutes: 10 });
  });

  it('is quiet where hostd names no release account, as on an install that never releases', async () => {
    await expect(check(null)).resolves.toEqual([]);
  });

  it('warns, naming it, when a repository is set to release and hostd names no account (#343)', async () => {
    const [result] = await check(null, 'acme/app');
    expect(result).toMatchObject({
      ok: false,
      severity: 'warning',
      detail:
        'acme/app is set to release, but hostd names no release account. Set OPENADLC_RELEASE_ACCOUNT to the account you made for releases (docs/self-hosting.md#the-release-account)',
      action: { label: 'Open the steps' },
    });
  });

  it('stays quiet with no account named while nothing releases, or that cannot be read', async () => {
    await expect(check(null, null)).resolves.toEqual([]);
    await expect(check(null, new Error('database down'))).resolves.toEqual([]);
  });

  it('is quiet where hostd cannot be asked, which the host check already says', async () => {
    await expect(check(new Error('hostd is not answering'))).resolves.toEqual([]);
    await expect(check(Object.assign(new Error('Not Found'), { status: 404 }))).resolves.toEqual([]);
  });

  it('passes when the account is fit, and says where it builds', async () => {
    await expect(check({ ok: true, account: ACCOUNT, uid: 503, home: HOME })).resolves.toEqual([
      { ok: true, says: `${ACCOUNT} (uid 503) builds releases in ${HOME}`, fixed: 'The release account is fit to build releases again' },
    ]);
  });

  const failing = (problem: Exclude<ReleaseAccountProbe, { ok: true }>['problem'], path?: string): ReleaseAccountProbe => ({
    ok: false,
    account: ACCOUNT,
    problem,
    detail: `${ACCOUNT} is ${problem}`,
    ...(path ? { path } : {}),
  });

  it.each([
    ['no_account', undefined, 'OPENADLC_RELEASE_ACCOUNT to the one you made'],
    ['not_dedicated', undefined, 'OPENADLC_RELEASE_ACCOUNT to the one you made'],
    ['no_sudo', undefined, 'sudo rule'],
    ['docker', '/var/run/docker.sock', 'group that owns /var/run/docker.sock'],
    ['docker', undefined, `sudo gpasswd -d ${ACCOUNT} docker`],
    ['can_sudo', undefined, 'NOPASSWD rule'],
    ['host_check_account', undefined, 'an account made only for releases, never the host check'],
  ] as const)('raises one card for %s, with the fix and the steps', async (problem, path, fix) => {
    const results = await check(failing(problem, path));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: false,
      severity: 'warning',
      detail: expect.stringContaining(fix),
      action: { label: 'Open the steps', url: expect.stringContaining('docs/self-hosting.md#the-release-account') },
    });
    expect(results[0]).toMatchObject({ detail: expect.stringContaining('Until then no release can be cut. See docs/self-hosting.md#the-release-account.') });
  });

  it.each([
    ['can_read', '/Users/jane/.openadlc', 'chmod 700 /Users/jane/.openadlc', 'The release account can read /Users/jane/.openadlc'],
    ['can_enter', '/Users/jane', 'chmod 700 /Users/jane', 'The release account can enter /Users/jane'],
    ['host_check_reaches', HOME, `sudo chmod 700 ${HOME}`, 'The host check account can reach the release account’s home'],
  ] as const)('raises one card for %s, with the command that stops it', async (problem, path, command, title) => {
    const results = await check(failing(problem, path));
    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        severity: 'warning',
        title,
        detail: expect.stringContaining(`Run: ${command}`),
        action: { label: 'Run in a terminal', command },
      }),
    ]);
    expect(results[0]).toMatchObject({ detail: expect.stringContaining('docs/self-hosting.md#the-release-account') });
  });
});
