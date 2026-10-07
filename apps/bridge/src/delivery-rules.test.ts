import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a repository's delivery rules come from: its `.github/fleetadlc.yml`,
 * else its row, else Settings' testing-deploy choice; and where its testing is
 * served, with the install's FLEETADLC_TESTING_URL only as the last word.
 */

const world = {
  stored: { deliveryRules: null as unknown, testingUrl: null as string | null },
  setting: null as string | null,
  choice: { approval: null as 'reviewers' | 'auto' | null, soakMinutes: null as number | null, reviewers: [] as string[] },
};

vi.mock('@fleetadlc/db', () => ({
  repos: { getDelivery: vi.fn(async () => world.stored), getProductionChoice: vi.fn(async () => world.choice) },
  settings: { getSetting: vi.fn(async () => world.setting) },
}));

import { DeliveryKnowledge, effectiveDelivery } from './delivery-rules.js';

const REPO = { id: 'repo-1', name: 'app', fullName: 'exampleco/app', defaultBranch: 'main' };

function client(file: string | null, workflows: string[] = []) {
  return {
    readFileIfPresent: vi.fn(async () => file),
    request: vi.fn(async () => ({ workflows: workflows.map((path) => ({ path })) }) as never),
  };
}

beforeEach(() => {
  world.stored = { deliveryRules: null, testingUrl: null };
  world.setting = null;
  world.choice = { approval: null, soakMinutes: null, reviewers: [] };
});

describe('the rules a repository ships by', () => {
  it('are its .github/fleetadlc.yml when it has one', async () => {
    const file = 'version: 1\nproduction:\n  approval: auto\n  soakMinutes: 15\n';
    const found = await effectiveDelivery({ repo: REPO, client: client(file) });
    expect(found.source).toBe('file');
    expect(found.rules.production).toMatchObject({ approval: 'auto', soakMinutes: 15 });
  });

  it('say why a file that does not parse was not used, and fall back rather than guess', async () => {
    world.stored.deliveryRules = { version: 1, testing: { on: 'none' }, production: { on: 'none' } };
    const found = await effectiveDelivery({ repo: REPO, client: client('version: 1\nproduction:\n  approval: maybe\n') });
    expect(found.source).toBe('repository');
    expect(found.rules.testing.on).toBe('none');
    expect(found.fileError).toContain('production.approval');
  });

  it('are the testing-deploy choice where there is neither', async () => {
    world.setting = JSON.stringify({ app: 'none' });
    expect((await effectiveDelivery({ repo: REPO, client: client(null) })).rules.testing.on).toBe('none');

    world.setting = null;
    const automatic = await effectiveDelivery({ repo: REPO, client: client(null, ['.github/workflows/deploy-testing.yml']) });
    expect(automatic.source).toBe('setting');
    expect(automatic.rules.testing.on).toBe('merge');
    // Nobody asked: production ships automatically, after the default soak.
    expect(automatic.rules.production).toMatchObject({ approval: 'auto', soakMinutes: 30 });
  });

  it('keep an existing repository on reviewers, as the migration recorded it, though its file says only `version: 1`', async () => {
    world.choice = { approval: 'reviewers', soakMinutes: 0, reviewers: [] };
    const fromFile = await effectiveDelivery({ repo: REPO, client: client('version: 1\n') });
    expect(fromFile.source).toBe('file');
    expect(fromFile.rules.production).toMatchObject({ approval: 'reviewers', soakMinutes: 0 });

    world.stored.deliveryRules = { version: 1, testing: { on: 'merge' } };
    expect((await effectiveDelivery({ repo: REPO, client: client(null) })).rules.production.approval).toBe('reviewers');
  });

  it('still ship by merging where Settings said so, whatever the choice', async () => {
    world.choice = { approval: 'reviewers', soakMinutes: 0, reviewers: [] };
    world.setting = JSON.stringify({ app: 'none' });
    expect((await effectiveDelivery({ repo: REPO, client: client(null) })).rules).toMatchObject({ testing: { on: 'none' }, production: { on: 'none' } });

    // Otherwise the fallback is the default with the recorded choice put in.
    world.setting = null;
    const deploys = await effectiveDelivery({ repo: REPO, client: client(null, ['.github/workflows/deploy-testing.yml']) });
    expect(deploys.rules.production).toMatchObject({ approval: 'reviewers', soakMinutes: 0 });
  });
});

describe('rules that could not be read', () => {
  const soaks = 'version: 1\nproduction:\n  approval: auto\n  soakMinutes: 60\n';
  const failing = () => ({
    readFileIfPresent: vi.fn(async (): Promise<string | null> => {
      throw new Error('GitHub answered 502: Bad Gateway');
    }),
    request: vi.fn(async () => ({ workflows: [] }) as never),
  });

  it('a contents read that fails with 502 is not read as no file', async () => {
    const found = await effectiveDelivery({ repo: REPO, client: failing() });
    // The fallback, for the board and Settings to show, but marked.
    expect(found.source).toBe('setting');
    expect(found.readError).toBe('.github/fleetadlc.yml could not be read: GitHub answered 502: Bad Gateway');

    const read = await effectiveDelivery({ repo: REPO, client: client(soaks) });
    expect(read.readError).toBeNull();
    // A 404 is no file: the fallback, and nothing unread.
    expect((await effectiveDelivery({ repo: REPO, client: client(null) })).readError).toBeNull();
  });

  it('a stored row that could not be read is not taken for no stored rules', async () => {
    const { repos } = await import('@fleetadlc/db');
    vi.mocked(repos.getDelivery).mockRejectedValueOnce(new Error('the database went away'));
    const found = await effectiveDelivery({ repo: REPO, client: client(null) });
    expect(found.readError).toBe("the repository's stored rules could not be read: the database went away");

    // With the file read, the row is not needed.
    vi.mocked(repos.getDelivery).mockRejectedValueOnce(new Error('the database went away'));
    expect(await effectiveDelivery({ repo: REPO, client: client(soaks) })).toMatchObject({ source: 'file', readError: null });
  });

  it('a production choice that could not be read is not taken for no choice, unless the file sets the approval', async () => {
    // The default it falls to ships automatically; the choice may have been a person.
    const { repos } = await import('@fleetadlc/db');
    vi.mocked(repos.getProductionChoice).mockRejectedValueOnce(new Error('the database went away'));
    expect((await effectiveDelivery({ repo: REPO, client: client(null) })).readError).toBe(
      "the repository's production choice could not be read: the database went away",
    );

    vi.mocked(repos.getProductionChoice).mockRejectedValueOnce(new Error('the database went away'));
    expect((await effectiveDelivery({ repo: REPO, client: client(soaks) })).readError).toBeNull();
  });

  it('a fallback from a read error is not cached', async () => {
    let now = 0;
    let down = true;
    const github = client(soaks);
    github.readFileIfPresent.mockImplementation(async () => {
      if (down) throw new Error('GitHub answered 502: Bad Gateway');
      return soaks;
    });
    const known = new DeliveryKnowledge(async () => github, '', 5 * 60_000, () => now);

    expect((await known.get(REPO)).readError).toContain('502');
    down = false;
    const read = await known.get(REPO);
    expect(read).toMatchObject({ source: 'file', readError: null });
    expect(read.rules.production.soakMinutes).toBe(60);

    // Past its time, and GitHub failing again: the last rules read stand in.
    down = true;
    now += 60 * 60_000;
    expect(await known.get(REPO)).toBe(read);
    expect(await known.get(REPO)).toBe(read);
    expect(github.readFileIfPresent).toHaveBeenCalledTimes(4);
  });
});

describe('where testing is served', () => {
  it('is the rules’ URL, else the repository’s, else the install’s deprecated one', async () => {
    const legacy = 'https://legacy.example.com';
    const withUrl = 'version: 1\ntesting:\n  url: https://rules.example.com\n';
    expect((await effectiveDelivery({ repo: REPO, client: client(withUrl), legacyTestingUrl: legacy })).testingUrl).toBe('https://rules.example.com');

    world.stored.testingUrl = 'https://repo.example.com';
    expect((await effectiveDelivery({ repo: REPO, client: client('version: 1\n'), legacyTestingUrl: legacy })).testingUrl).toBe('https://repo.example.com');

    world.stored.testingUrl = null;
    expect((await effectiveDelivery({ repo: REPO, client: client('version: 1\n'), legacyTestingUrl: legacy })).testingUrl).toBe(legacy);
    expect((await effectiveDelivery({ repo: REPO, client: client('version: 1\n') })).testingUrl).toBeNull();
  });
});

describe('what was read', () => {
  it('is remembered for a while, and read again once forgotten', async () => {
    const github = client('version: 1\n');
    const known = new DeliveryKnowledge(async () => github);
    await known.get(REPO);
    await known.get(REPO);
    expect(github.readFileIfPresent).toHaveBeenCalledTimes(1);
    known.forget(REPO.fullName);
    await known.get(REPO);
    expect(github.readFileIfPresent).toHaveBeenCalledTimes(2);
  });
});
