import { GitHubApiError, GitHubClient, installationTokenFor, type AppApi, type AppCredentials } from '@openadlc/github';
import type { Role } from './roles.js';

/**
 * The Security page's reader: each managed repository's open Dependabot,
 * code-scanning and secret-scanning alerts, read from GitHub as the app
 * (docs/adr/0086).
 *
 * Everything it asks of GitHub goes through `SecurityReads`, whose one read is
 * a GET, so nothing here can write to a repository. Each entry is built from
 * an allowlist of GitHub's fields, never by spreading its object: a
 * secret-scanning alert carries the leaked `secret` itself, and a spread would
 * carry it to the console. `hide_secret=true` asks GitHub to leave it out as
 * well, so either one alone keeps it in GitHub.
 *
 * A `user` sees Dependabot and code scanning; secret scanning is an admin's,
 * as GitHub's own default has it. For a user the secret-scanning endpoint is
 * never called, rather than called and filtered, so no cache entry or log
 * line made for a user can hold one (answered on OpenADLC#377).
 */

export type AlertType = 'dependabot' | 'code-scanning' | 'secret-scanning';
export const ALERT_TYPES: readonly AlertType[] = ['dependabot', 'code-scanning', 'secret-scanning'];

/** Each type's permission, as the manifest names it and as the app's settings page labels it. */
export const ALERT_PERMISSIONS: Record<AlertType, { key: string; label: string }> = {
  dependabot: { key: 'vulnerability_alerts', label: 'Dependabot alerts' },
  'code-scanning': { key: 'security_events', label: 'Code scanning alerts' },
  'secret-scanning': { key: 'secret_scanning_alerts', label: 'Secret scanning alerts' },
};

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface SecurityAlert {
  type: AlertType;
  repo: string;
  number: number;
  /** The advisory's summary, the rule's description, or the secret type's display name. */
  title: string;
  severity: Severity;
  url: string;
  createdAt: string;
  /** The package (ecosystem), or the rule id and file path; nothing for a secret. */
  where?: string;
  /** Code scanning's own `rule.severity` (error, warning, note) where GitHub set no security severity. */
  note?: string;
}

export type TypeState =
  | { state: 'read'; alerts: SecurityAlert[]; truncated: boolean }
  /** The feature is switched off on the repository, or has nothing to report: an empty state. */
  | { state: 'off' }
  | { state: 'unreadable'; permission: string }
  | { state: 'failed'; reason: string }
  | { state: 'admins-only' }
  | { state: 'not-installed' };

export interface SecurityAlertsView {
  readAt: string;
  repos: { repo: string; fullName: string; types: Record<AlertType, TypeState> }[];
}

export interface SecurityRepo {
  name: string;
  fullName: string;
}

export interface SecurityReads {
  /** The repositories this install manages. */
  repositories(): Promise<SecurityRepo[]>;
  /** An installation token for the one repository, or null when the app is not installed on it. Throws when GitHub could not be asked. */
  tokenFor(fullName: string): Promise<string | null>;
  /** A GET of a list endpoint, following its next links; throws GitHub's refusal (`GitHubApiError`). */
  getPaged<T>(token: string, path: string, options: { maxPages: number }): Promise<{ items: T[]; truncated: boolean }>;
}

/** 10 pages of 100: the most of one type the page shows for one repository. */
export const MAX_PAGES = 10;
export const MEMO_MS = 60_000;
const CONCURRENCY = 4;

/**
 * GitHub's words for an app that lacks the permission. The status cannot tell
 * it apart: a switched-off feature is a 403 too ("Dependabot alerts are
 * disabled for this repository", "Advanced Security must be enabled…"), and
 * `x-accepted-github-permissions` comes on an app's responses whatever the
 * cause. Only this message says the permission is what is missing.
 */
const NOT_ACCESSIBLE = /Resource not accessible by integration/i;

/** The list endpoint for one type, open alerts only. */
export function alertsPath(type: AlertType, fullName: string, perPage = 100): string {
  const base = `/repos/${fullName}`;
  switch (type) {
    case 'dependabot':
      return `${base}/dependabot/alerts?state=open&per_page=${perPage}`;
    case 'code-scanning':
      return `${base}/code-scanning/alerts?state=open&per_page=${perPage}`;
    case 'secret-scanning':
      return `${base}/secret-scanning/alerts?state=open&per_page=${perPage}&hide_secret=true`;
  }
}

/** What a failed read means for that type on that repository. */
export function classify(type: AlertType, error: unknown): Extract<TypeState, { state: 'unreadable' | 'off' | 'failed' }> {
  const status = error instanceof GitHubApiError ? error.status : null;
  const body = error instanceof GitHubApiError ? error.body : '';
  if (status === 403 && NOT_ACCESSIBLE.test(body)) return { state: 'unreadable', permission: ALERT_PERMISSIONS[type].label };
  // Any other 403 is a feature switched off; a 404 is secret scanning off, or
  // code scanning with no analysis yet. Neither is an error on the page.
  if (status === 403 || status === 404) return { state: 'off' };
  return { state: 'failed', reason: reasonOf(error) };
}

function reasonOf(error: unknown): string {
  if (error instanceof GitHubApiError) return `GitHub answered ${error.status}`;
  const message = error instanceof Error ? error.message : String(error);
  return `GitHub could not be asked: ${message.slice(0, 200)}`;
}

const LEVELS: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);

/** One of the scale's four words, or `none` for anything else, a missing level included. */
export function severityOf(value: unknown): Severity {
  const word = typeof value === 'string' ? value.toLowerCase() : '';
  // GitHub's advisories also say "moderate" for medium.
  if (word === 'moderate') return 'medium';
  return LEVELS.has(word) ? (word as Severity) : 'none';
}

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === 'object' ? (value as Raw) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** An alert as the page shows it, from GitHub's object by allowlist. */
export function toAlert(type: AlertType, repo: string, raw: unknown): SecurityAlert | null {
  const alert = obj(raw);
  const number = typeof alert.number === 'number' ? alert.number : null;
  const url = str(alert.html_url);
  // Only a link to GitHub itself is passed on: it is rendered as a link.
  if (number === null || !url || !url.startsWith('https://github.com/')) return null;
  const createdAt = str(alert.created_at) ?? '';
  if (type === 'dependabot') {
    const advisory = obj(alert.security_advisory);
    const pkg = obj(obj(alert.dependency).package);
    const name = str(pkg.name);
    const ecosystem = str(pkg.ecosystem);
    return {
      type,
      repo,
      number,
      title: str(advisory.summary) ?? `Dependabot alert #${number}`,
      severity: severityOf(advisory.severity ?? obj(alert.security_vulnerability).severity),
      url,
      createdAt,
      ...(name ? { where: ecosystem ? `${name} (${ecosystem})` : name } : {}),
    };
  }
  if (type === 'code-scanning') {
    const rule = obj(alert.rule);
    const path = str(obj(obj(alert.most_recent_instance).location).path);
    const id = str(rule.id);
    const severity = severityOf(rule.security_severity_level);
    const own = str(rule.severity);
    const where = [id, path].filter(Boolean).join(' · ');
    return {
      type,
      repo,
      number,
      title: str(rule.description) ?? str(rule.name) ?? id ?? `Code scanning alert #${number}`,
      severity,
      url,
      createdAt,
      ...(where ? { where } : {}),
      ...(severity === 'none' && own ? { note: own } : {}),
    };
  }
  // Secret scanning: the type's display name and the link, and nothing else.
  // GitHub gives no severity; ranking a leaked secret is not made up here.
  return {
    type,
    repo,
    number,
    title: str(alert.secret_type_display_name) ?? 'Secret',
    severity: 'none',
    url,
    createdAt,
  };
}

/** Runs `work` over `items`, at most `limit` at a time, in order. */
async function inBatches<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** What one read of one type on one repository answers, before an admin's or a user's view is made of it. */
type Read = Exclude<TypeState, { state: 'admins-only' }>;

export class SecurityAlertsReader {
  private readonly memo = new Map<string, { at: number; read: Promise<Read> }>();

  constructor(
    private readonly reads: SecurityReads,
    private readonly options: { memoMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The open alerts of every managed repository, or of the one named (by name
   * or full name). A user is never given, and never causes a read of, a
   * secret-scanning alert.
   */
  async view(input: { role: Role; repo?: string | null }): Promise<SecurityAlertsView> {
    const all = await this.reads.repositories();
    const wanted = input.repo ? all.filter((one) => one.name === input.repo || one.fullName === input.repo) : all;
    const types = ALERT_TYPES.filter((type) => type !== 'secret-scanning' || input.role === 'admin');
    const repos = await inBatches(wanted, CONCURRENCY, async (repo) => {
      const states = {} as Record<AlertType, TypeState>;
      for (const type of ALERT_TYPES) states[type] = { state: 'admins-only' };
      await Promise.all(types.map(async (type) => (states[type] = await this.read(repo, type))));
      return { repo: repo.name, fullName: repo.fullName, types: states };
    });
    return { readAt: new Date(this.now()).toISOString(), repos };
  }

  /**
   * One type on one repository, memoised for a minute. The key is the
   * repository and the type, so a secret-scanning answer lives only under its
   * own key, which a user's view never asks for.
   */
  read(repo: SecurityRepo, type: AlertType): Promise<Read> {
    const key = `${repo.fullName}\u0000${type}`;
    const now = this.now();
    const held = this.memo.get(key);
    if (held && now - held.at < (this.options.memoMs ?? MEMO_MS)) return held.read;
    const read = this.readNow(repo, type);
    this.memo.set(key, { at: now, read });
    // A failure is not kept: the next open asks again.
    void read.then((state) => {
      if (state.state === 'failed' && this.memo.get(key)?.read === read) this.memo.delete(key);
    });
    return read;
  }

  private async readNow(repo: SecurityRepo, type: AlertType): Promise<Read> {
    let token: string | null;
    try {
      token = await this.reads.tokenFor(repo.fullName);
    } catch (error) {
      return { state: 'failed', reason: reasonOf(error) };
    }
    if (!token) return { state: 'not-installed' };
    try {
      const { items, truncated } = await this.reads.getPaged<unknown>(token, alertsPath(type, repo.fullName), { maxPages: MAX_PAGES });
      const alerts = items.flatMap((raw) => toAlert(type, repo.name, raw) ?? []);
      return { state: 'read', alerts, truncated };
    } catch (error) {
      return classify(type, error);
    }
  }
}

/**
 * Whether the app can read one type on one repository, for the health check:
 * one alert's page of the same endpoint, classified as the page classifies it.
 */
export async function probeType(reads: SecurityReads, repo: SecurityRepo, type: AlertType): Promise<Read> {
  const token = await reads.tokenFor(repo.fullName);
  if (!token) return { state: 'not-installed' };
  try {
    await reads.getPaged<unknown>(token, alertsPath(type, repo.fullName, 1), { maxPages: 1 });
    return { state: 'read', alerts: [], truncated: false };
  } catch (error) {
    return classify(type, error);
  }
}

/** How long before its expiry an installation token is minted again. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/**
 * `SecurityReads` as the app, with an installation token scoped to each
 * repository, kept until shortly before it expires. Minting it is a POST to
 * the app's own installation, which writes nothing to a repository; every
 * repository read is `getPaged`'s GET.
 */
export function securityReadsAsApp(deps: {
  credentials: () => Promise<AppCredentials | null>;
  api: AppApi;
  repositories: () => Promise<SecurityRepo[]>;
  now?: () => number;
}): SecurityReads {
  const tokens = new Map<string, { token: string; until: number }>();
  const now = () => deps.now?.() ?? Date.now();
  return {
    repositories: deps.repositories,
    async tokenFor(fullName) {
      const held = tokens.get(fullName);
      if (held && held.until > now()) return held.token;
      const credentials = await deps.credentials();
      if (!credentials) return null;
      try {
        const minted = await installationTokenFor(deps.api, credentials, fullName);
        const expires = minted.expiresAt ? Date.parse(minted.expiresAt) : now() + 30 * 60 * 1000;
        tokens.set(fullName, { token: minted.token, until: expires - TOKEN_MARGIN_MS });
        return minted.token;
      } catch (error) {
        // The installation lookup answers 404 where the app is not installed.
        if (error instanceof GitHubApiError && error.status === 404) return null;
        if (error instanceof Error && /is not installed on/.test(error.message)) return null;
        throw error;
      }
    },
    getPaged: (token, path, options) => new GitHubClient({ token, actingAs: 'openadlc-app' }).getPaged(path, options),
  };
}
