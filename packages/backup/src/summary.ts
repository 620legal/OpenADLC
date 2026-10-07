import { accessTokenRef, appPrivateKeyRef, modelAccountRef, refreshTokenRef, registryTokenRef, signingKeyRef, webhookSecretRef } from '@fleetadlc/github';
import type { ArchivedAccount, BackupContents, BackupManifest, FormatVersion } from './archive.js';
import { isGitHubRefreshTokenRef, signsInByFolder } from './contents.js';
import { nameForLogin, sameLogin, stepNamed } from '@fleetadlc/shared';
import { ADD_THE_SEAT, archivedIdentities, archivedSeat, carriesSignIns, type AccountInArchive, type RestorePlan } from './plan.js';
import type { SignInLine, SignInState } from './signins.js';

/**
 * What an archive holds and what a restore would do, said by name.
 *
 * Refs, keys, seats, handles and labels only. A value never appears here, and
 * never appears anywhere else either: printing one would put the App private
 * key in a scrollback buffer, which is most of the way to putting it in a
 * screenshot. The CLI prints the text forms; the bridge sends the structured
 * ones to the console, which draws them.
 */

/** `1 secret`, not `1 secrets`: these lines are read by a person under pressure. */
export function counted(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}

/**
 * What `fleetadlc backup` says about sign-ins, every time: the fact about them
 * that decides whether taking them was right.
 */
export const SIGN_IN_ROTATION =
  'GitHub rotates a sign-in each time it is used, so restoring one moves it to the new install: right when the old install is gone; if the old one keeps running, one of the two will need reconnecting.';

/** What `fleetadlc backup` says when the sign-ins were left out. */
export function describeOmittedRefreshTokens(refs: string[]): string[] {
  const lines = [
    'The GitHub sign-ins are left out, so each bot connects again after a restore. Include them when the old install is going away.',
  ];
  if (refs.length > 0) lines.push(`Not stored: ${refs.join(', ')}.`);
  return lines;
}

/**
 * What `fleetadlc restore` says about refresh tokens an archive carries without
 * its maker having chosen them — one written before that was a choice. Naming
 * them shows they were passed over on purpose rather than lost.
 */
export function describeUnrestoredRefreshTokens(refs: string[]): string[] {
  const lines = [
    'Refresh tokens in an archive made before sign-ins could be chosen are a snapshot the live install has since invalidated, so they are not restored.',
  ];
  if (refs.length > 0) lines.push(`Not restored: ${refs.join(', ')}.`);
  return lines;
}

/** Where a bot's own login is written in a line: `builder (fleetadlc-atlas-janedoe) as fleetadlc-atlas-janedoe`. */
function botLine(bot: { name: string; slot?: string; githubLogin: string | null }): string {
  const seat = archivedSeat(bot);
  const called = bot.name === seat ? seat : `${seat} (${bot.name})`;
  return `${called}${bot.githubLogin ? ` as ${bot.githubLogin}` : ' (no account connected)'}`;
}

/** `irisexampleco, for builder, intake and qa, with its sign-in`. */
function gitHubAccountLine(account: AccountInArchive, contents: BackupContents): string {
  const seats = account.seats.length === 1 ? account.seats[0] : `${account.seats.slice(0, -1).join(', ')} and ${account.seats[account.seats.length - 1]}`;
  return `${account.login}, for ${seats}, ${accountSignedIn(account, contents) ? 'with its sign-in' : 'without its sign-in'}`;
}

/** Whether an account's GitHub sign-in is in the archive to be restored: a non-expiring token, or a refresh token its maker chose. */
function accountSignedIn(account: Pick<AccountInArchive, 'from'>, contents: BackupContents): boolean {
  if (!account.from) return false;
  if (contents.secrets[accessTokenRef(account.from)] !== undefined) return true;
  return contents.secrets[refreshTokenRef(account.from)] !== undefined && carriesSignIns(contents);
}

function accountLine(account: ArchivedAccount): string {
  return `${account.label} (${account.provider} ${account.kind === 'key' ? 'API key' : 'subscription'})`;
}

/**
 * An archive described by name, for `fleetadlc backup` before it asks for a
 * passphrase and `fleetadlc restore` once it has one.
 */
export function describeContents(contents: BackupContents): string[] {
  const secrets = Object.keys(contents.secrets).sort();
  const lines = [`${counted(secrets.length, 'secret')}:`];
  for (const ref of secrets) lines.push(`  ${ref}`);

  const settings = Object.keys(contents.settings).sort();
  lines.push('', `${counted(settings.length, 'setting')}:`);
  for (const key of settings) lines.push(`  ${key}`);

  lines.push('', `${counted(contents.bots.length, 'bot')}:`);
  for (const bot of contents.bots) lines.push(`  ${botLine(bot)}`);

  // A line per GitHub account, not per seat: seats sharing one share its one
  // sign-in, and that is what a person is deciding about.
  const accounts = archivedIdentities(contents);
  if (accounts.length > 0) {
    lines.push('', `${counted(accounts.length, 'GitHub account')}:`);
    for (const account of accounts) lines.push(`  ${gitHubAccountLine(account, contents)}`);
  }

  if (contents.manifest.version >= 2) {
    const repositories = contents.repositories ?? [];
    lines.push('', `${counted(repositories.length, 'repository').replace(/repositorys$/, 'repositories')}:`);
    for (const repo of repositories) lines.push(`  ${repo.fullName}`);

    const accounts = contents.accounts ?? [];
    lines.push('', `${counted(accounts.length, 'model account')}:`);
    for (const account of accounts) {
      const folder = contents.logins?.[account.id] ? ', with its sign-in folder' : '';
      lines.push(`  ${accountLine(account)}${folder}`);
    }

    const history = contents.history;
    lines.push('', history ? `history: ${historyLine(history)}` : 'no history');
  }
  return lines;
}

function historyLine(history: NonNullable<BackupContents['history']>): string {
  return [
    counted(history.threads.length, 'thread'),
    counted(history.messages.length, 'message'),
    counted(history.audit.length, 'audit line'),
    counted(history.ledger.length, 'ledger row'),
    counted(history.requests.length, 'request'),
    ...(history.attachments ? [counted(history.attachments.length, 'attachment')] : []),
  ].join(', ');
}

/** What a restore can say before a passphrase has been asked for. */
export function describeManifest(manifest: BackupManifest): string[] {
  const { counts } = manifest;
  const lines = [
    `format version ${manifest.version}`,
    `made ${manifest.createdAt}`,
    `holds ${counted(counts.secrets, 'secret')}, ${counted(counts.settings, 'setting')}, ${counted(counts.bots, 'bot')}`,
  ];
  if (manifest.version >= 2) {
    lines.push(
      `and ${counted(counts.repositories ?? 0, 'repository').replace(/repositorys$/, 'repositories')}, ${counted(counts.accounts ?? 0, 'model account')}, ${counted(counts.logins ?? 0, 'sign-in folder')}`,
    );
    if (manifest.version >= 3) lines.push(`the bots sign in as ${counted(counts.identities ?? 0, 'GitHub account')}`);
    const includes = manifest.includes;
    if (includes) {
      lines.push(
        `GitHub sign-ins ${includes.botSignIns ? 'included' : 'left out'}; history ${includes.history ? 'included' : 'left out'}`,
      );
    }
  }
  return lines;
}

/** The plan by name, in the order it will be carried out. */
export function describePlan(plan: RestorePlan): string[] {
  const lines: string[] = [];
  const section = (title: string, entries: string[]): void => {
    if (entries.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(`${title} (${entries.length}):`);
    for (const entry of entries) lines.push(`  ${entry}`);
  };

  section('GitHub credentials of an account this replaces, which this would delete', plan.secrets.remove);
  section('secrets this would overwrite', plan.secrets.overwrite);
  section('secrets this would add', plan.secrets.create);
  section('secrets never restored, because each install makes its own', plan.secrets.skipped);
  section('settings this would overwrite', plan.settings.overwrite);
  section('settings this would add', plan.settings.create);
  section('settings this install does not know, skipped', plan.settings.unknown);
  section('repositories this would overwrite', plan.repositories.overwrite);
  section('repositories this would add', plan.repositories.create);
  section('model accounts this would overwrite', plan.accounts.overwrite);
  section('model accounts this would add', plan.accounts.create);
  section('subscription sign-in folders this would overwrite', plan.logins.overwrite);
  section('subscription sign-in folders this would add', plan.logins.create);
  section('spending caps this would set', plan.spendingLimits);
  section(
    'bots that would get their account back',
    plan.bots.connect.map((bot) => `${bot.name} as ${bot.login}`),
  );
  section(
    'bots connected to a different account, which this would replace',
    plan.bots.replace.map((bot) => `${bot.name}: ${bot.from} becomes ${bot.to}`),
  );
  section('bots already on the account the archive names', plan.bots.unchanged);
  section(
    'bots whose GitHub sign-in this would restore',
    plan.bots.signIns.map((bot) => `${bot.name} as ${bot.login}`),
  );
  section(
    'bots that would take their account’s handle as their name',
    plan.bots.rename.map((bot) => `${bot.name} becomes ${bot.to}`),
  );
  section(
    'model assignments this would restore',
    plan.bots.assign.map((bot) => `${bot.name}: ${bot.model}${bot.modelAccountId ? ` on account ${bot.modelAccountId}` : ''}`),
  );
  section(
    'model assignments left as this install has them',
    plan.bots.keep.map((bot) => `${bot.name}: ${bot.reason}`),
  );
  section(`bots this install does not have, skipped — for each one’s seat, ${ADD_THE_SEAT}`, plan.bots.absent);
  section(
    'bots that will need to connect to GitHub again',
    plan.bots.deviceFlow.map((bot) => `${bot.name} as ${bot.login}`),
  );
  if (plan.history) {
    const { threads, messages, audit, ledger, requests, attachments, skipped } = plan.history;
    section('history this would add', [
      `${counted(threads, 'thread')}, ${counted(messages, 'message')}, ${counted(audit, 'audit line')}, ${counted(ledger, 'ledger row')}, ${counted(requests, 'request')}${attachments > 0 ? `, ${counted(attachments, 'attachment')}` : ''}`,
      ...(skipped > 0 ? [`${skipped} left out: they belong to seats this install does not have`] : []),
    ]);
  }

  return lines;
}

// ------------------------------------------------------------------ for a page

/** How an account's credential comes back, as a page says it. */
export type AccountCredential = 'key' | 'token' | 'sign-in' | 'none';

export interface HistoryCounts {
  threads: number;
  messages: number;
  audit: number;
  ledger: number;
  requests: number;
  /** Files given to the crew. Absent where none were counted. */
  attachments?: number;
}

/** What an archive holds, by group and name: what the walkthrough shows before anything is written. */
export interface ArchiveSummary {
  version: FormatVersion;
  createdAt: string;
  install: { settings: string[]; app: string[]; other: string[] };
  repositories: string[];
  bots: {
    seat: string;
    name: string;
    login: string | null;
    signingKey: boolean;
    /** Whether its GitHub sign-in is in the archive. */
    signIn: boolean;
    model: string | null;
  }[];
  /**
   * The GitHub accounts the bots sign in as, one line each however many seats
   * share it, and whether its sign-in is in the archive.
   */
  githubAccounts: { login: string; seats: string[]; signIn: boolean }[];
  /** Whether the maker chose the GitHub sign-ins; null for an archive from before that was a choice. */
  botSignIns: boolean | null;
  accounts: { id: string; label: string; provider: string; kind: string; credential: AccountCredential }[];
  accountSignIns: boolean | null;
  history: HistoryCounts | null;
}

const APP_SETTINGS: Record<string, string> = {
  githubClientId: 'client id',
  webhookSecret: 'webhook secret',
};

function credentialOf(account: ArchivedAccount, contents: BackupContents): AccountCredential {
  if (signsInByFolder(account)) return contents.logins?.[account.id] ? 'sign-in' : 'none';
  if (contents.secrets[modelAccountRef(account.id)] === undefined) return 'none';
  return account.kind === 'key' ? 'key' : 'token';
}

export function summarizeArchive(contents: BackupContents): ArchiveSummary {
  const githubAccounts = archivedIdentities(contents);
  // Whether a seat's sign-in is in the archive: its account's, wherever it is filed.
  const signedIn = (seat: string): boolean => {
    const account = githubAccounts.find((one) => one.seats.includes(seat));
    return account ? accountSignedIn(account, contents) : false;
  };
  const app = Object.keys(APP_SETTINGS)
    .filter((key) => contents.settings[key] !== undefined)
    .map((key) => APP_SETTINGS[key] as string);
  if (contents.secrets[webhookSecretRef()] !== undefined && !app.includes('webhook secret')) app.push('webhook secret');
  if (contents.secrets[appPrivateKeyRef()] !== undefined) app.unshift('private key');
  const other = contents.secrets[registryTokenRef()] !== undefined ? ['package registry token'] : [];

  const history = contents.history
    ? {
        threads: contents.history.threads.length,
        messages: contents.history.messages.length,
        audit: contents.history.audit.length,
        ledger: contents.history.ledger.length,
        requests: contents.history.requests.length,
        ...(contents.history.attachments ? { attachments: contents.history.attachments.length } : {}),
      }
    : null;

  return {
    version: contents.manifest.version,
    createdAt: contents.manifest.createdAt,
    install: {
      settings: Object.keys(contents.settings)
        .filter((key) => APP_SETTINGS[key] === undefined)
        .sort(),
      app,
      other,
    },
    repositories: (contents.repositories ?? []).map((repo) => repo.fullName),
    bots: contents.bots.map((bot) => ({
      seat: archivedSeat(bot),
      name: bot.name,
      login: bot.githubLogin,
      signingKey: contents.secrets[signingKeyRef(bot.name)] !== undefined,
      signIn: signedIn(archivedSeat(bot)),
      model: contents.manifest.version >= 2 ? bot.model : null,
    })),
    githubAccounts: githubAccounts.map((account) => ({
      login: account.login,
      seats: [...account.seats],
      signIn: accountSignedIn(account, contents),
    })),
    botSignIns: contents.manifest.includes ? contents.manifest.includes.botSignIns : null,
    accounts: (contents.accounts ?? []).map((account) => ({
      id: account.id,
      label: account.label,
      provider: account.provider,
      kind: account.kind,
      credential: credentialOf(account, contents),
    })),
    accountSignIns: contents.manifest.includes ? contents.manifest.includes.accountSignIns : null,
    history,
  };
}

/** What a restore will set up, by name, and what it leaves for a person. */
export interface RestoreSummary {
  settings: string[];
  app: string[];
  repositories: string[];
  accounts: {
    id: string;
    label: string;
    credential: AccountCredential;
    /** What becomes of its credential, when the archive carries one. */
    signIn: SignInState | null;
    reason: string | null;
  }[];
  bots: {
    seat: string;
    /** What it is called now. */
    name: string;
    login: string | null;
    /** The handle it takes, when it will be connected. */
    becomes: string | null;
    /** Connected once this is done: it has an account, and a token for it that works. */
    signIn: boolean;
    signingKey: boolean;
    model: string | null;
    needsConnecting: boolean;
    /** What becomes of its GitHub sign-in, when the archive carries one. */
    signInState: SignInState | null;
    reason: string | null;
  }[];
  /** Every sign-in in the archive, with its verdict and what becomes of it. */
  signIns: SignInLine[];
  history: HistoryCounts | null;
  /** What the archive holds that this restore leaves out, and why. */
  skipped: string[];
  /** What is left for a person once it is done. */
  next: string[];
}

/** Whether a sign-in in this state leaves its bot or account able to act. */
function holds(state: SignInState | null | undefined): boolean {
  return state === 'restored' || state === 'same' || state === 'taken-over';
}

/** The words ending a line about a sign-in that did not come back, without a full stop of their own. */
function notBack(line: SignInLine): string {
  if (line.state === 'left-out') return 'it was left out of the restore';
  return (line.reason ?? 'it was not accepted').replace(/[.\s]+$/, '');
}

/**
 * What a restore sets up and what it leaves for a person, by name.
 *
 * `signIns` are the archive's sign-ins with what becomes of each — before a
 * restore, what will; after one, what did. A sign-in that is blocked, refused
 * or left out leaves its bot to be connected again, and says why.
 */
export function summarizeRestore(
  contents: BackupContents,
  plan: RestorePlan,
  crew: { name: string; slot: string }[],
  signIns: readonly SignInLine[] = [],
): RestoreSummary {
  const archive = summarizeArchive(contents);
  const needing = new Map(plan.bots.deviceFlow.map((bot) => [bot.name, bot.login]));
  const assigned = new Map(plan.bots.assign.map((bot) => [bot.name, bot.model]));
  const accounts = new Map((contents.accounts ?? []).map((account) => [account.id, account]));
  const keys = new Set([...plan.secrets.create, ...plan.secrets.overwrite]);
  const lines = new Map(signIns.map((line) => [line.key, line]));
  // A GitHub sign-in is the account's: every seat on it is found under the one line.
  const lineOf = (seat: string) => signIns.find((line) => line.provider === 'github' && line.seats.includes(seat));

  const bots: RestoreSummary['bots'] = [];
  const reconnect = new Set<string>();
  const notInBackup: { name: string; login: string }[] = [];
  for (const bot of contents.bots) {
    const seat = archivedSeat(bot);
    const live = crew.find((one) => one.slot === seat);
    if (!live) continue;
    const line = lineOf(seat);
    // Its own sign-in counts too: a seat whose archived one is blocked or left
    // out keeps this install's, and was told to connect again all the same.
    const connected = (line !== undefined && holds(line.state)) || (Boolean(bot.githubLogin) && !needing.has(live.name));
    const pending = line?.state === 'take-over';
    const needsConnecting = Boolean(bot.githubLogin) && !connected && !pending;
    // Seats sharing an account keep their seats' names, as the bridge names them.
    const shared = plan.identities.some((identity) => identity.names.length > 1 && identity.names.includes(live.name));
    const handle = bot.githubLogin ? (shared ? seat : nameForLogin(bot.githubLogin)) : null;
    bots.push({
      seat,
      name: live.name,
      login: bot.githubLogin,
      becomes: (connected || pending) && handle && handle !== live.name ? handle : null,
      signIn: Boolean(bot.githubLogin) && connected,
      signingKey: keys.has(signingKeyRef(live.name)),
      model: assigned.get(live.name) ?? null,
      needsConnecting,
      signInState: line?.state ?? null,
      reason: line && !holds(line.state) && !pending ? notBack(line) : null,
    });
    if (!needsConnecting || !bot.githubLogin) continue;
    // Once per account: connecting it once is connecting every seat on it.
    if (line) reconnect.add(`Connect ${bot.githubLogin} to GitHub again: ${notBack(line)}.`);
    else if (!notInBackup.some((one) => one.login === bot.githubLogin)) notInBackup.push({ name: live.name, login: bot.githubLogin });
  }

  const skipped: string[] = [];
  if (plan.secrets.stale.length > 0) {
    skipped.push(
      `${counted(plan.secrets.stale.length, 'GitHub sign-in')} from before sign-ins could be chosen, which the old install has since replaced`,
    );
  }
  for (const name of plan.bots.absent) skipped.push(`${name}, whose seat this install does not have`);
  for (const bot of plan.bots.keep) skipped.push(`${bot.name}’s model assignment: ${bot.reason}`);
  for (const key of plan.settings.unknown) skipped.push(`the setting ${key}, which this version of OpenADLC does not know`);
  if (plan.history && plan.history.skipped > 0) {
    skipped.push(`${counted(plan.history.skipped, 'history row')} of seats this install does not have`);
  }

  const next: string[] = [];
  if (notInBackup.length > 0) {
    // Counted as accounts once one is shared: five seats on one are one to connect.
    const shared = plan.identities.some(
      (identity) => identity.names.length > 1 && notInBackup.some((one) => sameLogin(one.login, identity.login)),
    );
    // Not "Connect 2 GitHub accounts to GitHub".
    const connect = shared
      ? `Sign in again to ${counted(notInBackup.length, 'GitHub account')}`
      : `Connect ${counted(notInBackup.length, 'bot')} to GitHub`;
    next.push(
      `${connect} — ${notInBackup
        .map((bot) => bot.login)
        .join(', ')} — because ${notInBackup.length === 1 ? 'its sign-in was' : 'their sign-ins were'} not in the backup.`,
    );
  }
  next.push(...reconnect);

  const restoredAccounts = [...plan.accounts.create, ...plan.accounts.overwrite];
  const unsigned: string[] = [];
  const accountLines: RestoreSummary['accounts'] = [];
  for (const id of restoredAccounts) {
    const account = accounts.get(id);
    if (!account) continue;
    const line = lines.get(`account:${id}`);
    const archived = credentialOf(account, contents);
    const pending = line?.state === 'take-over';
    const back = line ? holds(line.state) || pending : archived !== 'none';
    accountLines.push({
      id,
      label: account.label,
      credential: back ? archived : 'none',
      signIn: line?.state ?? null,
      reason: line && !holds(line.state) && !pending ? notBack(line) : null,
    });
    if (back) continue;
    if (!line) {
      if (signsInByFolder(account)) unsigned.push(account.label);
      continue;
    }
    if (line.kind === 'subscription') next.push(`Sign in to ${account.label} again on ${stepNamed('models')}: ${notBack(line)}.`);
    else if (line.kind === 'claude-token') next.push(`Paste a new token for ${account.label} on ${stepNamed('models')}: ${notBack(line)}.`);
    else next.push(`Give ${account.label} a key that works on ${stepNamed('models')}: ${notBack(line)}.`);
  }
  if (unsigned.length > 0) {
    next.push(`Sign in to ${unsigned.join(', ')} on ${stepNamed('models')}: the sign-in folder was not in the backup.`);
  }
  // A bot's own engine key the provider refused is left out. When this
  // install has none of its own for the bot, nothing is left for it to think with.
  for (const line of signIns) {
    if (line.kind !== 'engine-key' || line.state !== 'blocked' || line.replaces) continue;
    next.push(`Give ${line.who} a model account on ${stepNamed('models')}: its own engine key was not restored, because ${notBack(line)}.`);
  }
  if (contents.settings.githubClientId !== undefined && !keys.has(appPrivateKeyRef())) {
    next.push(`Give the app its private key on ${stepNamed('app')}: the backup did not have one.`);
  }

  return {
    settings: [...plan.settings.create, ...plan.settings.overwrite].filter((key) => APP_SETTINGS[key] === undefined),
    app: archive.install.app,
    repositories: [...plan.repositories.create, ...plan.repositories.overwrite],
    accounts: accountLines,
    bots,
    signIns: [...signIns],
    history: plan.history
      ? {
          threads: plan.history.threads,
          messages: plan.history.messages,
          audit: plan.history.audit,
          ledger: plan.history.ledger,
          requests: plan.history.requests,
          ...(plan.history.attachments > 0 ? { attachments: plan.history.attachments } : {}),
        }
      : null,
    skipped,
    next,
  };
}

/** Refresh-token refs among a secret map's names. */
export function signInRefs(secrets: Record<string, string>): string[] {
  return Object.keys(secrets).filter(isGitHubRefreshTokenRef).sort();
}
