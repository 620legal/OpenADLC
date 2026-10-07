import { bots, credentials, identities, modelAccounts, query, repos, settings, spendingLimits, withTransaction } from '@fleetadlc/db';
import { appPrivateKeyRef, credentialKind, getSecretStore, modelAccountRef, signingKeyRef, webhookSecretRef, type SecretStore } from '@fleetadlc/github';
import { MESSAGE_KINDS, holdsCredential, isRepoColor, nextRepoColor } from '@fleetadlc/shared';
import { archiveSpendingLimit, BackupError, resolveSpendingLimits, type ArchivedAccount, type ArchivedCredential, type ArchivedHistory, type ArchivedRepository, type ArchivedSpendingLimit, type LoginFiles } from './archive.js';
import type { HistoryIds, RestoreDb, RestoreTarget } from './apply.js';
import type { InstallFacts } from './clean.js';
import {
  capAboveGlobal,
  RESTORED_REQUEST_STATES,
  RUNTIME_SETTINGS,
  repositoryNameTaken,
  signsInByFolder,
  spendingAmount,
  spendingCapName,
  type InstallBot,
  type InstallIdentity,
  type InstallSnapshot,
} from './contents.js';
import type { InstallShape } from './plan.js';
import type { BackupSelection } from './selection.js';
import type { SignInFacts } from './signins.js';
import type { HistoryHere } from './compare.js';
import type { UndoDb, UndoTarget } from './undo.js';
import type { HistoryCounts } from './summary.js';

/**
 * The install as the database and the secret store hold it: read into the
 * snapshot a backup is built from, and written from a restore plan.
 *
 * Shared by the bridge and the CLI, so what one writes the other reads. Where
 * the two differ is the edges, passed in: a subscription's sign-in folder is
 * hostd's, so the bridge reaches it through hostd while the CLI, on the same
 * machine, reads the login root; and a bot's rename moves its computer, which
 * only the bridge's routine can do.
 */

/** A database client inside a transaction, as much of one as this needs. */
interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** Who a restored setting is attributed to in the settings table. */
const RESTORED_BY = 'fleetadlc restore';

/**
 * The environment variable each setting falls back to, as the bridge reads
 * them: a setting stored in the table wins, and absent, the environment
 * `fleetadlc up` assembled from `install.json` still answers. A backup takes the
 * answer, wherever it came from, so a restored install does not depend on the
 * old one's `install.json`.
 */
const SETTING_ENV: Record<string, string> = {
  organization: 'FLEETADLC_GITHUB_ORG',
  githubClientId: 'FLEETADLC_GITHUB_CLIENT_ID',
  webhookSecret: 'FLEETADLC_WEBHOOK_SECRET',
  publicUrl: 'FLEETADLC_PUBLIC_URL',
  humans: 'FLEETADLC_HUMANS',
  automationBot: 'FLEETADLC_AUTOMATION_BOT',
};

export function effectiveSettings(
  stored: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...stored };
  for (const [key, variable] of Object.entries(SETTING_ENV)) {
    const value = env[variable]?.trim();
    if (out[key] === undefined && value) out[key] = value;
  }
  return out;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

async function storedSettings(): Promise<Record<string, string>> {
  const all = await settings.allSettings();
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function allSecrets(store: SecretStore): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  // Every ref the store has, not a list of the ones this file knows about: a
  // ref nothing recognises is named as left out rather than silently missed.
  for (const ref of await store.list()) {
    const value = await store.get(ref);
    if (value !== null) secrets[ref] = value;
  }
  return secrets;
}

function toAccount(account: Awaited<ReturnType<typeof modelAccounts.list>>[number]): ArchivedAccount {
  return {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    label: account.label,
    createdAt: account.createdAt,
    verifiedAt: account.verifiedAt ?? null,
    verifyError: account.verifyError ?? null,
  };
}

/** Everything that happened, found by seat and repository name rather than by this install's ids. */
/**
 * `none` when the table is not there at all, as on a database from before
 * migration 0029; any other failure is thrown. Every failure used to read as
 * none, so a statement timeout made a "with history" backup that carried no
 * attachments and said it had succeeded.
 */
function onlyWithoutTable<T>(error: unknown, none: T): T {
  if ((error as { code?: unknown } | null)?.code === '42P01') return none;
  throw error;
}

export async function readHistory(): Promise<ArchivedHistory> {
  const [threads, messages, audit, ledger, requests, files] = await Promise.all([
    query<Record<string, unknown>>(
      `select t.id, b.slot as seat, r.name as repo, t.subject_ref, t.created_at, t.updated_at
         from threads t join bots b on b.id = t.bot_id left join repos r on r.id = t.repo_id
        order by t.created_at, t.id`,
    ),
    query<Record<string, unknown>>(
      'select id, thread_id, kind, author, text, note, payload, github_url, at from messages order by at, id',
    ),
    query<Record<string, unknown>>('select actor, action, target, payload, at from audit order by id'),
    query<Record<string, unknown>>(
      `select b.slot as seat, l.engine, l.model, l.model_alias, l.prompt_hash, l.tokens_in, l.tokens_out,
              l.cost_usd::text as cost_usd, l.at
         from ledger l join bots b on b.id = l.bot_id
        order by l.id`,
    ),
    query<Record<string, unknown>>(
      `select q.id, q.text, q.context, r.name as repo, q.kind, q.requested_by, q.issue_number, q.state,
              q.created_at, q.updated_at
         from requests q left join repos r on r.id = q.repo_id
        order by q.created_at, q.id`,
    ),
    // What was sent with something; an upload nobody sent is a day from being swept.
    query<Record<string, unknown>>(
      `select a.id, a.subject_ref, r.name as repo, a.request_id, a.message_id, a.source, a.source_url, a.name,
              a.media_type, a.size_bytes, a.sha256, encode(a.content, 'base64') as content, a.uploaded_by, a.created_at
         from attachments a left join repos r on r.id = a.repo_id
        where a.subject_ref is not null
        order by a.created_at, a.id`,
    ).catch((error: unknown) => onlyWithoutTable(error, [] as Record<string, unknown>[])),
  ]);
  return {
    threads: threads.map((row) => ({
      id: String(row.id),
      seat: String(row.seat),
      repo: (row.repo as string | null) ?? null,
      subjectRef: String(row.subject_ref ?? ''),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    messages: messages.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      kind: String(row.kind),
      author: String(row.author),
      text: String(row.text),
      note: (row.note as string | null) ?? null,
      payload: row.payload ?? null,
      githubUrl: (row.github_url as string | null) ?? null,
      at: iso(row.at),
    })),
    audit: audit.map((row) => ({
      actor: String(row.actor),
      action: String(row.action),
      target: String(row.target),
      payload: row.payload ?? null,
      at: iso(row.at),
    })),
    ledger: ledger.map((row) => ({
      seat: String(row.seat),
      engine: String(row.engine),
      model: String(row.model),
      modelAlias: (row.model_alias as string | null) ?? null,
      promptHash: (row.prompt_hash as string | null) ?? null,
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      costUsd: Number(row.cost_usd),
      at: iso(row.at),
    })),
    requests: requests.map((row) => ({
      id: String(row.id),
      text: String(row.text),
      context: (row.context as string | null) ?? null,
      repo: (row.repo as string | null) ?? null,
      kind: (row.kind as string | null) ?? null,
      requestedBy: String(row.requested_by),
      issueNumber: row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number),
      state: String(row.state),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    attachments: files.map((row) => ({
      id: String(row.id),
      subjectRef: String(row.subject_ref),
      repo: (row.repo as string | null) ?? null,
      requestId: (row.request_id as string | null) ?? null,
      messageId: (row.message_id as string | null) ?? null,
      source: row.source === 'github' ? ('github' as const) : ('console' as const),
      sourceUrl: (row.source_url as string | null) ?? null,
      name: String(row.name),
      mediaType: String(row.media_type),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      content: String(row.content).replace(/\s+/g, ''),
      uploadedBy: String(row.uploaded_by),
      createdAt: iso(row.created_at),
    })),
  };
}

export interface ReadOptions {
  store?: SecretStore;
  /** An account's sign-in folder, or null when it has none. */
  readLogin?(accountId: string): Promise<LoginFiles | null>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The GitHub accounts this install holds a sign-in for, and the name each
 * bot's is filed under (`github_identities`, migration 0014). A bot that is
 * on none files its own under its name, which is what the bridge's
 * `signInOf` falls back to; so does every bot when the table cannot be read.
 */
async function readIdentities(): Promise<{ identities: InstallIdentity[]; nsOf: Map<string, string> }> {
  try {
    const [all, rows] = await Promise.all([
      identities.listIdentities(),
      query<{ name: string; secret_ns: string }>(
        'select b.name, i.secret_ns from bots b join github_identities i on i.id = b.identity_id',
      ),
    ]);
    return {
      identities: all.map((one) => ({ login: one.login, githubUserId: one.githubUserId, secretNs: one.secretNs })),
      nsOf: new Map(rows.map((row) => [row.name, row.secret_ns])),
    };
  } catch {
    return { identities: [], nsOf: new Map() };
  }
}

/** Everything a backup with this choice may take. History and sign-in folders are read only when chosen. */
export async function readInstall(selection: BackupSelection, options: ReadOptions = {}): Promise<InstallSnapshot> {
  const store = options.store ?? getSecretStore();
  const [secrets, stored, crew, credentialRows, repoRows, everyRepo, accountRows, github, limits] = await Promise.all([
    allSecrets(store),
    storedSettings(),
    bots.listBots(),
    credentials.listCredentials(),
    repos.listRepos(),
    repos.listRepos({ includeRemoved: true }),
    modelAccounts.list(),
    readIdentities(),
    // A failed read must not become an empty list. Restoring that archive
    // replaces the table, which would wipe every cap.
    spendingLimits.listLimits(),
  ]);
  const byId = new Map(crew.map((bot) => [bot.id, bot]));

  const credentialsByName: Record<string, ArchivedCredential> = {};
  for (const row of credentialRows) {
    const bot = byId.get(row.botId);
    if (!bot) continue;
    credentialsByName[bot.name] = {
      githubLogin: row.githubLogin,
      githubUserId: row.githubUserId,
      scopes: row.scopes,
      tokenExpiresAt: row.tokenExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      signingKeyId: row.signingKeyId,
      authorizedAt: row.authorizedAt,
      status: row.status,
    };
  }

  const accounts = accountRows.map(toAccount);
  const logins: Record<string, LoginFiles> = {};
  if (selection.accountSignIns && options.readLogin) {
    const wanted = selection.accounts === 'all' ? null : new Set(selection.accounts);
    for (const account of accounts) {
      if (!signsInByFolder(account) || (wanted && !wanted.has(account.id))) continue;
      const files = await options.readLogin(account.id);
      if (files) logins[account.id] = files;
    }
  }

  return {
    secrets,
    settings: effectiveSettings(stored, options.env),
    spendingLimits: limits.map((row) =>
      archiveSpendingLimit(
        row,
        repoRows.map((repo) => ({ id: repo.id, fullName: repo.fullName })),
        crew.map((bot) => ({ id: bot.id, name: bot.name, slot: bot.slot })),
      ),
    ),
    bots: crew.map(
      (bot): InstallBot => ({
        name: bot.name,
        slot: bot.slot,
        githubLogin: bot.githubLogin,
        engine: bot.engine,
        model: bot.model,
        modelAccountId: bot.modelAccountId,
        modelSetAt: bot.modelSetAt,
        color: bot.color ?? null,
        avatar: bot.avatar ?? null,
        identity: github.nsOf.get(bot.name) ?? null,
      }),
    ),
    identities: github.identities,
    credentials: credentialsByName,
    repositories: repoRows.map(
      (repo): ArchivedRepository => ({
        name: repo.name,
        fullName: repo.fullName,
        ownerSeat: repo.ownerBotId ? (byId.get(repo.ownerBotId)?.slot ?? null) : null,
        concurrency: repo.concurrency,
        stageModes: repo.stageModes as Record<string, string>,
        specRequiredLabels: repo.specRequiredLabels,
        humanReviewPaths: repo.humanReviewPaths,
        defaultBranch: repo.defaultBranch,
        color: repo.color,
      }),
    ),
    removedRepositories: everyRepo.filter((repo) => repo.removedAt).map((repo) => ({ name: repo.name, fullName: repo.fullName })),
    accounts,
    logins,
    history: selection.history ? await readHistory() : null,
  };
}

/** What the install has, by name: all a restore ever reads before it writes. */
export async function readShape(
  options: { store?: SecretStore; hasLogin?(accountId: string): Promise<boolean> } = {},
): Promise<InstallShape> {
  const store = options.store ?? getSecretStore();
  const [secretRefs, stored, crew, repoRows, accountRows, github] = await Promise.all([
    store.list(),
    storedSettings(),
    bots.listBots(),
    repos.listRepos({ includeRemoved: true }),
    modelAccounts.list(),
    readIdentities(),
  ]);
  const logins: string[] = [];
  if (options.hasLogin) {
    for (const account of accountRows) {
      if (signsInByFolder(account) && (await options.hasLogin(account.id).catch(() => false))) logins.push(account.id);
    }
  }
  return {
    secretRefs,
    settingKeys: Object.keys(stored),
    bots: crew.map((bot) => ({
      name: bot.name,
      slot: bot.slot,
      githubLogin: bot.githubLogin,
      engine: bot.engine,
      color: bot.color ?? null,
      avatar: bot.avatar ?? null,
    })),
    repositories: repoRows.filter((repo) => !repo.removedAt).map((repo) => repo.name),
    repositoryNames: repoRows.map((repo) => ({ name: repo.name, fullName: repo.fullName, ...(repo.removedAt ? { removed: true } : {}) })),
    accounts: accountRows.map((account) => account.id),
    logins,
    identities: github.identities.map((identity) => ({
      login: identity.login,
      secretNs: identity.secretNs,
      bots: crew.filter((bot) => github.nsOf.get(bot.name) === identity.secretNs).map((bot) => bot.name),
    })),
  };
}

/** What the Backup card offers, by name. No value from any of it. */
export interface BackupInventory {
  install: { settings: string[]; app: { clientId: boolean; privateKey: boolean; webhookSecret: boolean } };
  repositories: { name: string; fullName: string }[];
  bots: {
    seat: string;
    name: string;
    role: string;
    login: string | null;
    /** The kind of GitHub sign-in it holds, if any. */
    signIn: 'refresh' | 'static' | null;
    signingKey: boolean;
    modelAccountId: string | null;
  }[];
  accounts: {
    id: string;
    label: string;
    provider: string;
    kind: string;
    credential: 'key' | 'token' | 'sign-in';
    /** Whether the credential is there to take: the key or token stored, the folder signed in. Null when unknown. */
    stored: boolean | null;
  }[];
  history: HistoryCounts;
}

async function count(table: string, where = ''): Promise<number> {
  const rows = await query<{ count: string }>(`select count(*)::text as count from ${table}${where ? ` where ${where}` : ''}`);
  return Number(rows[0]?.count ?? 0);
}

export async function readInventory(
  options: { store?: SecretStore; signedIn?(accountId: string): Promise<boolean | null>; env?: NodeJS.ProcessEnv } = {},
): Promise<BackupInventory> {
  const store = options.store ?? getSecretStore();
  const [stored, crew, repoRows, accountRows, threads, messages, audit, ledger, requests, attachmentCount, github] = await Promise.all([
    storedSettings(),
    bots.listBots(),
    repos.listRepos(),
    modelAccounts.list(),
    count('threads'),
    count('messages'),
    count('audit'),
    count('ledger'),
    count('requests'),
    // Only what a backup carries: an upload nobody sent is not written.
    count('attachments', 'subject_ref is not null').catch((error: unknown) => onlyWithoutTable(error, 0)),
    readIdentities(),
  ]);
  const effective = effectiveSettings(stored, options.env);
  return {
    install: {
      settings: Object.keys(effective)
        .filter((key) => !RUNTIME_SETTINGS.includes(key))
        .sort(),
      app: {
        clientId: Boolean(effective.githubClientId),
        privateKey: (await store.get(appPrivateKeyRef())) !== null,
        webhookSecret: Boolean(effective.webhookSecret) || (await store.get(webhookSecretRef())) !== null,
      },
    },
    repositories: repoRows.map((repo) => ({ name: repo.name, fullName: repo.fullName })),
    bots: await Promise.all(
      crew.map(async (bot) => ({
        seat: bot.slot,
        name: bot.name,
        role: bot.role,
        login: bot.githubLogin,
        // Where the seat's sign-in is filed: its account's name when seats share one.
        signIn: await credentialKind(github.nsOf.get(bot.name) ?? bot.name, store),
        signingKey: (await store.get(signingKeyRef(bot.name))) !== null,
        modelAccountId: bot.modelAccountId,
      })),
    ),
    accounts: await Promise.all(
      accountRows.map(async (account) => {
        const folder = signsInByFolder(account);
        return {
          id: account.id,
          label: account.label,
          provider: account.provider,
          kind: account.kind,
          credential: folder ? ('sign-in' as const) : account.kind === 'key' ? ('key' as const) : ('token' as const),
          stored: folder
            ? ((await options.signedIn?.(account.id).catch(() => null)) ?? null)
            : (await store.get(modelAccountRef(account.id))) !== null,
        };
      }),
    ),
    history: { threads, messages, audit, ledger, requests, attachments: attachmentCount },
  };
}

const MESSAGE_KIND_SET = new Set<string>(MESSAGE_KINDS);

/**
 * The archive's caps as this install's rows. After the repositories and bots
 * are written: the archive names them, and the ids in the table are this
 * install's.
 */
async function capsHere(sql: Sql, rows: ArchivedSpendingLimit[]) {
  const [repoRows, botRows] = await Promise.all([
    sql.query('select id, full_name from repos where removed_at is null'),
    sql.query('select id, name, slot from bots'),
  ]);
  const repoHere = repoRows.rows.map((row) => ({ id: String(row.id), fullName: String(row.full_name) }));
  const botHere = botRows.rows.map((row) => ({ id: String(row.id), name: String(row.name), slot: row.slot == null ? undefined : String(row.slot) }));
  return { resolved: resolveSpendingLimits(rows, repoHere, botHere), repoHere, botHere };
}

/** The restore's rows, written through one transaction's client — and an undo's, which also takes away. */
export function restoreDb(sql: Sql): UndoDb {
  return {
    async replaceSpendingLimits(rows) {
      const { resolved } = await capsHere(sql, rows);
      await sql.query('delete from spending_limits');
      for (const row of resolved) {
        if (row.amountUsd == null) continue;
        await sql.query('insert into spending_limits (scope, kind, amount_usd) values ($1, $2, $3)', [row.scope, row.kind, row.amountUsd]);
      }
    },

    async mergeSpendingLimits(rows, actor) {
      // The lock saving from Settings takes: a restore writing beside a save
      // could leave a repository cap above the global one, which a save refuses.
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [spendingLimits.SAVE_LOCK]);
      const { resolved, repoHere, botHere } = await capsHere(sql, rows);
      const saved = await sql.query('select scope, kind, amount_usd::text as amount_usd from spending_limits');
      const key = (scope: string, kind: string) => `${scope}\0${kind}`;
      const current = new Map(saved.rows.map((row) => [key(String(row.scope), String(row.kind)), row.amount_usd == null ? null : Number(row.amount_usd)]));
      const next = new Map(current);
      const writes: { scope: string; kind: string; amountUsd: number; old: number | null }[] = [];
      for (const row of resolved) {
        if (row.amountUsd == null) continue;
        const old = current.get(key(row.scope, row.kind)) ?? null;
        next.set(key(row.scope, row.kind), row.amountUsd);
        if (old !== row.amountUsd) writes.push({ scope: row.scope, kind: row.kind, amountUsd: row.amountUsd, old });
      }
      const above = capAboveGlobal(
        [...next].map(([id, amountUsd]) => {
          const [scope = '', kind = ''] = id.split('\0');
          return { scope, kind, amountUsd };
        }),
      );
      if (above) {
        const repository = repoHere.find((repo) => `repo:${repo.id}` === above.scope)?.fullName ?? above.scope;
        const botId = above.kind.startsWith('month_bot:') ? above.kind.slice('month_bot:'.length) : null;
        const bot = botId ? (botHere.find((one) => one.id === botId)?.slot ?? botHere.find((one) => one.id === botId)?.name) : undefined;
        const name = spendingCapName({ scope: 'repo', repository, kind: botId ? 'month_bot' : above.kind, ...(bot ? { bot } : {}), amountUsd: above.amountUsd });
        throw new BackupError(
          `the backup's spending caps would leave ${name} at ${spendingAmount(above.amountUsd)}, above the global ${spendingAmount(above.globalUsd)}, which Settings refuses; nothing was changed`,
        );
      }
      for (const write of writes) {
        await sql.query(
          `insert into spending_limits (scope, kind, amount_usd) values ($1, $2, $3)
           on conflict (scope, kind) do update set amount_usd = excluded.amount_usd, updated_at = now()`,
          [write.scope, write.kind, write.amountUsd],
        );
        // As a save from Settings records it.
        await sql.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
          actor,
          'spending.limit_changed',
          `${write.scope} ${write.kind}`,
          JSON.stringify({ scope: write.scope, kind: write.kind, old: write.old, new: write.amountUsd }),
        ]);
      }
    },

    async setSetting(key, value) {
      // Empty clears, as the settings store does: an empty row would override
      // the environment with nothing.
      if (value.length === 0) {
        await sql.query('delete from settings where key = $1', [key]);
        return;
      }
      await sql.query(
        `insert into settings (key, value, updated_by) values ($1, $2, $3)
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, value, RESTORED_BY],
      );
    },

    async putAccount(account, { keepCheck }) {
      await sql.query(
        `insert into model_accounts (id, provider, kind, label, created_at, verified_at, verify_error)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set
           provider = excluded.provider, kind = excluded.kind, label = excluded.label,
           verified_at = excluded.verified_at, verify_error = excluded.verify_error`,
        [
          account.id,
          account.provider,
          account.kind,
          account.label,
          account.createdAt,
          keepCheck ? account.verifiedAt : null,
          keepCheck ? account.verifyError : null,
        ],
      );
    },

    async putRepository(repo, ownerName, options = {}) {
      // Found by full name, never by the short name: `on conflict (name)`
      // wrote other/widgets over acme/widgets' row, with acme's issues, tasks
      // and caps under it. Undo names the row a restore wrote it over.
      const byFullName = async (fullName: string) =>
        (await sql.query('select id, color from repos where lower(full_name) = lower($1)', [fullName])).rows[0];
      const row = (await byFullName(repo.fullName)) ?? (options.over ? await byFullName(options.over) : undefined);
      if (!row) {
        const namesake = (await sql.query('select name, full_name, removed_at from repos where lower(name) = lower($1)', [repo.name])).rows[0];
        if (namesake) {
          throw new BackupError(
            repositoryNameTaken(repo.fullName, { name: String(namesake.name), fullName: String(namesake.full_name), removed: namesake.removed_at != null }),
          );
        }
      }
      // Its colour as the archive has it. One written before repositories had
      // colours keeps the colour a row here already has, or is given the next
      // nobody has — the column's default would make every one of them blue.
      const inUse = (await sql.query('select id, color from repos where removed_at is null')).rows
        .filter((one) => !row || String(one.id) !== String(row.id))
        .map((one) => String(one.color));
      const color = isRepoColor(repo.color) ? repo.color : typeof row?.color === 'string' ? row.color : nextRepoColor(inUse);
      const values = [
        repo.fullName,
        ownerName,
        Math.max(1, Math.floor(repo.concurrency)),
        JSON.stringify(repo.stageModes),
        repo.specRequiredLabels,
        repo.humanReviewPaths,
        repo.defaultBranch || 'main',
        color,
      ];
      if (row) {
        // A repository the backup worked in is one this install works in: one
        // removed from OpenADLC here comes back.
        await sql.query(
          `update repos set
             full_name = $2,
             owner_bot_id = (select id from bots where name = $3),
             concurrency = $4,
             stage_modes = $5::jsonb,
             spec_required_labels = $6,
             human_review_paths = $7,
             default_branch = $8,
             color = $9,
             removed_at = null,
             updated_at = now()
           where id = $1`,
          [row.id, ...values],
        );
        return;
      }
      await sql.query(
        `insert into repos (name, full_name, owner_bot_id, concurrency, stage_modes, spec_required_labels, human_review_paths, default_branch, color)
         values ($1, $2, (select id from bots where name = $3), $4, $5::jsonb, $6, $7, $8, $9)`,
        [repo.name, ...values],
      );
    },

    async setBotLogin(name, login) {
      // A row that merely names the account holds nothing for it — a restore
      // is what is saying which bot is which now. One on the account's
      // identity shares it, and keeps it.
      await sql.query(
        `update bots set github_login = null, identity_id = null, updated_at = now()
         where lower(github_login) = lower($2) and name <> $1
           and (identity_id is null or identity_id not in (select id from github_identities where lower(login) = lower($2)))`,
        [name, login],
      );
      const updated = await sql.query('update bots set github_login = $2, updated_at = now() where name = $1', [name, login]);
      if (!updated.rowCount) throw new Error(`no bot named ${name} in this install`);
    },

    async putIdentity(identity, names) {
      const before = (await sql.query('select distinct identity_id from bots where name = any($1::text[]) and identity_id is not null', [names])).rows.map(
        (row) => String(row.identity_id),
      );
      let id = (await sql.query('select id from github_identities where lower(login) = lower($1)', [identity.login])).rows[0]?.id;
      if (id === undefined) {
        // The name may still be held by an account only these bots were on,
        // which they are leaving now; nobody else answers to it.
        await sql.query(
          `delete from github_identities i where i.secret_ns = $1
             and not exists (select 1 from bots b where b.identity_id = i.id and not (b.name = any($2::text[])))`,
          [identity.secretNs, names],
        );
        id = (
          await sql.query('insert into github_identities (login, github_user_id, secret_ns) values ($1, $2, $3) returning id', [
            identity.login,
            identity.githubUserId,
            identity.secretNs,
          ])
        ).rows[0]?.id;
      } else if (identity.githubUserId !== null) {
        await sql.query('update github_identities set github_user_id = coalesce(github_user_id, $2), updated_at = now() where id = $1', [
          id,
          identity.githubUserId,
        ]);
      }
      await sql.query('update bots set identity_id = $2, github_login = $3, updated_at = now() where name = any($1::text[])', [
        names,
        id,
        identity.login,
      ]);
      await sql.query(
        `delete from github_identities i where i.id = any($1::uuid[]) and i.id <> $2
           and not exists (select 1 from bots b where b.identity_id = i.id)`,
        [before, id],
      );
    },

    async setAssignment(name, assignment) {
      await sql.query(
        `update bots set engine = $2, model = $3, model_account_id = $4, model_set_at = $5, updated_at = now()
         where name = $1`,
        [name, assignment.engine, assignment.model, assignment.modelAccountId, assignment.modelSetAt],
      );
    },

    async setLook(name, look) {
      await sql.query('update bots set color = $2, avatar = $3, updated_at = now() where name = $1', [name, look.color, look.avatar]);
    },

    async putCredential(name, credential, secretRef) {
      await sql.query(
        `insert into bot_credentials
           (bot_id, github_login, github_user_id, secret_ref, scopes, token_expires_at, refresh_expires_at,
            signing_key_id, authorized_at, status)
         select id, $2::text, $3::bigint, $4::text, $5::text[], $6::timestamptz, $7::timestamptz, $8::bigint,
                $9::timestamptz, $10::text
           from bots where name = $1::text
         on conflict (bot_id) do update set
           github_login = excluded.github_login, github_user_id = excluded.github_user_id,
           secret_ref = excluded.secret_ref, scopes = excluded.scopes,
           token_expires_at = excluded.token_expires_at, refresh_expires_at = excluded.refresh_expires_at,
           signing_key_id = excluded.signing_key_id, authorized_at = excluded.authorized_at,
           status = excluded.status, updated_at = now()`,
        [
          name,
          credential.githubLogin,
          credential.githubUserId,
          secretRef,
          credential.scopes,
          credential.tokenExpiresAt,
          credential.refreshExpiresAt,
          credential.signingKeyId,
          credential.authorizedAt,
          credential.status,
        ],
      );
    },

    async putHistory(history) {
      const counts: HistoryCounts = { threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0, attachments: 0 };
      const ids: HistoryIds = { threads: [], messages: [], requests: [], audit: [], ledger: [], attachments: [] };
      const seats = new Map(
        (await sql.query('select id, slot from bots')).rows.map((row) => [String(row.slot), String(row.id)]),
      );
      const repoIds = new Map(
        (await sql.query('select id, name from repos')).rows.map((row) => [String(row.name), String(row.id)]),
      );

      // A thread is one bot's about one subject. One already here keeps its
      // id and takes the archive's messages; a new one keeps the archive's.
      const threadIds = new Map<string, string>();
      for (const thread of history.threads) {
        const botId = seats.get(thread.seat);
        if (!botId) continue;
        const same = await sql.query('select id from threads where id = $1', [thread.id]);
        if (same.rows[0]) {
          threadIds.set(thread.id, String(same.rows[0].id));
          continue;
        }
        const row = await sql.query(
          // Its role and seat are the seat's it is restored onto (0028): the
          // console tells seats sharing one account apart by them.
          `insert into threads (id, bot_id, repo_id, subject_ref, created_at, updated_at, role, seat)
           select $1, $2, $3, $4, $5, $6, b.role, b.slot from bots b where b.id = $2
           on conflict (bot_id, subject_ref) do update set updated_at = greatest(threads.updated_at, excluded.updated_at)
           returning id, (xmax = 0) as inserted`,
          [thread.id, botId, thread.repo ? (repoIds.get(thread.repo) ?? null) : null, thread.subjectRef, thread.createdAt, thread.updatedAt],
        );
        const inserted = row.rows[0];
        if (!inserted) continue;
        threadIds.set(thread.id, String(inserted.id));
        if (inserted.inserted === true) {
          counts.threads += 1;
          ids.threads.push(String(inserted.id));
        }
      }

      for (const message of history.messages) {
        const threadId = threadIds.get(message.threadId);
        if (!threadId || !MESSAGE_KIND_SET.has(message.kind)) continue;
        const row = await sql.query(
          `insert into messages (id, thread_id, kind, author, text, note, payload, github_url, at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do nothing
           returning id`,
          [
            message.id,
            threadId,
            message.kind,
            message.author,
            message.text,
            message.note,
            message.payload === null ? null : JSON.stringify(message.payload),
            message.githubUrl,
            message.at,
          ],
        );
        counts.messages += row.rowCount ?? 0;
        for (const added of row.rows) ids.messages.push(String(added.id));
      }

      // No natural key for either of these, so a line already here — the same
      // restore run twice — is recognised by what it says and when. When is a
      // millisecond window starting at the archived time: the archive keeps
      // milliseconds and Postgres microseconds, so an exact match almost never
      // held, and a backup restored into its own install doubled every audit
      // line and every cost.
      for (const line of history.audit) {
        const row = await sql.query(
          `insert into audit (actor, action, target, payload, at)
           select $1::text, $2::text, $3::text, $4::jsonb, $5::timestamptz
           where not exists (
             select 1 from audit
              where actor = $1::text and action = $2::text and target = $3::text
                and at >= $5::timestamptz and at < $5::timestamptz + interval '1 millisecond'
           )
           returning id`,
          [line.actor, line.action, line.target, line.payload === null ? null : JSON.stringify(line.payload), line.at],
        );
        counts.audit += row.rowCount ?? 0;
        for (const added of row.rows) ids.audit.push(String(added.id));
      }

      for (const spend of history.ledger) {
        const botId = seats.get(spend.seat);
        // The ledger stores the id that was called; a row from before that
        // was enforced, with an alias in it, is not one this table will take.
        if (!botId || spend.model.startsWith('newest:')) continue;
        const alias = spend.modelAlias?.startsWith('newest:') ? spend.modelAlias : null;
        const row = await sql.query(
          `insert into ledger (task_id, bot_id, engine, model, model_alias, prompt_hash, tokens_in, tokens_out, cost_usd, at)
           select null, $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::int, $7::int, $8::numeric, $9::timestamptz
           where not exists (
             select 1 from ledger
              where bot_id = $1::uuid and model = $3::text and cost_usd = $8::numeric
                and at >= $9::timestamptz and at < $9::timestamptz + interval '1 millisecond'
           )
           returning id`,
          [botId, spend.engine, spend.model, alias, spend.promptHash, spend.tokensIn, spend.tokensOut, spend.costUsd, spend.at],
        );
        counts.ledger += row.rowCount ?? 0;
        for (const added of row.rows) ids.ledger.push(String(added.id));
      }

      // A queued request comes back queued. The insert leaves queue_attempts
      // and queue_reason to their defaults (0 and null): restored, it is a
      // fresh place in the line, not a request that was passed over.
      for (const request of history.requests) {
        if (!RESTORED_REQUEST_STATES.has(request.state)) continue;
        const row = await sql.query(
          `insert into requests (id, text, context, repo_id, kind, requested_by, issue_number, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (id) do nothing
           returning id`,
          [
            request.id,
            request.text,
            request.context,
            request.repo ? (repoIds.get(request.repo) ?? null) : null,
            request.kind,
            request.requestedBy,
            request.issueNumber,
            request.state,
            request.createdAt,
            request.updatedAt,
          ],
        );
        counts.requests += row.rowCount ?? 0;
        for (const added of row.rows) ids.requests.push(String(added.id));
      }

      // After the requests and messages they belong to. One already here — by
      // id, or the same file on the same subject — is left as it is; a request
      // or message the restore did not bring is not pointed at.
      for (const file of history.attachments ?? []) {
        const row = await sql.query(
          `insert into attachments (id, subject_ref, repo_id, request_id, message_id, source, source_url, name, media_type,
                                    size_bytes, sha256, content, uploaded_by, created_at)
           values ($1, $2, $3,
                   (select id from requests where id = $4::uuid),
                   (select id from messages where id = $5::uuid),
                   $6, $7, $8, $9, $10, $11, decode($12, 'base64'), $13, $14)
           on conflict do nothing
           returning id`,
          [
            file.id,
            file.subjectRef,
            file.repo ? (repoIds.get(file.repo) ?? null) : null,
            file.requestId,
            file.messageId,
            file.source,
            file.sourceUrl,
            file.name,
            file.mediaType,
            file.sizeBytes,
            file.sha256,
            file.content,
            file.uploadedBy,
            file.createdAt,
          ],
        );
        counts.attachments = (counts.attachments ?? 0) + (row.rowCount ?? 0);
        for (const added of row.rows) ids.attachments!.push(String(added.id));
      }

      return { ...counts, ids };
    },

    async audit(entry) {
      await sql.query('insert into audit (actor, action, target, payload) values ($1, $2, $3, $4)', [
        entry.actor,
        entry.action,
        entry.target,
        JSON.stringify(entry.payload),
      ]);
    },

    async clearSetting(key) {
      await sql.query('delete from settings where key = $1', [key]);
    },

    async removeRepository(fullName) {
      // As removing it in Settings does: out of OpenADLC, its history kept.
      await sql.query(
        'update repos set removed_at = coalesce(removed_at, now()), updated_at = now() where lower(full_name) = lower($1)',
        [fullName],
      );
    },

    async removeAccount(id) {
      const using = (await sql.query('select name from bots where model_account_id = $1 order by name', [id])).rows.map((row) =>
        String(row.name),
      );
      if (using.length > 0) return using;
      await sql.query('delete from model_accounts where id = $1', [id]);
      return [];
    },

    async releaseLogin(name) {
      // Off its account too; an account nobody is on any more goes with it.
      const was = (await sql.query('select identity_id from bots where name = $1', [name])).rows[0]?.identity_id ?? null;
      await sql.query('update bots set github_login = null, identity_id = null, updated_at = now() where name = $1', [name]);
      if (was !== null) {
        await sql.query('delete from github_identities i where i.id = $1 and not exists (select 1 from bots b where b.identity_id = i.id)', [was]);
      }
    },

    async deleteCredential(name) {
      await sql.query('delete from bot_credentials where bot_id = (select id from bots where name = $1)', [name]);
    },

    async deleteHistory(ids) {
      // Only what the restore added. A thread goes only if nothing was said
      // in it since but what the restore brought.
      await sql.query('delete from messages where id = any($1::uuid[])', [ids.messages]);
      await sql.query(
        'delete from threads t where t.id = any($1::uuid[]) and not exists (select 1 from messages m where m.thread_id = t.id)',
        [ids.threads],
      );
      await sql.query('delete from attachments where id = any($1::uuid[])', [ids.attachments ?? []]);
      await sql.query('delete from requests where id = any($1::uuid[])', [ids.requests]);
      await sql.query('delete from audit where id = any($1::bigint[])', [ids.audit]);
      await sql.query('delete from ledger where id = any($1::bigint[])', [ids.ledger]);
    },
  };
}

/** The install a restore writes: the database, in one transaction, and the secret store; the edges passed in. */
export function liveTarget(
  options: Pick<RestoreTarget, 'forgetCheck' | 'recordCheck' | 'rename'> & Pick<UndoTarget, 'forgetLogin'> & { store?: SecretStore } = {},
): RestoreTarget & UndoTarget {
  const store = options.store ?? getSecretStore();
  return {
    secrets: {
      get: (ref) => store.get(ref),
      set: (ref, value) => store.set(ref, value),
      delete: (ref) => store.delete(ref),
    },
    transaction: (fn) => withTransaction((client) => fn(restoreDb(client as unknown as Sql))),
    forgetCheck:
      options.forgetCheck ??
      (async (accountId) => {
        await modelAccounts.clearVerification(accountId);
      }),
    recordCheck:
      options.recordCheck ??
      (async (accountId, checkedAt) => {
        await modelAccounts.recordVerification(accountId, { checkedAt, error: null });
      }),
    ...(options.rename ? { rename: options.rename } : {}),
    ...(options.forgetLogin ? { forgetLogin: options.forgetLogin } : {}),
  };
}

/**
 * What this install holds, for comparing an archive's sign-ins with by value:
 * the secret store, the sign-in folders (hostd's, so read through whatever the
 * caller has for them) and each seat's record of how its bot was signed in.
 */
export function liveSignInFacts(options: {
  store?: SecretStore;
  folder(accountId: string): Promise<LoginFiles | null>;
}): SignInFacts {
  const store = options.store ?? getSecretStore();
  return {
    secret: (ref) => store.get(ref),
    folder: (accountId) => options.folder(accountId).catch(() => null),
    credential: async (seat) => {
      const bot = await bots.getBotBySlot(seat);
      if (!bot) return null;
      const record = await credentials.getCredential(bot.id);
      return record
        ? { githubLogin: record.githubLogin, githubUserId: record.githubUserId, authorizedAt: record.authorizedAt }
        : null;
    },
  };
}

/** The GitHub App client id this install refreshes sign-ins with now: the setting, or the environment's. */
export async function installClientId(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return effectiveSettings(await storedSettings(), env).githubClientId?.trim() || null;
}

/**
 * The four facts that say whether this install is set up — an app, a
 * repository, a connected bot, a model account — read the way the walkthrough
 * reads them, for a caller with no bridge to ask: `fleetadlc restore`.
 */
export async function readInstallFacts(options: { store?: SecretStore; env?: NodeJS.ProcessEnv } = {}): Promise<InstallFacts> {
  const store = options.store ?? getSecretStore();
  const [stored, repoRows, crew, accountRows, appKey, github] = await Promise.all([
    storedSettings(),
    repos.listRepos(),
    bots.listBots(),
    modelAccounts.list(),
    store.get(appPrivateKeyRef()),
    readIdentities(),
  ]);
  const connectedBots: string[] = [];
  for (const bot of crew) {
    const kind = await credentialKind(github.nsOf.get(bot.name) ?? bot.name, store).catch(() => null);
    const credential = await credentials.getCredential(bot.id).catch(() => null);
    if (holdsCredential(kind, credential)) connectedBots.push(bot.name);
  }
  return {
    appConfigured: Boolean(effectiveSettings(stored, options.env).githubClientId?.trim()) || appKey !== null,
    repositories: repoRows.map((repo) => repo.fullName),
    connectedBots,
    modelAccounts: accountRows.map((account) => account.label),
  };
}

/**
 * How many of an archive's history rows this install already has, by kind:
 * found the way a restore finds them, so what it would add is the rest.
 */
export async function readHistoryHere(history: ArchivedHistory | null | undefined): Promise<HistoryHere> {
  if (!history) return { threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 };
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    Number((await query<{ count: string }>(sql, params))[0]?.count ?? 0);
  const [threads, messages, requests, attachments] = await Promise.all([
    count('select count(*)::text as count from threads where id = any($1::uuid[])', [history.threads.map((one) => one.id)]),
    count('select count(*)::text as count from messages where id = any($1::uuid[])', [history.messages.map((one) => one.id)]),
    count('select count(*)::text as count from requests where id = any($1::uuid[])', [history.requests.map((one) => one.id)]),
    count('select count(*)::text as count from attachments where id = any($1::uuid[])', [(history.attachments ?? []).map((one) => one.id)]),
  ]);
  // One query each, however long the history: the rows as arrays, matched
  // the way a restore recognises a line it has already written, `at` within
  // the millisecond the archive kept.
  const audit = await count(
    `select count(*)::text as count
       from unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[]) as line(actor, action, target, at)
      where exists (
        select 1 from audit a
         where a.actor = line.actor and a.action = line.action and a.target = line.target
           and a.at >= line.at and a.at < line.at + interval '1 millisecond')`,
    [
      history.audit.map((line) => line.actor),
      history.audit.map((line) => line.action),
      history.audit.map((line) => line.target),
      history.audit.map((line) => line.at),
    ],
  );
  const ledger = await count(
    `select count(*)::text as count
       from unnest($1::text[], $2::timestamptz[], $3::text[], $4::numeric[]) as spend(seat, at, model, cost)
      where exists (
        select 1 from ledger l join bots b on b.id = l.bot_id
         where b.slot = spend.seat and l.model = spend.model and l.cost_usd = spend.cost
           and l.at >= spend.at and l.at < spend.at + interval '1 millisecond')`,
    [
      history.ledger.map((row) => row.seat),
      history.ledger.map((row) => row.at),
      history.ledger.map((row) => row.model),
      history.ledger.map((row) => row.costUsd),
    ],
  );
  return { threads, messages, audit, ledger, requests, attachments };
}
