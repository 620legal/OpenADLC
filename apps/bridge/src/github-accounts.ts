/**
 * Looking up a GitHub account while somebody types its name.
 *
 * Two things this answers that a text field cannot. Whether the account exists
 * at all — a typo in the organization name is otherwise found much later, when
 * a bot cannot see a repository. And whether it is an organization or a personal
 * account, which changes what the install can do: a personal repository grants
 * write to every collaborator and has no Triage role, so reviewers and the
 * automation account end up with push rights they should not have. The page used
 * to say that *after* the name was saved and checked. Said while typing, it is
 * a decision rather than a regret.
 *
 * Unauthenticated when it has to be. At the first step of onboarding no bot is
 * connected yet, so there is no credential to use, and GitHub then allows ten
 * searches a minute (and sixty `GET /users` an hour) from this address. A
 * caller with a bot's token passes it for the larger budget. Hence the cache
 * and the debounce on the other end: without a token the budget is small and
 * shared with anybody else on this address.
 */

export interface GitHubAccount {
  login: string;
  type: 'User' | 'Organization';
  avatarUrl: string;
  htmlUrl: string;
  /** GitHub's numeric id; only the exact lookup is given it. */
  id?: number;
}

export interface AccountLookup {
  /** The account whose login is exactly what was typed, if there is one. */
  exact: GitHubAccount | null;
  /** Others that start the same way, so a near-miss is visible. */
  suggestions: GitHubAccount[];
  /** True when GitHub refused for rate reasons; the field still works. */
  rateLimited: boolean;
  /**
   * True when GitHub could not be asked at all: unreachable, or an error that
   * is not a rate limit. Like a rate limit it says nothing about the name, so
   * a field that needs a match offers to take the name unchecked.
   */
  unavailable?: boolean;
}

interface SearchResponse {
  items?: { login?: string; type?: string; avatar_url?: string; html_url?: string }[];
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: AccountLookup }>();

const EMPTY: AccountLookup = { exact: null, suggestions: [], rateLimited: false };

/**
 * @param fetchImpl injected so a test never reaches the network, and because a
 * lookup that hit GitHub for real would be rate-limited by the test suite alone.
 */
export async function lookUpAccount(
  query: string,
  options: { token?: string | null; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<AccountLookup> {
  const term = query.trim();
  // One character matches most of GitHub and tells nobody anything. Two are
  // asked: a login can be two characters long, and a complete login (the
  // configured organization) is looked up here too.
  if (term.length < 2) return EMPTY;

  const now = options.now ?? Date.now;
  // Its own key space: a search for `login:octocat`, a qualifier GitHub's
  // search takes, was cached under the key `loginAvailable('octocat')` reads,
  // and made a taken name read as free for a minute.
  const key = `search:${term.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < CACHE_MS) return cached.value;

  const doFetch = options.fetchImpl ?? fetch;
  const url = `https://api.github.com/search/users?q=${encodeURIComponent(term)}&per_page=5`;

  let value: AccountLookup;
  try {
    const response = await doFetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });

    if (response.status === 403 || response.status === 429) {
      // Not cached: the limit is measured in a minute, and caching a refusal
      // would keep the field broken long after it recovered.
      return { ...EMPTY, rateLimited: true };
    }
    // Not cached either, and not "nothing found": a field that needs a match
    // read that as nobody being called it, and would not take the name.
    if (!response.ok) return { ...EMPTY, unavailable: true };

    const body = (await response.json()) as SearchResponse;
    const accounts: GitHubAccount[] = (body.items ?? [])
      .filter((item) => item.login && (item.type === 'User' || item.type === 'Organization'))
      .map((item) => ({
        login: item.login as string,
        type: item.type as 'User' | 'Organization',
        avatarUrl: item.avatar_url ?? '',
        htmlUrl: item.html_url ?? '',
      }));

    // GitHub logins are case-insensitive, so `JaneDoe` and `janedoe` are the
    // same account and either spelling should read as found.
    const exact = accounts.find((account) => account.login.toLowerCase() === term.toLowerCase()) ?? null;
    value = {
      exact,
      suggestions: accounts.filter((account) => account.login !== exact?.login).slice(0, 4),
      rateLimited: false,
    };
  } catch {
    // A lookup is a convenience. It must never be why somebody cannot get past
    // this step, so an unreachable GitHub is said to be unavailable rather
    // than thrown, and the field offers the name unchecked.
    return { ...EMPTY, unavailable: true };
  }

  cache.set(key, { at: now(), value });
  return value;
}

/** For tests, which must not inherit another test's cached answer. */
export function clearAccountCache(): void {
  cache.clear();
}

/**
 * Whether a login is free, asked exactly rather than by search.
 *
 * `GET /users/{login}` answers 404 for a name nobody holds, which is the only
 * authoritative answer available. Search is not: it is eventually consistent, so
 * a freshly registered account is missing from it for a while — and "the search
 * index has not caught up" is indistinguishable from "this name is free" at the
 * moment somebody is about to type it into a sign-up form.
 *
 * `null` means GitHub could not be asked. That is deliberately not `true`: an
 * unreachable GitHub must not present a name as available, because the cost of
 * being wrong is a sign-up that fails at the last step.
 */
export async function loginAvailable(
  login: string,
  options: { token?: string | null; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<boolean | null> {
  const name = login.trim();
  if (!name) return null;

  const now = options.now ?? Date.now;
  const key = `login:${name.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < CACHE_MS) return cached.value.exact === null;

  // The cache fills only once an answer arrives, so nine seats on two accounts
  // asked together sent nine requests, and the anonymous limit is sixty an hour.
  const pending = asking.get(key);
  if (pending) return pending;
  const asked = askLoginAvailable(name, key, options, now).finally(() => asking.delete(key));
  asking.set(key, asked);
  return asked;
}

/** Lookups on their way, by login, shared by whoever asks meanwhile. */
const asking = new Map<string, Promise<boolean | null>>();

async function askLoginAvailable(
  name: string,
  key: string,
  options: { token?: string | null; fetchImpl?: typeof fetch },
  now: () => number,
): Promise<boolean | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });

    if (response.status === 404) {
      cache.set(key, { at: now(), value: { exact: null, suggestions: [], rateLimited: false } });
      return true;
    }
    if (!response.ok) return null;

    const body = (await response.json()) as { login?: string; id?: number; type?: string; avatar_url?: string; html_url?: string };
    cache.set(key, {
      at: now(),
      value: {
        exact: {
          login: body.login ?? name,
          type: body.type === 'Organization' ? 'Organization' : 'User',
          avatarUrl: body.avatar_url ?? '',
          htmlUrl: body.html_url ?? '',
          ...(body.id ? { id: body.id } : {}),
        },
        suggestions: [],
        rateLimited: false,
      },
    });
    return false;
  } catch {
    return null;
  }
}

/**
 * Whether an account is a person's or an organization's, from the same exact
 * answer `loginAvailable` asks for and keeps. Who can install an app differs —
 * on an organization only its owners can — so the words for it differ too.
 * Null when nobody holds the login, or GitHub could not be asked.
 */
export async function accountTypeOf(
  login: string,
  options: { token?: string | null; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<'User' | 'Organization' | null> {
  if ((await loginAvailable(login, options)) !== false) return null;
  return cache.get(`login:${login.trim().toLowerCase()}`)?.value.exact?.type ?? null;
}

/**
 * An account's numeric id, from the same exact answer: what the app's install
 * page takes to go past GitHub's account picker. Null when nobody holds the
 * login, or GitHub could not be asked.
 */
export async function accountIdOf(
  login: string,
  options: { token?: string | null; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<number | null> {
  if ((await loginAvailable(login, options)) !== false) return null;
  return cache.get(`login:${login.trim().toLowerCase()}`)?.value.exact?.id ?? null;
}
