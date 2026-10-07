import { ProviderKeyRejected } from '@fleetadlc/engines';
import { DeviceAuthError, GitHubApiError, type UserToken } from '@fleetadlc/github';
import { BackupError, type ArchivedHistory, type ArchivedSpendingLimit, type LoginFiles } from './archive.js';
import type { RestoreDb, RestoreTarget } from './apply.js';
import { capAboveGlobal, RESTORED_REQUEST_STATES, repositoryNameTaken, spendingCapKey, type InstallSnapshot } from './contents.js';
import type { InstallShape } from './plan.js';
import type { SignInChecks, TakeOverPorts } from './signins.js';

/**
 * An install to back up and a clean one to restore into, both invented.
 *
 * No ref, key, seat, login or label contains any of these values, so a test
 * that finds one in something printed or audited knows it leaked rather than
 * coincided with a name.
 */
export const VALUES = {
  appKey: '-----BEGIN RSA PRIVATE KEY-----\nzzz-app-key-zzz\n-----END RSA PRIVATE KEY-----\n',
  hook: 'zzz-hook-zzz',
  clientId: 'Iv1.zzz-client-zzz',
  builderSigning: 'zzz-builder-signing-zzz',
  builderRefresh: 'ghr_zzz-builder-refresh-zzz',
  reviewerSigning: 'zzz-reviewer-signing-zzz',
  reviewerRefresh: 'ghr_zzz-reviewer-refresh-zzz',
  internal: 'zzz-internal-zzz',
  apiKey: 'sk-ant-api-zzz-key-zzz',
  seatToken: 'sk-ant-oat-zzz-seat-zzz',
  codexAuth: '{"tokens":"zzz-codex-login-zzz"}',
  registry: 'zzz-registry-zzz',
};

export const KEY_ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const CLAUDE_SEAT = '22222222-2222-4222-8222-222222222222';
export const CODEX_SEAT = '33333333-3333-4333-8333-333333333333';

export const CODEX_LOGIN: LoginFiles = {
  'auth.json': Buffer.from(VALUES.codexAuth).toString('base64'),
  'config.toml': Buffer.from('model = "gpt-5"\n').toString('base64'),
};

export const HISTORY: ArchivedHistory = {
  threads: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      seat: 'builder',
      repo: 'fleetadlc-testbed',
      subjectRef: 'fleetadlc-testbed#12',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      seat: 'retired-seat',
      repo: null,
      subjectRef: '',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  ],
  messages: [
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      threadId: 'aaaaaaaa-0000-4000-8000-000000000001',
      kind: 'bot',
      author: 'fleetadlc-atlas-janedoe',
      text: 'Opened the pull request.',
      note: null,
      payload: null,
      githubUrl: null,
      at: '2026-09-02T10:00:00.000Z',
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      threadId: 'aaaaaaaa-0000-4000-8000-000000000002',
      kind: 'sys',
      author: 'fleetadlc',
      text: 'An old seat.',
      note: null,
      payload: null,
      githubUrl: null,
      at: '2026-09-01T10:00:00.000Z',
    },
  ],
  audit: [{ actor: 'alex@example.test', action: 'install.configured', target: 'install', payload: { keys: ['organization'] }, at: '2026-09-01T09:00:00.000Z' }],
  ledger: [
    {
      seat: 'builder',
      engine: 'claude',
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
      promptHash: null,
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.42,
      at: '2026-09-02T10:00:00.000Z',
    },
  ],
  requests: [
    {
      id: 'cccccccc-0000-4000-8000-000000000001',
      text: 'Add a health check',
      context: null,
      repo: 'fleetadlc-testbed',
      kind: 'feature',
      requestedBy: 'alex@example.test',
      issueNumber: 12,
      state: 'filed',
      createdAt: '2026-09-01T09:30:00.000Z',
      updatedAt: '2026-09-01T09:40:00.000Z',
    },
  ],
};

/** The install being backed up: three seats, two of them connected, three model accounts, one repository. */
export function sourceInstall(): InstallSnapshot {
  return {
    secrets: {
      'github-app-private-key': VALUES.appKey,
      'internal-api-secret': VALUES.internal,
      'registry-token': VALUES.registry,
      'ssh-signing-fleetadlc-atlas-janedoe': VALUES.builderSigning,
      'github-refresh-fleetadlc-atlas-janedoe': VALUES.builderRefresh,
      'ssh-signing-fleetadlc-sydney-janedoe': VALUES.reviewerSigning,
      'github-refresh-fleetadlc-sydney-janedoe': VALUES.reviewerRefresh,
      [`model-account-${KEY_ACCOUNT}`]: VALUES.apiKey,
      [`model-account-${CLAUDE_SEAT}`]: VALUES.seatToken,
      'something-newer': 'zzz-unknown-zzz',
    },
    settings: {
      organization: 'janedoe',
      githubClientId: VALUES.clientId,
      webhookSecret: VALUES.hook,
      operatorEmail: 'alex@example.test',
      engineUpdates: 'on',
      engineUpdateLast: '{"state":"updated"}',
    },
    bots: [
      {
        name: 'fleetadlc-atlas-janedoe',
        slot: 'builder',
        githubLogin: 'fleetadlc-atlas-janedoe',
        engine: 'claude',
        model: 'newest:opus',
        modelAccountId: CLAUDE_SEAT,
        modelSetAt: '2026-09-01T12:00:00.000Z',
      },
      {
        name: 'fleetadlc-sydney-janedoe',
        slot: 'lead-reviewer',
        githubLogin: 'fleetadlc-sydney-janedoe',
        engine: 'codex',
        model: 'gpt-5-codex',
        modelAccountId: CODEX_SEAT,
        modelSetAt: '2026-09-01T12:00:00.000Z',
      },
      {
        name: 'automation',
        slot: 'automation',
        githubLogin: null,
        engine: 'none',
        model: 'none',
        modelAccountId: null,
        modelSetAt: null,
      },
    ],
    credentials: {
      'fleetadlc-atlas-janedoe': {
        githubLogin: 'fleetadlc-atlas-janedoe',
        githubUserId: 101,
        scopes: [],
        tokenExpiresAt: '2026-09-24T18:00:00.000Z',
        refreshExpiresAt: '2027-03-01T00:00:00.000Z',
        signingKeyId: 9001,
        authorizedAt: '2026-09-01T11:00:00.000Z',
        status: 'active',
      },
      'fleetadlc-sydney-janedoe': {
        githubLogin: 'fleetadlc-sydney-janedoe',
        githubUserId: 102,
        scopes: [],
        tokenExpiresAt: null,
        refreshExpiresAt: null,
        signingKeyId: 9002,
        authorizedAt: '2026-09-01T11:00:00.000Z',
        status: 'active',
      },
    },
    repositories: [
      {
        name: 'fleetadlc-testbed',
        fullName: 'janedoe/fleetadlc-testbed',
        ownerSeat: 'builder',
        concurrency: 2,
        stageModes: { merged: 'autonomous' },
        specRequiredLabels: ['safety'],
        humanReviewPaths: ['infra/'],
        defaultBranch: 'main',
      },
    ],
    accounts: [
      { id: KEY_ACCOUNT, provider: 'anthropic', kind: 'key', label: 'Anthropic API', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: null, verifyError: null },
      { id: CLAUDE_SEAT, provider: 'anthropic', kind: 'subscription', label: 'Claude Max', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: '2026-09-02T00:00:00.000Z', verifyError: null },
      { id: CODEX_SEAT, provider: 'openai', kind: 'subscription', label: 'ChatGPT Pro', createdAt: '2026-09-01T00:00:00.000Z', verifiedAt: '2026-09-02T00:00:00.000Z', verifyError: null },
    ],
    logins: { [CODEX_SEAT]: CODEX_LOGIN },
    history: HISTORY,
  };
}

/** A clean install, as `fleetadlc up` leaves one: every seat seeded under its own name, nothing else. */
export function cleanShape(): InstallShape {
  return {
    secretRefs: ['internal-api-secret'],
    settingKeys: [],
    bots: [
      { name: 'builder', slot: 'builder', githubLogin: null, engine: 'claude' },
      { name: 'lead-reviewer', slot: 'lead-reviewer', githubLogin: null, engine: 'claude' },
      { name: 'automation', slot: 'automation', githubLogin: null, engine: 'none' },
    ],
    repositories: [],
    accounts: [],
    logins: [],
  };
}

/** Everything a restore did, in the order it did it, with what the database would hold afterwards. */
export interface Recorded {
  secrets: Map<string, string>;
  settings: Record<string, string>;
  accounts: { id: string; keepCheck: boolean }[];
  repositories: { name: string; owner: string | null }[];
  logins: Record<string, string>;
  assignments: Record<string, { engine: string; model: string; modelAccountId: string | null }>;
  /** Each bot's color and avatar, where the restore wrote them. */
  looks: Record<string, { color: string | null; avatar: string | null }>;
  credentials: Record<string, string>;
  history: ArchivedHistory[];
  audit: { action: string; payload: Record<string, unknown> }[];
  renamed: { name: string; to: string }[];
  /** Which GitHub account each bot was put on, by name, and where its sign-in is filed. */
  identities: Record<string, { login: string; ns: string }>;
  spendingLimits: import('./archive.js').ArchivedSpendingLimit[];
  /** Operations, in order. */
  order: string[];
}

/**
 * The caps after a merge, as live.ts makes one: each cap the archive names
 * set, none deleted, and a repository cap above the global one refused.
 */
function mergeCaps(
  here: ArchivedSpendingLimit[],
  rows: readonly ArchivedSpendingLimit[],
): { next: ArchivedSpendingLimit[]; changed: ArchivedSpendingLimit[] } {
  const next = here.map((cap) => ({ ...cap }));
  const changed: ArchivedSpendingLimit[] = [];
  for (const row of rows) {
    if (row.amountUsd == null) continue;
    const at = next.findIndex((cap) => spendingCapKey(cap) === spendingCapKey(row));
    if (at >= 0 && next[at]?.amountUsd === row.amountUsd) continue;
    if (at >= 0) next[at] = { ...row };
    else next.push({ ...row });
    changed.push(row);
  }
  const above = capAboveGlobal(
    next.map((cap) => ({ scope: cap.repository ? `repo:${cap.repository}` : cap.scope, kind: cap.bot ? `month_bot:${cap.bot}` : cap.kind, amountUsd: cap.amountUsd })),
  );
  if (above) throw new BackupError(`${above.scope.slice('repo:'.length)}'s cap is above the global one`);
  return { next, changed };
}

/**
 * A target that keeps what a restore wrote, with a transaction that commits
 * only when its callback resolves — and can be told to refuse one write, to
 * see what a failure leaves behind.
 */
export function fakeTarget(options: { existing?: Record<string, string>; failSecret?: string; rename?: boolean } = {}) {
  const recorded: Recorded = {
    secrets: new Map(Object.entries(options.existing ?? { 'internal-api-secret': VALUES.internal })),
    settings: {},
    accounts: [],
    repositories: [],
    logins: {},
    assignments: {},
    looks: {},
    credentials: {},
    history: [],
    audit: [],
    renamed: [],
    identities: {},
    spendingLimits: [],
    order: [],
  };
  const target: RestoreTarget = {
    secrets: {
      get: async (ref) => recorded.secrets.get(ref) ?? null,
      set: async (ref, value) => {
        if (ref === options.failSecret) throw new Error(`the store refused ${ref}`);
        recorded.secrets.set(ref, value);
        recorded.order.push(`secret ${ref}`);
      },
      delete: async (ref) => {
        if (ref === options.failSecret) throw new Error(`the store refused ${ref}`);
        recorded.secrets.delete(ref);
        recorded.order.push(`delete ${ref}`);
      },
    },
    async transaction(fn) {
      const pending: Recorded = {
        ...recorded,
        settings: { ...recorded.settings },
        accounts: [...recorded.accounts],
        repositories: [...recorded.repositories],
        logins: { ...recorded.logins },
        assignments: { ...recorded.assignments },
        looks: { ...recorded.looks },
        credentials: { ...recorded.credentials },
        history: [...recorded.history],
        audit: [...recorded.audit],
        identities: { ...recorded.identities },
        spendingLimits: [...recorded.spendingLimits],
      };
      const db: RestoreDb = {
        setSetting: async (key, value) => void (pending.settings[key] = value),
        replaceSpendingLimits: async (rows) => {
          pending.spendingLimits = rows.map((row) => ({ ...row }));
        },
        mergeSpendingLimits: async (rows, actor) => {
          const merged = mergeCaps(pending.spendingLimits, rows);
          pending.spendingLimits = merged.next;
          for (const cap of merged.changed) pending.audit.push({ action: 'spending.limit_changed', payload: { actor, cap } });
        },
        putAccount: async (account, { keepCheck }) => void pending.accounts.push({ id: account.id, keepCheck }),
        putRepository: async (repo, owner) => void pending.repositories.push({ name: repo.name, owner }),
        setBotLogin: async (name, login) => {
          pending.logins[name] = login;
          recorded.order.push(`login ${name}=${login}`);
        },
        putIdentity: async (identity, names) => {
          for (const name of names) pending.identities[name] = { login: identity.login, ns: identity.secretNs };
        },
        setLook: async (name, look) => void (pending.looks[name] = { ...look }),
        setAssignment: async (name, assignment) =>
          void (pending.assignments[name] = {
            engine: assignment.engine,
            model: assignment.model,
            modelAccountId: assignment.modelAccountId,
          }),
        putCredential: async (name, _credential, ref) => {
          pending.credentials[name] = ref;
          recorded.order.push(`credential ${name}`);
        },
        deleteCredential: async (name) => {
          delete pending.credentials[name];
          recorded.order.push(`forget credential ${name}`);
        },
        putHistory: async (history) => {
          pending.history.push(history);
          return {
            threads: history.threads.length,
            messages: history.messages.length,
            audit: history.audit.length,
            ledger: history.ledger.length,
            requests: history.requests.filter((request) => RESTORED_REQUEST_STATES.has(request.state)).length,
          };
        },
        audit: async (entry) => void pending.audit.push({ action: entry.action, payload: entry.payload }),
      };
      const result = await fn(db);
      // Committed: only now do the rows count.
      Object.assign(recorded, {
        settings: pending.settings,
        accounts: pending.accounts,
        repositories: pending.repositories,
        logins: pending.logins,
        assignments: pending.assignments,
        looks: pending.looks,
        credentials: pending.credentials,
        history: pending.history,
        audit: pending.audit,
        identities: pending.identities,
        spendingLimits: pending.spendingLimits,
      });
      return result;
    },
    forgetCheck: async (id) => void recorded.order.push(`forget ${id}`),
    recordCheck: async (id) => void recorded.order.push(`check ${id}`),
    ...(options.rename === false
      ? {}
      : {
          rename: async (input: { name: string; to: string }) => {
            recorded.renamed.push({ name: input.name, to: input.to });
            return { state: 'renamed' };
          },
        }),
  };
  return { target, recorded };
}

/**
 * The read-only checks, answered here: a value in `refuse` is refused the way
 * its provider refuses one, and a GitHub token signs in as `users[token]`.
 */
export function fakeChecks(options: { refuse?: readonly string[]; users?: Record<string, string> } = {}) {
  const asked: { what: string; auth?: string }[] = [];
  const checks: SignInChecks = {
    listModels: async (provider, secret, auth) => {
      asked.push({ what: `${provider} models`, auth });
      if (options.refuse?.includes(secret)) throw new ProviderKeyRejected('invalid x-api-key');
      return [{ id: 'model-one' }, { id: 'model-two' }];
    },
    gitHubUser: async (token) => {
      asked.push({ what: 'github user' });
      if (options.refuse?.includes(token)) throw new GitHubApiError(401, '/user', '{"message":"Bad credentials"}');
      return { login: options.users?.[token] ?? 'nobody-in-particular', id: 7 };
    },
  };
  return { checks, asked };
}

/**
 * Using a rotating sign-in, answered here. A refresh token in `refuse` is one
 * GitHub says is spent; any other comes back as a new pair, for the account
 * `logins` names it as. A subscription in `refuseLogin` is refused by its CLI.
 */
export function fakeTakeOver(
  options: { refuse?: readonly string[]; logins?: Record<string, string>; refuseLogin?: readonly string[] } = {},
) {
  const refreshed: string[] = [];
  const adopted: Record<string, LoginFiles> = {};
  const whose = new Map<string, string>();
  let issued = 0;
  const ports: TakeOverPorts = {
    refreshGitHub: async (refreshToken): Promise<UserToken> => {
      refreshed.push(refreshToken);
      if (options.refuse?.includes(refreshToken)) {
        throw new DeviceAuthError('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
      }
      issued += 1;
      const accessToken = `ghu_zzz-fresh-access-${issued}-zzz`;
      whose.set(accessToken, options.logins?.[refreshToken] ?? 'nobody-in-particular');
      return {
        accessToken,
        refreshToken: `ghr_zzz-fresh-refresh-${issued}-zzz`,
        expiresAt: new Date('2026-09-24T20:00:00.000Z'),
        refreshExpiresAt: new Date('2027-03-24T12:00:00.000Z'),
        scopes: [],
        tokenType: 'bearer',
      };
    },
    gitHubUser: async (token) => ({ login: whose.get(token) ?? 'nobody-in-particular', id: 7 }),
    adoptLogin: async (accountId, files) => {
      if (options.refuseLogin?.includes(accountId)) return { ok: false, message: 'unexpected status 401 Unauthorized' };
      adopted[accountId] = files;
      return { ok: true, message: 'answered: OK' };
    },
  };
  return { ports, refreshed, adopted };
}

/** Which account each of the source install's refresh tokens signs in as. */
export const REFRESH_LOGINS: Record<string, string> = {
  [VALUES.builderRefresh]: 'fleetadlc-atlas-janedoe',
  [VALUES.reviewerRefresh]: 'fleetadlc-sydney-janedoe',
};

// ------------------------------------------------------------------ an install in memory

/** A bot row, as the database has it. */
export interface MemoryBot {
  name: string;
  slot: string;
  githubLogin: string | null;
  engine: string;
  model: string;
  modelAccountId: string | null;
  modelSetAt: string | null;
  /** The `secretNs` of the GitHub account it is on, when one is recorded. */
  identity?: string | null;
  /** How its avatar looks, when a person chose one. */
  color?: string | null;
  avatar?: string | null;
}

export interface MemoryState {
  identities: import('./contents.js').InstallIdentity[];
  settings: Record<string, string>;
  secrets: Record<string, string>;
  bots: MemoryBot[];
  credentials: Record<string, import('./archive.js').ArchivedCredential>;
  repositories: (import('./archive.js').ArchivedRepository & { removed?: boolean })[];
  accounts: import('./archive.js').ArchivedAccount[];
  logins: Record<string, LoginFiles>;
  history: ArchivedHistory;
  spendingLimits: import('./archive.js').ArchivedSpendingLimit[];
}

/**
 * Postgres keeps an audit line's and a cost's time to the microsecond, and a
 * backup reads it back to the millisecond. The install in memory does the
 * same, so a restore that looked for a row "already here" by the exact
 * archived time — and so almost never found it — fails a test.
 */
function micros(at: string): number {
  const [whole, fraction = ''] = at.replace(/Z$/, '').split('.');
  return Date.parse(`${whole}Z`) * 1000 + Number(fraction.padEnd(6, '0').slice(0, 6));
}

/** A time as Postgres would hold it: with microseconds where the archive has none to say. */
function storedAt(at: string, extra = '000'): string {
  return /\.\d{3}Z$/.test(at) ? at.replace(/Z$/, `${extra}Z`) : at;
}

/** Read back the way `iso()` in live.ts reads it: to the millisecond, the rest dropped. */
function readAt(at: string): string {
  return at.replace(/(\.\d{3})\d+Z$/, '$1Z');
}

/** A stored time within the millisecond window starting at an archived one, as live.ts matches it. */
function sameMillisecond(stored: string, archived: string): boolean {
  const at = micros(archived);
  return micros(stored) >= at && micros(stored) < at + 1000;
}

/**
 * A whole install held in memory, readable the ways a restore reads one and
 * writable the ways a restore and an undo write one — each transaction on a
 * copy that counts only once it commits — so a restore and its undo can be
 * run end to end and the install compared with how it was.
 */
export function memoryInstall(initial: Partial<MemoryState> = {}) {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  let state: MemoryState = clone({
    settings: {},
    secrets: { 'internal-api-secret': VALUES.internal },
    bots: [],
    credentials: {},
    repositories: [],
    accounts: [],
    logins: {},
    history: { threads: [], messages: [], audit: [], ledger: [], requests: [] },
    identities: [],
    spendingLimits: [],
    ...initial,
  });
  // Rows written by the install itself, at now(), carry microseconds.
  for (const line of state.history.audit) line.at = storedAt(line.at, '417');
  for (const row of state.history.ledger) row.at = storedAt(row.at, '417');
  let serial = 0;

  const readHistory = (history: ArchivedHistory): ArchivedHistory => ({
    ...clone(history),
    audit: history.audit.map((line) => ({ ...clone(line), at: readAt(line.at) })),
    ledger: history.ledger.map((row) => ({ ...clone(row), at: readAt(row.at) })),
  });
  const auditHere = (history: ArchivedHistory, line: ArchivedHistory['audit'][number]) =>
    history.audit.some((one) => sameMillisecond(one.at, line.at) && one.action === line.action && one.actor === line.actor);
  const ledgerHere = (history: ArchivedHistory, row: ArchivedHistory['ledger'][number]) =>
    history.ledger.some((one) => sameMillisecond(one.at, row.at) && one.seat === row.seat);

  const view = (): InstallSnapshot => ({
    secrets: { ...state.secrets },
    settings: { ...state.settings },
    bots: state.bots.map((bot) => ({ ...bot })),
    credentials: clone(state.credentials),
    repositories: state.repositories.filter((repo) => !repo.removed).map(({ removed: _removed, ...repo }) => ({ ...repo })),
    removedRepositories: state.repositories.filter((repo) => repo.removed).map((repo) => ({ name: repo.name, fullName: repo.fullName })),
    accounts: clone(state.accounts),
    logins: clone(state.logins),
    history: readHistory(state.history),
    identities: clone(state.identities),
    spendingLimits: clone(state.spendingLimits),
  });

  const shape = (): InstallShape => ({
    secretRefs: Object.keys(state.secrets),
    settingKeys: Object.keys(state.settings),
    bots: state.bots.map((bot) => ({
      name: bot.name,
      slot: bot.slot,
      githubLogin: bot.githubLogin,
      engine: bot.engine,
      ...(bot.color !== undefined ? { color: bot.color } : {}),
      ...(bot.avatar !== undefined ? { avatar: bot.avatar } : {}),
    })),
    repositories: state.repositories.filter((repo) => !repo.removed).map((repo) => repo.name),
    repositoryNames: state.repositories.map((repo) => ({ name: repo.name, fullName: repo.fullName, ...(repo.removed ? { removed: true } : {}) })),
    accounts: state.accounts.map((account) => account.id),
    logins: Object.keys(state.logins),
    identities: state.identities.map((identity) => ({
      login: identity.login,
      secretNs: identity.secretNs,
      bots: state.bots.filter((bot) => bot.identity === identity.secretNs).map((bot) => bot.name),
    })),
  });

  const facts: import('./signins.js').SignInFacts = {
    secret: async (ref) => state.secrets[ref] ?? null,
    folder: async (id) => state.logins[id] ?? null,
    credential: async (seat) => {
      const bot = state.bots.find((one) => one.slot === seat);
      const record = bot ? state.credentials[bot.name] : undefined;
      return record ? { githubLogin: record.githubLogin, githubUserId: record.githubUserId, authorizedAt: record.authorizedAt } : null;
    },
  };

  const audit: string[] = [];
  const target: RestoreTarget & import('./undo.js').UndoTarget = {
    secrets: {
      get: async (ref) => state.secrets[ref] ?? null,
      set: async (ref, value) => void (state.secrets[ref] = value),
      delete: async (ref) => void delete state.secrets[ref],
    },
    async transaction(fn) {
      const draft = clone(state);
      const secretsBefore = { ...state.secrets };
      const bot = (name: string) => {
        const found = draft.bots.find((one) => one.name === name);
        if (!found) throw new Error(`no bot named ${name} in this install`);
        return found;
      };
      const db: import('./undo.js').UndoDb = {
        setSetting: async (key, value) => {
          if (value === '') delete draft.settings[key];
          else draft.settings[key] = value;
        },
        replaceSpendingLimits: async (rows) => {
          draft.spendingLimits = rows.map((row) => ({ ...row }));
        },
        mergeSpendingLimits: async (rows) => {
          const merged = mergeCaps(draft.spendingLimits, rows);
          draft.spendingLimits = merged.next;
          for (const _cap of merged.changed) audit.push('spending.limit_changed');
        },
        putAccount: async (account, { keepCheck }) => {
          const next = { ...account, verifiedAt: keepCheck ? account.verifiedAt : null, verifyError: keepCheck ? account.verifyError : null };
          const at = draft.accounts.findIndex((one) => one.id === account.id);
          if (at >= 0) draft.accounts[at] = { ...next, createdAt: draft.accounts[at]!.createdAt };
          else draft.accounts.push(next);
        },
        // As live.ts writes it: the row with this full name (or the one named
        // `over`), keeping its name; a name another repository has, refused.
        putRepository: async (repo, owner, options) => {
          const ownerSeat = owner ? (draft.bots.find((one) => one.name === owner)?.slot ?? null) : null;
          const byFullName = (fullName: string) => draft.repositories.findIndex((one) => one.fullName.toLowerCase() === fullName.toLowerCase());
          let at = byFullName(repo.fullName);
          if (at < 0 && options?.over) at = byFullName(options.over);
          if (at < 0) {
            const namesake = draft.repositories.find((one) => one.name.toLowerCase() === repo.name.toLowerCase());
            if (namesake) throw new BackupError(repositoryNameTaken(repo.fullName, namesake));
          }
          const here = draft.repositories[at];
          const next = { ...repo, name: here?.name ?? repo.name, ownerSeat, removed: false, color: repo.color ?? here?.color ?? 'blue' };
          if (at >= 0) draft.repositories[at] = next;
          else draft.repositories.push(next);
        },
        setBotLogin: async (name, login) => {
          const sharing = draft.identities.find((one) => one.login.toLowerCase() === login.toLowerCase())?.secretNs;
          for (const other of draft.bots) {
            if (other.name === name || other.githubLogin?.toLowerCase() !== login.toLowerCase()) continue;
            if (sharing && other.identity === sharing) continue;
            other.githubLogin = null;
            other.identity = null;
          }
          bot(name).githubLogin = login;
        },
        putIdentity: async (identity, names) => {
          const leaving = new Set(names.map((name) => bot(name).identity).filter((ns): ns is string => Boolean(ns)));
          let ns = draft.identities.find((one) => one.login.toLowerCase() === identity.login.toLowerCase())?.secretNs;
          if (!ns) {
            const holder = draft.identities.find((one) => one.secretNs === identity.secretNs);
            if (holder && draft.bots.some((one) => one.identity === holder.secretNs && !names.includes(one.name))) {
              throw new Error(`another account is filed under ${identity.secretNs}`);
            }
            draft.identities = draft.identities.filter((one) => one.secretNs !== identity.secretNs);
            draft.identities.push({ login: identity.login, githubUserId: identity.githubUserId, secretNs: identity.secretNs });
            ns = identity.secretNs;
          }
          for (const name of names) Object.assign(bot(name), { identity: ns, githubLogin: identity.login });
          draft.identities = draft.identities.filter(
            (one) => one.secretNs === ns || !leaving.has(one.secretNs) || draft.bots.some((other) => other.identity === one.secretNs),
          );
        },
        setLook: async (name, look) => void Object.assign(bot(name), look),
        setAssignment: async (name, assignment) => {
          Object.assign(bot(name), {
            engine: assignment.engine,
            model: assignment.model,
            modelAccountId: assignment.modelAccountId,
            modelSetAt: assignment.modelSetAt,
          });
        },
        putCredential: async (name, credential) => void (draft.credentials[name] = { ...credential }),
        putHistory: async (history) => {
          const ids = { threads: [] as string[], messages: [] as string[], requests: [] as string[], audit: [] as string[], ledger: [] as string[] };
          const seats = new Set(draft.bots.map((one) => one.slot));
          for (const thread of history.threads) {
            if (!seats.has(thread.seat) || draft.history.threads.some((one) => one.id === thread.id)) continue;
            draft.history.threads.push(thread);
            ids.threads.push(thread.id);
          }
          for (const message of history.messages) {
            if (!draft.history.threads.some((one) => one.id === message.threadId)) continue;
            if (draft.history.messages.some((one) => one.id === message.id)) continue;
            draft.history.messages.push(message);
            ids.messages.push(message.id);
          }
          for (const line of history.audit) {
            if (auditHere(draft.history, line)) continue;
            serial += 1;
            draft.history.audit.push({ ...line, at: storedAt(line.at), target: `${line.target}#${serial}` });
            ids.audit.push(String(serial));
          }
          for (const row of history.ledger) {
            if (!seats.has(row.seat) || ledgerHere(draft.history, row)) continue;
            serial += 1;
            draft.history.ledger.push({ ...row, at: storedAt(row.at), promptHash: String(serial) });
            ids.ledger.push(String(serial));
          }
          for (const request of history.requests) {
            if (!RESTORED_REQUEST_STATES.has(request.state)) continue;
            if (draft.history.requests.some((one) => one.id === request.id)) continue;
            draft.history.requests.push(request);
            ids.requests.push(request.id);
          }
          return {
            threads: ids.threads.length,
            messages: ids.messages.length,
            audit: ids.audit.length,
            ledger: ids.ledger.length,
            requests: ids.requests.length,
            ids,
          };
        },
        audit: async (entry) => void audit.push(entry.action),
        clearSetting: async (key) => void delete draft.settings[key],
        removeRepository: async (fullName) => {
          for (const repo of draft.repositories) if (repo.fullName.toLowerCase() === fullName.toLowerCase()) repo.removed = true;
        },
        removeAccount: async (id) => {
          const using = draft.bots.filter((one) => one.modelAccountId === id).map((one) => one.name);
          if (using.length === 0) draft.accounts = draft.accounts.filter((one) => one.id !== id);
          return using;
        },
        releaseLogin: async (name) => {
          const was = bot(name).identity;
          Object.assign(bot(name), { githubLogin: null, identity: null });
          if (was && !draft.bots.some((other) => other.identity === was)) {
            draft.identities = draft.identities.filter((one) => one.secretNs !== was);
          }
        },
        deleteCredential: async (name) => void delete draft.credentials[name],
        deleteHistory: async (ids) => {
          draft.history.messages = draft.history.messages.filter((one) => !ids.messages.includes(one.id));
          draft.history.threads = draft.history.threads.filter(
            (one) => !ids.threads.includes(one.id) || draft.history.messages.some((message) => message.threadId === one.id),
          );
          draft.history.requests = draft.history.requests.filter((one) => !ids.requests.includes(one.id));
          draft.history.audit = draft.history.audit.filter((one) => !ids.audit.some((id) => one.target.endsWith(`#${id}`)));
          draft.history.ledger = draft.history.ledger.filter((one) => !ids.ledger.includes(one.promptHash ?? ''));
        },
      };
      try {
        const result = await fn(db);
        // Rows commit; the secrets were written to the live state as they went.
        state = { ...draft, secrets: state.secrets, logins: state.logins };
        return result;
      } catch (error) {
        state.secrets = secretsBefore;
        throw error;
      }
    },
    forgetCheck: async () => undefined,
    recordCheck: async () => undefined,
    forgetLogin: async (id) => void delete state.logins[id],
  };

  /** Adopting a subscription's folder writes it where the account keeps it, as hostd does. */
  const adopt = (files: LoginFiles, accountId: string) => void (state.logins[accountId] = files);

  /** How many of an archive's history rows are here, found the way `putHistory` finds them, as `readHistoryHere` does. */
  const historyHere = (history: ArchivedHistory): import('./compare.js').HistoryHere => ({
    threads: history.threads.filter((thread) => state.history.threads.some((one) => one.id === thread.id)).length,
    messages: history.messages.filter((message) => state.history.messages.some((one) => one.id === message.id)).length,
    audit: history.audit.filter((line) => auditHere(state.history, line)).length,
    ledger: history.ledger.filter((row) => ledgerHere(state.history, row)).length,
    requests: history.requests.filter((request) => state.history.requests.some((one) => one.id === request.id)).length,
  });

  return { view, shape, facts, target, adopt, audit, historyHere, state: () => clone(state) };
}
