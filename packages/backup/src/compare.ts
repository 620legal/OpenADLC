import { settings as settingKeys } from '@fleetadlc/db';
import { accessTokenRef, appPrivateKeyRef, engineKeyRef, modelAccountRef, refreshTokenRef, registryTokenRef, signingKeyRef, webhookSecretRef } from '@fleetadlc/github';
import { ENGINES, sameLogin } from '@fleetadlc/shared';
import type { ArchivedBot, ArchivedRepository, BackupContents } from './archive.js';
import {
  archivedSetting,
  ATTRIBUTION_KEY_REF,
  namesakeOf,
  repositoryNames,
  repositoryNameTaken,
  spendingAmount,
  spendingCapKey,
  spendingCapName,
  type InstallSnapshot,
} from './contents.js';
import { ADD_THE_SEAT, archivedIdentities, archivedSeat } from './plan.js';
import { choosable, takeOverWarning, type SignIn, type SignInChoices, type SignInVerdict } from './signins.js';

/**
 * An archive laid beside an install that is already set up, thing by thing.
 *
 * A restore onto a clean install puts things where there is nothing. Into an
 * install that works, every item is one of four:
 *
 *   new         the backup has it and this install does not — ticked;
 *   same        both have it, the same; nothing to do;
 *   different   both have it, not the same — what differs is said, and this
 *               install's is kept unless a person takes the backup's;
 *   only here   this install has it and the backup does not — kept, because a
 *               restore never deletes anything.
 *
 * Things are matched the way a restore finds them: settings by key, the
 * GitHub App as one thing (its client id, key and webhook secret belong
 * together), repositories by full name, bots by seat — a seat whose GitHub
 * account differs asks which account it is, this install's unless a person
 * says otherwise — and model accounts by id. Sign-ins are judged first
 * (`judgeSignIns`): one that is expired or refused cannot be ticked, and one
 * that rotates is offered unticked with what taking it over means.
 *
 * Names and plain settings only. A secret is compared by value and said to
 * differ; its value never appears here.
 */

export type ItemState = 'new' | 'same' | 'different' | 'only-here';

export type CompareGroup = 'install' | 'repositories' | 'crew' | 'accounts' | 'sign-ins' | 'history';

export interface CompareItem {
  /** What a choice names it by: `setting:organization`, `app`, `repo:acme/widgets`, `seat:builder:account`, … */
  key: string;
  group: CompareGroup;
  /** What it is, in words. */
  label: string;
  state: ItemState;
  /** What differs, in words, when it is different. Never a secret's value. */
  differences: string[];
  /** Whether the backup's may be taken at all. */
  takeable: boolean;
  /** Ticked before anybody touches it. */
  take: boolean;
  /** Said beside it: why it cannot be taken, what taking it does, or what a check said. */
  note: string | null;
  /** Taken only if this other item is: a bot's sign-in goes with the account it is for. */
  dependsOn: string | null;
  /** The seat a crew item or a bot's sign-in is about. */
  seat?: string;
  /** Every seat a GitHub sign-in signs in: more than one when they share the account. */
  seats?: string[];
  /** For a seat's account: the account on each side. */
  accounts?: { here: string | null; backup: string | null };
  /** For a sign-in: its verdict, and whether using it takes it over. */
  verdict?: SignInVerdict;
  rotates?: boolean;
}

export interface Comparison {
  groups: { group: CompareGroup; items: CompareItem[] }[];
  /** What is ticked before anybody touches it, by key. */
  choices: Record<string, boolean>;
}

/** Rows of the archive's history that this install already has, by kind. */
export interface HistoryHere {
  threads: number;
  messages: number;
  audit: number;
  ledger: number;
  requests: number;
  /** Absent from a count made before attachments were restored. */
  attachments?: number;
}

const SETTING_LABELS: Record<string, string> = {
  organization: 'The organization',
  operatorEmail: 'The operator’s email',
  publicUrl: 'The public address',
  humans: 'The people who may approve',
  automationBot: 'The automation account',
  engineUpdates: 'Weekly engine updates',
  engineUpdateDay: 'The engine update’s day',
  engineUpdateTime: 'The engine update’s time',
  engineUpdateMinReleaseAgeDays: 'How many days old a release must be before an engine update takes it',
  systemToolSchedules: 'When each tool updates, and its pin',
  systemTimeZone: 'The install’s time zone',
  installName: 'The install’s name on its posts',
  attributionMode: 'Whether a crew post that does not check still counts',
  bridgeMergeOff: 'The repositories whose approved pull requests a person merges',
  ciMergeByPerson: 'The repositories where a person merges a change to CI',
  allowedAccounts: 'The other accounts the app may be installed on',
  ciMinutesCap: 'The monthly cap on GitHub Actions minutes',
  humanIds: 'The GitHub account ids of the people who may approve',
  workPaused: 'The pause of new work',
  workPausedRepos: 'The repositories paused',
  workPausedSeats: 'The seats paused',
  unownedIssues: 'The issues waiting on a person',
  heldItems: 'The work items held',
  testingDeploy: 'Which repositories have a testing deploy',
};

/** Labelled, but a JSON value nobody reads by eye, so only said to differ. */
const STRUCTURED_SETTINGS = new Set([
  'systemToolSchedules',
  'humanIds',
  'workPaused',
  'workPausedRepos',
  'workPausedSeats',
  'unownedIssues',
  'heldItems',
  'testingDeploy',
]);

/** The App's parts, which are taken or kept together: one app's client id with another's key is neither. */
const APP_SETTINGS = ['githubClientId', 'webhookSecret', 'appPrivateKey'];

/**
 * Settings shown by value when they differ. The App's own are compared in its
 * item, structured ones are only said to differ, and so is one without a label
 * (`appClientSecret`, should it ever reach the table): a setting is shown by
 * value only once someone has said it may be.
 */
const PLAIN_SETTINGS = new Set(Object.keys(SETTING_LABELS).filter((key) => !STRUCTURED_SETTINGS.has(key)));

/** Seats whose name is an acronym, which a capital first letter alone wrote as "Qa" and "Sre". */
const ACRONYM_SEATS: Record<string, string> = { qa: 'QA', sre: 'SRE' };

function seatTitle(seat: string): string {
  const acronym = ACRONYM_SEATS[seat];
  if (acronym) return acronym;
  const words = seat.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function item(fields: Omit<CompareItem, 'differences' | 'takeable' | 'take' | 'note' | 'dependsOn'> & Partial<CompareItem>): CompareItem {
  const state = fields.state;
  return {
    differences: [],
    takeable: state === 'new' || state === 'different',
    take: state === 'new',
    note: null,
    dependsOn: null,
    ...fields,
  };
}

function listWords(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ------------------------------------------------------------------ the install and its app

function compareInstallGroup(contents: BackupContents, here: InstallSnapshot): CompareItem[] {
  const items: CompareItem[] = [];

  const appParts: { key: string; archive: string | undefined; here: string | undefined; word: string; plain: boolean }[] = [
    { key: 'githubClientId', archive: contents.settings.githubClientId, here: here.settings.githubClientId, word: 'client id', plain: true },
    {
      // In the secret store; an archive or an install from before it moved there has it as a setting.
      key: 'webhookSecret',
      archive: contents.secrets[webhookSecretRef()] ?? contents.settings.webhookSecret,
      here: here.secrets[webhookSecretRef()] ?? here.settings.webhookSecret,
      word: 'webhook secret',
      plain: false,
    },
    {
      key: appPrivateKeyRef(),
      archive: contents.secrets[appPrivateKeyRef()],
      here: here.secrets[appPrivateKeyRef()],
      word: 'private key',
      plain: false,
    },
  ];
  const carried = appParts.filter((part) => part.archive !== undefined && part.archive !== '');
  if (carried.length > 0) {
    const hereHas = appParts.some((part) => part.here !== undefined && part.here !== '');
    const differences: string[] = [];
    for (const part of carried) {
      if (part.here === part.archive) continue;
      if (part.here === undefined || part.here === '') differences.push(`this install has no ${part.word}`);
      else if (part.plain) differences.push(`${part.word}: ${part.here} here, ${part.archive} in the backup`);
      else differences.push(`its ${part.word} differs`);
    }
    // A part the backup lacks would stay as this install has it, beside the
    // backup's others: one app's client id with another's key, which only the
    // summary after the restore used to say. Unless both name the same app,
    // that is not offered.
    const sameApp = Boolean(contents.settings.githubClientId) && contents.settings.githubClientId === here.settings.githubClientId;
    const lacking = sameApp ? [] : appParts.filter((part) => !carried.includes(part) && part.here !== undefined && part.here !== '');
    for (const part of lacking) differences.push(`the backup has no ${part.word}; this install’s would be paired with the backup’s app`);
    items.push(
      item({
        key: 'app',
        group: 'install',
        label: 'The GitHub App — its client id, private key and webhook secret',
        state: !hereHas ? 'new' : differences.length === 0 ? 'same' : 'different',
        differences: hereHas ? differences : [],
        note:
          hereHas && lacking.length > 0
            ? 'Kept as this install has it: the backup does not carry the whole app.'
            : hereHas && differences.length > 0
              ? 'Taking the backup’s app changes which app every bot signs in through.'
              : null,
        ...(hereHas && lacking.length > 0 ? { takeable: false, take: false } : {}),
      }),
    );
  }

  for (const key of Object.keys(contents.settings).sort()) {
    if (APP_SETTINGS.includes(key)) continue;
    // A backup from before these were left out can still carry this machine's
    // update state; it is not offered, and the schedules are compared without
    // their slots, which differ between any two machines.
    const archive = archivedSetting(key, contents.settings[key] as string);
    if (archive === null) continue;
    const label = SETTING_LABELS[key] ?? `The setting ${key}`;
    if (!settingKeys.isSettingKey(key)) {
      items.push(
        item({
          key: `setting:${key}`,
          group: 'install',
          label,
          state: 'new',
          takeable: false,
          take: false,
          note: 'this version of OpenADLC does not know it',
        }),
      );
      continue;
    }
    const stored = here.settings[key];
    const current = stored === undefined || stored === '' ? stored : (archivedSetting(key, stored) ?? undefined);
    const state: ItemState = current === undefined || current === '' ? 'new' : current === archive ? 'same' : 'different';
    items.push(
      item({
        key: `setting:${key}`,
        group: 'install',
        label,
        state,
        differences:
          state === 'different' ? [PLAIN_SETTINGS.has(key) ? `${current} here, ${archive} in the backup` : 'the backup’s is another one'] : [],
      }),
    );
  }
  for (const key of Object.keys(here.settings).sort()) {
    if (APP_SETTINGS.includes(key) || contents.settings[key] !== undefined || !SETTING_LABELS[key]) continue;
    items.push(item({ key: `setting:${key}`, group: 'install', label: SETTING_LABELS[key] as string, state: 'only-here' }));
  }

  const registry = contents.secrets[registryTokenRef()];
  if (registry !== undefined) {
    const current = here.secrets[registryTokenRef()];
    const state: ItemState = current === undefined ? 'new' : current === registry ? 'same' : 'different';
    items.push(
      item({
        key: 'secret:registry-token',
        group: 'install',
        label: 'The package registry token',
        state,
        differences: state === 'different' ? ['the backup’s is another one'] : [],
      }),
    );
  }

  const keyring = contents.secrets[ATTRIBUTION_KEY_REF];
  if (keyring !== undefined) {
    const current = here.secrets[ATTRIBUTION_KEY_REF];
    const state: ItemState = current === undefined ? 'new' : current === keyring ? 'same' : 'different';
    items.push(
      item({
        key: 'secret:attribution-key',
        group: 'install',
        label: 'The key the crew’s posts are signed with',
        state,
        differences: state === 'different' ? ['the backup’s is another one'] : [],
        // Taken, it is added to this install's rather than put over it.
        note:
          state === 'different'
            ? 'Taking the backup’s signs from now on with it; this install’s is kept among the keys that check, for as long as a replaced key is.'
            : null,
      }),
    );
  }
  return items;
}

// ------------------------------------------------------------------ spending caps

/**
 * The archive's spending caps, as one item. A restore into a set-up install
 * used to replace the whole table whatever was ticked — a monthly cap raised,
 * and every repository, bot and provider cap deleted — with nothing on this
 * screen or in the audit log to say so. Taken, only the caps the archive
 * names are written; one that is only here stays.
 */
function compareSpending(contents: BackupContents, here: InstallSnapshot): CompareItem[] {
  if (contents.spendingLimits === undefined || contents.spendingLimits.length === 0) return [];
  const current = new Map((here.spendingLimits ?? []).map((cap) => [spendingCapKey(cap), cap.amountUsd]));
  const differences: string[] = [];
  let anyHere = false;
  for (const cap of contents.spendingLimits) {
    const mine = current.get(spendingCapKey(cap));
    if (mine != null) anyHere = true;
    if ((mine ?? null) === (cap.amountUsd ?? null)) continue;
    differences.push(`${spendingCapName(cap)}: ${spendingAmount(mine)} here, ${spendingAmount(cap.amountUsd)} in the backup`);
  }
  return [
    item({
      key: 'spending',
      group: 'install',
      label: 'The spending caps',
      state: differences.length === 0 ? 'same' : anyHere ? 'different' : 'new',
      differences,
      note: differences.length > 0 ? 'Taking them sets the caps the backup names; a cap only this install has is kept.' : null,
    }),
  ];
}

// ------------------------------------------------------------------ repositories

function repoDifferences(here: ArchivedRepository, backup: ArchivedRepository): string[] {
  const out: string[] = [];
  if (here.concurrency !== backup.concurrency) out.push(`builds at once: ${here.concurrency} here, ${backup.concurrency} in the backup`);
  if ((here.ownerSeat ?? null) !== (backup.ownerSeat ?? null)) {
    out.push(
      `builder: ${here.ownerSeat ? seatTitle(here.ownerSeat) : 'none'} here, ${backup.ownerSeat ? seatTitle(backup.ownerSeat) : 'none'} in the backup`,
    );
  }
  if (here.defaultBranch !== backup.defaultBranch) out.push(`default branch: ${here.defaultBranch} here, ${backup.defaultBranch} in the backup`);
  const stages = new Set([...Object.keys(here.stageModes), ...Object.keys(backup.stageModes)]);
  for (const stage of [...stages].sort()) {
    const a = here.stageModes[stage] ?? 'the default';
    const b = backup.stageModes[stage] ?? 'the default';
    if (a !== b) out.push(`${stage}: ${a} here, ${b} in the backup`);
  }
  if (!sameSet(here.specRequiredLabels, backup.specRequiredLabels)) {
    out.push(`labels that need a spec: ${listWords(here.specRequiredLabels)} here, ${listWords(backup.specRequiredLabels)} in the backup`);
  }
  if (!sameSet(here.humanReviewPaths, backup.humanReviewPaths)) {
    out.push(`paths a person reviews: ${listWords(here.humanReviewPaths)} here, ${listWords(backup.humanReviewPaths)} in the backup`);
  }
  if (backup.color && here.color && here.color !== backup.color) out.push(`color: ${here.color} here, ${backup.color} in the backup`);
  return out;
}

function compareRepositories(contents: BackupContents, here: InstallSnapshot): CompareItem[] {
  const items: CompareItem[] = [];
  const archived = contents.repositories ?? [];
  const byFullName = (list: readonly ArchivedRepository[], fullName: string) =>
    list.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase());
  const names = repositoryNames(here);
  for (const repo of archived) {
    const current = byFullName(here.repositories, repo.fullName);
    const namesake = namesakeOf(repo, names);
    if (namesake) {
      items.push(
        item({
          key: `repo:${repo.fullName.toLowerCase()}`,
          group: 'repositories',
          label: repo.fullName,
          state: 'new',
          takeable: false,
          take: false,
          note: repositoryNameTaken(repo.fullName, namesake),
        }),
      );
      continue;
    }
    const differences = current ? repoDifferences(current, repo) : [];
    items.push(
      item({
        key: `repo:${repo.fullName.toLowerCase()}`,
        group: 'repositories',
        label: repo.fullName,
        state: !current ? 'new' : differences.length === 0 ? 'same' : 'different',
        differences,
      }),
    );
  }
  if (contents.repositories !== undefined) {
    for (const repo of here.repositories) {
      if (byFullName(archived, repo.fullName)) continue;
      items.push(item({ key: `repo:${repo.fullName.toLowerCase()}`, group: 'repositories', label: repo.fullName, state: 'only-here' }));
    }
  }
  return items;
}

// ------------------------------------------------------------------ the crew

/**
 * The model assignment an archived bot has to give, or why it cannot give it:
 * the same rules a restore onto a clean install follows (`planRestore`).
 */
function assignmentOf(
  bot: ArchivedBot,
  live: InstallSnapshot['bots'][number],
  contents: BackupContents,
  here: InstallSnapshot,
): { engine: string; model: string; accountId: string | null } | { reason: string } | null {
  if (contents.manifest.version < 2 || bot.model === null || bot.model.trim() === '') return null;
  if (bot.engine === 'none' && live.engine === 'none') return null;
  if (!bot.modelSetAt && !bot.modelAccountId) return null;
  if (!(ENGINES as readonly string[]).includes(bot.engine)) return { reason: `this version of OpenADLC does not know the engine ${bot.engine}` };
  if ((live.engine === 'none') !== (bot.engine === 'none')) {
    return { reason: live.engine === 'none' ? 'this install’s seat thinks with no model' : 'the backup’s seat thought with no model' };
  }
  const account = bot.modelAccountId ?? null;
  if (account && !(contents.accounts ?? []).some((one) => one.id === account) && !here.accounts.some((one) => one.id === account)) {
    return { reason: 'its model account is not in the backup' };
  }
  return { engine: bot.engine, model: bot.model, accountId: account };
}

function accountLabel(id: string | null, contents: BackupContents, here: InstallSnapshot): string {
  if (!id) return 'no account';
  return (
    here.accounts.find((one) => one.id === id)?.label ?? (contents.accounts ?? []).find((one) => one.id === id)?.label ?? 'an account'
  );
}

function compareCrew(contents: BackupContents, here: InstallSnapshot, signIns: readonly SignIn[]): CompareItem[] {
  const items: CompareItem[] = [];
  const seats = new Set<string>();
  for (const bot of contents.bots) {
    const seat = archivedSeat(bot);
    seats.add(seat);
    const title = seatTitle(seat);
    const live = here.bots.find((one) => one.slot === seat);
    if (!live) {
      items.push(
        item({
          key: `seat:${seat}:account`,
          group: 'crew',
          label: title,
          seat,
          state: 'new',
          takeable: false,
          take: false,
          note: `this install has no such seat: ${ADD_THE_SEAT}`,
        }),
      );
      continue;
    }

    // The account, and the signing key GitHub knows it by: they go together.
    if (bot.githubLogin) {
      const archivedKey = contents.secrets[signingKeyRef(bot.name)];
      const currentKey = here.secrets[signingKeyRef(live.name)];
      const base = { key: `seat:${seat}:account`, group: 'crew' as const, seat, accounts: { here: live.githubLogin, backup: bot.githubLogin } };
      if (!live.githubLogin) {
        items.push(item({ ...base, label: `${title}’s GitHub account`, state: 'new' }));
      } else if (sameLogin(live.githubLogin, bot.githubLogin)) {
        const keyDiffers = archivedKey !== undefined && currentKey !== undefined && archivedKey !== currentKey;
        const keyMissing = archivedKey !== undefined && currentKey === undefined;
        items.push(
          item({
            ...base,
            label: `${title}’s GitHub account`,
            state: keyDiffers || keyMissing ? 'different' : 'same',
            differences: keyDiffers ? ['its signing key differs'] : keyMissing ? ['this install has no signing key for it'] : [],
          }),
        );
      } else {
        items.push(
          item({
            ...base,
            label: `${title}’s GitHub account`,
            state: 'different',
            differences: [`${live.githubLogin} here, ${bot.githubLogin} in the backup`],
            note: `Taking the backup’s makes ${title} ${bot.githubLogin}; this install’s sign-in for ${live.githubLogin} is let go.`,
          }),
        );
      }
    }

    // What it thinks with, and the key it thinks with when it has its own.
    const assignment = assignmentOf(bot, live, contents, here);
    const archivedEngineKey = contents.secrets[engineKeyRef(bot.name)];
    const currentEngineKey = here.secrets[engineKeyRef(live.name)];
    if (!assignment && archivedEngineKey === undefined) continue;
    const base = { key: `seat:${seat}:model`, group: 'crew' as const, seat, label: `What ${title} thinks with` };
    if (assignment && 'reason' in assignment) {
      items.push(item({ ...base, state: 'different', takeable: false, take: false, note: `kept as this install has it: ${assignment.reason}` }));
      continue;
    }
    const differences: string[] = [];
    if (assignment) {
      if (assignment.model !== live.model || assignment.engine !== live.engine) {
        differences.push(`model: ${live.model} here, ${assignment.model} in the backup`);
      }
      if ((assignment.accountId ?? null) !== (live.modelAccountId ?? null)) {
        differences.push(
          `account: ${accountLabel(live.modelAccountId, contents, here)} here, ${accountLabel(assignment.accountId, contents, here)} in the backup`,
        );
      }
    }
    let note: string | null = null;
    if (archivedEngineKey !== undefined && archivedEngineKey !== currentEngineKey) {
      differences.push(currentEngineKey === undefined ? 'this install has no engine key of its own for it' : 'its own engine key differs');
      // The key comes with this item only when it works (`compareSignIns`).
      const verdict = signIns.find((one) => one.key === `engine:${seat}`)?.verdict;
      if (verdict?.state === 'works') note = `The backup’s engine key works: ${verdict.said}.`;
      else if (verdict?.state === 'blocked') {
        note = `The backup’s engine key was refused: ${verdict.reason}; ${
          currentEngineKey === undefined ? 'it is left out' : 'this install’s is kept'
        }.`;
      }
    }
    // On a model account this install does not have, it comes with that
    // account or not at all: taken alone, the restore found the account in
    // neither place and kept this install's model while writing the seat's key.
    const account = assignment?.accountId ?? null;
    const comesWith = account && !here.accounts.some((one) => one.id === account) ? `account:${account}` : null;
    items.push(
      item({
        ...base,
        state: differences.length === 0 ? 'same' : 'different',
        differences,
        ...(note ? { note } : {}),
        ...(comesWith ? { dependsOn: comesWith } : {}),
      }),
    );
  }

  for (const live of here.bots) {
    if (seats.has(live.slot) || !live.githubLogin) continue;
    items.push(
      item({
        key: `seat:${live.slot}:account`,
        group: 'crew',
        label: `${seatTitle(live.slot)}’s GitHub account`,
        seat: live.slot,
        state: 'only-here',
        accounts: { here: live.githubLogin, backup: null },
      }),
    );
  }
  return items;
}

// ------------------------------------------------------------------ model accounts

function compareAccounts(contents: BackupContents, here: InstallSnapshot): CompareItem[] {
  const items: CompareItem[] = [];
  const archived = contents.accounts ?? [];
  for (const account of archived) {
    const current = here.accounts.find((one) => one.id === account.id);
    const differences: string[] = [];
    if (current) {
      if (current.label !== account.label) differences.push(`name: ${current.label} here, ${account.label} in the backup`);
      if (current.provider !== account.provider || current.kind !== account.kind) {
        differences.push(`kind: ${current.provider} ${current.kind} here, ${account.provider} ${account.kind} in the backup`);
      }
    }
    items.push(
      item({
        key: `account:${account.id}`,
        group: 'accounts',
        label: account.label,
        state: !current ? 'new' : differences.length === 0 ? 'same' : 'different',
        differences,
      }),
    );
  }
  if (contents.accounts !== undefined) {
    for (const account of here.accounts) {
      if (archived.some((one) => one.id === account.id)) continue;
      items.push(item({ key: `account:${account.id}`, group: 'accounts', label: account.label, state: 'only-here' }));
    }
  }
  return items;
}

// ------------------------------------------------------------------ sign-ins

function compareSignIns(signIns: readonly SignIn[], others: readonly CompareItem[]): CompareItem[] {
  return signIns.map((signIn) => {
    const { verdict } = signIn;
    const state: ItemState = verdict.state === 'same' ? 'same' : signIn.replaces ? 'different' : 'new';
    const can = choosable(signIn);
    // A bot's sign-in is for the account the backup has in its seat: it goes
    // with that account, when the account is one to choose — for an account
    // seats share, with the first of their seats whose account is. An
    // account's sign-in goes with its row, when the row is new here. A bot's
    // own engine key goes with what it thinks with.
    const parentKeys =
      signIn.kind === 'engine-key'
        ? [`seat:${signIn.seat}:model`]
        : signIn.provider === 'github'
          ? signIn.seats.map((seat) => `seat:${seat}:account`)
          : [`account:${signIn.accountId}`];
    const parent = others.find((one) => parentKeys.includes(one.key) && (one.state === 'new' || one.state === 'different'));
    const dependsOn = parent ? parent.key : null;
    const label =
      signIn.kind === 'engine-key'
        ? `${seatTitle(signIn.seat ?? '')}’s engine key`
        : signIn.provider !== 'github'
          ? signIn.who
          : signIn.seats.length > 1
            ? `${signIn.who}, shared by ${listWords(signIn.seats.map(seatTitle)).replace(/, ([^,]*)$/, ' and $1')}`
            : `${seatTitle(signIn.seat ?? '')} as ${signIn.who}`;
    return item({
      key: `signin:${signIn.key}`,
      group: 'sign-ins',
      label,
      state,
      takeable: state !== 'same' && can,
      // A working one this install lacks comes back; one that would replace
      // this install's, or rotate away from wherever else it is used, waits
      // to be asked for. A working engine key comes back whenever what its
      // bot thinks with is taken, which is the person's choice already.
      take: state !== 'same' && verdict.state === 'works' && (!signIn.replaces || signIn.kind === 'engine-key'),
      note:
        verdict.state === 'blocked'
          ? verdict.reason
          : verdict.state === 'check-by-use'
            ? takeOverWarning(signIn)
            : verdict.state === 'works'
              ? verdict.said
              : null,
      dependsOn,
      ...(signIn.seat ? { seat: signIn.seat } : {}),
      ...(signIn.seats.length > 0 ? { seats: [...signIn.seats] } : {}),
      verdict,
      rotates: signIn.rotates,
    });
  });
}

// ------------------------------------------------------------------ history

function compareHistory(contents: BackupContents, already: HistoryHere | null | undefined): CompareItem[] {
  const history = contents.history;
  if (!history) return [];
  const here = already ?? { threads: 0, messages: 0, audit: 0, ledger: 0, requests: 0 };
  const fresh = {
    threads: Math.max(0, history.threads.length - here.threads),
    messages: Math.max(0, history.messages.length - here.messages),
    audit: Math.max(0, history.audit.length - here.audit),
    ledger: Math.max(0, history.ledger.length - here.ledger),
    requests: Math.max(0, history.requests.length - here.requests),
    attachments: Math.max(0, (history.attachments?.length ?? 0) - (here.attachments ?? 0)),
  };
  const total = fresh.threads + fresh.messages + fresh.audit + fresh.ledger + fresh.requests + fresh.attachments;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return [
    item({
      key: 'history',
      group: 'history',
      label: 'History — threads, files, the audit log, costs and requests',
      state: total === 0 ? 'same' : 'new',
      differences:
        total === 0
          ? []
          : [
              `${count(fresh.threads, 'thread')}, ${count(fresh.messages, 'message')}, ${count(fresh.audit, 'audit line')}, ${count(fresh.ledger, 'cost')}, ${count(fresh.requests, 'request')} and ${count(fresh.attachments, 'file')} not here yet`,
            ],
      note: total === 0 ? null : 'Added beside this install’s own; nothing here is replaced.',
    }),
  ];
}

// ------------------------------------------------------------------ all of it

const ORDER: CompareGroup[] = ['install', 'repositories', 'crew', 'accounts', 'sign-ins', 'history'];

export function compareInstall(input: {
  contents: BackupContents;
  here: InstallSnapshot;
  signIns: readonly SignIn[];
  historyHere?: HistoryHere | null;
}): Comparison {
  const { contents, here } = input;
  const items = [
    ...compareInstallGroup(contents, here),
    ...compareSpending(contents, here),
    ...compareRepositories(contents, here),
    ...compareCrew(contents, here, input.signIns),
    ...compareAccounts(contents, here),
  ];
  items.push(...compareSignIns(input.signIns, items), ...compareHistory(contents, input.historyHere));
  const groups = ORDER.map((group) => ({ group, items: items.filter((one) => one.group === group) })).filter(
    (group) => group.items.length > 0,
  );
  const choices: Record<string, boolean> = {};
  for (const one of items) if (one.takeable) choices[one.key] = one.take;
  return { groups, choices };
}

/** Every item, in order. */
export function itemsOf(comparison: Comparison): CompareItem[] {
  return comparison.groups.flatMap((group) => group.items);
}

/**
 * Whether an item is taken with these choices: it can be, it was ticked (or
 * is by default), and whatever it goes with is taken too.
 */
export function taken(comparison: Comparison, choices: Record<string, boolean>, key: string): boolean {
  const found = itemsOf(comparison).find((one) => one.key === key);
  if (!found || !found.takeable) return false;
  if (!(choices[key] ?? found.take)) return false;
  return found.dependsOn ? taken(comparison, choices, found.dependsOn) : true;
}

/** Refuses a choice that takes what cannot be taken, naming it and why. */
export function refusedComparisonChoice(comparison: Comparison, choices: Record<string, boolean>): string | null {
  for (const one of itemsOf(comparison)) {
    if (choices[one.key] !== true || one.takeable) continue;
    if (one.state === 'same') return `${one.label} is the same here already`;
    if (one.state === 'only-here') return `${one.label} is only in this install; a restore never removes anything`;
    return `${one.label} cannot be taken from the backup${one.note ? `: ${one.note}` : ''}`;
  }
  return null;
}

/**
 * The archive as the choices have it: only what is to be taken, arranged so
 * the plan a clean restore makes of it (`planRestore`) changes exactly that
 * and nothing else. A seat that keeps its account keeps it in the archive
 * too, so nothing of this install's sign-in is let go; one that keeps what it
 * thinks with has no assignment to give; a repository is written under the
 * name this install has for it. Sign-ins stay, for `runRestore` to take or
 * leave by the choices it is handed with them.
 */
export function chosenArchive(input: {
  contents: BackupContents;
  here: InstallSnapshot;
  comparison: Comparison;
  choices: Record<string, boolean>;
}): { contents: BackupContents; signIns: SignInChoices } {
  const { contents, here, comparison, choices } = input;
  const take = (key: string) => taken(comparison, choices, key);

  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(contents.settings)) {
    const archived = archivedSetting(key, value);
    if (archived === null) continue;
    if (APP_SETTINGS.includes(key) ? take('app') : take(`setting:${key}`)) settings[key] = archived;
  }

  const secrets: Record<string, string> = {};
  const keep = (ref: string) => {
    const value = contents.secrets[ref];
    if (value !== undefined) secrets[ref] = value;
  };
  if (take('app')) {
    keep(appPrivateKeyRef());
    keep(webhookSecretRef());
  }
  if (take('secret:registry-token')) keep(registryTokenRef());
  if (take('secret:attribution-key')) keep(ATTRIBUTION_KEY_REF);

  // Each GitHub sign-in stays, under the account's name, for `runRestore` to
  // take or leave; it is taken only with an account it is for.
  for (const account of archivedIdentities(contents)) {
    if (!account.from) continue;
    keep(refreshTokenRef(account.from));
    keep(accessTokenRef(account.from));
  }

  const bots: ArchivedBot[] = [];
  for (const bot of contents.bots) {
    const seat = archivedSeat(bot);
    const live = here.bots.find((one) => one.slot === seat);
    if (!live) continue;
    const account = take(`seat:${seat}:account`);
    const model = take(`seat:${seat}:model`);
    if (account) keep(signingKeyRef(bot.name));
    if (model) keep(engineKeyRef(bot.name));
    const next: ArchivedBot = { ...bot };
    if (!account) {
      next.githubLogin = live.githubLogin;
      delete next.credential;
    }
    if (!model) {
      next.modelSetAt = null;
      next.modelAccountId = null;
    }
    // How its avatar looks comes back with the seat: with its account or its
    // model, whichever was taken, and not for a seat nothing was taken for.
    if (!account && !model) {
      delete next.color;
      delete next.avatar;
    }
    bots.push(next);
  }

  for (const account of contents.accounts ?? []) keep(modelAccountRef(account.id));

  const repositories: ArchivedRepository[] = [];
  for (const repo of contents.repositories ?? []) {
    if (!take(`repo:${repo.fullName.toLowerCase()}`)) continue;
    const current = here.repositories.find((one) => one.fullName.toLowerCase() === repo.fullName.toLowerCase());
    repositories.push(current ? { ...repo, name: current.name } : repo);
  }

  const signIns: SignInChoices = {};
  for (const one of itemsOf(comparison)) {
    if (one.group !== 'sign-ins') continue;
    signIns[one.key.slice('signin:'.length)] = take(one.key);
  }

  // Caps go only when taken: an archive's list, carried through, was written
  // whatever was ticked.
  const { spendingLimits, ...rest } = contents;
  return {
    contents: {
      ...rest,
      ...(spendingLimits !== undefined && take('spending') ? { spendingLimits } : {}),
      settings,
      secrets,
      bots,
      repositories,
      accounts: (contents.accounts ?? []).filter((account) => take(`account:${account.id}`)),
      logins: contents.logins ?? {},
      history: take('history') ? (contents.history ?? null) : null,
    },
    signIns,
  };
}
