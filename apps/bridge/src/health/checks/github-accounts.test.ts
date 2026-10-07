import { describe, expect, it } from 'vitest';
import { githubAccountsCheck, githubAccountsReady, type HeldGitHubAccount } from './github-accounts.js';

function account(login: string, signIn: HeldGitHubAccount['signIn']): HeldGitHubAccount {
  return { login, signIn };
}

describe('two GitHub accounts', () => {
  it('is done once two of them can still sign in', () => {
    expect(githubAccountsReady([account('fleetadlc-crew', 'signed-in')])).toBe(false);
    expect(
      githubAccountsReady([account('fleetadlc-crew', 'signed-in'), account('fleetadlc-review', 'needs-reconnecting')]),
    ).toBe(false);
    expect(githubAccountsReady([account('fleetadlc-crew', 'signed-in'), account('fleetadlc-review', 'signed-in')])).toBe(true);
  });

  it('asks for the second account, and says nothing about a seat', async () => {
    const check = githubAccountsCheck({
      accounts: async () => [account('fleetadlc-crew', 'signed-in')],
    });
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({
      ok: false,
      title: 'Only one GitHub account is connected',
      action: { href: '/onboarding?step=github-accounts' },
    });
    expect(check.steps).toEqual(['github-accounts']);
    expect(JSON.stringify(result)).not.toMatch(/seat|signing key/i);
  });

  it('says a stored sign-in stopped working, and that none is connected when OpenADLC holds no account', async () => {
    const stopped = githubAccountsCheck({
      accounts: async () => [account('fleetadlc-crew', 'needs-reconnecting'), account('fleetadlc-review', 'needs-reconnecting')],
    });
    const [stoppedResult] = await stopped.run(new Date());
    // One card, naming each account, so a person holding several knows which.
    expect(stoppedResult).toMatchObject({
      ok: false,
      title: 'GitHub sign-ins stopped working: fleetadlc-crew, fleetadlc-review',
      detail: expect.stringMatching(/^Reconnect fleetadlc-crew and fleetadlc-review\./),
    });

    const none = githubAccountsCheck({ accounts: async () => [] });
    const [noneResult] = await none.run(new Date());
    expect(noneResult).toMatchObject({ ok: false, title: 'No GitHub account is connected' });
  });

  it('says reconnect when one sign-in still works and another does not', async () => {
    const check = githubAccountsCheck({
      accounts: async () => [account('fleetadlc-crew', 'signed-in'), account('fleetadlc-review', 'needs-reconnecting')],
    });
    const [result] = await check.run(new Date());
    expect(result).toMatchObject({
      ok: false,
      title: 'The GitHub sign-in for fleetadlc-review stopped working',
      detail: expect.stringMatching(/^Reconnect fleetadlc-review\./),
    });
  });

  it('passes once both sign-ins work', async () => {
    const check = githubAccountsCheck({
      accounts: async () => [account('fleetadlc-crew', 'signed-in'), account('fleetadlc-review', 'signed-in')],
    });
    await expect(check.run(new Date())).resolves.toEqual([{ ok: true, fixed: 'Two GitHub accounts are connected' }]);
  });
});

describe('an account GitHub could not be asked about', () => {
  it('gives no answer when the two depend on it, and is no reconnect card', async () => {
    const [result] = await githubAccountsCheck({
      accounts: async () => [account('fleetadlc-crew', 'signed-in'), account('fleetadlc-review', 'unknown')],
    }).run(new Date());
    expect(result).toEqual({ ok: null, reason: 'GitHub could not be asked whether fleetadlc-review can still sign in' });
  });

  it('does not stand in for an account that is not there', async () => {
    const [result] = await githubAccountsCheck({ accounts: async () => [account('fleetadlc-crew', 'unknown')] }).run(new Date());
    expect(result).toMatchObject({ ok: false, title: 'Only one GitHub account is connected' });
  });
});
