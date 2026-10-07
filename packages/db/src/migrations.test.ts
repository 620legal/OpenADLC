import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSONA_SEATS, REPO_COLORS, seatForPersona } from '@fleetadlc/shared';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** One statement per entry, comments dropped and whitespace folded. */
function statements(file: string): string[] {
  return readFileSync(join(migrations, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

describe('the migrations, which `migrate.ts` applies in name order', () => {
  it('are each named by a four-digit number no other shares, so that order is the numbers’', () => {
    const files = readdirSync(migrations).filter((file) => file.endsWith('.sql'));
    for (const file of files) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((file) => file.slice(0, 4));
    expect(numbers.filter((number, index) => numbers.indexOf(number) !== index)).toEqual([]);
  });
});

describe('0008, on an install that already has rows', () => {
  const sql = statements('0008_model_assignment.sql');

  it('checks new ledger rows for an alias without validating old ones', () => {
    // `migrate` runs inside `fleetadlc up`. A row that recorded `newest:` before the
    // check existed would otherwise fail the migration, and the install with it.
    const check = sql.find((statement) => statement.includes('add constraint ledger_model_resolved'));
    expect(check).toBeDefined();
    expect(check).toMatch(/not valid$/);
  });

  it('adds the column that says a model came from the console', () => {
    expect(sql).toContain('alter table bots add column if not exists model_set_at timestamptz');
  });
});

describe('0035, a computer per task and tasks at once per seat', () => {
  const sql = statements('0035_task_computers.sql');

  it('adds every column without failing on an install that has them', () => {
    for (const column of [
      'alter table tasks add column if not exists container text',
      'alter table hosts add column if not exists capacity_tasks int not null default 4',
      'alter table bots add column if not exists max_tasks int not null default 1',
      'alter table bots add column if not exists cpus numeric not null default 2',
      'alter table bots add column if not exists memory_gb numeric not null default 4',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql.find((statement) => statement.startsWith('alter table tasks add column if not exists host_id uuid'))).toBeDefined();
    expect(sql).toContain('alter table bots add constraint bots_max_tasks_range check (max_tasks between 1 and 16)');
  });

  it('settles a seat running one subject twice before it builds the index that forbids it', () => {
    // An index that cannot be built fails the migration, and `fleetadlc up`.
    const settle = sql.findIndex((statement) => statement.startsWith('update tasks set state = \'stopped\''));
    const index = sql.findIndex((statement) => statement.startsWith('create unique index if not exists tasks_one_live_per_bot_subject'));
    expect(settle).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(settle);
    expect(sql[index]).toContain("on tasks (bot_id, subject_ref) where state in ('queued', 'running')");
  });
});

describe('0010, which gives every bot a seat', () => {
  const sql = statements('0010_bot_slots.sql');
  const text = sql.join(';\n');

  it('maps each persona onto the seat the shared table and config/bots.yaml use', () => {
    // Two copies of one table: this migration's, which runs once, and the one
    // a restore and an old setting are read with. They must say the same.
    const mapped = Object.fromEntries(
      [...text.matchAll(/when name = '([a-z]+)' then '([a-z-]+)'/g)].map((match) => [match[1], match[2]]),
    );
    expect(mapped).toEqual(PERSONA_SEATS);
    expect(text).toContain("when name ~ '^atlas-[0-9]+$' then 'builder-' || substr(name, 7)");
    expect(seatForPersona('atlas-12')).toBe('builder-12');
  });

  it('keeps every name it does not know as a seat of its own, and lets no two rows share one', () => {
    expect(text).toContain('else name end as slot');
    // Two rows wanting one seat keep their own names instead of failing the
    // unique index, and `fleetadlc up` with it.
    expect(text).toContain('having count(*) > 1');
    expect(text).toContain('set slot = case when wanted.slot in (select slot from contested) then bots.name else wanted.slot end');
  });

  it('fills the column before it requires it, and renames nobody', () => {
    const order = [
      'alter table bots add column if not exists slot text',
      'alter table bots alter column slot set not null',
      'alter table bots add constraint bots_slot_key unique (slot)',
    ].map((statement) => sql.findIndex((candidate) => candidate === statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sql.findIndex((candidate) => candidate.startsWith('with wanted as'))).toBeLessThan(order[1] ?? -1);
    // SQL cannot move a secret or a container. The bridge renames.
    expect(text).not.toMatch(/set name =/);
  });

  it('adds the mark an unfinished rename is found by', () => {
    expect(sql).toContain('alter table bots add column if not exists renamed_from text');
  });
});

describe('0012, which gives every repository a colour and lets one be removed', () => {
  const sql = statements('0012_repo_color_and_removal.sql');
  const text = sql.join(';\n');

  it('adds the two columns without failing on an install that has them', () => {
    expect(sql).toContain('alter table repos add column if not exists color text');
    expect(sql).toContain('alter table repos add column if not exists removed_at timestamptz');
  });

  it('colours the repositories already here from the palette the console draws, in the order they were added', () => {
    // Two copies of one list: this migration's, which runs once, and the one a
    // repository added from now on is given its colour from.
    const palette = /array\[([^\]]+)\]/.exec(text)?.[1]?.split(',').map((entry) => entry.trim().replace(/'/g, ''));
    expect(palette).toEqual([...REPO_COLORS]);
    expect(text).toContain('row_number() over (order by created_at, name) as position');
    expect(text).toContain(`[((ordered.position - 1) % ${REPO_COLORS.length}) + 1]`);
  });

  it('fills the column before it requires it, and deletes nothing', () => {
    const backfill = sql.findIndex((statement) => statement.startsWith('with ordered as'));
    const required = sql.indexOf('alter table repos alter column color set not null');
    expect(backfill).toBeGreaterThan(-1);
    expect(required).toBeGreaterThan(backfill);
    expect(text).not.toMatch(/\bdelete\b|\bdrop\b/);
  });
});

describe('0031, which records every stage move', () => {
  const sql = statements('0031_stage_moves.sql');
  const text = sql.join(';\n');

  it('keeps the move, how it was made, who made it and why', () => {
    const table = sql.find((statement) => statement.startsWith('create table if not exists stage_moves'));
    expect(table).toBeDefined();
    for (const column of ['repo_id', 'issue_number', 'pr_number', 'from_stage', 'to_stage', 'actor', 'task_id', 'reason', 'comment_url', 'created_at']) {
      expect(table).toContain(column);
    }
    expect(table).toContain("kind text not null check (kind in ('forward', 'send_back', 'person'))");
    expect(text).not.toMatch(/\bdrop\b/);
  });
});

describe('0032, which records the checks hostd ran on a head', () => {
  const sql = statements('0032_local_ci_runs.sql');

  it('keeps one row per hostd run, by repository and commit', () => {
    const table = sql.find((statement) => statement.startsWith('create table if not exists local_ci_runs'));
    expect(table).toBeDefined();
    expect(table).toContain('run_id text not null unique');
    for (const column of ['task_id', 'repo_id', 'branch', 'head_sha', 'ok', 'exit_code', 'duration_ms', 'log_tail', 'created_at']) {
      expect(table).toContain(column);
    }
    expect(sql).toContain('create index if not exists local_ci_runs_head on local_ci_runs (repo_id, head_sha, created_at)');
  });
});

describe('0033, where a repository says how it ships', () => {
  const sql = statements('0033_repo_delivery.sql');

  it('adds the rules and the testing URL as columns that start empty', () => {
    expect(sql).toContain('alter table repos add column if not exists delivery_rules jsonb');
    expect(sql).toContain('alter table repos add column if not exists testing_url text');
    expect(sql.join(';\n')).not.toMatch(/\bdrop\b|not null/);
  });
});

describe('0034, which records what the deploy pipeline did with each merged commit', () => {
  const sql = statements('0034_deploy_runs.sql');

  it('keeps one row per commit in a repository, with each step once', () => {
    const table = sql.find((statement) => statement.startsWith('create table if not exists deploy_runs'));
    expect(table).toBeDefined();
    expect(table).toContain('unique (repo_id, sha)');
    for (const column of [
      'testing_dispatched_at',
      'smoke_conclusion',
      'promote_after',
      'promote_dispatched_at',
      'production_conclusion',
      'rollback_dispatched_at',
      'sent_back_at',
    ]) {
      expect(table).toContain(column);
    }
  });
});

describe('0040, which checks what the ledger and a task are charged', () => {
  const sql = statements('0040_ledger_amounts_checked.sql');

  it('refuses a negative or NaN cost, and negative tokens, on new rows without validating old ones', () => {
    // A session reported -1000 and "NaN" and the ledger took both. An install
    // that already holds such a row still has to migrate inside `fleetadlc up`.
    for (const name of ['ledger_cost_counted', 'ledger_tokens_counted', 'tasks_cost_counted']) {
      const check = sql.find((statement) => statement.includes(`add constraint ${name}`));
      expect(check, name).toBeDefined();
      expect(check, name).toMatch(/not valid$/);
    }
    expect(sql.find((statement) => statement.includes('add constraint ledger_cost_counted'))).toContain("cost_usd >= 0 and cost_usd <> 'nan'");
    expect(sql.find((statement) => statement.includes('add constraint tasks_cost_counted'))).toContain("cost_usd >= 0 and cost_usd <> 'nan'");
    expect(sql.find((statement) => statement.includes('add constraint ledger_tokens_counted'))).toContain('tokens_in >= 0 and tokens_out >= 0');
  });
});

describe('0041, which keeps the text a person vouched for on a stranger’s issue', () => {
  const sql = statements('0041_issue_vouched_text.sql');

  it('adds each column without failing on an install that has it, and fills none in', () => {
    for (const column of ['vouched_title text', 'vouched_body text', 'vouched_by text', 'vouched_at timestamptz']) {
      expect(sql).toContain(`alter table issues add column if not exists ${column}`);
    }
    expect(sql.some((statement) => statement.startsWith('update'))).toBe(false);
  });

  it('comes after 0040, so it runs after every migration it may follow', () => {
    const files = readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files.indexOf('0041_issue_vouched_text.sql')).toBe(files.indexOf('0040_ledger_amounts_checked.sql') + 1);
  });
});

describe('0046, which holds a promote for a person where GitHub cannot hold a production reviewer', () => {
  const sql = statements('0046_promote_held.sql');

  it('adds when it was held and who released it, without failing on an install that has them', () => {
    expect(sql).toContain('alter table deploy_runs add column if not exists promote_held_at timestamptz');
    expect(sql).toContain('alter table deploy_runs add column if not exists promote_released_by text');
  });

  it('finds what is held and not yet dispatched by an index of its own', () => {
    expect(sql).toContain(
      'create index if not exists deploy_runs_promote_held on deploy_runs (promote_held_at) where promote_held_at is not null and promote_dispatched_at is null',
    );
  });
});

describe('0047, which records how each repository’s production ships', () => {
  const sql = statements('0047_repo_production_choice.sql');

  it('adds the choice as columns a repository added later starts without', () => {
    expect(sql).toContain("alter table repos add column if not exists production_approval text check (production_approval in ('auto', 'reviewers'))");
    expect(sql).toContain('alter table repos add column if not exists production_soak_minutes integer');
    expect(sql).toContain("alter table repos add column if not exists production_reviewers text[] not null default '{}'");
  });

  it('keeps every repository already here on reviewers with no soak, as the old default was', () => {
    expect(sql).toContain("update repos set production_approval = 'reviewers', production_soak_minutes = 0 where production_approval is null");
    // Once the columns are there, before anything reads them.
    const update = sql.findIndex((statement) => statement.startsWith('update repos'));
    expect(update).toBeGreaterThan(sql.findIndex((statement) => statement.includes('production_soak_minutes integer')));
  });
});

describe('0077, which keeps which issue a stacked issue was built on', () => {
  const sql = statements('0077_stacks.sql');

  it('keeps one row per stacked issue, with no window, and a hold once per stacking', () => {
    const table = sql.find((statement) => statement.startsWith('create table if not exists stacks'));
    expect(table).toBeDefined();
    expect(table).toContain('primary key (repo_id, issue_number)');
    for (const column of ['on_issue', 'on_pr', 'on_branch', 'on_head_sha', 'started_at', 'paused_at']) expect(table).toContain(column);
  });

  it('backfills the stacks started before it from their events, and can be run again', () => {
    const backfill = sql.find((statement) => statement.startsWith('insert into stacks'));
    expect(backfill).toContain("where e.type = 'stack.started'");
    expect(backfill).toContain("p.type = 'stack.paused'");
    expect(backfill).toMatch(/on conflict do nothing$/);
  });
});

describe('0134, which indexes the events table', () => {
  const sql = statements('0134_events_indexes.sql');

  it('indexes events by type and by source, each over time, without failing on an install that has them', () => {
    expect(sql).toEqual([
      'create index if not exists events_type_at on events (type, at)',
      'create index if not exists events_source_at on events (source, at)',
    ]);
  });
});

describe('0144, which keeps each request’s eight-character subject its own', () => {
  const sql = statements('0144_request_id8_unique.sql');

  it('marks the requests already sharing a prefix before it builds the index that forbids one, and leaves them out of it', () => {
    // An index that cannot be built fails the migration, and `fleetadlc up`.
    expect(sql).toContain('alter table requests add column if not exists id8_shared boolean not null default false');
    const mark = sql.findIndex((statement) => statement.startsWith('update requests set id8_shared = true'));
    const index = sql.findIndex((statement) => statement.startsWith('create unique index if not exists requests_id8'));
    expect(mark).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(mark);
    // Every row but the oldest of each prefix: the oldest stays in the index,
    // so a new request sharing either's prefix is still refused.
    expect(sql[mark]).toContain('partition by left(id::text, 8) order by created_at, id');
    expect(sql[mark]).toContain('where prefixed.nth > 1');
    expect(sql[index]).toBe('create unique index if not exists requests_id8 on requests (left(id::text, 8)) where not id8_shared');
  });

  it('changes no request’s id, which its tasks, threads and gates name it by', () => {
    expect(sql.filter((statement) => /set id\b|set id =/.test(statement))).toEqual([]);
  });
});
