import { describe, expect, it } from 'vitest';
import type { BotRole } from '@fleetadlc/shared';
import { builderPool, builderSlots, combinedTasks, missingBuildersReason, ownerCannotBuild } from './pool.js';

function bot(name: string, slot: string, role: BotRole = 'implement', githubLogin: string | null = name, maxTasks = 1) {
  return { id: `id-${slot}`, name, slot, role, githubLogin, maxTasks };
}

// The owner is connected, so it goes by its handle.
const owner = bot('fleetadlc-atlas-janedoe', 'builder');

describe('who builds in a repository', () => {
  it('is the owner and the other bots with its role, whatever they are called', () => {
    // Found by name it was the owner's handle with `-2` after it, which is
    // nobody: the second builder is `builder-2`, or its own account's handle.
    const crew = [
      bot('intake', 'intake', 'intake'),
      owner,
      bot('irisexampleco', 'builder-2'),
      bot('builder-3', 'builder-3'),
      bot('qa', 'qa', 'qa'),
    ];

    expect(builderPool(owner, crew, 3).map((entry) => entry.name)).toEqual([
      'fleetadlc-atlas-janedoe',
      'irisexampleco',
      'builder-3',
    ]);
  });

  it('takes no more than the concurrency, the owner first and the rest in seat order', () => {
    const crew = [bot('b10', 'builder-10'), bot('b3', 'builder-3'), owner, bot('b2', 'builder-2')];

    expect(builderPool(owner, crew, 1)).toEqual([owner]);
    expect(builderPool(owner, crew, 3).map((entry) => entry.slot)).toEqual(['builder', 'builder-2', 'builder-3']);
  });

  it('is never a bot with another role, even one that can implement', () => {
    // QA has the implement skill; it is not a builder.
    const crew = [owner, bot('qa', 'qa', 'qa'), bot('system-engineer', 'system-engineer', 'spec')];
    expect(builderPool(owner, crew, 3)).toEqual([owner]);
  });
});

describe('a builder seat on no GitHub account yet', () => {
  // Added from settings a moment ago, before anybody chose its account. Work
  // leased to it failed at once, and its lease held the issue's paths.
  const added = bot('builder-2', 'builder-2', 'implement', null);

  it('is given no work until it is on one', () => {
    expect(builderPool(owner, [owner, added], 2)).toEqual([owner]);
    expect(builderPool(owner, [owner, { ...added, githubLogin: 'fleetadlc-crew-janedoe' }], 2).map((entry) => entry.slot)).toEqual([
      'builder',
      'builder-2',
    ]);
  });

  it('is given work when engines are scripted, even beside a connected owner, as holdFor allows', () => {
    // The concurrency suite adds builder-2 with no account on the same install
    // the live suites need a connected owner on.
    expect(builderPool(owner, [owner, added], 2, { scripted: true }).map((entry) => entry.slot)).toEqual(['builder', 'builder-2']);
    expect(missingBuildersReason(owner, [owner, added], [owner], 3, { scripted: true })).toContain('or add a builder-3 seat');
  });

  it('works as before where nobody has an account, as on a scripted install', () => {
    const unconnectedOwner = { ...owner, githubLogin: null };
    expect(builderPool(unconnectedOwner, [unconnectedOwner, added], 2).map((entry) => entry.slot)).toEqual(['builder', 'builder-2']);
  });

  it('is what the dispatcher names when the repository asks for more builders than can work', () => {
    const crew = [owner, added];
    expect(missingBuildersReason(owner, crew, builderPool(owner, crew, 2), 2)).toBe(
      'concurrency is 2 but the builders that can work run 1 task(s) at once; put builder-2 on a GitHub account in Settings → Crew',
    );
  });
});

describe('what the dispatcher says when concurrency outruns the builders', () => {
  it('says what they run between them, and names both ways to give them more', () => {
    const crew = [owner, bot('intake', 'intake', 'intake')];
    expect(missingBuildersReason(owner, crew, [owner], 2)).toBe(
      "concurrency is 2 but the builders' combined maxTasks is 1; raise a builder's tasks at once on the Crew page, or add a builder-2 seat in Settings → Crew",
    );
  });

  it('names the first seat that is free, and counts every builder’s tasks at once', () => {
    const crew = [{ ...owner, maxTasks: 2 }, bot('b2', 'builder-2')];
    expect(missingBuildersReason(owner, crew, crew, 4)).toBe(
      "concurrency is 4 but the builders' combined maxTasks is 3; raise a builder's tasks at once on the Crew page, or add a builder-3 seat in Settings → Crew",
    );
  });
});

describe('where a repository’s next builds go', () => {
  const second = bot('irisexampleco', 'builder-2', 'implement', 'irisexampleco', 2);
  const seats = [{ ...owner, maxTasks: 3 }, second];

  it('fills the owner first, then the next seat, one place per task each has room for', () => {
    const room = (seat: { id: string }) => (seat.id === owner.id ? 2 : 2);
    expect(builderSlots(seats, room, 3).map((seat) => seat.slot)).toEqual(['builder', 'builder', 'builder-2']);
  });

  it('skips a seat with no room, and stops at the limit', () => {
    expect(builderSlots(seats, (seat) => (seat.id === owner.id ? 0 : 2), 5).map((seat) => seat.slot)).toEqual(['builder-2', 'builder-2']);
    expect(builderSlots(seats, () => 3, 0)).toEqual([]);
  });

  it('counts what the builders run between them', () => {
    expect(combinedTasks(seats)).toBe(5);
    // A row that says nothing runs one.
    expect(combinedTasks([{ ...owner, maxTasks: undefined as unknown as number }])).toBe(1);
  });
});

describe('an owner that cannot build', () => {
  it('is the automation account, which thinks with no model, and the repository is skipped saying so', () => {
    expect(ownerCannotBuild({ name: 'janedoe-fleetadlc-flow', engine: 'none' }, 'fleetadlc-testbed')).toBe(
      'janedoe-fleetadlc-flow owns fleetadlc-testbed but thinks with no model, so nothing is leased to it; ' +
        'set `owner: builder` for fleetadlc-testbed in config/repos.yaml and run `fleetadlc seed` ' +
        '(settings the entry leaves out keep what the console set)',
    );
  });

  it('is not a builder on any engine', () => {
    expect(ownerCannotBuild({ name: 'fleetadlc-atlas-janedoe', engine: 'claude' }, 'fleetadlc-testbed')).toBeNull();
    expect(ownerCannotBuild({ name: 'irisexampleco', engine: 'grok' }, 'fleetadlc-testbed')).toBeNull();
  });
});
