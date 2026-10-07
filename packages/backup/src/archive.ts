import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from 'node:crypto';

/**
 * What an archive says it holds, in numbers.
 *
 * Version 1 counted three things. Version 2 carries what a person chose to
 * back up, so it counts each of those groups as well, as 0 when the group was
 * not chosen (`includes` says which were); only `attachments` may be absent.
 * Version 3 counts the GitHub accounts too.
 */
export interface ManifestCounts {
  secrets: number;
  settings: number;
  bots: number;
  repositories?: number;
  accounts?: number;
  /** Subscription sign-in folders. */
  logins?: number;
  threads?: number;
  messages?: number;
  audit?: number;
  ledger?: number;
  requests?: number;
  /** The GitHub accounts the crew signs in as. Version 3. */
  identities?: number;
  /**
   * Files given to the crew, in the history. Counted only by an archive that
   * carries them, so one written before them still reads as it was written.
   */
  attachments?: number;
}

/**
 * What was chosen when the archive was made — as flags, never as names.
 *
 * A restore reads this to know what the file means as well as what it holds:
 * a refresh token in an archive whose maker chose "GitHub sign-ins" is one to
 * put back; one in an archive written before anybody could choose is a
 * snapshot the live install has since invalidated.
 */
export interface ManifestIncludes {
  /** The install's settings and the GitHub App's credentials. */
  install: boolean;
  repositories: boolean;
  /** Every bot, some of them, or none. */
  bots: 'all' | 'some' | 'none';
  /** Each chosen bot's GitHub sign-in: its refresh token, or its non-expiring token. */
  botSignIns: boolean;
  accounts: 'all' | 'some' | 'none';
  /** Each chosen OpenAI or xAI subscription's sign-in folder. */
  accountSignIns: boolean;
  /** Threads, the audit log, the cost ledger and requests. */
  history: boolean;
}

/**
 * The cleartext part of an archive: enough to tell an operator what a file is,
 * and nothing more.
 *
 * Deliberately counts and flags only. Not the organization, not the GitHub
 * client id, not a bot login, not a secret's name and certainly not its value —
 * because this is the half of the file that anyone who has the file can read.
 * "Nine secrets, eight settings, nine bots, taken on Tuesday" is what somebody
 * staring at `fleetadlc-backup-2026-09-21.fleetbak` needs in order to know they
 * have the right file; who the install belongs to is not.
 */
export interface BackupManifest {
  /**
   * 1 for an archive written before a backup could be chosen; 2 since; 3 once
   * seats could share a GitHub account.
   */
  version: FormatVersion;
  createdAt: string;
  counts: ManifestCounts;
  /** Version 2 and later. */
  includes?: ManifestIncludes;
}

/** Every version of the contents this OpenADLC reads. */
export type FormatVersion = 1 | 2 | 3;

/** A bot's GitHub sign-in bookkeeping: the `bot_credentials` row, without the token it points at. */
export interface ArchivedCredential {
  githubLogin: string;
  githubUserId: number | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  refreshExpiresAt: string | null;
  signingKeyId: number | null;
  authorizedAt: string | null;
  status: 'unauthorized' | 'active' | 'expired' | 'revoked';
}

/**
 * A bot as an archive carries it.
 *
 * `slot` is the seat the bot sat in, which is what a restore finds the row
 * by: the name is the account's handle once one connects, and differs from
 * install to install. An archive written before seats existed has none, and
 * its persona names are read as the seats they were.
 *
 * The rest is version 2's: the model assignment — the model, the engine it is
 * thought with, the account whose credential it uses, and whether the console
 * chose it — and, when the sign-in came along, its bookkeeping.
 */
export interface ArchivedBot {
  name: string;
  slot?: string;
  githubLogin: string | null;
  engine: string;
  model: string | null;
  modelAccountId?: string | null;
  /** When the model was chosen in the console; null when it came from config/bots.yaml. */
  modelSetAt?: string | null;
  /**
   * How its avatar looks: the color and the avatar a person chose, null for
   * the default (its role's tint, its engine's mark). Absent from an archive
   * written before either could be chosen, which a restore leaves alone.
   */
  color?: string | null;
  avatar?: string | null;
  credential?: ArchivedCredential;
}

/**
 * A GitHub account the crew signs in as, and the seats that do: version 3's.
 *
 * Seats may share one account (migration 0014), and a shared account's
 * sign-in is one refresh token, filed once under the account's name
 * (`secretNs`) rather than under any seat's — GitHub rotates it on every use,
 * so nine copies of it would lock each other out. The archive carries that
 * one token under the same name, and this says which seats it belongs to. An
 * account used by one seat is here too, usually filed under that bot's name.
 *
 * An archive from before version 3 has none of these: each bot with a login
 * was an account of its own, its sign-in filed under the bot's name, and a
 * restore reads it that way (`archivedIdentities` in plan.ts).
 */
export interface ArchivedIdentity {
  login: string;
  githubUserId: number | null;
  /** The name its sign-in is filed under in `secrets`: `github-refresh-<secretNs>`. */
  secretNs: string;
  /** The seats that sign in as it, in the crew's order. */
  seats: string[];
}

/** A repository and how much the crew may do in it without asking. */
export interface ArchivedRepository {
  name: string;
  fullName: string;
  /** The seat of the bot that builds it, which is what stays put between installs. */
  ownerSeat: string | null;
  concurrency: number;
  stageModes: Record<string, string>;
  specRequiredLabels: string[];
  humanReviewPaths: string[];
  defaultBranch: string;
  /**
   * The colour the board tells it apart by, a name from the palette. Absent
   * from an archive written before repositories had one.
   */
  color?: string;
}

/**
 * A model account's row. Its credential, when it has one in the secret store —
 * a key, or a Claude subscription's token — travels in `secrets` under
 * `model-account-<id>`; an OpenAI or xAI subscription's sign-in travels in
 * `logins`, keyed by the same id.
 */
export interface ArchivedAccount {
  id: string;
  provider: 'anthropic' | 'openai' | 'xai';
  kind: 'key' | 'subscription';
  label: string;
  createdAt: string;
  verifiedAt: string | null;
  verifyError: string | null;
}

/** A subscription's sign-in folder: file name to its bytes, base64. */
export type LoginFiles = Record<string, string>;

export interface ArchivedThread {
  id: string;
  /** The seat of the bot the thread is with. */
  seat: string;
  /** The repository it is about, by name, or null. */
  repo: string | null;
  subjectRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchivedMessage {
  id: string;
  threadId: string;
  kind: string;
  author: string;
  text: string;
  note: string | null;
  payload: unknown;
  githubUrl: string | null;
  at: string;
}

export interface ArchivedAuditEntry {
  actor: string;
  action: string;
  target: string;
  payload: unknown;
  at: string;
}

export interface ArchivedLedgerEntry {
  /** The seat of the bot that spent it. */
  seat: string;
  engine: string;
  model: string;
  modelAlias: string | null;
  promptHash: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  at: string;
}

export interface ArchivedRequest {
  id: string;
  text: string;
  context: string | null;
  repo: string | null;
  kind: string | null;
  requestedBy: string;
  issueNumber: number | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A file given to the crew with a request or a message, or read from an issue
 * (migration 0029), with its bytes as base64. In the history because it is
 * what a request was about: a restored request whose screenshot was left
 * behind is a question nobody can answer.
 */
export interface ArchivedAttachment {
  id: string;
  subjectRef: string;
  repo: string | null;
  requestId: string | null;
  messageId: string | null;
  source: 'console' | 'github';
  sourceUrl: string | null;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  /** The file's bytes, base64. */
  content: string;
  uploadedBy: string;
  createdAt: string;
}

/**
 * One cap from `spending_limits`.
 *
 * A repository cap names the repository (`repository`), and a per-bot cap
 * names the bot (`bot`). The table's own `repo:<id>` and `month_bot:<id>`
 * are this install's ids: a restore onto a new install generates new ones,
 * and an archive that kept the old ids pointed at nothing.
 */
export interface ArchivedSpendingLimit {
  /** `global`, or `repo` when `repository` names one. An older archive may still say `repo:<id>`. */
  scope: string;
  /** Full name (`owner/name`) when the cap is one repository's. */
  repository?: string;
  /** `month_total`, `task`, `month_provider:<provider>`, or `month_bot` when `bot` names one. */
  kind: string;
  /**
   * The bot's slot when the cap is that bot's month. The slot stays when the
   * bot takes its GitHub login; the name does not. An older archive may still
   * say the name it had then.
   */
  bot?: string;
  amountUsd: number | null;
}

/** A cap as the archive carries it: repository and bot by name, when this install can say them. */
export function archiveSpendingLimit(
  row: { scope: string; kind: string; amountUsd: number | null },
  repos: readonly { id: string; fullName: string }[],
  bots: readonly { id: string; name: string; slot?: string }[],
): ArchivedSpendingLimit {
  const repoId = row.scope.startsWith('repo:') ? row.scope.slice('repo:'.length) : null;
  const repo = repoId ? repos.find((one) => one.id === repoId) : undefined;
  const botId = row.kind.startsWith('month_bot:') ? row.kind.slice('month_bot:'.length) : null;
  const bot = botId ? bots.find((one) => one.id === botId) : undefined;
  return {
    scope: repo ? 'repo' : row.scope,
    ...(repo ? { repository: repo.fullName } : {}),
    kind: bot ? 'month_bot' : row.kind,
    ...(bot ? { bot: bot.slot ?? bot.name } : {}),
    amountUsd: row.amountUsd,
  };
}

/**
 * The table's rows for this install. A repository or bot the install does not
 * have is left out: writing the old id would insert a cap nothing reads.
 */
export function resolveSpendingLimits(
  rows: readonly ArchivedSpendingLimit[],
  repos: readonly { id: string; fullName: string }[],
  bots: readonly { id: string; name: string; slot?: string }[],
): { scope: string; kind: string; amountUsd: number | null }[] {
  const repoByName = new Map(repos.map((repo) => [repo.fullName.toLowerCase(), repo.id]));
  const repoIds = new Set(repos.map((repo) => repo.id));
  const botIds = new Set(bots.map((bot) => bot.id));
  const botIdOf = (token: string): string | undefined =>
    bots.find((bot) => bot.slot === token)?.id ?? bots.find((bot) => bot.name === token)?.id;
  const out: { scope: string; kind: string; amountUsd: number | null }[] = [];
  for (const row of rows) {
    let scope = row.scope;
    if (row.repository) {
      const id = repoByName.get(row.repository.toLowerCase());
      if (!id) continue;
      scope = `repo:${id}`;
    } else if (scope.startsWith('repo:')) {
      const token = scope.slice('repo:'.length);
      if (repoIds.has(token)) scope = `repo:${token}`;
      else {
        const id = repoByName.get(token.toLowerCase());
        if (!id) continue;
        scope = `repo:${id}`;
      }
    }
    let kind = row.kind;
    if (row.bot) {
      const id = botIdOf(row.bot);
      if (!id) continue;
      kind = `month_bot:${id}`;
    } else if (kind.startsWith('month_bot:')) {
      const token = kind.slice('month_bot:'.length);
      if (botIds.has(token)) kind = `month_bot:${token}`;
      else {
        const id = botIdOf(token);
        if (!id) continue;
        kind = `month_bot:${id}`;
      }
    }
    out.push({ scope, kind, amountUsd: row.amountUsd });
  }
  return out;
}

/**
 * What happened on the install, for somebody who wants it on the next one.
 * Tasks are not part of it, so a ledger row comes back without the task it
 * was spent on.
 */
export interface ArchivedHistory {
  threads: ArchivedThread[];
  messages: ArchivedMessage[];
  audit: ArchivedAuditEntry[];
  ledger: ArchivedLedgerEntry[];
  requests: ArchivedRequest[];
  /** Absent from an archive written before attachments existed. */
  attachments?: ArchivedAttachment[];
}

/**
 * Everything worth carrying to a new machine.
 *
 * `secrets` is the part of the install's secret store the archive carries,
 * keyed by the same refs `SecretStore` uses: the GitHub App private key, the
 * package registry token, the attribution key the crew's posts are signed
 * with, each chosen bot's signing key (and its sign-in, when that was chosen),
 * each chosen model account's key or token. `settings` is the install settings
 * table. `bots` is the crew's shape, so a restore knows which logins and
 * engines to put back.
 *
 * The rest is version 2's, and absent from an archive written before it —
 * but for `identities` and `spendingLimits`, which are version 3's.
 */
export interface BackupContents {
  manifest: BackupManifest;
  /** secret ref -> value, e.g. "github-app-private-key" -> "-----BEGIN…" */
  secrets: Record<string, string>;
  /** setting key -> value, e.g. "organization" -> "janedoe" */
  settings: Record<string, string>;
  bots: ArchivedBot[];
  repositories?: ArchivedRepository[];
  accounts?: ArchivedAccount[];
  /** account id -> its sign-in folder */
  logins?: Record<string, LoginFiles>;
  history?: ArchivedHistory | null;
  /** The GitHub accounts the archived seats sign in as. Version 3. */
  identities?: ArchivedIdentity[];
  /**
   * Caps saved in Settings. Absent from an archive written before they
   * existed, and from one that did not include the install: a restore of
   * either leaves the caps already here. Present, including as an empty
   * list, it is the whole table.
   */
  spendingLimits?: ArchivedSpendingLimit[];
}

/**
 * Every failure this module produces, so a CLI can tell "you typed the wrong
 * passphrase" from "the process crashed". Node's crypto errors are the opposite
 * of that: a bad passphrase surfaces as `Unsupported state or unable to
 * authenticate data`, which reads like a bug in OpenADLC.
 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * The payload as one JSON string. V8 caps a string at about 536 million
 * characters, and attachments travel base64 inside it, so an install with
 * more than about 380 MiB of attachments in its history threw a bare
 * `RangeError: Invalid string length` here, which said nothing about what to
 * change.
 */
function serialize(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new BackupError(
        'this archive is too large to write in one piece: back up without history, or with less of it',
      );
    }
    throw error;
  }
}

/** The whole format family, so a `FLEETBAK2` file can be recognised as ours. */
const FAMILY = 'FLEETBAK';
/**
 * First line of every archive. A file that does not start with it is not ours.
 *
 * The container — two cleartext lines, then salt, IV, tag and ciphertext — is
 * the same for every version of the contents, so it keeps its name. What the
 * contents are is the manifest's `version`, which is authenticated with them.
 */
const MAGIC = `${FAMILY}1`;
/** What this version of OpenADLC writes. */
export const FORMAT_VERSION: FormatVersion = 3;
const READABLE_VERSIONS: readonly number[] = [1, 2, 3];

const SALT_BYTES = 16;
/** GCM's native nonce length; anything else makes Node hash the IV down to 12. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** aes-256. */
const KEY_BYTES = 32;

/**
 * The manifest is counts, flags and a timestamp, so it is a few hundred
 * bytes at most. The cap exists so that a file which merely *begins* with our magic
 * cannot make us scan gigabytes looking for a newline that is not there.
 */
const MAX_MANIFEST_BYTES = 1024;

/**
 * Key derivation cost.
 *
 * N = 2**17, r = 8, p = 1 measures ~0.3s on an M-series laptop, so it stays
 * inside the ~1s budget even on a machine two or three times slower — which is
 * the machine that matters, because this runs on whatever the operator is
 * holding when they restore. The point of the cost is that the passphrase is
 * human-chosen and the archive is a file somebody might copy to a USB stick or a
 * cloud drive: an attacker gets unlimited offline guesses, and 0.3s per guess is
 * what makes a guessing run expensive.
 *
 * scrypt needs roughly 128 * N * r bytes = 128 MiB here, and Node's default
 * `maxmem` is 32 MiB, so it throws `memory limit exceeded` unless maxmem is
 * raised with N. 256 MiB leaves headroom without inviting a caller-controlled
 * allocation (N is ours, not theirs).
 */
const SCRYPT: ScryptOptions = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/**
 * Passphrases get typed on a different machine than they were invented on —
 * that is the entire premise of a backup — and macOS and Linux disagree about
 * how to encode an accented character. Normalising means "café" opens an archive
 * written as "café" whichever keyboard produced it.
 */
function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  // Off the event loop, in libuv's pool: the bridge seals and opens archives
  // inside request handlers, and `scryptSync` held every webhook, the merge
  // line and the console for the whole derivation, once per preview.
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, KEY_BYTES, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * An empty passphrase would produce a file that looks encrypted and is not. This
 * is a backup of the crew's GitHub accounts' credentials; refusing is kinder than
 * writing it.
 */
function requirePassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new BackupError(
      'a backup needs a passphrase; an empty one would leave every secret in the archive readable by anyone who finds the file',
    );
  }
  return passphrase;
}

/**
 * Why a new passphrase cannot be used, or null.
 *
 * Asked twice because a typo is unrecoverable in a way it usually is not: there
 * is nothing to compare the archive against and nothing to reset it with, so a
 * mistyped passphrase is discovered on the day the credentials are already
 * gone. An empty one is refused rather than taken to mean "no encryption" — a
 * file that looks encrypted and is not would be the worst of the three.
 */
export function passphraseRefusal(first: string, second: string): string | null {
  if (first.length === 0) return 'an empty passphrase would leave the archive unprotected';
  if (first !== second) return 'the two passphrases do not match';
  return null;
}

/**
 * Below this, a passphrase is warned about and still used.
 *
 * Anyone who gets the file guesses offline, and scrypt's ~0.3s is all that
 * slows them: a four-letter lowercase one falls in about a day and a half of
 * one core. Warned rather than refused, so an old archive with a short one
 * still opens and a person who chooses one is told, not stopped. The console
 * has its own copy (apps/console/src/lib/backup.ts), with the same number and
 * words, because it cannot import this package.
 */
export const PASSPHRASE_ADVISED_LENGTH = 12;

/** What is said about a passphrase shorter than `PASSPHRASE_ADVISED_LENGTH`, or null. */
export function passphraseWarning(passphrase: string): string | null {
  // By code point, as the normalised form scrypt is given: "café" is four.
  if ([...passphrase.normalize('NFC')].length >= PASSPHRASE_ADVISED_LENGTH) return null;
  return 'Shorter than 12 characters: anyone who gets this file can guess a short passphrase offline, and it holds the app’s private key and every sign-in. Use a generated one, or three or four random words.';
}

/** Lowercase Crockford base32: no look-alikes, and 32 symbols, so `byte & 31` has no bias. */
const PASSPHRASE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A strong passphrase: 25 random symbols of 32, in five groups of five, which
 * is 125 bits and reads aloud without a 0/o or 1/l mix-up. The console's copy
 * makes the same shape.
 */
export function generatePassphrase(): string {
  const bytes = randomBytes(25);
  const symbols = Array.from(bytes, (byte) => PASSPHRASE_ALPHABET[byte & 31]).join('');
  return symbols.match(/.{5}/g)!.join('-');
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new BackupError(`${what} must be a string`);
  return value;
}

/** UTC to the second or the millisecond, as `toISOString` writes it. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * When an archive was made, as one exact shape and nothing else. The manifest
 * is read and printed before a passphrase proves anything, so a string here
 * could carry a terminal's escape sequences to the person about to type one.
 * `Date.parse` alone would not stop that: it accepts text in parentheses.
 */
function asTimestamp(value: unknown, what: string): string {
  const text = asString(value, what);
  const at = new Date(text);
  if (!ISO_UTC.test(text) || Number.isNaN(at.getTime())) throw new BackupError(`${what} is not a time in UTC, such as 2026-09-21T09:14:00.000Z`);
  return at.toISOString();
}

function asStringOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, what);
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BackupError(`${what} must be a number`);
  return value;
}

function asNumberOrNull(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, what);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new BackupError(`${what} must be an array`);
  return value;
}

function asStrings(value: unknown, what: string): string[] {
  return asArray(value, what).map((item, index) => asString(item, `${what} ${index}`));
}

/**
 * Note what the messages here do and do not name: a key, never a value. A ref
 * like `github-refresh-builder` is already printed by `fleetadlc backup` and
 * `fleetadlc restore`, but a value that lands in a CLI log or a bug report has
 * escaped the archive.
 */
function asStringMap(value: unknown, what: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupError(`${what} must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new BackupError(`${what} has a non-string value under "${key}"`);
    out[key] = item;
  }
  return out;
}

const CREDENTIAL_STATES: readonly ArchivedCredential['status'][] = ['unauthorized', 'active', 'expired', 'revoked'];

function asCredential(value: unknown, what: string): ArchivedCredential {
  const row = asObject(value, what);
  const status = asString(row.status, `${what} status`);
  if (!(CREDENTIAL_STATES as readonly string[]).includes(status)) throw new BackupError(`${what} has no known status`);
  return {
    githubLogin: asString(row.githubLogin, `${what} githubLogin`),
    githubUserId: asNumberOrNull(row.githubUserId, `${what} githubUserId`),
    scopes: asStrings(row.scopes ?? [], `${what} scopes`),
    tokenExpiresAt: asStringOrNull(row.tokenExpiresAt, `${what} tokenExpiresAt`),
    refreshExpiresAt: asStringOrNull(row.refreshExpiresAt, `${what} refreshExpiresAt`),
    signingKeyId: asNumberOrNull(row.signingKeyId, `${what} signingKeyId`),
    authorizedAt: asStringOrNull(row.authorizedAt, `${what} authorizedAt`),
    status: status as ArchivedCredential['status'],
  };
}

/**
 * Rebuilt field by field rather than spread, so the archive can only ever hold
 * the things its version defines. A caller who hands us a richer bot object
 * does not get the extras smuggled into a file that a future version must then
 * keep reading — and a version 1 archive holds the five fields it always did.
 */
function asBots(value: unknown, version: FormatVersion): ArchivedBot[] {
  if (!Array.isArray(value)) throw new BackupError('the bot list must be an array');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new BackupError(`bot ${index} must be an object`);
    const bot = entry as Record<string, unknown>;
    const slot = asStringOrNull(bot.slot, `bot ${index} slot`);
    const base: ArchivedBot = {
      name: asString(bot.name, `bot ${index} name`),
      // Only when there is one, so an archive written before seats reads back
      // exactly as it was written.
      ...(slot ? { slot } : {}),
      githubLogin: asStringOrNull(bot.githubLogin, `bot ${index} githubLogin`),
      engine: asString(bot.engine, `bot ${index} engine`),
      model: asStringOrNull(bot.model, `bot ${index} model`),
    };
    if (version === 1) return base;
    return {
      ...base,
      modelAccountId: asStringOrNull(bot.modelAccountId, `bot ${index} modelAccountId`),
      modelSetAt: asStringOrNull(bot.modelSetAt, `bot ${index} modelSetAt`),
      ...('color' in bot ? { color: asStringOrNull(bot.color, `bot ${index} color`) } : {}),
      ...('avatar' in bot ? { avatar: asStringOrNull(bot.avatar, `bot ${index} avatar`) } : {}),
      ...(bot.credential !== undefined && bot.credential !== null
        ? { credential: asCredential(bot.credential, `bot ${index} credential`) }
        : {}),
    };
  });
}

function asRepositories(value: unknown): ArchivedRepository[] {
  return asArray(value ?? [], 'the repositories').map((entry, index) => {
    const repo = asObject(entry, `repository ${index}`);
    return {
      name: asString(repo.name, `repository ${index} name`),
      fullName: asString(repo.fullName, `repository ${index} fullName`),
      ownerSeat: asStringOrNull(repo.ownerSeat, `repository ${index} ownerSeat`),
      concurrency: asNumber(repo.concurrency, `repository ${index} concurrency`),
      stageModes: asStringMap(repo.stageModes ?? {}, `repository ${index} stageModes`),
      specRequiredLabels: asStrings(repo.specRequiredLabels ?? [], `repository ${index} specRequiredLabels`),
      humanReviewPaths: asStrings(repo.humanReviewPaths ?? [], `repository ${index} humanReviewPaths`),
      defaultBranch: asString(repo.defaultBranch ?? 'main', `repository ${index} defaultBranch`),
      // Kept only when it is one: a colour this OpenADLC does not know is left
      // for the restore to give the repository one it does.
      ...(typeof repo.color === 'string' && repo.color ? { color: repo.color } : {}),
    };
  });
}

const PROVIDERS: readonly string[] = ['anthropic', 'openai', 'xai'];
const KINDS: readonly string[] = ['key', 'subscription'];

function asAccounts(value: unknown): ArchivedAccount[] {
  return asArray(value ?? [], 'the model accounts').map((entry, index) => {
    const account = asObject(entry, `model account ${index}`);
    const provider = asString(account.provider, `model account ${index} provider`);
    const kind = asString(account.kind, `model account ${index} kind`);
    if (!PROVIDERS.includes(provider)) throw new BackupError(`model account ${index} has no known provider`);
    if (!KINDS.includes(kind)) throw new BackupError(`model account ${index} has no known kind`);
    return {
      id: asString(account.id, `model account ${index} id`),
      provider: provider as ArchivedAccount['provider'],
      kind: kind as ArchivedAccount['kind'],
      label: asString(account.label, `model account ${index} label`),
      createdAt: asString(account.createdAt, `model account ${index} createdAt`),
      verifiedAt: asStringOrNull(account.verifiedAt, `model account ${index} verifiedAt`),
      verifyError: asStringOrNull(account.verifyError, `model account ${index} verifyError`),
    };
  });
}

function asLogins(value: unknown): Record<string, LoginFiles> {
  const logins = asObject(value ?? {}, 'the sign-in folders');
  const out: Record<string, LoginFiles> = {};
  for (const [account, files] of Object.entries(logins)) {
    out[account] = asStringMap(files, `the sign-in folder of account ${account}`);
  }
  return out;
}

function asIdentities(value: unknown): ArchivedIdentity[] {
  return asArray(value ?? [], 'the GitHub accounts').map((entry, index) => {
    const identity = asObject(entry, `GitHub account ${index}`);
    const secretNs = asString(identity.secretNs, `GitHub account ${index} secretNs`);
    // It becomes part of a secret's name, so it has to be one a store takes.
    if (!/^[a-zA-Z0-9._:-]+$/.test(secretNs)) throw new BackupError(`GitHub account ${index} is filed under a name no secret can have`);
    return {
      login: asString(identity.login, `GitHub account ${index} login`),
      githubUserId: asNumberOrNull(identity.githubUserId, `GitHub account ${index} githubUserId`),
      secretNs,
      seats: asStrings(identity.seats ?? [], `GitHub account ${index} seats`),
    };
  });
}

function asHistory(value: unknown): ArchivedHistory | null {
  if (value === null || value === undefined) return null;
  const history = asObject(value, 'the history');
  return {
    threads: asArray(history.threads ?? [], 'the threads').map((entry, index) => {
      const row = asObject(entry, `thread ${index}`);
      return {
        id: asString(row.id, `thread ${index} id`),
        seat: asString(row.seat, `thread ${index} seat`),
        repo: asStringOrNull(row.repo, `thread ${index} repo`),
        subjectRef: asString(row.subjectRef, `thread ${index} subjectRef`),
        createdAt: asString(row.createdAt, `thread ${index} createdAt`),
        updatedAt: asString(row.updatedAt, `thread ${index} updatedAt`),
      };
    }),
    messages: asArray(history.messages ?? [], 'the messages').map((entry, index) => {
      const row = asObject(entry, `message ${index}`);
      return {
        id: asString(row.id, `message ${index} id`),
        threadId: asString(row.threadId, `message ${index} threadId`),
        kind: asString(row.kind, `message ${index} kind`),
        author: asString(row.author, `message ${index} author`),
        text: asString(row.text, `message ${index} text`),
        note: asStringOrNull(row.note, `message ${index} note`),
        payload: row.payload ?? null,
        githubUrl: asStringOrNull(row.githubUrl, `message ${index} githubUrl`),
        at: asString(row.at, `message ${index} at`),
      };
    }),
    audit: asArray(history.audit ?? [], 'the audit log').map((entry, index) => {
      const row = asObject(entry, `audit line ${index}`);
      return {
        actor: asString(row.actor, `audit line ${index} actor`),
        action: asString(row.action, `audit line ${index} action`),
        target: asString(row.target, `audit line ${index} target`),
        payload: row.payload ?? null,
        at: asString(row.at, `audit line ${index} at`),
      };
    }),
    ledger: asArray(history.ledger ?? [], 'the cost ledger').map((entry, index) => {
      const row = asObject(entry, `ledger row ${index}`);
      return {
        seat: asString(row.seat, `ledger row ${index} seat`),
        engine: asString(row.engine, `ledger row ${index} engine`),
        model: asString(row.model, `ledger row ${index} model`),
        modelAlias: asStringOrNull(row.modelAlias, `ledger row ${index} modelAlias`),
        promptHash: asStringOrNull(row.promptHash, `ledger row ${index} promptHash`),
        tokensIn: asNumber(row.tokensIn, `ledger row ${index} tokensIn`),
        tokensOut: asNumber(row.tokensOut, `ledger row ${index} tokensOut`),
        costUsd: asNumber(row.costUsd, `ledger row ${index} costUsd`),
        at: asString(row.at, `ledger row ${index} at`),
      };
    }),
    requests: asArray(history.requests ?? [], 'the requests').map((entry, index) => {
      const row = asObject(entry, `request ${index}`);
      return {
        id: asString(row.id, `request ${index} id`),
        text: asString(row.text, `request ${index} text`),
        context: asStringOrNull(row.context, `request ${index} context`),
        repo: asStringOrNull(row.repo, `request ${index} repo`),
        kind: asStringOrNull(row.kind, `request ${index} kind`),
        requestedBy: asString(row.requestedBy, `request ${index} requestedBy`),
        issueNumber: asNumberOrNull(row.issueNumber, `request ${index} issueNumber`),
        state: asString(row.state, `request ${index} state`),
        createdAt: asString(row.createdAt, `request ${index} createdAt`),
        updatedAt: asString(row.updatedAt, `request ${index} updatedAt`),
      };
    }),
    ...(history.attachments === undefined
      ? {}
      : {
          attachments: asArray(history.attachments, 'the attachments').map((entry, index) => {
            const row = asObject(entry, `attachment ${index}`);
            const source = asString(row.source, `attachment ${index} source`);
            if (source !== 'console' && source !== 'github') throw new BackupError(`attachment ${index} came from ${source}, which is neither the console nor GitHub`);
            return {
              id: asString(row.id, `attachment ${index} id`),
              subjectRef: asString(row.subjectRef, `attachment ${index} subjectRef`),
              repo: asStringOrNull(row.repo, `attachment ${index} repo`),
              requestId: asStringOrNull(row.requestId, `attachment ${index} requestId`),
              messageId: asStringOrNull(row.messageId, `attachment ${index} messageId`),
              source,
              sourceUrl: asStringOrNull(row.sourceUrl, `attachment ${index} sourceUrl`),
              name: asString(row.name, `attachment ${index} name`),
              mediaType: asString(row.mediaType, `attachment ${index} mediaType`),
              sizeBytes: asNumber(row.sizeBytes, `attachment ${index} sizeBytes`),
              sha256: asString(row.sha256, `attachment ${index} sha256`),
              content: asString(row.content, `attachment ${index} content`),
              uploadedBy: asString(row.uploadedBy, `attachment ${index} uploadedBy`),
              createdAt: asString(row.createdAt, `attachment ${index} createdAt`),
            };
          }),
        }),
  };
}

/** The encrypted half: everything but the manifest. */
interface Payload {
  secrets: Record<string, string>;
  settings: Record<string, string>;
  bots: ArchivedBot[];
  repositories?: ArchivedRepository[];
  accounts?: ArchivedAccount[];
  logins?: Record<string, LoginFiles>;
  history?: ArchivedHistory | null;
  identities?: ArchivedIdentity[];
  spendingLimits?: ArchivedSpendingLimit[];
}

function versionOf(value: unknown): FormatVersion {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new BackupError(
    `this backup declares version ${String(value)}, and this version of OpenADLC reads versions ${READABLE_VERSIONS.slice(0, -1).join(', ')} and ${READABLE_VERSIONS[READABLE_VERSIONS.length - 1]}. ` +
      'Upgrade OpenADLC, then restore again',
  );
}

/**
 * One validator for both directions: what `encryptBackup` accepts is exactly
 * what `decryptBackup` will hand back, so the round trip has no gap for a field
 * to change shape in. Version 1 holds three things, version 2 seven, and
 * version 3 adds the GitHub accounts and, when the install was included, the
 * spending limits; an older payload never grows what its version did not have.
 */
function payloadOf(value: unknown, version: FormatVersion): Payload {
  if (typeof value !== 'object' || value === null) {
    throw new BackupError('a backup needs secrets, settings and a bot list');
  }
  const contents = value as Record<string, unknown>;
  const v1 = {
    secrets: asStringMap(contents.secrets, 'the secrets'),
    settings: asStringMap(contents.settings, 'the settings'),
    bots: asBots(contents.bots, version),
  };
  if (version === 1) return v1;
  const v2 = {
    ...v1,
    repositories: asRepositories(contents.repositories),
    accounts: asAccounts(contents.accounts),
    logins: asLogins(contents.logins),
    history: asHistory(contents.history),
  };
  if (version === 2) return v2;
  // An archive from before Settings saved caps has no list. One that has the
  // key, even empty, is the whole table: a restore replaces what is here.
  const limits = asSpendingLimits(contents);
  return { ...v2, identities: asIdentities(contents.identities), ...limits };
}

function asSpendingLimits(contents: Record<string, unknown>): { spendingLimits: ArchivedSpendingLimit[] } | Record<string, never> {
  if (!Object.prototype.hasOwnProperty.call(contents, 'spendingLimits')) return {};
  const value = contents.spendingLimits;
  if (!Array.isArray(value)) throw new BackupError('the spending limits are not a list');
  return {
    spendingLimits: value.map((entry, index) => {
      const row = asObject(entry, `spending limit ${index}`);
      const amount = row.amountUsd;
      if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount))) {
        throw new BackupError(`spending limit ${index} has no amount`);
      }
      const repository = row.repository;
      const bot = row.bot;
      if (repository !== undefined && typeof repository !== 'string') {
        throw new BackupError(`spending limit ${index} does not name its repository`);
      }
      if (bot !== undefined && typeof bot !== 'string') throw new BackupError(`spending limit ${index} does not name its bot`);
      return {
        scope: asString(row.scope, `spending limit ${index} scope`),
        kind: asString(row.kind, `spending limit ${index} kind`),
        amountUsd: amount as number | null,
        ...(typeof repository === 'string' ? { repository } : {}),
        ...(typeof bot === 'string' ? { bot } : {}),
      };
    }),
  };
}

function asIncludes(value: unknown): ManifestIncludes {
  const includes = asObject(value, "this backup's list of what it includes");
  const flag = (key: keyof ManifestIncludes): boolean => {
    const found = includes[key];
    if (typeof found !== 'boolean') throw new BackupError(`this backup does not say whether it includes ${key}`);
    return found;
  };
  const extent = (key: 'bots' | 'accounts'): 'all' | 'some' | 'none' => {
    const found = includes[key];
    if (found !== 'all' && found !== 'some' && found !== 'none') {
      throw new BackupError(`this backup does not say which ${key} it includes`);
    }
    return found;
  };
  return {
    install: flag('install'),
    repositories: flag('repositories'),
    bots: extent('bots'),
    botSignIns: flag('botSignIns'),
    accounts: extent('accounts'),
    accountSignIns: flag('accountSignIns'),
    history: flag('history'),
  };
}

/** What each version counts, taken from the payload. */
function countsOf(payload: Payload, version: FormatVersion): ManifestCounts {
  const counts: ManifestCounts = {
    secrets: Object.keys(payload.secrets).length,
    settings: Object.keys(payload.settings).length,
    bots: payload.bots.length,
  };
  if (version === 1) return counts;
  const v2 = {
    ...counts,
    repositories: payload.repositories?.length ?? 0,
    accounts: payload.accounts?.length ?? 0,
    logins: Object.keys(payload.logins ?? {}).length,
    threads: payload.history?.threads.length ?? 0,
    messages: payload.history?.messages.length ?? 0,
    audit: payload.history?.audit.length ?? 0,
    ledger: payload.history?.ledger.length ?? 0,
    requests: payload.history?.requests.length ?? 0,
    // Only when the archive carries them, so an archive written before them
    // counts what it was written with and still reads.
    ...(payload.history?.attachments ? { attachments: payload.history.attachments.length } : {}),
  };
  if (version === 2) return v2;
  return { ...v2, identities: payload.identities?.length ?? 0 };
}

/**
 * The counts are taken from the payload, not from the caller's manifest, so the
 * cleartext half of the file cannot lie about the encrypted half. Somebody
 * deciding whether to keep a backup reads the manifest; if it could claim nine
 * secrets over an archive holding two, it would be worse than having no manifest
 * at all.
 */
function manifestFor(contents: Pick<BackupContents, 'manifest'>, payload: Payload, version: FormatVersion): BackupManifest {
  const createdAt = asTimestamp(contents.manifest?.createdAt, 'the manifest createdAt');
  const manifest: BackupManifest = { version, createdAt, counts: countsOf(payload, version) };
  if (version >= 2) manifest.includes = asIncludes(contents.manifest?.includes);
  return manifest;
}

/**
 * `FLEETBAK1\n{manifest}\n` — two text lines, so `head -2` on the file answers
 * "what is this and when was it taken" with no tooling at all.
 */
function headerBytes(manifest: BackupManifest): Buffer {
  return Buffer.from(`${MAGIC}\n${serialize(manifest)}\n`, 'utf8');
}

/**
 * Encrypts everything but the manifest and returns the whole archive.
 *
 * Layout: `FLEETBAK1\n` + manifest JSON + `\n` + salt(16) + iv(12) + tag(16) +
 * aes-256-gcm ciphertext. The two cleartext lines are passed to GCM as
 * additional authenticated data, so editing the manifest breaks decryption
 * instead of quietly mislabelling the file.
 *
 * The version written is the one the caller's manifest names: what OpenADLC
 * collects now is version 3, and a version 1 or 2 archive can still be made,
 * which is how the tests hold an older archive to restore.
 *
 * What the format does not hide: roughly how much configuration an install has.
 * The counts say so out loud and the ciphertext length says so anyway; hiding it
 * would mean padding, and it is not worth protecting.
 */
export async function encryptBackup(contents: BackupContents, passphrase: string): Promise<Buffer> {
  requirePassphrase(passphrase);
  const version = versionOf(contents.manifest?.version);
  const payload = payloadOf(contents, version);
  const manifest = manifestFor(contents, payload, version);
  const header = headerBytes(manifest);

  // Fresh per archive, and never derived from the passphrase or the contents:
  // two backups of an unchanged install must not be recognisable as such, and
  // reusing a GCM nonce under one key is the one mistake the mode does not
  // survive.
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(serialize(payload), 'utf8'), cipher.final()]);

  return Buffer.concat([header, salt, iv, cipher.getAuthTag(), body]);
}

interface ParsedArchive {
  manifest: BackupManifest;
  /** Exactly the bytes that were the AAD when this file was written. */
  header: Buffer;
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  body: Buffer;
}

const V2_COUNTS: readonly (keyof ManifestCounts)[] = [
  'repositories',
  'accounts',
  'logins',
  'threads',
  'messages',
  'audit',
  'ledger',
  'requests',
];

/**
 * Rebuilt field by field, like the bots, and for a sharper reason: this is the
 * *unauthenticated* read. Anything a tampered header added is dropped here
 * rather than handed to a caller who has not proved they hold the passphrase.
 */
function parseManifest(json: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new BackupError('this file has a FLEETBAK1 header but its manifest is not readable JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupError('this backup has no manifest');
  }
  const manifest = value as Record<string, unknown>;
  const version = versionOf(manifest.version);
  const counts = manifest.counts;
  if (typeof counts !== 'object' || counts === null) throw new BackupError("this backup's manifest has no counts");
  const count = (key: keyof ManifestCounts): number => {
    const found = (counts as Record<string, unknown>)[key];
    if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
      throw new BackupError(`this backup's manifest has no ${key} count`);
    }
    return found;
  };
  const parsed: BackupManifest = {
    version,
    createdAt: asTimestamp(manifest.createdAt, "this backup's createdAt"),
    counts: { secrets: count('secrets'), settings: count('settings'), bots: count('bots') },
  };
  if (version >= 2) {
    for (const key of V2_COUNTS) parsed.counts[key] = count(key);
    parsed.includes = asIncludes(manifest.includes);
  }
  if (version >= 3) parsed.counts.identities = count('identities');
  if (version >= 2 && 'attachments' in (counts as Record<string, unknown>)) parsed.counts.attachments = count('attachments');
  return parsed;
}

/**
 * Splits an archive without needing the passphrase.
 *
 * Every failure in here is about the *file* — wrong type, truncated, a newer
 * format — and is raised before any key is derived, so pointing the CLI at the
 * wrong path costs nothing and says something useful.
 */
function parse(archive: Buffer): ParsedArchive {
  if (!Buffer.isBuffer(archive)) throw new BackupError('a backup archive must be a Buffer');

  // latin1 so arbitrary bytes decode without replacement characters; we are only
  // looking at ASCII.
  const opening = archive.subarray(0, FAMILY.length + MAX_MANIFEST_BYTES).toString('latin1');
  if (!opening.startsWith(`${MAGIC}\n`)) {
    if (opening.startsWith(FAMILY)) {
      const line = (opening.split('\n')[0] ?? '').trim();
      throw new BackupError(`this archive says it is ${line}, and this version of OpenADLC reads ${MAGIC} archives. Upgrade OpenADLC, then restore again`);
    }
    throw new BackupError(`this file is not an OpenADLC backup: it does not begin with the ${MAGIC} header`);
  }

  const manifestAt = MAGIC.length + 1;
  const newline = archive.indexOf(0x0a, manifestAt);
  if (newline < 0 || newline - manifestAt > MAX_MANIFEST_BYTES) {
    throw new BackupError('this file has a FLEETBAK1 header but no manifest line after it');
  }

  const saltAt = newline + 1;
  const ivAt = saltAt + SALT_BYTES;
  const tagAt = ivAt + IV_BYTES;
  const bodyAt = tagAt + TAG_BYTES;
  // `<=`, not `<`: an archive always carries a payload, so an empty body means
  // the file was cut short.
  if (archive.length <= bodyAt) {
    throw new BackupError('this backup is truncated: the header is there but the encrypted contents are not');
  }

  return {
    manifest: parseManifest(archive.subarray(manifestAt, newline).toString('utf8')),
    header: archive.subarray(0, saltAt),
    salt: archive.subarray(saltAt, ivAt),
    iv: archive.subarray(ivAt, tagAt),
    tag: archive.subarray(tagAt, bodyAt),
    body: archive.subarray(bodyAt),
  };
}

/**
 * Reads the cleartext header without the passphrase, so a file can identify
 * itself.
 *
 * Unauthenticated by definition — there is no key here to check anything with —
 * so treat the answer as a label on the outside of the box. `decryptBackup`
 * returns the same manifest once the auth tag has vouched for it.
 */
export function readManifest(archive: Buffer): BackupManifest {
  return parse(archive).manifest;
}

function sameCounts(a: ManifestCounts, b: ManifestCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ManifestCounts>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Decrypts an archive, or throws BackupError.
 *
 * The manifest that comes back is the cleartext one, but by the time it is
 * returned the auth tag has covered it: the header was the AAD, so a manifest
 * that disagrees with the file it sits on cannot get this far.
 */
export async function decryptBackup(archive: Buffer, passphrase: string): Promise<BackupContents> {
  requirePassphrase(passphrase);
  const parsed = parse(archive);

  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, parsed.salt), parsed.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(parsed.header);
  decipher.setAuthTag(parsed.tag);

  let plaintext: string;
  try {
    // `update` hands back plaintext *before* anything has been verified, so it
    // stays in this scope until `final` has checked the tag. Nothing from an
    // archive that fails authentication reaches the caller.
    plaintext = Buffer.concat([decipher.update(parsed.body), decipher.final()]).toString('utf8');
  } catch {
    // GCM cannot distinguish a wrong key from altered bytes — both are just "the
    // tag does not match" — so the message has to own both possibilities rather
    // than assert the friendlier one.
    throw new BackupError(
      'that passphrase does not open this archive (either the passphrase is wrong, or the file has been altered since it was written)',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new BackupError('this backup decrypted, but its contents are not readable JSON');
  }
  const payload = payloadOf(value, parsed.manifest.version);

  // Both halves are authenticated, so they can only disagree if whatever wrote
  // the file was broken. Catching that here keeps the promise the manifest makes
  // — that the cleartext description matches the payload — true on read as well
  // as on write.
  if (!sameCounts(parsed.manifest.counts, countsOf(payload, parsed.manifest.version))) {
    throw new BackupError("this backup's manifest does not describe its contents");
  }

  return { manifest: parsed.manifest, ...payload };
}

// ------------------------------------------------------------------ plain text

/**
 * The unencrypted form.
 *
 * Encryption is the default and this is the path somebody has to ask for. It
 * exists because an install whose access is controlled somewhere else — behind
 * IAP, on a host only its operator reaches — may reasonably decide the
 * passphrase costs more than it buys: it cannot be scripted, and a forgotten one
 * loses the archive outright. The console never offers it.
 *
 * What it does not do is change what the file is. This holds the App private
 * key, which never expires, the signing keys, and whatever bot sign-ins and API
 * keys were chosen — and access control protects the place a file is fetched
 * *from*, never the file afterwards. So the format announces itself: the first
 * key in the document is a warning, readable by anyone who opens it, and the
 * extension differs so it cannot be mistaken for a sealed archive at a glance.
 */
const PLAIN_FORMAT = 'fleetadlc-backup-plain';

/**
 * What a plain file may say it is: this name, and the one written before the
 * rename from Fleet. Only the new one is written; the old one was refused as
 * "not an OpenADLC backup", though the file was a good backup.
 */
const PLAIN_FORMATS: ReadonlySet<unknown> = new Set([PLAIN_FORMAT, 'fleet-backup-plain']);

const PLAIN_WARNING =
  'UNENCRYPTED. This file holds the GitHub App private key, signing keys, webhook ' +
  'secret, the package registry token, any non-expiring bot tokens and API keys, ' +
  'Claude subscription tokens, and, when they were chosen, the OpenAI and xAI ' +
  'subscription sign-ins, the bots’ GitHub sign-ins and the history (messages, ' +
  'requests, attachments), in plain text. Anyone who reads it holds the install. ' +
  'Recovering from a leak means a new App key, signing keys and webhook secret, ' +
  'revoking each bot’s GitHub authorization, revoking any non-expiring bot token, ' +
  'rotating every API key and the registry token, and signing each model ' +
  'subscription out and in again.';

export function writePlain(contents: BackupContents): Buffer {
  const version = versionOf(contents.manifest?.version);
  const payload = payloadOf(contents, version);
  const manifest = manifestFor(contents, payload, version);

  // The warning first, because a reader sees the top of a file.
  return Buffer.from(
    `${serialize(
      {
        WARNING: PLAIN_WARNING,
        format: PLAIN_FORMAT,
        manifest,
        ...payload,
      },
      2,
    )}\n`,
    'utf8',
  );
}

export function readPlain(file: Buffer): BackupContents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.toString('utf8'));
  } catch {
    throw new BackupError('this file is not an OpenADLC backup: it is neither sealed nor readable JSON');
  }

  const document = parsed as Record<string, unknown>;
  if (!PLAIN_FORMATS.has(document?.format)) {
    throw new BackupError('this file is not an OpenADLC backup: it does not say it is one');
  }

  const declared = (document.manifest as Record<string, unknown> | undefined)?.version;
  const version = versionOf(declared ?? 1);
  const payload = payloadOf(document, version);
  return { manifest: manifestFor(document as unknown as BackupContents, payload, version), ...payload };
}

/** Which of the two a file is, so a restore knows whether to ask for anything. */
export function formatOf(file: Buffer): 'sealed' | 'plain' | 'unknown' {
  if (file.subarray(0, FAMILY.length).toString('utf8') === FAMILY) return 'sealed';
  try {
    const document = JSON.parse(file.toString('utf8')) as Record<string, unknown>;
    if (PLAIN_FORMATS.has(document?.format)) return 'plain';
  } catch {
    // Not JSON, so not ours in this form.
  }
  return 'unknown';
}
