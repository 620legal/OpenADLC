import { afterEach, describe, expect, it } from 'vitest';
import { githubClientId } from './client-id.js';

const before = process.env.FLEETADLC_GITHUB_CLIENT_ID;

afterEach(() => {
  if (before === undefined) delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
  else process.env.FLEETADLC_GITHUB_CLIENT_ID = before;
});

describe('the GitHub App client id the CLI uses', () => {
  it('is the one the console stored, over install.json, because the bridge prefers it', async () => {
    // install.json named the old app; auth login signed bots in through it and
    // the bridge, refreshing with the new one, had their seats revoked.
    delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
    expect(await githubClientId({ githubClientId: 'Iv23liOld' }, async () => 'Iv23liNew')).toBe('Iv23liNew');
    expect(await githubClientId({ githubClientId: '' }, async () => 'Iv23liStored', 'Iv23liEnv')).toBe('Iv23liStored');
  });

  it('is the environment’s when nothing is stored', async () => {
    process.env.FLEETADLC_GITHUB_CLIENT_ID = 'Iv23liEnv';
    expect(await githubClientId({ githubClientId: '' }, async () => null)).toBe('Iv23liEnv');
    expect(await githubClientId({ githubClientId: 'Iv23liFile' }, async () => null)).toBe('Iv23liEnv');
  });

  it('is install.json’s when neither the settings nor the environment has one', async () => {
    delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
    expect(await githubClientId({ githubClientId: 'Iv23liFile' }, async () => null)).toBe('Iv23liFile');
    expect(await githubClientId({ githubClientId: 'Iv23liFile' }, async () => '  ', ' ')).toBe('Iv23liFile');
  });

  it('falls back past settings that cannot be read, and is nothing when none of the three has one', async () => {
    delete process.env.FLEETADLC_GITHUB_CLIENT_ID;
    const unreadable = async () => Promise.reject(new Error('no database'));
    expect(await githubClientId({ githubClientId: 'Iv23liFile' }, unreadable, 'Iv23liEnv')).toBe('Iv23liEnv');
    expect(await githubClientId({ githubClientId: 'Iv23liFile' }, unreadable, undefined)).toBe('Iv23liFile');
    expect(await githubClientId({ githubClientId: '' }, unreadable, undefined)).toBeNull();
    expect(await githubClientId({ githubClientId: '' }, async () => null, undefined)).toBeNull();
  });
});
