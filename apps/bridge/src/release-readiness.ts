import { lastAuditHaving, releaseRuns, repos, type ReleaseRun, type ReleaseSetting } from '@openadlc/db';
import type { RuleApi } from '@openadlc/github';
import type { HealthAction } from '@openadlc/shared';
import type { ReleaseAccountProbe } from './hostd-client.js';
import { RELEASE_ACCOUNT_DOCS, RELEASE_ACCOUNT_DOCS_URL, releaseAccountFix } from './health/checks/release-account.js';
import { judgeReleaseTag, likelyNextTag } from './health/checks/release-tag-rules.js';
import type { CheckResult } from './health/types.js';
import type { ReleaseReader } from './release-routes.js';
import type { LastRelease, ReleaseRepo } from './release-service.js';
import { HttpFailure } from './router.js';

/**
 * What a cut of a repository needs, read for its release page (#371,
 * docs/adr/0084-a-releases-readiness-is-read-never-pinned-or-started.md).
 *
 * It only informs: Cut release starts a build exactly as it did before
 * (ADR 0072), whatever this says. So it holds no release handle. Every
 * dependency is a plain read, given as a function, and the module imports
 * the service, the cut's routes, the publisher and hostd's client as types
 * only: nothing reached from here can start, pin, sign or publish. In
 * particular it never pins a compare view — a 60 s poll would push the
 * person's own view out of the five `VIEWS_PER_IDENTITY` keeps, and a cut
 * from an evicted view is refused.
 *
 * The signing key is known here only as a yes or no from the store's list of
 * refs (`hasReleaseSigningKey`), passed in by the wiring: the key is never
 * read, decrypted or loaded on this path, and hostd's signer stays its only
 * reader (ADR 0069).
 *
 * Each item is read on its own, with its own timeout: a read that throws or
 * hangs is that item's "could not check", never the page's.
 */

/** How long one item may take before it is "could not check". */
export const READINESS_ITEM_TIMEOUT_MS = 10_000;

/** How long one reading is kept, so several open tabs cost one, and hostd's probe and GitHub are not asked on every poll. */
export const READINESS_TTL_MS = 30_000;

export type ReadinessItemId = 'account' | 'signing_key' | 'recipe' | 'release_tag' | 'version' | 'last_build';

/** The order the page shows them in. */
export const READINESS_ITEMS: readonly ReadinessItemId[] = ['account', 'signing_key', 'recipe', 'release_tag', 'version', 'last_build'];

export interface ReadinessItem {
  id: ReadinessItemId;
  title: string;
  /** `unknown` is "could not check": the read failed, and `says` holds why. */
  status: 'pass' | 'fail' | 'unknown';
  /** What was found; on unknown, the reason. */
  says: string;
  /** On fail: the command or setting that fixes it. */
  fix?: string;
  action?: HealthAction;
  /** Shown apart, and never counted toward ready: an old failed build does not stop a cut. */
  informational?: true;
}

export interface Readiness {
  repo: string;
  fullName: string;
  checkedAt: string;
  items: ReadinessItem[];
}

/** The version the cut reads at a head (`ReleaseCuts.version`): its text, and why a cut would be refused, if it would. */
export type HeadVersion = { text: string | null; blocked: { message: string } | null };

export interface ReleaseReadinessDeps {
  repo(name: string): Promise<ReleaseRepo | null>;
  /** The release recipe, or null when it is not whole (`repos.getRelease`). */
  getRelease(repoId: string): Promise<ReleaseSetting | null>;
  /** Who last saved the recipe, from the audit, or null when no row says. */
  recipeSetBy(repoName: string): Promise<{ actor: string; at: string } | null>;
  /** Whether a signing key is filed for `owner/name`: a yes or no, never the key. */
  hasSigningKey(fullName: string): Promise<boolean>;
  /** hostd's probe of the release account (`GET /release/account`); null probe when hostd names none. */
  releaseAccount(): Promise<{ probe: ReleaseAccountProbe | null }>;
  /** The last published release where releases go, or null for none; throws when it cannot be read. */
  lastRelease(releaseRepo: string): Promise<LastRelease | null>;
  /** A client to read the repository with, as the view reads it; null when none can. */
  reader(fullName: string): Promise<ReleaseReader | null>;
  /** The cut's own version read at a SHA (`ReleaseCuts.version`). */
  version(client: ReleaseReader, repo: ReleaseRepo, setting: ReleaseSetting, last: LastRelease | null, sha: string): Promise<HeadVersion>;
  /** The app's own client on a repository, as the tag card asks; null where it is not installed. */
  app(fullName: string): Promise<RuleApi | null>;
  /** The repository's newest release run, or null for none. */
  lastRun(repoId: string): Promise<ReleaseRun | null>;
  now?(): number;
  timeoutMs?: number;
}

const TITLES: Record<ReadinessItemId, string> = {
  account: 'Release account',
  signing_key: 'Signing key',
  recipe: 'Release recipe',
  release_tag: 'Release tag',
  version: 'Next version',
  last_build: 'Last build',
};

const SHA = /^[0-9a-f]{40}$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

/** `promise`, or a rejection saying it took too long. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`it did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** One item as the card's result reads: fail with the card's fix, unknown with its reason, else pass. */
function fromCheck(id: ReadinessItemId, result: CheckResult): Omit<ReadinessItem, 'title'> {
  if (result.ok === false) return { id, status: 'fail', says: result.title, fix: result.detail, action: result.action };
  if (result.ok === null) return { id, status: 'unknown', says: result.reason };
  return { id, status: 'pass', says: result.says ?? 'It passes' };
}

/** The head's SHA and the version the cut would read there. */
interface Head {
  sha: string;
  version: HeadVersion;
}

export class ReleaseReadiness {
  // A plain record, not a Map: the source test holds this file to never naming the secret store's reader, `get`.
  private readonly kept: Record<string, { at: number; reading: Promise<Readiness> } | undefined> = Object.create(null);

  constructor(private readonly deps: ReleaseReadinessDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The repository's readiness, read at most once per `READINESS_TTL_MS`. A 404 for no such repository. */
  async read(name: string): Promise<Readiness> {
    const at = this.now();
    for (const [key, one] of Object.entries(this.kept)) if (one && at - one.at >= READINESS_TTL_MS) delete this.kept[key];
    const kept = this.kept[name];
    if (kept) return kept.reading;
    const reading = this.readNow(name);
    this.kept[name] = { at, reading };
    // A failed reading (no such repository, the database down) is not kept.
    reading.catch(() => {
      if (this.kept[name]?.reading === reading) delete this.kept[name];
    });
    return reading;
  }

  private async readNow(name: string): Promise<Readiness> {
    const repo = await this.deps.repo(name);
    if (!repo) throw new HttpFailure(404, `${name} is not a repository this install manages.`);
    const ms = this.deps.timeoutMs ?? READINESS_ITEM_TIMEOUT_MS;

    // Read once and shared by the items that need them; each item still answers on its own.
    const setting = this.deps.getRelease(repo.id);
    const releaseRepo = setting.then((one) => one?.releaseRepo ?? repo.fullName);
    const last = releaseRepo.then((target) => this.deps.lastRelease(target));
    const head = this.head(repo, setting, last);
    // Read by the items that wait on them; a rejection here is that item's to say.
    for (const shared of [setting, releaseRepo, last, head]) shared.catch(() => undefined);

    const reads: Record<ReadinessItemId, () => Promise<Omit<ReadinessItem, 'title'>>> = {
      account: () => this.account(),
      signing_key: () => this.signingKey(repo),
      recipe: () => this.recipe(repo, setting),
      release_tag: () => this.releaseTag(repo, releaseRepo, last, head),
      version: () => this.version(repo, setting, last, head),
      last_build: () => this.lastBuild(repo),
    };
    const settled = await Promise.allSettled(READINESS_ITEMS.map((id) => within(reads[id](), ms)));
    const items = READINESS_ITEMS.map((id, index): ReadinessItem => {
      const one = settled[index];
      const found: Omit<ReadinessItem, 'title'> =
        one?.status === 'fulfilled' ? one.value : { id, status: 'unknown', says: `Could not check: ${messageOf(one?.reason)}` };
      return { ...found, id, title: TITLES[id], ...(id === 'last_build' ? { informational: true as const } : {}) };
    });
    return { repo: repo.name, fullName: repo.fullName, checkedAt: new Date(this.now()).toISOString(), items };
  }

  /** The default branch's head and the version at it, as the view reads them, without pinning a view. Null without a recipe. */
  private async head(repo: ReleaseRepo, setting: Promise<ReleaseSetting | null>, last: Promise<LastRelease | null>): Promise<Head | null> {
    const recipe = await setting;
    if (!recipe) return null;
    const client = await this.deps.reader(repo.fullName).catch(() => null);
    if (!client) throw new Error(`OpenADLC has no GitHub account to read ${repo.fullName} with yet`);
    const ref = await client.request<{ object?: { sha?: unknown } }>(
      'GET',
      `/repos/${repo.fullName}/git/ref/heads/${repo.defaultBranch.split('/').map(encodeURIComponent).join('/')}`,
    );
    const sha = typeof ref.object?.sha === 'string' ? ref.object.sha.toLowerCase() : '';
    if (!SHA.test(sha)) throw new Error(`GitHub did not answer a commit for ${repo.defaultBranch} of ${repo.fullName}`);
    // The version's text does not need the last release, only its gate does: an unreadable last release
    // still leaves the tag item the head's version, and the version item says it could not check.
    return { sha, version: await this.deps.version(client, repo, recipe, await last.catch(() => null), sha) };
  }

  private async account(): Promise<Omit<ReadinessItem, 'title'>> {
    const { probe } = await this.deps.releaseAccount();
    if (!probe) {
      return {
        id: 'account',
        status: 'fail',
        says: 'hostd names no release account',
        fix: `Set OPENADLC_RELEASE_ACCOUNT to the account you made for releases (${RELEASE_ACCOUNT_DOCS}), then restart hostd.`,
        action: { label: 'Open the steps', url: RELEASE_ACCOUNT_DOCS_URL },
      };
    }
    if (probe.ok) return { id: 'account', status: 'pass', says: `${probe.account} (uid ${probe.uid}) builds releases in ${probe.home}` };
    const fix = releaseAccountFix(probe);
    return { id: 'account', status: 'fail', says: fix.title, fix: fix.detail, action: fix.action };
  }

  private async signingKey(repo: ReleaseRepo): Promise<Omit<ReadinessItem, 'title'>> {
    if (await this.deps.hasSigningKey(repo.fullName)) {
      return { id: 'signing_key', status: 'pass', says: `A signing key is filed for ${repo.fullName}; it is proved when a release is signed.` };
    }
    const command = `openadlc release-key import --repo ${repo.fullName} --file <path>`;
    return {
      id: 'signing_key',
      status: 'fail',
      says: `No release signing key is filed for ${repo.fullName}, so a build would stop when it is signed.`,
      fix: `Run on the host: ${command}`,
      action: { label: 'Run on the host', command },
    };
  }

  private async recipe(repo: ReleaseRepo, setting: Promise<ReleaseSetting | null>): Promise<Omit<ReadinessItem, 'title'>> {
    const recipe = await setting;
    if (!recipe) {
      return {
        id: 'recipe',
        status: 'fail',
        says: `${repo.name} has no release recipe: the command, the artifact and the version file are not all set.`,
        fix: `An admin sets it in Settings → ${repo.name} → Release.`,
        action: { label: 'Open the settings', href: `/settings/repositories/${encodeURIComponent(repo.name)}` },
      };
    }
    const by = await this.deps.recipeSetBy(repo.name).catch(() => null);
    const version = recipe.versionKey ? `${recipe.versionFile} (${recipe.versionKey})` : recipe.versionFile;
    const who = by ? `set by ${by.actor} at ${by.at}` : 'who set it is not recorded';
    return { id: 'recipe', status: 'pass', says: `Runs ${recipe.command}, leaves ${recipe.artifact}, reads the version from ${version}; ${who}.` };
  }

  private async releaseTag(
    repo: ReleaseRepo,
    releaseRepo: Promise<string>,
    last: Promise<LastRelease | null>,
    head: Promise<Head | null>,
  ): Promise<Omit<ReadinessItem, 'title'>> {
    const target = await releaseRepo;
    // The tag the publish makes is `v` and the head's version; without one, the card's likely next tag.
    const atHead = await head.catch(() => null);
    let tag: string;
    if (atHead?.version.text) tag = `v${atHead.version.text}`;
    else {
      try {
        tag = likelyNextTag((await last)?.version ?? null);
      } catch (error) {
        return { id: 'release_tag', status: 'unknown', says: `The last release of ${target} could not be read: ${messageOf(error)}` };
      }
    }
    const names = [...new Map([repo.fullName, target].map((name) => [name.toLowerCase(), name])).values()];
    const results = await Promise.all(names.map((name) => judgeReleaseTag({ app: this.deps.app }, name, repo.fullName, tag, name.toLowerCase() !== repo.fullName.toLowerCase())));
    // The worst wins: a block, then no answer, then fine.
    const worst = results.find((one) => one.ok === false) ?? results.find((one) => one.ok === null) ?? results[0];
    if (!worst) return { id: 'release_tag', status: 'unknown', says: 'Nothing was judged' };
    if (worst.ok === true) {
      return { id: 'release_tag', status: 'pass', says: names.length > 1 ? `OpenADLC's app may create ${tag} on ${names.join(' and ')}` : (worst.says ?? `OpenADLC's app may create ${tag}`) };
    }
    return fromCheck('release_tag', worst);
  }

  private async version(
    repo: ReleaseRepo,
    setting: Promise<ReleaseSetting | null>,
    last: Promise<LastRelease | null>,
    head: Promise<Head | null>,
  ): Promise<Omit<ReadinessItem, 'title'>> {
    const recipe = await setting;
    if (!recipe) return { id: 'version', status: 'unknown', says: 'Could not check: it needs the release recipe’s version file.' };
    let previous: LastRelease | null;
    try {
      previous = await last;
    } catch (error) {
      return { id: 'version', status: 'unknown', says: `Could not check: the last release of ${recipe.releaseRepo ?? repo.fullName} could not be read: ${messageOf(error)}` };
    }
    let atHead: Head | null;
    try {
      atHead = await head;
    } catch (error) {
      return { id: 'version', status: 'unknown', says: `Could not check: ${messageOf(error)}` };
    }
    if (!atHead) return { id: 'version', status: 'unknown', says: 'Could not check: it needs the release recipe’s version file.' };
    const { sha, version } = atHead;
    const lastText = previous ? previous.version : 'no release yet';
    if (!version.blocked) {
      return {
        id: 'version',
        status: 'pass',
        says: previous ? `${version.text ?? '?'} at ${sha7(sha)} is above ${previous.version}` : `${version.text ?? '?'} at ${sha7(sha)} would be the first release`,
      };
    }
    return {
      id: 'version',
      status: 'fail',
      says: `${version.blocked.message}. At ${sha7(sha)}: ${version.text ?? 'no version read'}; last release: ${lastText}.`,
      fix: `Raise the version in ${recipe.versionFile}${recipe.versionKey ? ` (${recipe.versionKey})` : ''} above ${lastText}, or use Prepare next version on this page when it is offered.`,
    };
  }

  private async lastBuild(repo: ReleaseRepo): Promise<Omit<ReadinessItem, 'title'>> {
    const run = await this.deps.lastRun(repo.id);
    if (!run) return { id: 'last_build', status: 'pass', says: `${repo.name} has not been built for a release yet.` };
    const when = `started ${run.startedAt}${run.finishedAt ? `, ended ${run.finishedAt}` : ''}, cut by ${run.requestedByLogin}`;
    const why = run.reason ? `: ${run.reason}` : '';
    switch (run.state) {
      case 'failed':
      case 'cancelled':
      case 'lost':
        // Said from the row alone: hostd never looks in the account's folder for us (`release-run.ts`).
        return {
          id: 'last_build',
          status: 'fail',
          says: `The last build ${run.state === 'lost' ? 'was lost' : run.state}${why} (${when}). The build tree in the release account's home is kept as that build left it, and the next cut reuses it.`,
          fix: 'Tick Clean build when you cut.',
        };
      case 'publish_failed':
        return {
          id: 'last_build',
          status: 'fail',
          says: `The last build was built but not published (${when}); hostd still holds the built artifact.`,
          fix: run.reason ?? 'See the run below for why the publish failed.',
        };
      case 'running':
      case 'built':
      case 'publishing':
        return { id: 'last_build', status: 'pass', says: `A release is in flight (${run.state}; ${when}).` };
      case 'published':
        return { id: 'last_build', status: 'pass', says: `The last build was published${run.tag ? ` as ${run.tag}` : ''} (${when}).` };
      case 'refused':
        return { id: 'last_build', status: 'pass', says: `The last build was refused before it ran${why} (${when}); it left nothing behind.` };
    }
  }
}

/** The live wiring: the database and the reads `api.ts` hands it. Nothing here can start, pin, sign or publish. */
export function liveReleaseReadiness(input: {
  version: ReleaseReadinessDeps['version'];
  lastRelease: ReleaseReadinessDeps['lastRelease'];
  reader: ReleaseReadinessDeps['reader'];
  app: ReleaseReadinessDeps['app'];
  releaseAccount: ReleaseReadinessDeps['releaseAccount'];
  hasSigningKey: ReleaseReadinessDeps['hasSigningKey'];
}): ReleaseReadiness {
  return new ReleaseReadiness({
    ...input,
    repo: async (name) => {
      const found = await repos.getRepoByName(name);
      return found ? { id: found.id, name: found.name, fullName: found.fullName, defaultBranch: found.defaultBranch } : null;
    },
    getRelease: (repoId) => repos.getRelease(repoId),
    recipeSetBy: async (repoName) => {
      const row = await lastAuditHaving('repo.settings', repoName, 'release');
      return row ? { actor: row.actor, at: row.at } : null;
    },
    lastRun: async (repoId) => (await releaseRuns.forRepo(repoId, 1))[0] ?? null,
  });
}
