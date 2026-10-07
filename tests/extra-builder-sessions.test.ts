import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; the suites import it as well.
import { addSecondBuilder, retireBuilder } from './second-builder.mjs';

/**
 * The concurrency suite adds a second builder, then deletes the row. The idle
 * shell is not the task session, so cancelling the task leaves
 * `fleetadlc__builder-2__shell` with no bot behind it.
 */

interface BotRow {
  name: string;
}

interface SessionRow {
  name: string;
}

function install(options: { hostdListsShell: boolean }) {
  // builder-3 is a real builder somebody configured, in the middle of a task.
  // The owner is connected, so it goes by its handle.
  const bots: BotRow[] = [{ name: 'fleetadlc-atlas-janedoe' }, { name: 'builder-2' }, { name: 'builder-3' }];
  const tmux = [
    'fleetadlc__fleetadlc-atlas-janedoe__shell',
    'fleetadlc__builder-2__shell',
    'fleetadlc__builder-3__shell',
    'fleetadlc__builder-3__implement',
    'fleetadlc__intake__shell',
  ];
  const host = new Map<string, SessionRow[]>([['builder-3', [{ name: 'shell' }, { name: 'implement' }]]]);
  if (options.hostdListsShell) host.set('builder-2', [{ name: 'shell' }]);
  const killedHost: string[] = [];
  const killedTmux: string[] = [];

  return {
    killedHost,
    killedTmux,
    tmux,
    bots,
    async retire(name: string) {
      return retireBuilder(name, {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql === 'delete from bots where name = $1') {
            const index = bots.findIndex((bot) => bot.name === params[0]);
            if (index >= 0) bots.splice(index, 1);
            return [];
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
        listHostSessions: async (bot: string) => host.get(bot)?.map((session) => ({ ...session })) ?? [],
        killHostSession: async (bot: string, session: string) => {
          killedHost.push(`${bot}/${session}`);
          const left = (host.get(bot) ?? []).filter((entry) => entry.name !== session);
          host.set(bot, left);
        },
        listTmuxSessions: async () => [...tmux],
        killTmuxSession: async (name: string) => {
          killedTmux.push(name);
          const index = tmux.indexOf(name);
          if (index >= 0) tmux.splice(index, 1);
        },
      });
    },
  };
}

describe('retiring the extra builder', () => {
  it('kills fleetadlc__builder-2__shell and leaves the owner’s shell', async () => {
    const fixture = install({ hostdListsShell: true });

    const orphans = await fixture.retire('builder-2');

    expect(orphans).toEqual([]);
    expect(fixture.killedHost).toEqual(['builder-2/shell']);
    expect(fixture.killedTmux).toEqual(['fleetadlc__builder-2__shell']);
    expect(fixture.tmux).not.toContain('fleetadlc__builder-2__shell');
    expect(fixture.tmux).toContain('fleetadlc__fleetadlc-atlas-janedoe__shell');
    expect(fixture.bots.map((bot) => bot.name)).not.toContain('builder-2');
  });

  it('kills the host tmux session when hostd is no longer listing the bot', async () => {
    // After the row is gone, nothing asks hostd for that bot. The session is
    // still on the host tmux server, which is where this one was found.
    const fixture = install({ hostdListsShell: false });

    const orphans = await fixture.retire('builder-2');

    expect(orphans).toEqual([]);
    expect(fixture.killedTmux).toEqual(['fleetadlc__builder-2__shell']);
    expect(fixture.tmux).not.toContain('fleetadlc__builder-2__shell');
  });

  it('leaves every other builder, and what it is running, alone', async () => {
    // It retired every bot like `<owner>-%`, so a configured third builder
    // lost its row and its running task along with the suite's own second.
    const fixture = install({ hostdListsShell: true });

    await fixture.retire('builder-2');

    expect(fixture.bots.map((bot) => bot.name)).toEqual(['fleetadlc-atlas-janedoe', 'builder-3']);
    expect(fixture.tmux).toEqual([
      'fleetadlc__fleetadlc-atlas-janedoe__shell',
      'fleetadlc__builder-3__shell',
      'fleetadlc__builder-3__implement',
      'fleetadlc__intake__shell',
    ]);
    expect(fixture.killedHost.filter((session) => session.startsWith('builder-3/'))).toEqual([]);
  });
});

describe('adding the second builder', () => {
  // Connected, so it goes by its handle; its seat is what the second one is
  // numbered from.
  const owner = {
    name: 'fleetadlc-atlas-janedoe',
    slot: 'builder',
    displayName: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-5',
    githubLogin: 'fleetadlc-atlas-janedoe',
    hostId: 'host-1',
    skills: [],
    sidecarDb: null,
  };

  it('seeds the builder-2 seat when there is none, and says it did', async () => {
    // Named for the owner's handle it would be `fleetadlc-atlas-janedoe-2`: a
    // name nobody chose, for an account nobody has.
    const written: { slot: string }[] = [];
    const added = await addSecondBuilder(owner, {
      getBotBySlot: async () => null,
      seedBot: async (input: { slot: string }) => {
        written.push(input);
        return { id: 'bot-builder-2', name: input.slot, ...input };
      },
    });

    expect(added.created).toBe(true);
    expect(added.bot.name).toBe('builder-2');
    expect(written).toEqual([expect.objectContaining({ slot: 'builder-2', role: 'implement' })]);
    expect(written[0]).not.toHaveProperty('githubLogin');
  });

  it('uses a builder-2 that was already there as it is, and does not claim it', async () => {
    // A configured second builder is somebody's bot. Writing the suite's
    // version over it and deleting it afterwards would take it, and its work,
    // away.
    const configured = { id: 'bot-real', name: 'real-login', slot: 'builder-2', githubLogin: 'real-login' };
    const written: string[] = [];
    const added = await addSecondBuilder(owner, {
      getBotBySlot: async (slot: string) => (slot === 'builder-2' ? configured : null),
      seedBot: async (input: { slot: string }) => {
        written.push(input.slot);
        return { id: 'overwritten', ...input };
      },
    });

    expect(added).toEqual({ bot: configured, created: false });
    expect(written).toEqual([]);
  });
});

describe('the concurrency suite', () => {
  it('runs its checks however it is started', () => {
    // It compared import.meta.url, which has symlinks resolved, with argv[1],
    // which does not. Started through a symlinked path it did nothing and
    // exited 0, which reads as a pass. What a test needs now lives in
    // second-builder.mjs, so the suite has nothing to guard.
    const source = readFileSync(new URL('./concurrency.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/^main\(\)\.catch\(/m);
    expect(source).not.toContain('import.meta.url ===');
  });

  it('retires only the builder it created', () => {
    // The decision is made in main(), which a test cannot run: the name it
    // retires is the one addSecondBuilder reported creating, and nothing else.
    const source = readFileSync(new URL('./concurrency.mjs', import.meta.url), 'utf8');
    expect(source).toContain('if (added.created) created = second.name;');
    expect(source).toMatch(/if \(created\) \{\s*const orphans = await retireBuilder\(created, liveRetireDeps\);/);
    expect(source).not.toMatch(/like \$1/);
  });
});
