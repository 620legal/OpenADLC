import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, queryOne, withTransaction } from '../client.js';
import { ModelAccountNotFound } from './modelAccounts.js';
import {
  AssignmentRefused,
  SeatRefused,
  addSeat,
  keptOnReseed,
  releaseLogin,
  removeSeat,
  renameBotRow,
  seatWorkRefusal,
  seedBot,
  setAppearance,
  setAssignment,
  setGithubLogin,
} from './bots.js';

const ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440000';

function botRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    name: 'fleetadlc-atlas-janedoe',
    slot: 'builder',
    display_name: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'claude-sonnet-5',
    github_login: 'fleetadlc-atlas-janedoe',
    host_id: null,
    container: 'bot-fleetadlc-atlas-janedoe',
    status: 'stopped',
    skills: ['implement'],
    sidecar_db: true,
    model_account_id: null,
    model_set_at: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(queryOne).mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(withTransaction).mockReset();
});

describe('reseeding the crew', () => {
  const SET_AT = '2026-09-23T12:00:00.000Z';

  it('keeps a model the console set', () => {
    expect(
      keptOnReseed(
        { engine: 'claude', model: 'newest:opus', modelSetAt: SET_AT },
        { engine: 'claude', model: 'claude-sonnet-5' },
      ),
    ).toEqual({ engine: 'claude', model: 'newest:opus' });
  });

  it('uses the file when there is no row', () => {
    expect(keptOnReseed(null, { engine: 'claude', model: 'claude-sonnet-5' })).toEqual({
      engine: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  it('applies a YAML edit to a bot whose model nobody set in the console', () => {
    // `bots.model` is never null, so a row always had a model. Keeping it for
    // that reason meant no edit to config/bots.yaml reached a bot again.
    expect(
      keptOnReseed(
        { engine: 'claude', model: 'claude-sonnet-5', modelSetAt: null },
        { engine: 'claude', model: 'claude-opus-5' },
      ),
    ).toEqual({ engine: 'claude', model: 'claude-opus-5' });
  });

  it('keeps a console assignment’s engine with its model, whatever engine the file names', () => {
    // The account decides the engine: a builder put on an xAI seat in the
    // console runs grok, though the file says claude. Keeping the model
    // without the engine was engine claude, model grok-4.
    expect(
      keptOnReseed(
        { engine: 'grok', model: 'grok-4.7', modelSetAt: SET_AT },
        { engine: 'claude', model: 'claude-sonnet-5' },
      ),
    ).toEqual({ engine: 'grok', model: 'grok-4.7' });
  });

  it('takes the file’s engine and model for a bot nobody assigned', () => {
    expect(
      keptOnReseed(
        { engine: 'grok', model: 'grok-4', modelSetAt: null },
        { engine: 'claude', model: 'claude-sonnet-5' },
      ),
    ).toEqual({ engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('takes the file for a bot that does not think, on either side', () => {
    // A console save of the automation bot's `none` must not hold it there if
    // the file makes it think, nor keep a model on a bot the file stops.
    expect(
      keptOnReseed(
        { engine: 'none', model: 'none', modelSetAt: SET_AT },
        { engine: 'claude', model: 'claude-haiku-4-5' },
      ),
    ).toMatchObject({ engine: 'claude', model: 'claude-haiku-4-5' });
    expect(
      keptOnReseed(
        { engine: 'claude', model: 'newest:opus', modelSetAt: SET_AT },
        { engine: 'none', model: 'none' },
      ),
    ).toMatchObject({ engine: 'none', model: 'none' });
  });

  it('finds the row by its seat, and leaves its name, its container and its account alone', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(botRow({ model_account_id: ACCOUNT_ID }));

    const bot = await seedBot({
      slot: 'builder',
      displayName: 'Builder',
      role: 'implement',
      engine: 'claude',
      model: 'claude-sonnet-5',
      hostId: null,
      skills: ['implement'],
      sidecarDb: true,
    });

    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    // A connected builder is `fleetadlc-atlas-janedoe`. Upserting by name found no
    // `builder` and would have added a second one.
    expect(sql).toContain('on conflict (slot) do update set');
    // A new seat is named after itself, with a container to match.
    expect(sql).toContain("values ($1, $1, $2, $3, $4, $5, 'bot-' || $1,");
    // An existing row's name, container and login are what connecting wrote.
    const update = sql.slice(sql.indexOf('do update set'), sql.indexOf('returning'));
    expect(update).not.toMatch(/\bname = excluded/);
    expect(update).not.toContain('container = excluded');
    expect(update).not.toContain('github_login');
    // A login connected or a backup restored writes the row's own engine and
    // model back; that must not drop the assignment. A new engine is a new
    // provider, so an account for the old one goes with it.
    expect(sql).toContain(
      'model_set_at = case when bots.model = excluded.model and bots.engine = excluded.engine then bots.model_set_at end',
    );
    expect(sql).toContain('model_account_id = case when bots.engine = excluded.engine then bots.model_account_id end');
    expect(bot).toMatchObject({ name: 'fleetadlc-atlas-janedoe', slot: 'builder', modelAccountId: ACCOUNT_ID });
  });

  it('stores the file’s CPUs and memory, and its tasks at once only when it names a number', async () => {
    // cpus and memoryGb were parsed and dropped, so every container ran on the
    // driver's two CPUs and 4 GB whatever the file said.
    vi.mocked(queryOne).mockResolvedValueOnce(botRow({ cpus: '2', memory_gb: '6', max_tasks: 3 }));
    const seat = {
      slot: 'builder',
      displayName: 'Builder',
      role: 'implement' as const,
      engine: 'claude' as const,
      model: 'claude-sonnet-5',
      hostId: null,
      skills: ['implement'],
      sidecarDb: true,
    };

    const bot = await seedBot({ ...seat, cpus: 2, memoryGb: 6 });

    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(params?.slice(8)).toEqual([2, 6, null]);
    expect(text).toContain('cpus = coalesce($9::numeric, bots.cpus)');
    expect(text).toContain('memory_gb = coalesce($10::numeric, bots.memory_gb)');
    // Left out of the file, a person's "tasks at once" survives the restart.
    expect(text).toContain('max_tasks = coalesce($11::int, bots.max_tasks)');
    expect(bot).toMatchObject({ cpus: 2, memoryGb: 6, maxTasks: 3 });

    vi.mocked(queryOne).mockResolvedValueOnce(botRow({}));
    await seedBot({ ...seat, cpus: 1, memoryGb: 2, maxTasks: 4 });
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]?.slice(8)).toEqual([1, 2, 4]);
  });
});

describe('an account another row only names', () => {
  it('is taken off every other row, case-insensitively, and never off the bot connecting', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ name: 'sydney' }]);

    const released = await releaseLogin('Noraexampleco', 'bot-nova');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql).replace(/\s+/g, ' ')).toContain('where lower(github_login) = lower($1) and id <> $2');
    expect(params).toEqual(['Noraexampleco', 'bot-nova']);
    expect(released).toEqual(['sydney']);
  });
});

describe('the row’s half of a rename', () => {
  /** A transaction whose `workPausedSeats` row holds `pauses`, kept as it is written. */
  function transaction(returned: unknown[], pauses: string | null = null) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const settings = { workPausedSeats: pauses };
    vi.mocked(withTransaction).mockImplementation(async (fn) =>
      fn({
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql: sql.replace(/\s+/g, ' '), params });
          if (sql.includes('from settings')) return { rows: settings.workPausedSeats === null ? [] : [{ value: settings.workPausedSeats }] };
          if (sql.includes('update settings')) settings.workPausedSeats = params[1] as string;
          return { rows: sql.includes('update bots') ? returned : [] };
        },
      } as never),
    );
    return { calls, settings };
  }

  const input = {
    id: 'bot-1',
    from: 'atlas',
    to: 'fleetadlc-atlas-janedoe',
    actor: 'bridge',
    reason: 'connected as FleetADLC-Atlas-Janedoe',
    secretRefs: [
      { from: 'github-refresh-atlas', to: 'github-refresh-fleetadlc-atlas-janedoe' },
      { from: 'github-token-atlas', to: 'github-token-fleetadlc-atlas-janedoe' },
    ],
  };

  it('moves the name, the container, the credential’s ref and the sessions together, and says so', async () => {
    const { calls } = transaction([botRow()]);

    const bot = await renameBotRow(input);

    expect(bot?.name).toBe('fleetadlc-atlas-janedoe');
    const [rename, ...rest] = calls;
    expect(rename?.sql).toContain('update bots set name = $3,');
    expect(rename?.sql).toContain('renamed_from = $2, updated_at = now() where id = $1 and name = $2');
    // The prefix hostd recorded stays; only the name after it changes.
    expect(rename?.sql).toContain(
      "container = case when right(container, length($2)) = $2 then left(container, length(container) - length($2)) || $3 else 'bot-' || $3 end",
    );
    expect(rename?.params).toEqual(['bot-1', 'atlas', 'fleetadlc-atlas-janedoe']);
    expect(rest.map((call) => call.params)).toEqual([
      ['bot-1', 'github-refresh-atlas', 'github-refresh-fleetadlc-atlas-janedoe'],
      ['bot-1', 'github-token-atlas', 'github-token-fleetadlc-atlas-janedoe'],
      // The account's secrets are filed under the bot's name, and move with it.
      ['bot-1', 'atlas', 'fleetadlc-atlas-janedoe'],
      ['bot-1'],
      // No seat is paused: the pauses are read, and left alone.
      ['workPausedSeats'],
      [
        'bridge',
        'bot.renamed',
        'fleetadlc-atlas-janedoe',
        JSON.stringify({ from: 'atlas', to: 'fleetadlc-atlas-janedoe', reason: 'connected as FleetADLC-Atlas-Janedoe' }),
      ],
    ]);
    expect(rest[3]?.sql).toBe('delete from sessions where bot_id = $1');
  });

  it('changes nothing when the bot is no longer called what the caller thought', async () => {
    const { calls } = transaction([]);

    expect(await renameBotRow(input)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('keeps a paused seat paused under its new name, and nothing under the old one', async () => {
    const pause = { by: 'janedoe', at: '2026-10-01T09:00:00.000Z', why: 'checking its account' };
    const other = { by: 'janedoe', at: '2026-10-01T09:05:00.000Z', why: null };
    // A stale entry under the new name gives way to the moved one.
    const { settings } = transaction([botRow()], JSON.stringify({ atlas: pause, reviewer: other, 'fleetadlc-atlas-janedoe': other }));

    await renameBotRow(input);

    const after = JSON.parse(settings.workPausedSeats ?? '{}');
    expect(after).toEqual({ reviewer: other, 'fleetadlc-atlas-janedoe': pause });
    expect(after.atlas).toBeUndefined();
  });

  it('leaves the pauses as they are when this bot is not paused, or they do not read', async () => {
    for (const stored of [null, '', 'not json', '[]', JSON.stringify({ reviewer: { by: 'janedoe', at: 'x', why: null } })]) {
      const { calls, settings } = transaction([botRow()], stored);

      expect((await renameBotRow(input))?.name).toBe('fleetadlc-atlas-janedoe');
      expect(settings.workPausedSeats).toBe(stored);
      expect(calls.some((call) => call.sql.includes('update settings'))).toBe(false);
    }
  });
});

describe('setting an assignment', () => {
  it('writes the model and the account together', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('update bots')) return botRow({ model: 'newest:opus', model_account_id: ACCOUNT_ID });
      if (text.includes('model_accounts')) {
        return {
          id: ACCOUNT_ID,
          provider: 'anthropic',
          kind: 'key',
          label: 'primary',
          created_at: new Date('2026-09-23T12:00:00.000Z'),
        };
      }
      return botRow();
    });

    const bot = await setAssignment('bot-1', { engine: 'claude', model: ' newest:opus ', modelAccountId: ACCOUNT_ID });

    const update = vi.mocked(queryOne).mock.calls.find((call) => String(call[0]).includes('update bots'));
    expect(update?.[1]).toEqual(['bot-1', 'claude', 'newest:opus', ACCOUNT_ID]);
    // What tells the next `fleetadlc up` this model is the console's.
    expect(String(update?.[0])).toMatch(/model_set_at = now\(\)/);
    expect(bot.model).toBe('newest:opus');
    expect(bot.modelAccountId).toBe(ACCOUNT_ID);
  });

  it('writes the engine the account puts the bot on, in the same statement', async () => {
    // A builder moved onto an xAI seat: its next task reads engine grok from
    // this row, with the account whose login grok needs.
    vi.mocked(queryOne).mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes('update bots')) {
        const values = params as unknown[];
        return botRow({ engine: values[1], model: values[2], model_account_id: values[3], model_set_at: new Date() });
      }
      if (text.includes('model_accounts')) {
        return { id: ACCOUNT_ID, provider: 'xai', kind: 'subscription', label: 'SuperGrok', created_at: new Date() };
      }
      return botRow();
    });

    const bot = await setAssignment('bot-1', { engine: 'grok', model: 'grok-4.7', modelAccountId: ACCOUNT_ID });

    const update = vi.mocked(queryOne).mock.calls.find((call) => String(call[0]).includes('update bots'));
    expect(String(update?.[0])).toMatch(/set engine = \$2, model = \$3, model_account_id = \$4, model_set_at = now\(\)/);
    expect(bot).toMatchObject({ engine: 'grok', model: 'grok-4.7', modelAccountId: ACCOUNT_ID });
    expect(bot.modelSetAt).not.toBeNull();
  });

  it('refuses a blank model before it writes', async () => {
    await expect(
      setAssignment('bot-1', { engine: 'claude', model: '  ', modelAccountId: null }),
    ).rejects.toBeInstanceOf(AssignmentRefused);
    expect(vi.mocked(queryOne)).not.toHaveBeenCalled();
  });

  it('refuses an account on the automation bot', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(botRow({ name: 'automation', slot: 'automation', engine: 'none', model: 'none' }));

    await expect(
      setAssignment('bot-1', { engine: 'none', model: 'none', modelAccountId: ACCOUNT_ID }),
    ).rejects.toThrow(/cannot be assigned an account/);
    expect(vi.mocked(queryOne).mock.calls.some((call) => String(call[0]).includes('update bots'))).toBe(false);
  });

  it('does not make the automation bot think, nor stop a bot that does', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(botRow({ name: 'automation', slot: 'automation', engine: 'none', model: 'none' }));
    await expect(
      setAssignment('bot-1', { engine: 'claude', model: 'claude-opus-5', modelAccountId: null }),
    ).rejects.toThrow(/does not run a model, and an assignment does not make it/);

    vi.mocked(queryOne).mockResolvedValueOnce(botRow());
    await expect(setAssignment('bot-1', { engine: 'none', model: 'none', modelAccountId: null })).rejects.toThrow(
      /runs a model, and an assignment does not stop it/,
    );
    expect(vi.mocked(queryOne).mock.calls.some((call) => String(call[0]).includes('update bots'))).toBe(false);
  });

  it('refuses an account that is not there', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('model_accounts')) return null;
      return botRow();
    });

    await expect(
      setAssignment('bot-1', { engine: 'claude', model: 'claude-opus-5', modelAccountId: ACCOUNT_ID }),
    ).rejects.toBeInstanceOf(ModelAccountNotFound);
  });
});

describe('an account connecting', () => {
  function transaction(answers: Record<string, unknown[]>) {
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(withTransaction).mockImplementation(async (fn) =>
      fn({
        query: async (sql: string, params: unknown[]) => {
          const flat = sql.replace(/\s+/g, ' ');
          calls.push({ sql: flat, params });
          const key = Object.keys(answers).find((part) => flat.includes(part));
          return { rows: key ? answers[key] : [] };
        },
      } as never),
    );
    return calls;
  }

  it('files a new account as an identity under the bot’s own name, where its secrets already are', async () => {
    const calls = transaction({ 'select name from bots': [{ name: 'builder' }], 'insert into github_identities': [{ id: 'id-1' }] });

    await setGithubLogin('bot-1', 'FleetADLC-Builder');

    const insert = calls.find((call) => call.sql.startsWith('insert into github_identities'));
    expect(insert?.params).toEqual(['FleetADLC-Builder', 'builder']);
    expect(calls.at(-1)).toEqual({ sql: 'update bots set identity_id = $2 where id = $1', params: ['bot-1', 'id-1'] });
  });

  it('keeps the name an account other seats share is filed under', async () => {
    const calls = transaction({
      'select name from bots': [{ name: 'qa' }],
      'from github_identities i where lower(i.login)': [{ id: 'shared', sharers: '2' }],
    });

    await setGithubLogin('bot-qa', 'fleetadlc-example');

    expect(calls.some((call) => call.sql.startsWith('insert into github_identities'))).toBe(false);
    expect(calls.some((call) => call.sql.startsWith('update github_identities set login'))).toBe(false);
    expect(calls.at(-1)?.params).toEqual(['bot-qa', 'shared']);
  });

  it('lets go of the identity when the bot is disconnected', async () => {
    const calls = transaction({});
    await setGithubLogin('bot-1', null);
    expect(calls.at(-1)).toEqual({ sql: 'update bots set identity_id = null where id = $1', params: ['bot-1'] });
  });
});

describe('adding and removing a seat while the install runs', () => {
  /** A transaction whose statements answer by the first key their text starts with. */
  function transaction(answers: Record<string, unknown[]>) {
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(withTransaction).mockImplementation(async (fn) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          const text = sql.replace(/\s+/g, ' ').trim();
          calls.push({ sql: text, params });
          const key = Object.keys(answers).find((one) => text.startsWith(one));
          return { rows: key ? answers[key] : [] };
        },
      } as never),
    );
    return calls;
  }

  const builder = {
    like: 'builder',
    displayName: 'Builder',
    role: 'implement' as const,
    engine: 'claude' as const,
    model: 'claude-sonnet-5',
    hostId: 'host-1',
    skills: ['implement'],
    sidecarDb: true,
    actor: 'janedoe',
  };

  it('takes the next free seat, named after itself, and says who added it', async () => {
    // `builder-2` is taken, and so is `builder-3` — as the handle of a
    // connected bot — so the new seat is `builder-4`.
    const calls = transaction({
      'select slot, name from bots': [
        { slot: 'builder', name: 'fleetadlc-atlas-janedoe' },
        { slot: 'builder-2', name: 'builder-2' },
        { slot: 'qa', name: 'builder-3' },
      ],
      'insert into bots': [botRow({ id: 'bot-4', slot: 'builder-4', name: 'builder-4', container: 'bot-builder-4', github_login: null })],
    });

    const bot = await addSeat(builder);

    expect(bot).toMatchObject({ slot: 'builder-4', name: 'builder-4', githubLogin: null });
    expect(calls[0]?.sql).toBe('lock table bots in share row exclusive mode');
    const insert = calls.find((call) => call.sql.startsWith('insert into bots'));
    // Named after the prefix hostd recorded on its host, or `bot-`.
    expect(insert?.sql).toContain('where b.host_id is not distinct from $6');
    // A recorded prefix wins over a row still holding the seed's `bot-<name>`.
    expect(insert?.sql).toContain("order by (b.container <> 'bot-' || b.name) desc, b.updated_at desc");
    expect(insert?.sql).toContain("'bot-') || $1");
    expect(insert?.params).toEqual(['builder-4', 'Builder', 'implement', 'claude', 'claude-sonnet-5', 'host-1', ['implement'], true, 'builder']);
    // Sized like the seat it was added beside, not on the column's defaults.
    expect(insert?.sql).toContain('coalesce((select cpus from bots where slot = $9), 2)');
    expect(insert?.sql).toContain('coalesce((select memory_gb from bots where slot = $9), 4)');
    expect(calls.at(-1)?.params).toEqual([
      'janedoe',
      'bot.seat_added',
      'builder-4',
      JSON.stringify({ like: 'builder', role: 'implement', engine: 'claude', model: 'claude-sonnet-5' }),
    ]);
  });

  const seat = botRow({ id: 'bot-2', slot: 'builder-2', name: 'builder-2', github_login: null });
  const facts = (extra: Record<string, unknown> = {}) => ({ unfinished: '0', spent: '0', owns: null, others: '1', leased: null, ...extra });

  it('removes a seat nothing depends on, and says who removed it', async () => {
    const calls = transaction({ 'select id,': [seat], 'select (select count(*)': [facts()] });

    const removed = await removeSeat({ id: 'bot-2', actor: 'janedoe' });

    expect(removed.slot).toBe('builder-2');
    expect(calls.some((call) => call.sql === 'delete from bots where id = $1')).toBe(true);
    expect(calls.at(-1)?.params).toEqual([
      'janedoe',
      'bot.seat_removed',
      'builder-2',
      JSON.stringify({ name: 'builder-2', role: 'implement' }),
    ]);
  });

  it.each([
    [{ unfinished: '1' }, 'has a task that has not ended'],
    // Leased to the seat before it was on an account, and its task failed at
    // once: nothing unfinished, nothing spent, and the lease's path claim
    // would go with the row.
    [{ leased: 'infra#12' }, 'holds the lease on infra#12; release it or let it expire'],
    [{ owns: 'infra' }, 'owns infra; make another bot the owner first'],
    [{ others: '0' }, 'is the only bot with its role'],
    // The ledger's rows go with the bot's, and the month's cap is counted from them.
    [{ spent: '3' }, 'so it stays; pause it on the Crew page'],
  ])('keeps a seat when %o, and says why', async (found, reason) => {
    const calls = transaction({ 'select id,': [seat], 'select (select count(*)': [facts(found)] });

    const refused = removeSeat({ id: 'bot-2', actor: 'janedoe' });

    await expect(refused).rejects.toBeInstanceOf(SeatRefused);
    await expect(refused).rejects.toThrow(reason);
    expect(calls.some((call) => call.sql.startsWith('delete from bots'))).toBe(false);
  });

  it('answers 404 for a seat that is not there', async () => {
    transaction({});
    await expect(removeSeat({ id: 'gone', actor: 'janedoe' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('moving a seat off its account while it works', () => {
  const seat = botRow({ id: 'bot-2', slot: 'builder-2', name: 'builder-2' });

  it.each([
    [{ unfinished: '1', leased: null }, 'builder-2 has a task that has not ended; stop it or let it finish, then move it'],
    [{ unfinished: '0', leased: 'infra#12' }, 'builder-2 holds the lease on infra#12; release it or let it expire, then move it'],
  ])('refuses when %o, ending with what to do', async (found, reason) => {
    vi.mocked(queryOne).mockResolvedValue(seat as never);
    vi.mocked(query).mockResolvedValue([found] as never);

    const refusal = await seatWorkRefusal('bot-2', 'move it');

    expect(refusal).toBeInstanceOf(SeatRefused);
    expect(refusal?.message).toBe(reason);
    expect(refusal?.status).toBe(409);
  });

  it('allows a seat with nothing in flight, whatever it owns or has spent', async () => {
    // Owning a repository or having spent is a reason to keep a seat, not to
    // keep it on one account.
    vi.mocked(queryOne).mockResolvedValue(seat as never);
    vi.mocked(query).mockResolvedValue([{ unfinished: '0', leased: null }] as never);

    expect(await seatWorkRefusal('bot-2', 'move it')).toBeNull();
    expect(vi.mocked(query).mock.calls[0]?.[0]).not.toContain('ledger');
  });
});

describe('a crew member’s color and avatar', () => {
  it('stores a color from the palette, leaving the avatar as it is, and reads it back', async () => {
    vi.mocked(queryOne).mockResolvedValue(botRow({ color: 'rose' }));
    const bot = await setAppearance('bot-1', { color: 'rose' });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['bot-1', true, 'rose', false, null]);
    expect(bot?.color).toBe('rose');
  });

  it('goes back to the role’s tint and the engine’s mark as null', async () => {
    vi.mocked(queryOne).mockResolvedValue(botRow({ color: null, avatar: null }));
    const bot = await setAppearance('bot-1', { color: null, avatar: null });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['bot-1', true, null, true, null]);
    expect(bot?.color).toBeNull();
    expect(bot?.avatar).toBeNull();
  });

  it('writes both in one statement, so a request never stores half of it', async () => {
    vi.mocked(queryOne).mockResolvedValue(botRow({ color: 'sky', avatar: 'initials' }));
    const bot = await setAppearance('bot-1', { color: 'sky', avatar: 'initials' });
    expect(vi.mocked(queryOne)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/color = case when \$2 then \$3 else color end,\s*avatar = case when \$4 then \$5 else avatar end/);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['bot-1', true, 'sky', true, 'initials']);
    expect([bot?.color, bot?.avatar]).toEqual(['sky', 'initials']);
  });

  it('refuses a name it cannot draw, or a change that names neither, before anything is written', async () => {
    await expect(setAppearance('bot-1', { color: 'chartreuse' as never })).rejects.toThrow(/not a crew color/);
    await expect(setAppearance('bot-1', { color: 'rose', avatar: 'claude-logo' as never })).rejects.toThrow(/not an avatar/);
    await expect(setAppearance('bot-1', {})).rejects.toThrow(/say which/);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('reads a stored name the palette or this release no longer has as no choice', async () => {
    vi.mocked(queryOne).mockResolvedValue(botRow({ color: 'chartreuse', avatar: 'sparkles' }));
    const bot = await setAppearance('bot-1', { avatar: 'dots' });
    expect(bot?.color).toBeNull();
    expect(bot?.avatar).toBeNull();
  });
});
