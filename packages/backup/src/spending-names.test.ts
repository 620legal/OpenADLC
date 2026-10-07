import { describe, expect, it } from 'vitest';
import { archiveSpendingLimit, resolveSpendingLimits } from './archive.js';
import { buildBackup } from './contents.js';
import { EVERYTHING } from './selection.js';
import { cleanShape, sourceInstall } from './test-fixtures.js';
import { planUndo, type RestoreJournal } from './undo.js';

const REPOS = [{ id: 'repo-old', fullName: 'acme/widgets' }];
const BOTS = [{ id: 'bot-old', name: 'builder', slot: 'builder' }];

describe('a spending cap in an archive', () => {
  it('names the repository and the bot, and a restore writes this install’s ids', () => {
    const archived = [
      archiveSpendingLimit({ scope: 'global', kind: 'month_total', amountUsd: 80 }, REPOS, BOTS),
      archiveSpendingLimit({ scope: 'repo:repo-old', kind: 'task', amountUsd: 5 }, REPOS, BOTS),
      archiveSpendingLimit({ scope: 'repo:repo-old', kind: 'month_bot:bot-old', amountUsd: 10 }, REPOS, BOTS),
      archiveSpendingLimit({ scope: 'global', kind: 'month_provider:anthropic', amountUsd: 40 }, REPOS, BOTS),
    ];

    expect(archived[1]).toEqual({ scope: 'repo', repository: 'acme/widgets', kind: 'task', amountUsd: 5 });
    expect(archived[2]).toEqual({ scope: 'repo', repository: 'acme/widgets', kind: 'month_bot', bot: 'builder', amountUsd: 10 });

    expect(
      resolveSpendingLimits(archived, [{ id: 'repo-new', fullName: 'acme/widgets' }], [{ id: 'bot-new', name: 'builder' }]),
    ).toEqual([
      { scope: 'global', kind: 'month_total', amountUsd: 80 },
      { scope: 'repo:repo-new', kind: 'task', amountUsd: 5 },
      { scope: 'repo:repo-new', kind: 'month_bot:bot-new', amountUsd: 10 },
      { scope: 'global', kind: 'month_provider:anthropic', amountUsd: 40 },
    ]);
  });

  it('follows the slot when the bot has taken its GitHub login and the new install is still named by its seat', () => {
    const archived = archiveSpendingLimit(
      { scope: 'global', kind: 'month_bot:bot-old', amountUsd: 10 },
      REPOS,
      [{ id: 'bot-old', name: 'fleetadlc-atlas-janedoe', slot: 'builder' }],
    );

    expect(archived.bot).toBe('builder');
    expect(
      resolveSpendingLimits([archived], [{ id: 'repo-new', fullName: 'acme/widgets' }], [{ id: 'bot-new', name: 'builder', slot: 'builder' }]),
    ).toEqual([{ scope: 'global', kind: 'month_bot:bot-new', amountUsd: 10 }]);
  });

  it('leaves out a repository or a bot this install does not have', () => {
    const rows = [
      { scope: 'repo', repository: 'acme/gone', kind: 'task', amountUsd: 5 },
      { scope: 'global', kind: 'month_bot', bot: 'nobody', amountUsd: 10 },
      { scope: 'repo:repo-old', kind: 'month_bot:bot-old', amountUsd: 1 },
    ];
    expect(resolveSpendingLimits(rows, [{ id: 'repo-new', fullName: 'acme/widgets' }], [{ id: 'bot-new', name: 'builder' }])).toEqual([]);
  });

  it('is what an undo puts back when the restore replaced the table', () => {
    const before = [{ scope: 'global', kind: 'month_total', amountUsd: 12 }];
    const snapshot = buildBackup({ ...sourceInstall(), spendingLimits: before }, EVERYTHING, new Date('2026-09-25T10:00:00.000Z')).contents;
    const journal: RestoreJournal = {
      id: 'r',
      restoredAt: '2026-09-25T10:00:00.000Z',
      until: '2026-09-26T10:00:00.000Z',
      actor: 'alex@example.test',
      backupMadeAt: snapshot.manifest.createdAt,
      settings: [],
      install: [],
      seats: [],
      repositories: [],
      accounts: [],
      accountCredentials: [],
      history: null,
      spending: true,
    };
    expect(planUndo(snapshot, journal, cleanShape()).spendingLimits).toEqual(before);
    expect(planUndo(snapshot, { ...journal, spending: false }, cleanShape()).spendingLimits).toBeUndefined();
  });

  it('keeps an id that is already this install’s', () => {
    expect(
      resolveSpendingLimits(
        [{ scope: 'repo:repo-new', kind: 'month_bot:bot-new', amountUsd: 10 }],
        [{ id: 'repo-new', fullName: 'acme/widgets' }],
        [{ id: 'bot-new', name: 'builder' }],
      ),
    ).toEqual([{ scope: 'repo:repo-new', kind: 'month_bot:bot-new', amountUsd: 10 }]);
  });
});
