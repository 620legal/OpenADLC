import { BackupError, type ManifestIncludes } from './archive.js';

/**
 * What a person chose to back up.
 *
 * The groups are the ones a person thinks in, not the tables and refs they are
 * kept in: the install and its GitHub App, the repositories, the crew (all of
 * it or some bots, by seat), the model accounts (all or some, by id), and the
 * history. Two of them have a second tick, because what they carry behaves
 * differently from everything else once it is copied.
 *
 * A bot's GitHub sign-in is a refresh token, and GitHub rotates it every time
 * it is used. The copy in an archive is only good until one of the installs
 * holding it refreshes: restoring it moves the sign-in to the new install,
 * which is exactly right when the old install is gone and exactly wrong when it
 * keeps running — then one of the two will need reconnecting. A subscription's
 * sign-in folder rotates the same way. So both are ticks of their own, on by
 * default only when the whole install is being backed up, which is when a
 * person is most likely moving it rather than copying part of it.
 */
export interface BackupSelection {
  /**
   * The install's settings, the GitHub App's client id, private key and webhook
   * secret, the package registry token, and the attribution key the crew's
   * posts are signed with.
   */
  install: boolean;
  /** Every repository and its settings. */
  repositories: boolean;
  /** Every bot, or the chosen seats. `[]` is none. */
  bots: 'all' | string[];
  /** Each chosen bot's GitHub sign-in. */
  botSignIns: boolean;
  /** Every model account, or the chosen ids. `[]` is none. */
  accounts: 'all' | string[];
  /** Each chosen OpenAI or xAI subscription's sign-in folder. */
  accountSignIns: boolean;
  /** Threads, the audit log, the cost ledger and requests. */
  history: boolean;
}

/** The whole install, which is what `fleetadlc backup` takes unless told otherwise. History is still asked for. */
export const EVERYTHING: BackupSelection = {
  install: true,
  repositories: true,
  bots: 'all',
  botSignIns: true,
  accounts: 'all',
  accountSignIns: true,
  history: false,
};

/** Whether this is the whole install: every group, every bot, every account. History does not count either way. */
export function isEverything(selection: Pick<BackupSelection, 'install' | 'repositories' | 'bots' | 'accounts'>): boolean {
  return selection.install && selection.repositories && selection.bots === 'all' && selection.accounts === 'all';
}

/**
 * Whether the sign-ins come along when nobody has said: yes for the whole
 * install, no for part of it. See `BackupSelection`.
 */
export function signInsByDefault(selection: Pick<BackupSelection, 'install' | 'repositories' | 'bots' | 'accounts'>): boolean {
  return isEverything(selection);
}

/** Whether anything at all was chosen. */
export function choosesAnything(selection: BackupSelection): boolean {
  return (
    selection.install ||
    selection.repositories ||
    selection.bots === 'all' ||
    selection.bots.length > 0 ||
    selection.accounts === 'all' ||
    selection.accounts.length > 0 ||
    selection.history
  );
}

function extent(choice: 'all' | string[], total: number): 'all' | 'some' | 'none' {
  if (choice === 'all') return total === 0 ? 'none' : 'all';
  if (choice.length === 0) return 'none';
  return choice.length >= total ? 'all' : 'some';
}

/** What the manifest records about the choice: flags, never names. */
export function includesOf(
  selection: BackupSelection,
  totals: { bots: number; accounts: number },
): ManifestIncludes {
  const bots = extent(selection.bots, totals.bots);
  const accounts = extent(selection.accounts, totals.accounts);
  return {
    install: selection.install,
    repositories: selection.repositories,
    bots,
    botSignIns: bots !== 'none' && selection.botSignIns,
    accounts,
    accountSignIns: accounts !== 'none' && selection.accountSignIns,
    history: selection.history,
  };
}

function flag(value: unknown, what: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BackupError(`${what} must be true or false`);
  return value;
}

function choice(value: unknown, what: string, known: readonly string[], noun: string): 'all' | string[] {
  if (value === undefined || value === null) return [];
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BackupError(`${what} must be "all" or a list`);
  }
  const chosen = [...new Set(value as string[])];
  const unknown = chosen.filter((item) => !known.includes(item));
  if (unknown.length > 0) throw new BackupError(`this install has no ${noun} ${unknown.join(', ')}`);
  return chosen;
}

/**
 * A selection as a request carries it, checked against the install it is for:
 * every seat and every account id must be one it has. A sign-in tick that was
 * not sent takes the default for what was chosen.
 */
export function selectionFrom(input: unknown, install: { seats: readonly string[]; accounts: readonly string[] }): BackupSelection {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BackupError('say what to back up');
  }
  const body = input as Record<string, unknown>;
  const partial = {
    install: flag(body.install, 'install') ?? false,
    repositories: flag(body.repositories, 'repositories') ?? false,
    bots: choice(body.bots, 'bots', install.seats, 'seat'),
    accounts: choice(body.accounts, 'accounts', install.accounts, 'model account'),
  };
  const byDefault = signInsByDefault(partial);
  const selection: BackupSelection = {
    ...partial,
    botSignIns: flag(body.botSignIns, 'botSignIns') ?? byDefault,
    accountSignIns: flag(body.accountSignIns, 'accountSignIns') ?? byDefault,
    history: flag(body.history, 'history') ?? false,
  };
  if (!choosesAnything(selection)) throw new BackupError('choose something to back up');
  return selection;
}
