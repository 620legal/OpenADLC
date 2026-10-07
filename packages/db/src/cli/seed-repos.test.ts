import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig } from '@fleetadlc/shared';

vi.mock('../store/bots.js', () => ({ listBots: vi.fn() }));
vi.mock('../store/repos.js', () => ({
  upsertRepo: vi.fn(),
  RepoNameTaken: class RepoNameTaken extends Error {},
}));

import * as bots from '../store/bots.js';
import * as repos from '../store/repos.js';
import { writeRepos } from './seed-repos.js';
import { scriptedRepository } from './scripted-repo.js';

function listed(owner: string, fullName = 'exampleco/app'): RepoConfig {
  return { ...scriptedRepository(owner), name: fullName.split('/')[1]!, fullName };
}

beforeEach(() => {
  vi.mocked(bots.listBots).mockReset().mockResolvedValue([{ id: 'b1', name: 'fleetadlc-builder-janedoe', slot: 'builder' }] as never);
  vi.mocked(repos.upsertRepo).mockReset();
});

describe('seeding config/repos.yaml', () => {
  it('writes a repository whose owner names a seat with that bot as its owner', async () => {
    expect(await writeRepos([listed('builder')])).toEqual({ unknownOwners: [], refused: [] });
    expect(repos.upsertRepo).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'exampleco/app', ownerBotId: 'b1' }));
  });

  it('names an owner that is no bot, instead of storing the repository ownerless without a word', async () => {
    // A misspelt seat left the repository with no owner, which the dispatcher
    // skips, so nothing ever built there and nothing said why.
    const { unknownOwners } = await writeRepos([listed('builder'), listed('buidler', 'exampleco/other')]);

    expect(unknownOwners).toEqual([{ fullName: 'exampleco/other', owner: 'buidler' }]);
    expect(repos.upsertRepo).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'exampleco/other', ownerBotId: null }));
  });

  it('passes a setting the file leaves out as left out, so the row keeps its own', async () => {
    await writeRepos([{ name: 'app', fullName: 'exampleco/app', owner: 'builder' }]);
    const input = vi.mocked(repos.upsertRepo).mock.calls[0]![0];
    expect(input.stageModes).toBeUndefined();
    expect(input.concurrency).toBeUndefined();
  });

  it('names a repository refused for another’s name and writes the rest', async () => {
    vi.mocked(repos.upsertRepo).mockRejectedValueOnce(
      new (repos.RepoNameTaken as unknown as new (message: string) => Error)('OpenADLC already has a repository called api (janedoe/api), and names each repository by its name alone, so acme/api cannot be added beside it'),
    );
    const { refused } = await writeRepos([listed('builder', 'acme/api'), listed('builder', 'exampleco/other')]);

    expect(refused).toEqual([{ fullName: 'acme/api', reason: expect.stringContaining('janedoe/api') }]);
    expect(repos.upsertRepo).toHaveBeenCalledTimes(2);
  });
});
