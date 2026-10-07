import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '@fleetadlc/shared';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

import { queryOne } from '../client.js';
import { writeCrew } from './seed-crew.js';

const SET_AT = new Date('2026-09-23T12:00:00.000Z');
const SEAT = '550e8400-e29b-41d4-a716-446655440000';

/** The statement the seed wrote each bot with, whitespace folded. */
function upsertSql(): string {
  const insert = vi.mocked(queryOne).mock.calls.find((call) => String(call[0]).includes('insert into bots'));
  return String(insert?.[0] ?? '').replace(/\s+/g, ' ');
}

function configured(partial: Partial<BotConfig> = {}): BotConfig {
  return {
    slot: 'lead-reviewer',
    displayName: 'Lead reviewer',
    role: 'review_lead',
    engine: 'claude',
    model: 'claude-sonnet-5',
    skills: [],
    cpus: 1,
    memoryGb: 2,
    sidecarDb: false,
    ...partial,
  };
}

function row(extra: Record<string, unknown>) {
  return {
    id: 'bot-1',
    name: 'lead-reviewer',
    slot: 'lead-reviewer',
    display_name: 'Lead reviewer',
    role: 'review_lead',
    engine: 'claude',
    model: 'claude-sonnet-5',
    github_login: null,
    host_id: null,
    container: 'bot-lead-reviewer',
    status: 'stopped',
    skills: [],
    sidecar_db: false,
    model_account_id: null,
    model_set_at: null,
    ...extra,
  };
}

/** The row the seed finds, and the values it writes back. */
function database(existing: Record<string, unknown> | null) {
  vi.mocked(queryOne).mockImplementation(async (sql, params) => {
    if (String(sql).includes('insert into bots')) {
      const values = params as unknown[];
      return row({ engine: values[3], model: values[4] });
    }
    return existing ? row(existing) : null;
  });
  return () => {
    const insert = vi.mocked(queryOne).mock.calls.find((call) => String(call[0]).includes('insert into bots'));
    const values = (insert?.[1] ?? []) as unknown[];
    return { slot: values[0], engine: values[3], model: values[4] };
  };
}

beforeEach(() => {
  vi.mocked(queryOne).mockReset();
});

describe('what `fleetadlc up` writes for each configured bot', () => {
  it('finds a connected bot by its seat, not by the handle it now goes by', async () => {
    // The builder connected as fleetadlc-atlas-janedoe and took that name. A seed
    // that looked for `builder` by name found nothing and added a second one.
    const written = database({ name: 'fleetadlc-atlas-janedoe', slot: 'builder', github_login: 'fleetadlc-atlas-janedoe' });

    await writeCrew([configured({ slot: 'builder', role: 'implement' })], 'host-1');

    const lookup = vi.mocked(queryOne).mock.calls[0];
    expect(String(lookup?.[0])).toContain('where slot = $1');
    expect(lookup?.[1]).toEqual(['builder']);
    expect(written().slot).toBe('builder');
    expect(upsertSql()).toContain('on conflict (slot) do update set');
  });

  it('writes no account for any bot', async () => {
    // config/bots.yaml names none, and the seed has nowhere to take one from.
    database(null);

    await writeCrew([configured()], 'host-1');

    expect(upsertSql().slice(0, upsertSql().indexOf('returning'))).not.toContain('github_login');
  });

  it('moves a bot to the engine and model the file now names', async () => {
    // The file said grok, the row says grok-4, and nobody touched the console.
    // Keeping the row's model on reseed produced engine claude, model grok-4.
    const written = database({ engine: 'grok', model: 'grok-4' });

    await writeCrew([configured({ engine: 'claude', model: 'claude-sonnet-5' })], 'host-1');

    expect(written()).toMatchObject({ engine: 'claude', model: 'claude-sonnet-5' });
  });

  it('applies a new model from the file to a bot nobody assigned', async () => {
    const written = database({ model: 'claude-sonnet-5', model_set_at: null });

    await writeCrew([configured({ model: 'claude-opus-5' })], 'host-1');

    expect(written().model).toBe('claude-opus-5');
  });

  it('leaves a model the console set, on the engine it was set for', async () => {
    const written = database({ model: 'newest:opus', model_set_at: SET_AT });

    await writeCrew([configured({ model: 'claude-sonnet-5' })], 'host-1');

    expect(written().model).toBe('newest:opus');
  });

  it('keeps a console assignment to another provider’s account — engine, model and account — over the file', async () => {
    // The second reviewer, configured for grok, put on a Claude seat in the
    // console. The file still says grok; the restart must not put it back.
    const written = database({
      engine: 'claude',
      model: 'newest:opus',
      model_account_id: SEAT,
      model_set_at: SET_AT,
    });

    await writeCrew([configured({ engine: 'grok', model: 'grok-4' })], 'host-1');

    expect(written()).toMatchObject({ engine: 'claude', model: 'newest:opus' });
    // The row keeps its account because the engine it is written with is the
    // one that account was chosen for: that is the upsert's rule, and the
    // engine above is what makes it hold.
    expect(upsertSql()).toContain(
      'model_account_id = case when bots.engine = excluded.engine then bots.model_account_id end',
    );
    expect(upsertSql()).toContain(
      'model_set_at = case when bots.model = excluded.model and bots.engine = excluded.engine then bots.model_set_at end',
    );
  });

  it('moves a bot nobody assigned to the engine and model the file names, beside one that was assigned', async () => {
    // One `fleetadlc up`, two bots: the console's choice stays on one, the file's
    // edit reaches the other.
    const rows: Record<string, Record<string, unknown>> = {
      'lead-reviewer': {
        name: 'tessexampleco',
        slot: 'lead-reviewer',
        engine: 'claude',
        model: 'claude-opus-5-5',
        model_account_id: SEAT,
        model_set_at: SET_AT,
      },
      'security-reviewer': { slot: 'security-reviewer', engine: 'codex', model: 'gpt-5-codex', model_set_at: null },
    };
    vi.mocked(queryOne).mockImplementation(async (sql, params) => {
      const values = params as unknown[];
      if (String(sql).includes('insert into bots')) {
        return row({ slot: values[0], engine: values[3], model: values[4] });
      }
      const found = rows[String(values[0])];
      return found ? row(found) : null;
    });

    await writeCrew(
      [
        configured({ slot: 'lead-reviewer', engine: 'grok', model: 'grok-4' }),
        configured({ slot: 'security-reviewer', engine: 'grok', model: 'grok-4.7' }),
      ],
      'host-1',
    );

    const writes = vi
      .mocked(queryOne)
      .mock.calls.filter((call) => String(call[0]).includes('insert into bots'))
      .map((call) => (call[1] as unknown[]).slice(0, 5));
    expect(writes.map(([slot, , , engine, model]) => ({ slot, engine, model }))).toEqual([
      { slot: 'lead-reviewer', engine: 'claude', model: 'claude-opus-5-5' },
      { slot: 'security-reviewer', engine: 'grok', model: 'grok-4.7' },
    ]);
  });

  it('writes every other seat when one cannot be written, and says which', async () => {
    // A seat whose name another bot already goes by — an account whose handle
    // is `qa`, connected to another seat — is a unique violation on insert.
    // It must not keep the rest of the crew from being seeded.
    vi.mocked(queryOne).mockImplementation(async (sql, params) => {
      const values = params as unknown[];
      if (String(sql).includes('insert into bots')) {
        if (values[0] === 'qa') throw new Error('duplicate key value violates unique constraint "bots_name_key"');
        return row({ slot: values[0] });
      }
      return null;
    });

    const refused = await writeCrew([configured({ slot: 'qa', role: 'qa' }), configured({ slot: 'sre', role: 'deploy' })], 'host-1');

    expect(refused).toEqual([{ slot: 'qa', reason: expect.stringContaining('bots_name_key') }]);
    const written = vi
      .mocked(queryOne)
      .mock.calls.filter((call) => String(call[0]).includes('insert into bots'))
      .map((call) => (call[1] as unknown[])[0]);
    expect(written).toEqual(['qa', 'sre']);
  });

  it('writes what each task computer is given, and tasks at once only when the file names it', async () => {
    // cpus and memoryGb were parsed and never stored: every container got the
    // driver's two CPUs and 4 GB, whatever this file said.
    database(null);

    await writeCrew([configured({ cpus: 2, memoryGb: 6 }), configured({ slot: 'builder', maxTasks: 3 })], 'host-1');

    const sizes = vi
      .mocked(queryOne)
      .mock.calls.filter((call) => String(call[0]).includes('insert into bots'))
      .map((call) => (call[1] as unknown[]).slice(8));
    // Left out, a person's Crew → "tasks at once" is kept: null is "keep".
    expect(sizes).toEqual([
      [2, 6, null],
      [1, 2, 3],
    ]);
  });

  it('is what the seed runs for the crew', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed.ts'), 'utf8');
    expect(source).toContain('await writeCrew(crew, host.id);');
    // Nothing else in the seed writes a bot, so nothing else can choose a model.
    expect(source).not.toContain('seedBot(');
    expect(source).not.toContain('upsertBot(');
  });
});
