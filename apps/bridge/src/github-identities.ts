import { bots, credentials, identities } from '@fleetadlc/db';
import { personChoiceRefusal, type Person } from './account-guard.js';
import { credentialKind, getSecretStore, type SecretStore } from '@fleetadlc/github';
import { accountGroupOf, holdsCredential, otherGroupHolder, roleLabel, type AccountGroup, type Bot, type BotRole } from '@fleetadlc/shared';
import { signInKind } from './sign-in.js';

/**
 * The GitHub accounts OpenADLC holds, with the seats on each, and which account
 * each seat may be put on — what settings' connected accounts and crew draw, and
 * what the bridge checks an assignment against before it makes one.
 *
 * The rules live here and nowhere else. The console shows the reason a choice
 * is refused, as this says it, and the assignment route refuses with the same
 * words: a page that worked the rules out for itself would drift from the
 * bridge that enforces them.
 */

/** Whether OpenADLC can act as an account: a stored sign-in GitHub has not revoked. */
export type SignInState = 'signed-in' | 'needs-reconnecting' | 'not-signed-in';

/** A seat as the rules need it: its role, which account it is on, and whether it holds a sign-in. */
export interface SeatOnAccount {
  id: string;
  name: string;
  slot: string;
  role: BotRole;
  githubLogin: string | null;
  /** Holds a sign-in, as the walkthrough counts it (`holdsCredential`). */
  connected: boolean;
  /** The identity it is on, or null when it is on none. */
  identityId: string | null;
}

/** An account OpenADLC holds, with the seats on it. */
export interface HeldAccount {
  id: string;
  login: string;
  githubUserId: number | null;
  secretNs: string;
  /** When it was first connected; see `GitHubAccountsView`. */
  connectedAt?: string | null;
  signIn: SignInState;
  seats: SeatOnAccount[];
}

export interface GitHubAccountsView {
  accounts: {
    login: string;
    url: string;
    /** The group its seats are in; null when no seat is on it, `mixed` when seats of both groups are. */
    group: AccountGroup | 'mixed' | null;
    signIn: SignInState;
    /**
     * `approves`: whether a merge needs the seat's approval — the lead, and a
     * seat config/review.yaml marks `blocking`. Only those matter when two
     * seats share an account: the merge refuses two required reviewers on one
     * login, and an advisory seat's approval is not asked for.
     */
    seats: { name: string; slot: string; role: BotRole; roleLabel: string; approves: boolean }[];
    /**
     * When it was first connected. The walkthrough asks for the account that
     * does the work first and the one that approves it second, so with nothing
     * else to go on, that order says which is which.
     */
    connectedAt: string | null;
  }[];
  bots: {
    name: string;
    slot: string;
    role: BotRole;
    roleLabel: string;
    group: AccountGroup;
    /** The account it is on, or null when it is on none. */
    login: string | null;
    /** Every account OpenADLC holds, and why this seat may not use it, when it may not. */
    choices: { login: string; refusal: string | null }[];
  }[];
}

/**
 * Whether an account can be signed in as. A revoked or expired authorization
 * on any seat of it is the account's — they share one sign-in — so the
 * account needs reconnecting, not the seat.
 *
 * `proven` is what the `bot-sign-in` health check last found for each seat on
 * it, by asking GitHub: true when the seat signed in, false when GitHub
 * refused it, null when it has not said. It outranks the stored status, which
 * is only as fresh as the last time a token was minted: the card said
 * "Needs reconnecting" over an account the check had just signed in as, and
 * "Signed in" over one GitHub had revoked.
 */
export function signInStateOf(
  kind: 'refresh' | 'static' | null,
  statuses: readonly (string | null | undefined)[],
  proven: readonly (boolean | null | undefined)[] = [],
): SignInState {
  if (!kind) return 'not-signed-in';
  if (proven.some((one) => one === false)) return 'needs-reconnecting';
  if (proven.length > 0 && proven.every((one) => one === true)) return 'signed-in';
  return statuses.some((status) => status === 'revoked' || status === 'expired') ? 'needs-reconnecting' : 'signed-in';
}

/** The group an account serves, from the seats on it. */
export function groupOfAccount(seats: readonly { role: BotRole }[]): AccountGroup | 'mixed' | null {
  const groups = new Set(seats.map((seat) => accountGroupOf(seat.role)));
  if (groups.size === 0) return null;
  return groups.size > 1 ? 'mixed' : [...groups][0]!;
}

/**
 * Why a seat may not use an account, or null when it may.
 *
 * GitHub won't let the account that opened a pull request approve it, so a
 * reviewer never shares an account with a seat of the crew group, nor a crew
 * seat with a reviewer: asked of the seats on the account and of any other
 * connected seat that names it. And an account whose sign-in does not work
 * has nothing to give a seat — it is reconnected first. Nor is a person's
 * account any seat's (`account-guard.ts`).
 *
 * Short, because the console prints it beside the choice; the route puts it
 * in a sentence.
 */
export function assignmentRefusal(
  seat: { id: string; role: BotRole },
  account: Pick<HeldAccount, 'login' | 'signIn' | 'seats'>,
  crew: readonly SeatOnAccount[],
  /** The people no bot may sign in as (`peopleOf`), read by the caller: this asks GitHub nothing. */
  people: readonly Person[] = [],
): string | null {
  const person = personChoiceRefusal(account.login, people);
  if (person) return person;
  const group = accountGroupOf(seat.role);
  const across =
    account.seats.find((other) => other.id !== seat.id && accountGroupOf(other.role) !== group) ??
    otherGroupHolder(account.login, seat, crew);
  if (across) {
    return group === 'reviewers'
      ? `used by the ${roleLabel(across.role)} — reviewers need their own account`
      : `the reviewers’ account (the ${roleLabel(across.role)} uses it) — the crew needs a different one`;
  }
  if (account.signIn === 'not-signed-in') return 'not signed in — reconnect it first';
  if (account.signIn === 'needs-reconnecting') return 'its sign-in stopped working — reconnect it first';
  return null;
}

/**
 * Where the sign-in of an account no seat is on is filed.
 *
 * A seat's own account is filed under the seat's name, and a seat's name
 * moves its secrets with it when it is renamed — so an account left behind
 * under a seat's name would be carried off, or written over, by that seat's
 * next rename or connect. This name cannot be a seat's: seats are lowercase
 * letters, digits and hyphens (`BOT_NAME_PATTERN`), and a GitHub login has no
 * underscore either, so no connect ever lands on it.
 */
export function accountSecretNs(login: string): string {
  return `account_${login.toLowerCase()}`;
}

/**
 * Whether OpenADLC can still get a token for an account: true or false once the
 * token broker has tried, null when it could not say — no client id yet, say,
 * which is this install's to fix and says nothing about the account.
 */
export type SignInProbe = (account: { secretNs: string; login: string }) => Promise<boolean | null>;

/**
 * The crew and the accounts, as they stand.
 *
 * An account no seat is on has no seat's credential row to say whether its
 * sign-in still works, so `probe` asks the token broker for it — the one
 * component allowed to refresh it — and one GitHub has revoked shows as
 * needing reconnecting rather than as signed in on the strength of a stored
 * token nothing uses.
 */
export async function readAccounts(
  store: SecretStore = getSecretStore(),
  probe?: SignInProbe,
  /** What the `bot-sign-in` check last found for a seat, by its id; see `signInStateOf`. */
  proven?: (botId: string, authorizedAt: string | null) => boolean | null,
): Promise<{
  crew: (SeatOnAccount & { bot: Bot })[];
  accounts: HeldAccount[];
}> {
  const [crew, all, onIdentity] = await Promise.all([bots.listBots(), identities.listIdentities(), identities.seatIdentities()]);
  const identityOf = new Map(onIdentity.map((row) => [row.botId, row.identityId]));
  const statusOf = new Map<string, string | null>();
  const authorizedAtOf = new Map<string, string | null>();
  const seats = await Promise.all(
    crew.map(async (bot) => {
      const credential = await credentials.getCredential(bot.id);
      statusOf.set(bot.id, credential?.status ?? null);
      authorizedAtOf.set(bot.id, credential?.authorizedAt ?? null);
      return {
        bot,
        id: bot.id,
        name: bot.name,
        slot: bot.slot,
        role: bot.role,
        githubLogin: bot.githubLogin,
        connected: holdsCredential(await signInKind(bot, store).catch(() => null), credential),
        identityId: identityOf.get(bot.id) ?? null,
      };
    }),
  );
  const accounts = await Promise.all(
    all.map(async (identity) => {
      const on = seats.filter((seat) => seat.identityId === identity.id);
      const kind = await credentialKind(identity.secretNs, store).catch(() => null);
      const works = kind && on.length === 0 && probe ? await probe(identity).catch(() => null) : null;
      return {
        id: identity.id,
        login: identity.login,
        githubUserId: identity.githubUserId,
        secretNs: identity.secretNs,
        connectedAt: identity.connectedAt ?? null,
        signIn: signInStateOf(
          kind,
          works === false ? ['revoked'] : on.map((seat) => statusOf.get(seat.id)),
          proven ? on.map((seat) => proven(seat.id, authorizedAtOf.get(seat.id) ?? null)) : [],
        ),
        seats: on,
      } satisfies HeldAccount;
    }),
  );
  return { crew: seats, accounts };
}

const GROUP_ORDER = { crew: 0, reviewers: 1, mixed: 2, none: 3 } as const;

/**
 * What settings draws: the connected accounts, and each crew seat's account
 * choices. `approving` is the seats, by name, whose approval a merge needs.
 */
export function accountsView(
  crew: readonly SeatOnAccount[],
  accounts: readonly HeldAccount[],
  approving: ReadonlySet<string>,
  people: readonly Person[] = [],
): GitHubAccountsView {
  const listed = accounts
    .map((account) => ({ account, group: groupOfAccount(account.seats) }))
    .sort(
      (a, b) =>
        GROUP_ORDER[a.group ?? 'none'] - GROUP_ORDER[b.group ?? 'none'] || a.account.login.localeCompare(b.account.login),
    );
  return {
    accounts: listed.map(({ account, group }) => ({
      login: account.login,
      url: `https://github.com/${account.login}`,
      group,
      signIn: account.signIn,
      seats: account.seats.map((seat) => ({
        name: seat.name,
        slot: seat.slot,
        role: seat.role,
        roleLabel: roleLabel(seat.role),
        approves: approving.has(seat.name),
      })),
      connectedAt: account.connectedAt ?? null,
    })),
    bots: crew.map((seat) => ({
      name: seat.name,
      slot: seat.slot,
      role: seat.role,
      roleLabel: roleLabel(seat.role),
      group: accountGroupOf(seat.role),
      login: accounts.find((account) => account.id === seat.identityId)?.login ?? null,
      choices: listed.map(({ account }) => ({ login: account.login, refusal: assignmentRefusal(seat, account, crew, people) })),
    })),
  };
}
