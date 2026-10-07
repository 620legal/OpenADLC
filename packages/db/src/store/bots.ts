import { isAvatar, isCrewColor, MAX_TASKS_PER_SEAT, nextSeat, type Avatar, type Bot, type BotRole, type CrewColor, type EngineName } from '@fleetadlc/shared';
import { query, queryOne, withTransaction } from '../client.js';
import { ModelAccountNotFound, get as getModelAccount } from './modelAccounts.js';

/** A console write that cannot be stored: no model, or an account on a bot that has none. */
export class AssignmentRefused extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AssignmentRefused';
  }
}

/**
 * What `fleetadlc up` writes back for the fields a person can change from the
 * console.
 *
 * The configuration is the fresh-install default. An assignment made in the
 * console stays whole: its engine and its model here, and its account in
 * `seedBot`, whatever config/bots.yaml says. The account decides the engine —
 * a bot given an xAI account runs grok — so keeping the console's model and
 * taking the file's engine would pair a grok model with claude, and keeping
 * the file's engine would hand grok's account to claude. `bots.model` is never
 * null, so "a row exists" cannot mean "somebody chose this": `model_set_at`
 * does. A bot nobody assigned takes the file's engine and model, so a YAML
 * edit still reaches it.
 *
 * A bot that does not think has no choice to keep. The automation bot's only
 * model is `none`, and a file that moves a bot to or from `engine: none`
 * changes what the bot is, not which model it runs, so the file wins there —
 * and the automation bot is never held at `none` by a console save.
 *
 * Which account a bot is, is not here at all. The file names none, and the
 * seed never writes one: a login is what connecting writes, and the name
 * follows it.
 */
export function keptOnReseed(
  existing: { engine: EngineName; model: string; modelSetAt: string | null } | null,
  configured: { engine: EngineName; model: string },
): { engine: EngineName; model: string } {
  const chosen =
    existing && existing.modelSetAt && existing.engine !== 'none' && configured.engine !== 'none' ? existing : null;
  return {
    engine: chosen ? chosen.engine : configured.engine,
    model: chosen ? chosen.model : configured.model,
  };
}

interface BotRow {
  id: string;
  name: string;
  slot: string;
  display_name: string;
  role: BotRole;
  engine: EngineName;
  model: string;
  github_login: string | null;
  host_id: string | null;
  container: string;
  status: Bot['status'];
  skills: string[];
  sidecar_db: boolean;
  model_account_id: string | null;
  model_set_at: Date | null;
  color: string | null;
  avatar: string | null;
  max_tasks: number;
  /** `numeric`, which the driver hands back as text. */
  cpus: string;
  memory_gb: string;
}

const COLUMNS = `id, name, slot, display_name, role, engine, model, github_login,
         host_id, container, status, skills, sidecar_db, model_account_id, model_set_at, color, avatar,
         max_tasks, cpus, memory_gb`;

const SELECT = `
  select ${COLUMNS}
  from bots
`;

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    slot: row.slot,
    displayName: row.display_name,
    role: row.role,
    engine: row.engine,
    model: row.model,
    githubLogin: row.github_login,
    hostId: row.host_id,
    container: row.container,
    status: row.status,
    skills: row.skills,
    sidecarDb: row.sidecar_db,
    modelAccountId: row.model_account_id,
    modelSetAt: row.model_set_at ? row.model_set_at.toISOString() : null,
    // A name the palette no longer has reads as no choice, so the avatar is
    // drawn in its role's tint rather than in nothing.
    color: isCrewColor(row.color) ? row.color : null,
    // Likewise an avatar: one this release does not draw reads as no choice,
    // so the engine's mark is drawn.
    avatar: isAvatar(row.avatar) ? row.avatar : null,
    // Absent on a row read by a query that does not name them; the readers
    // take absent as the defaults (`maxTasksOf`, the driver's own sizes).
    ...(row.max_tasks == null ? {} : { maxTasks: row.max_tasks }),
    ...(row.cpus == null ? {} : { cpus: Number(row.cpus) }),
    ...(row.memory_gb == null ? {} : { memoryGb: Number(row.memory_gb) }),
  };
}

export async function listBots(): Promise<Bot[]> {
  const rows = await query<BotRow>(`${SELECT} order by name`);
  return rows.map(toBot);
}

export async function getBotByName(name: string): Promise<Bot | null> {
  const row = await queryOne<BotRow>(`${SELECT} where name = $1`, [name]);
  return row ? toBot(row) : null;
}

export async function getBotById(id: string): Promise<Bot | null> {
  const row = await queryOne<BotRow>(`${SELECT} where id = $1`, [id]);
  return row ? toBot(row) : null;
}

/** The bot in a seat, whatever it is called now. */
export async function getBotBySlot(slot: string): Promise<Bot | null> {
  const row = await queryOne<BotRow>(`${SELECT} where slot = $1`, [slot]);
  return row ? toBot(row) : null;
}

/**
 * The prefix a host's bots' containers carry, read from `bots.container`.
 * That column is the seat's legacy container name: the seed's `bot-<name>`, or
 * what hostd wrote before each task had a computer of its own. hostd no longer
 * writes it (a task's computer is `tasks.container`), so another prefix comes
 * only from a row an earlier hostd wrote. Such a prefix wins over `bot-`, and
 * the newest row wins among the rest; `bot-` when no row ends in its name.
 */
const CONTAINER_PREFIX_ON_HOST = (hostParam: string) =>
  `coalesce((select left(b.container, length(b.container) - length(b.name)) from bots b
              where b.host_id is not distinct from ${hostParam} and right(b.container, length(b.name)) = b.name
              order by (b.container <> 'bot-' || b.name) desc, b.updated_at desc limit 1), 'bot-')`;

/**
 * Seeds a seat from configuration: what `fleetadlc up` writes for each entry in
 * config/bots.yaml.
 *
 * Found by the seat, never by the name. A new seat's row is named after the
 * seat, with a container to match and no account. An existing row keeps its
 * name, its container and its login — a connected bot is its account's
 * handle, and the file has no say in that — and takes everything else the
 * file describes.
 *
 * `engine` and `model` are updated to whatever the caller passes. `fleetadlc up`
 * passes `keptOnReseed`, so a console assignment's engine and model are what
 * come back in, and the YAML does not replace them. `model_set_at` stays only
 * while the model and the engine are the ones the console chose; anything else
 * means the model now came from here. `model_account_id` stays while the
 * engine does, which is how a console assignment keeps its account through
 * `fleetadlc up`: the seed writes that assignment's engine back, and the account
 * is the one that engine was chosen for. A new engine is a new provider, and
 * an account for the old one would hand the engine a key it cannot use.
 *
 * `cpus` and `memoryGb` are the file's, every time: what a task's computer is
 * given. `maxTasks` is the file's only when it names one; left out, a new
 * seat runs one task at a time and an existing one keeps what a person set
 * in Crew → "tasks at once".
 */
export async function seedBot(input: {
  slot: string;
  displayName: string;
  role: BotRole;
  engine: EngineName;
  model: string;
  hostId: string | null;
  skills: string[];
  sidecarDb: boolean;
  cpus?: number;
  memoryGb?: number;
  maxTasks?: number | null;
}): Promise<Bot> {
  const row = await queryOne<BotRow>(
    `insert into bots (slot, name, display_name, role, engine, model, container, host_id, skills, sidecar_db,
                       cpus, memory_gb, max_tasks)
     values ($1, $1, $2, $3, $4, $5, 'bot-' || $1, $6, $7, $8,
             coalesce($9::numeric, 2), coalesce($10::numeric, 4), coalesce($11::int, 1))
     on conflict (slot) do update set
       display_name = excluded.display_name,
       role = excluded.role,
       engine = excluded.engine,
       model = excluded.model,
       model_set_at = case
         when bots.model = excluded.model and bots.engine = excluded.engine then bots.model_set_at
       end,
       model_account_id = case when bots.engine = excluded.engine then bots.model_account_id end,
       host_id = excluded.host_id,
       skills = excluded.skills,
       sidecar_db = excluded.sidecar_db,
       cpus = coalesce($9::numeric, bots.cpus),
       memory_gb = coalesce($10::numeric, bots.memory_gb),
       max_tasks = coalesce($11::int, bots.max_tasks),
       updated_at = now()
     returning ${COLUMNS}`,
    [
      input.slot,
      input.displayName,
      input.role,
      input.engine,
      input.model,
      input.hostId,
      input.skills,
      input.sidecarDb,
      input.cpus ?? null,
      input.memoryGb ?? null,
      input.maxTasks ?? null,
    ],
  );
  if (!row) throw new Error(`failed to seed the ${input.slot} seat`);
  return toBot(row);
}

/** A seat that cannot be added, removed or moved, with the reason in words a person acts on. */
export class SeatRefused extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'SeatRefused';
  }
}

/**
 * Adds one more seat like `like` — `builder` gives `builder-2`, then
 * `builder-3` — while the install runs: what settings' "Add a builder" does.
 *
 * The row is what `seedBot` would write for a new entry in config/bots.yaml:
 * named after its seat, with a legacy container name to match and no account.
 * Nothing else is made here. hostd makes a computer for each task as it
 * starts (`tasks.container`), and the account is chosen on the crew table like
 * any other seat's.
 * `fleetadlc up` only ever adds and updates the seats the file names, so a seat
 * added here stays.
 *
 * The next free seat is worked out under a lock on the table, so two clicks
 * cannot both pick `builder-2`. A seat's name is a bot's name until an account
 * connects, and names are unique too, so a name some connected bot already
 * goes by is skipped as well.
 */
export async function addSeat(input: {
  like: string;
  displayName: string;
  role: BotRole;
  engine: EngineName;
  model: string;
  hostId: string | null;
  skills: string[];
  sidecarDb: boolean;
  actor: string;
}): Promise<Bot> {
  return withTransaction(async (client) => {
    await client.query('lock table bots in share row exclusive mode');
    const taken = (await client.query<{ slot: string; name: string }>('select slot, name from bots')).rows.flatMap(
      (row) => [row.slot, row.name],
    );
    const slot = nextSeat(input.like, taken);
    // The legacy container name, with the prefix the host's other rows carry
    // (`CONTAINER_PREFIX_ON_HOST`); `bot-` when none carries another.
    const inserted = await client.query<BotRow>(
      // Sized like the seat it was added beside: "Add a builder" is another
      // builder, and one on the column defaults had a smaller computer.
      `insert into bots (slot, name, display_name, role, engine, model, container, host_id, skills, sidecar_db, cpus, memory_gb)
       values ($1, $1, $2, $3, $4, $5, ${CONTAINER_PREFIX_ON_HOST('$6')} || $1, $6, $7, $8,
               coalesce((select cpus from bots where slot = $9), 2), coalesce((select memory_gb from bots where slot = $9), 4))
       returning ${COLUMNS}`,
      [slot, input.displayName, input.role, input.engine, input.model, input.hostId, input.skills, input.sidecarDb, input.like],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error(`failed to add the ${slot} seat`);
    await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
      input.actor,
      'bot.seat_added',
      slot,
      JSON.stringify({ like: input.like, role: input.role, engine: input.engine, model: input.model }),
    ]);
    return toBot(row);
  });
}

/**
 * Removes a seat added beside another of its role, when nothing depends on it.
 *
 * Refused while it has a task that has not ended, since hostd may be running
 * it; while it holds a lease, whose claim on its paths would go with the row;
 * while a repository names it as its owner; when it is the last bot of its
 * role; and once usage has been recorded against it. A bot's ledger rows are
 * deleted with its row, and they are what the month's cap is counted from, so
 * removing a seat that has spent would quietly raise what is left to spend. A
 * seat that has worked stays; pausing it on the Crew page is what stops work
 * being given to it.
 *
 * The refusals are decided again inside the transaction that deletes, with
 * the row locked, so a task started after the caller asked
 * `seatRemovalRefusal` cannot be lost with it. Ended tasks that recorded
 * nothing go with the row. Which account it was on is not touched here: the
 * caller takes the seat off its account first, and the account stays OpenADLC's.
 */
export async function removeSeat(input: { id: string; actor: string }): Promise<Bot> {
  return withTransaction(async (client) => {
    const found = await client.query<BotRow>(`select ${COLUMNS} from bots where id = $1 for update`, [input.id]);
    const row = found.rows[0];
    if (!row) throw new SeatRefused(`no bot ${input.id}`, 404);
    const refusal = await removalRefusal(row, async (sql, params) => (await client.query(sql, params)).rows);
    if (refusal) throw refusal;
    await client.query('delete from bots where id = $1', [input.id]);
    await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
      input.actor,
      'bot.seat_removed',
      row.slot,
      JSON.stringify({ name: row.name, role: row.role }),
    ]);
    return toBot(row);
  });
}

/**
 * Why a seat cannot be removed now, or null when it can: asked before the
 * seat is taken off its account, so a seat that is kept is not left
 * disconnected. `removeSeat` asks again as it deletes.
 */
export async function seatRemovalRefusal(id: string): Promise<SeatRefused | null> {
  const row = await queryOne<BotRow>(`${SELECT} where id = $1`, [id]);
  if (!row) return new SeatRefused(`no bot ${id}`, 404);
  return removalRefusal(row, (sql, params) => query(sql, params));
}

/**
 * Why a seat cannot be taken off its GitHub account now, or null when it can:
 * a task that has not ended, or a lease. Moving a busy seat off its account
 * took its credential and its login from the work in flight: its gate
 * questions went unposted, a resume started with no token, and a reviewer's
 * review was looked for under another login. `then` ends the message with
 * what to do once it is free.
 */
export async function seatWorkRefusal(id: string, then: string): Promise<SeatRefused | null> {
  const row = await queryOne<BotRow>(`${SELECT} where id = $1`, [id]);
  if (!row) return new SeatRefused(`no bot ${id}`, 404);
  return workRefusal(row, then, (sql, params) => query(sql, params));
}

async function workRefusal(
  row: Pick<BotRow, 'name' | 'id'>,
  then: string,
  select: (sql: string, params: unknown[]) => Promise<unknown[]>,
): Promise<SeatRefused | null> {
  const [facts] = (await select(
    `select
       (select count(*) from tasks where bot_id = $1 and state in ('queued', 'running', 'paused'))::text as unfinished,
       (select string_agg(coalesce(r.name, 'issue') || '#' || l.issue_number, ', ' order by l.issue_number)
          from leases l left join repos r on r.id = l.repo_id
         where l.bot_id = $1 and l.state in ('leased', 'in_task', 'paused')) as leased`,
    [row.id],
  )) as { unfinished: string; leased: string | null }[];
  if (Number(facts?.unfinished ?? 0) > 0) {
    return new SeatRefused(`${row.name} has a task that has not ended; stop it or let it finish, then ${then}`);
  }
  // A lease is deleted with its bot's row, and with it the claim on its
  // paths that keeps an overlapping issue from going out. One is held before
  // its task exists, and after a task that ended without spending anything.
  if (facts?.leased) {
    return new SeatRefused(`${row.name} holds the lease on ${facts.leased}; release it or let it expire, then ${then}`);
  }
  return null;
}

async function removalRefusal(
  row: Pick<BotRow, 'name' | 'role' | 'id'>,
  select: (sql: string, params: unknown[]) => Promise<unknown[]>,
): Promise<SeatRefused | null> {
  const working = await workRefusal(row, 'remove the seat', select);
  if (working) return working;
  const [facts] = (await select(
    `select
       (select count(*) from ledger where bot_id = $1)::text as spent,
       (select string_agg(name, ', ' order by name) from repos where owner_bot_id = $1 and removed_at is null) as owns,
       (select count(*) from bots where role = $2 and id <> $1)::text as others`,
    [row.id, row.role],
  )) as { spent: string; owns: string | null; others: string }[];
  if (facts?.owns) return new SeatRefused(`${row.name} owns ${facts.owns}; make another bot the owner first`);
  if (Number(facts?.others ?? 0) === 0) {
    return new SeatRefused(`${row.name} is the only bot with its role, and the crew needs one`);
  }
  if (Number(facts?.spent ?? 0) > 0) {
    return new SeatRefused(
      `${row.name} has usage recorded against it, which the month's cap is counted from, so it stays; pause it on the Crew page and nothing new is given to it`,
    );
  }
  return null;
}

/**
 * Which account a bot is, as GitHub said when it connected, or null when it
 * is not connected to one.
 *
 * Nothing else about the row changes: the name follows the login, and that is
 * a rename — containers, folders and secrets move with it — not a column.
 */
export async function setGithubLogin(botId: string, login: string | null): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('update bots set github_login = $2, updated_at = now() where id = $1', [botId, login]);
    if (!login) {
      await client.query('update bots set identity_id = null where id = $1', [botId]);
      return;
    }
    // The account is an identity (migration 0014). A bot that connects on its
    // own is filed under its own name, as its secrets always were; an identity
    // other seats already share keeps the name it has.
    const name = (await client.query<{ name: string }>('select name from bots where id = $1', [botId])).rows[0]?.name;
    if (!name) return;
    const existing = (
      await client.query<{ id: string; sharers: string }>(
        `select i.id, (select count(*) from bots b where b.identity_id = i.id and b.id <> $2)::text as sharers
         from github_identities i where lower(i.login) = lower($1)`,
        [login, botId],
      )
    ).rows[0];
    // Whatever else was filed under this bot's name belongs to an account it
    // no longer is, and nobody else signs in as it.
    await client.query(
      `delete from github_identities i
       where i.secret_ns = $1 and lower(i.login) <> lower($2)
         and not exists (select 1 from bots b where b.identity_id = i.id and b.id <> $3)`,
      [name, login, botId],
    );
    let identityId = existing?.id;
    if (!identityId) {
      identityId = (
        await client.query<{ id: string }>(
          'insert into github_identities (login, secret_ns) values ($1, $2) returning id',
          [login, name],
        )
      ).rows[0]?.id;
    } else if (existing && Number(existing.sharers) === 0) {
      await client.query('update github_identities set login = $2, secret_ns = $3, updated_at = now() where id = $1', [
        identityId,
        login,
        name,
      ]);
    }
    await client.query('update bots set identity_id = $2 where id = $1', [botId, identityId]);
  });
}

/**
 * Takes a login off every other bot that names it.
 *
 * Only for rows that hold no credential for it: the caller has already asked
 * whether another bot is connected as this account, and refused if one is. A
 * row that merely names it — an earlier install's, or a guess the old
 * configuration made — is stale, so it lets go before the bot that did
 * connect says which account it is.
 */
export async function releaseLogin(login: string, exceptBotId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `update bots set github_login = null, identity_id = null, updated_at = now()
     where lower(github_login) = lower($1) and id <> $2
     returning name`,
    [login, exceptBotId],
  );
  return rows.map((row) => row.name);
}

/**
 * Puts a seat on an account OpenADLC holds: the same identity, the same login.
 *
 * The identity it was on before is kept, even when no seat is left on it: an
 * account no bot uses is still an account OpenADLC holds, listed in settings and
 * put back on a seat from there. Forgetting one is its own act — Disconnect —
 * and never a side effect of moving a seat.
 */
export async function shareIdentity(botId: string, identityId: string): Promise<void> {
  await query(
    `update bots set identity_id = $2,
       github_login = (select login from github_identities where id = $2), updated_at = now()
     where id = $1`,
    [botId, identityId],
  );
}

/** Bots whose last rename stopped before every secret had moved. */
export async function unfinishedRenames(): Promise<{ id: string; name: string; renamedFrom: string }[]> {
  const rows = await query<{ id: string; name: string; renamed_from: string }>(
    'select id, name, renamed_from from bots where renamed_from is not null order by name',
  );
  return rows.map((row) => ({ id: row.id, name: row.name, renamedFrom: row.renamed_from }));
}

/**
 * The row's half of a rename, in one transaction: the name, the container
 * named after it, where the credential row says its secret is, and the audit
 * line. The sessions hostd observed belonged to the container that was just
 * removed, so they go too, as they do when a bot restarts.
 *
 * `renamed_from` is set here and cleared by `finishRename`, once the old
 * secret files are gone. Guarded on the name it expects to replace, so two
 * renames of one bot cannot both apply: the second finds nothing and says so.
 */
export async function renameBotRow(input: {
  id: string;
  from: string;
  to: string;
  actor: string;
  reason: string;
  /** The ref a credential row may point at, before and after, keyed by prefix. */
  secretRefs: { from: string; to: string }[];
}): Promise<Bot | null> {
  return withTransaction(async (client) => {
    const renamed = await client.query<BotRow>(
      // The legacy container name keeps its prefix (the seed's `bot-`, or one
      // an earlier hostd wrote); only the name after it changes.
      `update bots set name = $3,
         container = case when right(container, length($2)) = $2
                          then left(container, length(container) - length($2)) || $3
                          else 'bot-' || $3 end,
         renamed_from = $2, updated_at = now()
       where id = $1 and name = $2
       returning ${COLUMNS}`,
      [input.id, input.from, input.to],
    );
    const row = renamed.rows[0];
    if (!row) return null;

    for (const ref of input.secretRefs) {
      await client.query(
        'update bot_credentials set secret_ref = $3, updated_at = now() where bot_id = $1 and secret_ref = $2',
        [input.id, ref.from, ref.to],
      );
    }
    // A bot on an account of its own has that account's secrets filed under
    // its name, and they are moving with it. A shared account's are not the
    // bot's to move, and its seats are never renamed.
    await client.query(
      `update github_identities i set secret_ns = $3, updated_at = now()
       where i.id = (select identity_id from bots where id = $1) and i.secret_ns = $2
         and not exists (select 1 from bots b where b.identity_id = i.id and b.id <> $1)`,
      [input.id, input.from, input.to],
    );
    await client.query('delete from sessions where bot_id = $1', [input.id]);
    // A seat paused from Crew is paused by name. Left behind, connecting an
    // account to a paused seat lifted its pause with nobody pressing Resume,
    // and the entry could later pause another bot given the old name.
    const paused = await client.query<{ value: string }>('select value from settings where key = $1 for update', ['workPausedSeats']);
    const pauses = seatPausesMoved(paused.rows[0]?.value ?? null, input.from, input.to);
    if (pauses) {
      await client.query('update settings set value = $2, updated_by = $3, updated_at = now() where key = $1', [
        'workPausedSeats',
        pauses,
        input.actor,
      ]);
    }
    await client.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
      input.actor,
      'bot.renamed',
      input.to,
      JSON.stringify({ from: input.from, to: input.to, reason: input.reason }),
    ]);
    return toBot(row);
  });
}

/**
 * `workPausedSeats` with `from`'s pause under `to`, or null when there is
 * nothing to move. Parsed here rather than cast in SQL: a value that does not
 * read pauses nobody (`seatPausesFrom` in the bridge), and must not abort the
 * rename. A stale entry under the new name is replaced by the moved one.
 */
function seatPausesMoved(stored: string | null, from: string, to: string): string | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, from)) return null;
  const { [from]: pause, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify({ ...rest, [to]: pause });
}

/** Every secret of a rename is under the new name now. */
export async function finishRename(botId: string): Promise<void> {
  await query('update bots set renamed_from = null, updated_at = now() where id = $1', [botId]);
}

export async function setBotStatus(name: string, status: Bot['status']): Promise<void> {
  await query('update bots set status = $2, updated_at = now() where name = $1', [name, status]);
}

/**
 * The console's assignment: which account's credential this bot uses, the
 * engine that account is thought with, and which model it runs.
 *
 * Read on the next task start. Nothing caches the choice in the process, so
 * the write takes effect without a restart — including a new engine, which
 * hostd reads from this row, with the login mount the account needs. An empty
 * model is refused here as well as by the row: `chooseEngine` would otherwise
 * be handed an empty string. The automation bot (`engine: none`) is refused an
 * account, and a bot is never moved to or from `none` here: that is what a bot
 * is, not which model it runs. Whether the account's provider is the engine's,
 * and whether the model is one it serves, is `checkModelAssignment`'s
 * question, asked by the route before it gets here.
 *
 * `model_set_at` is what marks the assignment as the console's, so the next
 * `fleetadlc up` leaves its engine, model and account alone.
 */
export async function setAssignment(
  botId: string,
  input: { engine: EngineName; model: string; modelAccountId: string | null },
): Promise<Bot> {
  const model = input.model.trim();
  if (!model) throw new AssignmentRefused('a bot needs a model');

  const current = await getBotById(botId);
  if (!current) throw new AssignmentRefused(`no bot ${botId}`);

  if (current.engine === 'none' || input.engine === 'none') {
    if (current.engine !== input.engine) {
      throw new AssignmentRefused(
        current.engine === 'none'
          ? `${current.name} does not run a model, and an assignment does not make it`
          : `${current.name} runs a model, and an assignment does not stop it`,
      );
    }
    if (input.modelAccountId) {
      throw new AssignmentRefused(`${current.name} does not run a model and cannot be assigned an account`);
    }
    if (model !== 'none') throw new AssignmentRefused(`${current.name} does not run a model`);
  }

  if (input.modelAccountId) {
    const account = await getModelAccount(input.modelAccountId);
    if (!account) throw new ModelAccountNotFound(input.modelAccountId);
  }

  const row = await queryOne<BotRow>(
    `update bots set engine = $2, model = $3, model_account_id = $4, model_set_at = now(), updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [botId, input.engine, model, input.modelAccountId],
  );
  if (!row) throw new AssignmentRefused(`no bot ${botId}`);
  return toBot(row);
}

/**
 * How many tasks a seat runs at once (Crew → "tasks at once"), 1 to 16. Each
 * is a computer of its own with the seat's size, all as the seat's one GitHub
 * identity. Returns the row, or null for a bot that is not there.
 */
export async function setMaxTasks(botId: string, maxTasks: number): Promise<Bot | null> {
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_TASKS_PER_SEAT) {
    throw new AssignmentRefused(`a seat runs from 1 to ${MAX_TASKS_PER_SEAT} tasks at once`);
  }
  const row = await queryOne<BotRow>(`update bots set max_tasks = $2, updated_at = now() where id = $1 returning ${COLUMNS}`, [botId, maxTasks]);
  return row ? toBot(row) : null;
}

/**
 * How a bot's avatar looks: the color a person chose (a name from
 * `CREW_COLORS`, or null for its role's tint) and the avatar it shows (a name
 * from `AVATARS`, or null for its engine's mark). A field left out is left as
 * it is, and both are written in one statement, so a request that changes both
 * never stores half of it. The route has already refused a name that is not
 * in its list; this refuses it again, since a stored name the console cannot
 * draw would be an avatar in nothing. It is the look of the avatar and nothing
 * else, so it does not touch `model_set_at` or anything a task reads.
 */
export async function setAppearance(
  botId: string,
  change: { color?: CrewColor | null; avatar?: Avatar | null },
): Promise<Bot | null> {
  const hasColor = 'color' in change;
  const hasAvatar = 'avatar' in change;
  const color = change.color ?? null;
  const avatar = change.avatar ?? null;
  if (hasColor && color !== null && !isCrewColor(color)) throw new AssignmentRefused(`${String(color)} is not a crew color`);
  if (hasAvatar && avatar !== null && !isAvatar(avatar)) throw new AssignmentRefused(`${String(avatar)} is not an avatar`);
  if (!hasColor && !hasAvatar) throw new AssignmentRefused('say which color, or which avatar');
  const row = await queryOne<BotRow>(
    `update bots set
       color = case when $2 then $3 else color end,
       avatar = case when $4 then $5 else avatar end,
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [botId, hasColor, color, hasAvatar, avatar],
  );
  return row ? toBot(row) : null;
}
