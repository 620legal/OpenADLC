import { settings } from '@fleetadlc/db';
import { sameLogin } from '@fleetadlc/shared';

/**
 * The install's people (`humans`) pinned to their GitHub accounts.
 *
 * A login in `humans` may answer gates and approve plan changes on every
 * repository the install works in, and OpenADLC acts for it everywhere. A
 * login is only a name: GitHub frees it for anyone to register once its
 * account is renamed or deleted, and whoever took it over answered gates as
 * the person it used to be. So each login is pinned to the numeric account id
 * it had when it was configured, kept in the settings as `humanIds` (a JSON
 * object, lower-cased login to id), and a delivery counts as one of `humans`
 * only when its user's id is that id. A login that resolves to another
 * account, or to none, is a card on the board (`repo-config`).
 */

/** Asks GitHub for the account behind a login: its id, false when there is none, null when GitHub did not say. */
export type AccountIdOf = (login: string) => Promise<number | false | null>;

let resolver: AccountIdOf | null = null;

/** Set once at start-up (`main.ts`): how a login is resolved to its account id. */
export function resolveHumanIdsWith(resolve: AccountIdOf | null): void {
  resolver = resolve;
}

/** The pinned ids, by lower-cased login; empty when none are kept or the setting cannot be read. */
export async function pinnedHumanIds(): Promise<Record<string, number>> {
  const raw = await settings.getSetting('humanIds').catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pins: Record<string, number> = {};
    for (const [login, id] of Object.entries(parsed ?? {})) if (Number.isInteger(id)) pins[login.toLowerCase()] = id as number;
    return pins;
  } catch {
    return {};
  }
}

/**
 * The account id a `humans` login is pinned to, pinning it now when it was
 * not yet: a login from FLEETADLC_HUMANS, or saved before pins were kept.
 * Null when GitHub cannot be asked, or says there is no such account, which
 * admits nobody as that login.
 */
export async function pinnedIdOf(login: string): Promise<number | null> {
  const key = login.toLowerCase();
  const pinned = (await pinnedHumanIds())[key];
  if (pinned !== undefined) return pinned;
  const id = resolver ? await resolver(login).catch(() => null) : null;
  if (typeof id !== 'number') return null;
  await settings.mergeSettingJson('humanIds', { [key]: id }, 'bridge').catch(() => undefined);
  return id;
}

/**
 * Whether a delivery's user is one of `humans`: the login is listed, and its
 * account id is the one pinned for that login. A login alone is not enough,
 * and neither is a delivery that names no id.
 */
export async function isPinnedHuman(humans: readonly string[], login: string | null | undefined, id: number | null | undefined): Promise<boolean> {
  if (!login || typeof id !== 'number') return false;
  if (!humans.some((human) => sameLogin(human, login))) return false;
  return (await pinnedIdOf(login)) === id;
}

/**
 * Keeps the pins in step with a newly saved `humans`: a login added is pinned
 * to the account it names now, and one taken out is forgotten. A login already
 * pinned keeps its pin, so a save cannot quietly move it to whoever holds the
 * name today; to pin a login again, take it out and save, then put it back.
 */
export async function repinHumans(humans: readonly string[], by: string): Promise<{ pinned: string[]; unresolved: string[] }> {
  const pins = await pinnedHumanIds();
  const wanted = new Set(humans.map((login) => login.toLowerCase()));
  for (const login of Object.keys(pins)) {
    if (!wanted.has(login)) await settings.removeSettingJsonKey('humanIds', login, by);
  }
  const pinned: string[] = [];
  const unresolved: string[] = [];
  for (const login of wanted) {
    if (pins[login] !== undefined) continue;
    const id = resolver ? await resolver(login).catch(() => null) : null;
    if (typeof id === 'number') {
      await settings.mergeSettingJson('humanIds', { [login]: id }, by);
      pinned.push(login);
    } else {
      unresolved.push(login);
    }
  }
  return { pinned, unresolved };
}

/** A pinned login whose account is not the one it was pinned to: another id, or none. */
export interface MovedHuman {
  login: string;
  pinned: number;
  /** The id the login resolves to now, or false when there is no account by it. */
  now: number | false;
}

/**
 * The pinned logins GitHub now resolves to another account, or to none. A
 * login GitHub did not answer for is left out: not knowing is not a change.
 */
export async function movedHumans(humans: readonly string[], idOf: AccountIdOf): Promise<{ moved: MovedHuman[]; unknown: string[] }> {
  const pins = await pinnedHumanIds();
  const moved: MovedHuman[] = [];
  const unknown: string[] = [];
  for (const login of humans) {
    const pinned = pins[login.toLowerCase()];
    if (pinned === undefined) continue;
    const now = await idOf(login).catch(() => null);
    if (now === null) unknown.push(login);
    else if (now !== pinned) moved.push({ login, pinned, now });
  }
  return { moved, unknown };
}
