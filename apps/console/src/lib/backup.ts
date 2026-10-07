import { botLabel, type BotLabel } from './bot-label';
import { countWords } from './crew';

/**
 * Backing the install up, and restoring one from a backup, in the words the
 * Settings card and the walkthrough use.
 *
 * What goes in an archive and how it comes back is decided by the bridge —
 * the same code `fleetadlc backup` runs — and it answers with names, never values.
 * These are its answers' shapes, and the choice a person makes on the card, so
 * the card can say what it will download before anything is downloaded.
 */

/** What the bridge offers to back up, by name. */
export interface BackupInventory {
  install: { settings: string[]; app: { clientId: boolean; privateKey: boolean; webhookSecret: boolean } };
  repositories: { name: string; fullName: string }[];
  bots: {
    seat: string;
    name: string;
    role: string;
    login: string | null;
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
    stored: boolean | null;
  }[];
  history: HistoryCounts;
}

export interface HistoryCounts {
  threads: number;
  messages: number;
  audit: number;
  ledger: number;
  requests: number;
  /** Files given to the crew. Absent from an older bridge. */
  attachments?: number;
}

/**
 * What a person chose. The two sign-in ticks are null until somebody touches
 * them, and until then they follow the rule the bridge and `fleetadlc backup` use:
 * on for the whole install, off for part of it.
 */
export interface BackupChoice {
  install: boolean;
  repositories: boolean;
  /** Every bot, or the chosen seats. */
  bots: 'all' | string[];
  botSignIns: boolean | null;
  /** Every model account, or the chosen ids. */
  accounts: 'all' | string[];
  accountSignIns: boolean | null;
  history: boolean;
}

/** Where the card starts: the whole install, sign-ins following it, history left for the asking. */
export const WHOLE_INSTALL: BackupChoice = {
  install: true,
  repositories: true,
  bots: 'all',
  botSignIns: null,
  accounts: 'all',
  accountSignIns: null,
  history: false,
};

export const SIGN_IN_WHY =
  'GitHub rotates a sign-in each time it is used, so restoring one moves it to the new install. That is right when this install is going away; if it keeps running, one of the two will need reconnecting.';

export const SIGN_IN_DEFAULT = 'On by default when you back up everything, off when you choose part of it.';

/** Whether this is the whole install: every group, every bot, every account. */
export function isWholeInstall(choice: Pick<BackupChoice, 'install' | 'repositories' | 'bots' | 'accounts'>): boolean {
  return choice.install && choice.repositories && choice.bots === 'all' && choice.accounts === 'all';
}

/** Whether a sign-in tick is on, by a person's say or by the rule. */
export function signInsOn(choice: BackupChoice, which: 'botSignIns' | 'accountSignIns'): boolean {
  return choice[which] ?? isWholeInstall(choice);
}

export function chosenSeats(choice: BackupChoice, inventory: Pick<BackupInventory, 'bots'>): string[] {
  return choice.bots === 'all' ? inventory.bots.map((bot) => bot.seat) : choice.bots;
}

export function chosenAccounts(choice: BackupChoice, inventory: Pick<BackupInventory, 'accounts'>): string[] {
  return choice.accounts === 'all' ? inventory.accounts.map((account) => account.id) : choice.accounts;
}

/** Ticks or unticks one of a list, and calls it "all" when that is what it is. */
function toggled(current: 'all' | string[], every: readonly string[], item: string): 'all' | string[] {
  const list = current === 'all' ? [...every] : [...current];
  const next = list.includes(item) ? list.filter((one) => one !== item) : [...list, item];
  const ordered = every.filter((one) => next.includes(one));
  return ordered.length === every.length && every.length > 0 ? 'all' : ordered;
}

export function toggleSeat(choice: BackupChoice, inventory: Pick<BackupInventory, 'bots'>, seat: string): BackupChoice {
  return { ...choice, bots: toggled(choice.bots, inventory.bots.map((bot) => bot.seat), seat) };
}

export function toggleAccount(choice: BackupChoice, inventory: Pick<BackupInventory, 'accounts'>, id: string): BackupChoice {
  return { ...choice, accounts: toggled(choice.accounts, inventory.accounts.map((account) => account.id), id) };
}

/** A bot as the card names it: its handle and role once connected, its role until then. */
export function backupBotLabel(bot: BackupInventory['bots'][number]): BotLabel {
  return botLabel({ name: bot.name, slot: bot.seat, role: bot.role, githubLogin: bot.login, connected: bot.signIn !== null });
}

function words(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function appParts(app: BackupInventory['install']['app']): string[] {
  return [app.clientId && 'client id', app.privateKey && 'private key', app.webhookSecret && 'webhook secret'].filter(
    (part): part is string => Boolean(part),
  );
}

/**
 * What the download will hold, in a line per group: names and counts, never
 * a value. The last line says what is left out, so nothing is assumed.
 */
export function summaryLines(inventory: BackupInventory, choice: BackupChoice): string[] {
  const lines: string[] = [];
  const left: string[] = [];

  if (choice.install) {
    const app = appParts(inventory.install.app);
    lines.push(
      `The install’s ${countWords(inventory.install.settings.length, 'setting').toLowerCase()}${app.length > 0 ? `, and the app’s ${words(app)}` : ''}`,
    );
  } else left.push('the install and its app');

  if (choice.repositories && inventory.repositories.length > 0) {
    lines.push(
      `${countWords(inventory.repositories.length, 'repository').replace(/repositorys$/, 'repositories')}: ${inventory.repositories.map((repo) => repo.fullName).join(', ')}`,
    );
  } else if (!choice.repositories) left.push('the repositories');

  const seats = chosenSeats(choice, inventory);
  if (seats.length > 0) {
    const bots = inventory.bots.filter((bot) => seats.includes(bot.seat));
    const named = choice.bots === 'all' ? '' : ` — ${bots.map((bot) => backupBotLabel(bot).name).join(', ')}`;
    const signIns = signInsOn(choice, 'botSignIns');
    const connected = bots.filter((bot) => bot.signIn !== null).length;
    lines.push(
      `${choice.bots === 'all' ? 'Every bot' : countWords(bots.length, 'bot')}${named}${signIns ? (connected > 0 ? `, with ${connected === bots.length ? 'their' : `${connected} of their`} GitHub sign-ins` : '') : ', without their GitHub sign-ins'}`,
    );
  } else left.push('the crew');

  const ids = chosenAccounts(choice, inventory);
  if (ids.length > 0) {
    const accounts = inventory.accounts.filter((account) => ids.includes(account.id));
    const folders = accounts.filter((account) => account.credential === 'sign-in');
    const signIns = signInsOn(choice, 'accountSignIns');
    const withFolders =
      folders.length === 0 ? '' : signIns ? `, with ${countWords(folders.length, 'subscription sign-in').toLowerCase()}` : ', without the subscription sign-ins';
    lines.push(`${countWords(accounts.length, 'model account')}: ${accounts.map((account) => account.label).join(', ')}${withFolders}`);
  } else if (inventory.accounts.length > 0) left.push('the model accounts');

  if (choice.history) {
    // The files given to the crew too: the archive carries each one in full.
    const { threads, messages, audit, ledger, requests, attachments } = inventory.history;
    const counted = [
      countWords(threads, 'thread'),
      countWords(messages, 'message'),
      countWords(audit, 'audit line'),
      countWords(ledger, 'cost'),
      countWords(requests, 'request'),
      ...(attachments ? [countWords(attachments, 'attachment')] : []),
    ].map((one) => one.toLowerCase());
    lines.push(`History: ${counted.slice(0, -1).join(', ')} and ${counted.at(-1)}`);
  } else left.push('the history');

  if (left.length > 0) lines.push(`Not included: ${words(left)}.`);
  return lines;
}

/**
 * Below this, a passphrase is warned about and the download still goes ahead.
 * A copy of `PASSPHRASE_ADVISED_LENGTH` in packages/backup/src/archive.ts, with
 * the same number and words: the console cannot import that package, which
 * uses node:crypto.
 */
export const PASSPHRASE_ADVISED_LENGTH = 12;

/** What is said under the fields about a passphrase shorter than 12 characters, or null. The backup package's words. */
export function passphraseWarning(passphrase: string): string | null {
  // By code point, as the normalised form scrypt is given.
  if ([...passphrase.normalize('NFC')].length >= PASSPHRASE_ADVISED_LENGTH) return null;
  return 'Shorter than 12 characters: anyone who gets this file can guess a short passphrase offline, and it holds the app’s private key and every sign-in. Use a generated one, or three or four random words.';
}

/** Lowercase Crockford base32, as the backup package's generator uses. */
const PASSPHRASE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A strong passphrase, the backup package's shape: 25 random symbols of 32 in
 * five groups of five, 125 bits. From the browser's `crypto.getRandomValues`.
 */
export function generatePassphrase(): string {
  const bytes = new Uint8Array(25);
  crypto.getRandomValues(bytes);
  const symbols = Array.from(bytes, (byte) => PASSPHRASE_ALPHABET[byte & 31]).join('');
  return (symbols.match(/.{5}/g) ?? []).join('-');
}

/** Why the download cannot start yet, or null. A short passphrase is not a reason: it is warned about separately. */
export function downloadProblem(choice: BackupChoice, inventory: BackupInventory, passphrase: string, again: string): string | null {
  const anything =
    choice.install ||
    (choice.repositories && inventory.repositories.length > 0) ||
    chosenSeats(choice, inventory).length > 0 ||
    chosenAccounts(choice, inventory).length > 0 ||
    choice.history;
  if (!anything) return 'Choose something to back up.';
  if (passphrase.length === 0) return 'Give the backup a passphrase.';
  if (again.length === 0) return 'Type the passphrase again.';
  if (passphrase !== again) return 'The two passphrases do not match.';
  return null;
}

/** What the bridge is sent: the choice, with each sign-in tick as it stands, and the passphrase twice. */
export function backupRequest(choice: BackupChoice, passphrase: string, again: string) {
  return {
    selection: {
      install: choice.install,
      repositories: choice.repositories,
      bots: choice.bots,
      botSignIns: signInsOn(choice, 'botSignIns'),
      accounts: choice.accounts,
      accountSignIns: signInsOn(choice, 'accountSignIns'),
      history: choice.history,
    },
    passphrase,
    confirm: again,
  };
}

/** The file's name, as the bridge gave it, or the one it would have. */
export function backupFilename(disposition: string | null, now: Date = new Date()): string {
  const named = /filename="([^"]+)"/.exec(disposition ?? '')?.[1];
  return named && /^[\w.-]+$/.test(named) ? named : `fleetadlc-backup-${now.toISOString().slice(0, 10)}.fleetbak`;
}

// ------------------------------------------------------------------ restoring

/** Whether this install can be restored into, as the bridge says. */
export interface RestoreState {
  clean: boolean;
  setUp: string[];
}

export type AccountCredential = 'key' | 'token' | 'sign-in' | 'none';

/** What an archive holds, as the bridge read it. */
export interface ArchiveSummary {
  version: number;
  createdAt: string;
  install: { settings: string[]; app: string[]; other: string[] };
  repositories: string[];
  bots: { seat: string; name: string; login: string | null; signingKey: boolean; signIn: boolean; model: string | null }[];
  /** The GitHub accounts, one each however many seats share it. Absent from a bridge older than shared accounts. */
  githubAccounts?: { login: string; seats: string[]; signIn: boolean }[];
  botSignIns: boolean | null;
  accounts: { id: string; label: string; provider: string; kind: string; credential: AccountCredential }[];
  accountSignIns: boolean | null;
  history: HistoryCounts | null;
}

/** What each verdict on a sign-in is called. The bridge decides them; this names them. */
export type SignInVerdict =
  | { state: 'same' }
  | { state: 'works'; said: string }
  | { state: 'blocked'; reason: string }
  | { state: 'check-by-use' };

export type SignInState = 'restored' | 'same' | 'take-over' | 'taken-over' | 'refused' | 'blocked' | 'left-out';

/** One sign-in in a backup, judged: whose it is, its verdict, whether it is ticked, and what becomes of it. */
export interface SignInLine {
  key: string;
  kind: 'github-refresh' | 'github-token' | 'api-key' | 'claude-token' | 'subscription' | 'engine-key';
  /** Null only for a bot's engine key when its engine has no provider to check it with. */
  provider: 'github' | 'anthropic' | 'openai' | 'xai' | null;
  seat: string | null;
  /** Every seat a GitHub sign-in signs in: several when they share the account, which is one sign-in. */
  seats?: string[];
  accountId: string | null;
  who: string;
  rotates: boolean;
  replaces: boolean;
  verdict: SignInVerdict;
  chosen: boolean;
  state: SignInState;
  reason: string | null;
}

export const VERDICT_WORDS: Record<SignInVerdict['state'], string> = {
  same: 'Same as this install’s',
  works: 'Works',
  blocked: 'Cannot be restored',
  'check-by-use': 'Can only be checked by using it',
};

export const GITHUB_TAKE_OVER =
  'Checking a GitHub sign-in uses it — if it works, this install takes it over from wherever else it is in use.';

export const SUBSCRIPTION_TAKE_OVER =
  'Checking a subscription’s sign-in uses it — if it works, this install takes it over from wherever else it is in use.';

/** Whether a sign-in can be ticked: one that works, or one that can only be checked by using it. */
export function choosable(line: Pick<SignInLine, 'verdict'>): boolean {
  return line.verdict.state === 'works' || line.verdict.state === 'check-by-use';
}

/** What a restore sets up, and what it leaves for a person. */
export interface RestoreSummary {
  settings: string[];
  app: string[];
  repositories: string[];
  accounts: { id: string; label: string; credential: AccountCredential; signIn: SignInState | null; reason: string | null }[];
  bots: {
    seat: string;
    name: string;
    login: string | null;
    becomes: string | null;
    signIn: boolean;
    signingKey: boolean;
    model: string | null;
    needsConnecting: boolean;
    signInState: SignInState | null;
    reason: string | null;
  }[];
  signIns: SignInLine[];
  history: HistoryCounts | null;
  skipped: string[];
  next: string[];
}

export interface RestorePreview {
  sealed: boolean;
  holds: ArchiveSummary;
  restores: RestoreSummary;
  /** Every sign-in in the backup, judged, with what is ticked to begin with. */
  signIns: SignInLine[];
}

export interface RestoreResult {
  restored: RestoreSummary;
  /** Every sign-in in the backup, and what became of it. */
  signIns: SignInLine[];
  renames: { name: string; to: string; state: string; reason?: string }[];
}

/** What is ticked to begin with, by sign-in. */
export function choicesOf(lines: readonly SignInLine[]): Record<string, boolean> {
  return Object.fromEntries(lines.map((line) => [line.key, line.chosen]));
}

/**
 * A sign-in by whose it is: a bot's by its role and account, an account's by
 * its label, a GitHub account several seats share by the account and how
 * many seats — it is one sign-in, however many seats use it — and a bot's
 * own engine key by the bot.
 */
export function signInName(line: Pick<SignInLine, 'seat' | 'who' | 'provider' | 'seats'> & Partial<Pick<SignInLine, 'kind'>>): string {
  if (line.kind === 'engine-key') return `${line.who} (engine key)`;
  if (line.provider === 'github' && line.seats && line.seats.length > 1) return `${line.who}, shared by ${line.seats.length} seats`;
  if (line.provider !== 'github' || !line.seat) return line.who;
  const role = botLabel({ name: line.seat, slot: line.seat }).role;
  const title = role ? role.charAt(0).toUpperCase() + role.slice(1) : line.seat;
  return `${title} as ${line.who}`;
}

/** What a sign-in's verdict says beside its name, before a restore. */
export function verdictLine(line: SignInLine): string {
  const { verdict } = line;
  if (verdict.state === 'works') return `${VERDICT_WORDS.works} — ${verdict.said}`;
  if (verdict.state === 'blocked') return `${VERDICT_WORDS.blocked} — ${verdict.reason}`;
  if (verdict.state === 'same') return `${VERDICT_WORDS.same} — nothing to do`;
  return VERDICT_WORDS['check-by-use'];
}

/** What became of a sign-in, once a restore is done. */
export function outcomeLine(line: SignInLine): string {
  const name = signInName(line);
  switch (line.state) {
    case 'restored':
      return `${name}: restored, and it works`;
    case 'taken-over':
      return `${name}: checked by using it, and taken over`;
    case 'same':
      return `${name}: the same as this install’s already`;
    case 'refused':
      return `${name}: not restored — ${line.reason ?? 'it was not accepted'}`;
    case 'blocked':
      return `${name}: not restored — ${line.reason ?? 'expired or refused'}`;
    case 'left-out':
      return `${name}: left out`;
    case 'take-over':
      return `${name}: to be checked by using it`;
  }
}

/** `1 thread`, `13 audit lines`: counts in the middle of a line. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A history's rows in one line. */
export function historyLine(history: HistoryCounts): string {
  return `History: ${words([
    plural(history.threads, 'thread'),
    plural(history.messages, 'message'),
    plural(history.audit, 'audit line'),
    plural(history.ledger, 'cost'),
    plural(history.requests, 'request'),
    ...(history.attachments ? [plural(history.attachments, 'attachment')] : []),
  ])}`;
}

/** What is set up, in one sentence: "the GitHub App, 3 bots connected to GitHub and 2 model accounts". */
export function setUpSentence(state: RestoreState): string {
  return words(state.setUp);
}

/** "made 24 September 2026", from the archive's own clock. */
export function madeOn(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A bot in a restore, as the walkthrough names it: its role, and the account it will be. */
export function restoreBotLine(bot: RestoreSummary['bots'][number]): string {
  const role = botLabel({ name: bot.seat, slot: bot.seat }).role;
  const who = role ? role.charAt(0).toUpperCase() + role.slice(1) : bot.seat;
  if (!bot.login) return `${who}: no account`;
  if (bot.signInState === 'take-over') return `${who}: ${bot.login}, if its sign-in still works`;
  if (bot.needsConnecting) return `${who}: ${bot.login}, to connect again`;
  return `${who}: ${bot.login}, connected`;
}

/** The archive, in a few lines a person checks before restoring. */
export function holdsLines(holds: ArchiveSummary): string[] {
  const lines: string[] = [];
  if (holds.install.settings.length > 0 || holds.install.app.length > 0) {
    const app = holds.install.app.length > 0 ? `, and the app’s ${words(holds.install.app)}` : '';
    lines.push(`The install’s ${countWords(holds.install.settings.length, 'setting').toLowerCase()}${app}`);
  }
  if (holds.repositories.length > 0) {
    lines.push(`${countWords(holds.repositories.length, 'repository').replace(/repositorys$/, 'repositories')}: ${holds.repositories.join(', ')}`);
  }
  if (holds.bots.length > 0) {
    const signedIn = holds.bots.filter((bot) => bot.signIn).length;
    lines.push(
      `${countWords(holds.bots.length, 'bot')}${
        signedIn === 0
          ? ', without their GitHub sign-ins'
          : holds.bots.length === 1
            ? ', with its GitHub sign-in'
            : signedIn === holds.bots.length
              ? ', all with their GitHub sign-ins'
              : `, ${signedIn} with ${signedIn === 1 ? 'its GitHub sign-in' : 'their GitHub sign-ins'}`
      }`,
    );
  }
  // Said once seats share one: five seats on one account are one sign-in, not five.
  const github = holds.githubAccounts ?? [];
  if (github.some((account) => account.seats.length > 1)) {
    lines.push(
      `${countWords(github.length, 'GitHub account')}: ${github.map((account) => (account.seats.length > 1 ? `${account.login} (${account.seats.length} seats)` : account.login)).join(', ')}`,
    );
  }
  if (holds.accounts.length > 0) lines.push(`${countWords(holds.accounts.length, 'model account')}: ${holds.accounts.map((account) => account.label).join(', ')}`);
  if (holds.history) lines.push(historyLine(holds.history));
  return lines;
}

/** A chosen file, read for the bridge: base64, which is how the console's route carries it on. */
export function base64Of(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let at = 0; at < view.length; at += 0x8000) binary += String.fromCharCode(...view.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** Whether a file's first bytes say it is a sealed archive, which needs a passphrase. */
export function looksSealed(bytes: ArrayBuffer): boolean {
  return new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 8)) === 'FLEETBAK';
}

// ------------------------------------------------------------------ restoring into a set-up install

export type ItemState = 'new' | 'same' | 'different' | 'only-here';
export type CompareGroup = 'install' | 'repositories' | 'crew' | 'accounts' | 'sign-ins' | 'history';

/** One thing in a backup, beside this install's, as the bridge compared them. */
export interface CompareItem {
  key: string;
  group: CompareGroup;
  label: string;
  state: ItemState;
  differences: string[];
  takeable: boolean;
  take: boolean;
  note: string | null;
  dependsOn: string | null;
  seat?: string;
  seats?: string[];
  accounts?: { here: string | null; backup: string | null };
  verdict?: SignInVerdict;
  rotates?: boolean;
}

export interface Comparison {
  groups: { group: CompareGroup; items: CompareItem[] }[];
  choices: Record<string, boolean>;
}

/** The last restore into this install, while it can be undone. */
export interface UndoView {
  restoredAt: string;
  until: string;
  backupMadeAt: string;
  actor: string;
}

export interface IntoPreview {
  sealed: boolean;
  holds: ArchiveSummary;
  comparison: Comparison;
  undo: UndoView | null;
}

export interface RestoreJob {
  id: string;
  kind: 'restore' | 'undo';
  state: 'waiting' | 'applying' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  waitingFor: string[];
  error: string | null;
  result:
    | { summary: RestoreSummary; signIns: SignInLine[]; undoUntil: string }
    | {
        signIns: { key: string; who: string; state: 'restored' | 'taken-over' | 'same' | 'kept'; reason?: string }[];
        keptAccounts: { id: string; usedBy: string[] }[];
        keptSeats?: { seat: string; login: string | null; reason: string }[];
      }
    | null;
}

export const GROUP_TITLES: Record<CompareGroup, string> = {
  install: 'Install and GitHub App',
  repositories: 'Repositories',
  crew: 'Crew',
  accounts: 'Model accounts',
  'sign-ins': 'Sign-ins',
  history: 'History',
};

export const STATE_WORDS: Record<ItemState, string> = {
  new: 'new here',
  same: 'same',
  different: 'different',
  'only-here': 'only here',
};

/** Whether an item is taken with these choices: it can be, it is ticked, and what it goes with is taken. */
export function takenIn(comparison: Comparison, choices: Record<string, boolean>, key: string): boolean {
  const item = comparison.groups.flatMap((group) => group.items).find((one) => one.key === key);
  if (!item || !item.takeable) return false;
  if (!(choices[key] ?? item.take)) return false;
  return item.dependsOn ? takenIn(comparison, choices, item.dependsOn) : true;
}

/** An item whose choice is which of two GitHub accounts a seat is. */
export function isAccountChoice(item: CompareItem): boolean {
  return item.state === 'different' && Boolean(item.accounts?.here && item.accounts?.backup);
}

/** How many things a restore with these choices takes from the backup. */
export function takenCount(comparison: Comparison, choices: Record<string, boolean>): number {
  return comparison.groups.flatMap((group) => group.items).filter((item) => takenIn(comparison, choices, item.key)).length;
}

/** "25 September, 10:12", in the viewer's own zone. */
export function whenWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Where a restore or undo has got to, in a line. */
export function jobLine(job: RestoreJob): string {
  const what = job.kind === 'undo' ? 'the undo' : 'the restore';
  if (job.state === 'waiting') {
    if (job.waitingFor.length === 0) return `Starting ${what}…`;
    const names = job.waitingFor.length === 1 ? job.waitingFor[0] : `${job.waitingFor.slice(0, -1).join(', ')} and ${job.waitingFor.at(-1)}`;
    return `Waiting for ${names} to finish ${job.waitingFor.length === 1 ? 'its' : 'their'} work — nothing has been changed yet.`;
  }
  if (job.state === 'applying') {
    return job.kind === 'undo'
      ? 'Undoing: putting back what the restore changed, from the backup taken before it.'
      : 'Restoring: this install has been backed up first, and what you chose is being written. The dispatcher waits until it is done.';
  }
  if (job.state === 'failed') return `${job.kind === 'undo' ? 'The undo' : 'The restore'} did not finish: ${job.error ?? 'no reason was given'}`;
  return job.kind === 'undo' ? 'Undone: what the restore changed is as it was before.' : 'Restored.';
}
