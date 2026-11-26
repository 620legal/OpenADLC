import { randomUUID } from 'node:crypto';
import { audit as writeAudit, people as peopleStore, releaseRuns, repos, type ReleaseRun, type ReleaseSetting } from '@openadlc/db';
import { parseRepoVersion, repoVersionFrom, repoVersionGate, repoVersionNotAbove, suggestNextRepoVersion, type RepoVersion } from '@openadlc/shared';
import { LINK_ACCOUNT_URL, PEOPLE_URL } from './human-review-decide.js';
import { personKey, type FlowView, type GitHubViewer, type PersonFlows, type PersonGitHubDeps } from './person-github.js';
import type { Preparation } from './release-prepare.js';
import type { ReleaseReadiness } from './release-readiness.js';
import type { LastRelease, ReleaseRepo, ReleaseService } from './release-service.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Cutting a release from the console (#345,
 * docs/adr/0072-a-release-is-cut-by-an-approver-from-a-pinned-view-with-a-fresh-device-code-proof.md).
 *
 * The one way a release run starts. `ReleaseService.start` checks nothing
 * about who asked, so everything that decides it is here:
 *
 * - **The bridge pins the view, and the click names the view, never a
 *   commit.** Building the compare view reads the default branch's head once
 *   and keeps it, with the last release and the version at that head, under a
 *   view id. The cut takes `{ viewId, clean }` and nothing else: were the click
 *   to send a SHA, a stale tab or a hand-made request could release any
 *   commit of the branch, one nobody compared. A view is the identity's that
 *   built it, lasts 15 minutes, is spent once `start` accepts a run from it,
 *   and is kept in memory only: a restarted bridge forgets it, and the person
 *   reloads.
 * - **Who may cut:** a console person whose linked GitHub account has
 *   Approves on in People, asked before the sign-in and again after it, and
 *   proved by a fresh device-code sign-in whose account id and login are the
 *   linked ones and not an account the crew uses. The token is used only to
 *   ask GitHub who approved the code; `PersonFlows` revokes it.
 * - **The version** at the pinned head is checked with hostd's own rule
 *   (`parseRepoVersion`, `repoVersionGate`), so nobody approves a code for a
 *   cut hostd would refuse. hostd checks it again at the same SHA, and its
 *   check is the authority.
 * - Every refusal of a cut is audited as `release.cut_refused` with its
 *   reason, before or after the sign-in; a cut is `release.cut`.
 *
 * The routes are `user` routes: anyone in the console may watch a release.
 * Approves is checked here, per person, as the author's sign-off checks it
 * (ADR 0063), not by a role.
 */

/** How long a pinned view may be cut from. */
export const VIEW_TTL_MS = 15 * 60_000;

/** The most views kept per identity: a person reloading the page makes one each time. */
const VIEWS_PER_IDENTITY = 5;

/** How much of the version file is read: as much as hostd reads (`VERSION_FILE_BYTES`). */
const VERSION_FILE_BYTES = 64 * 1024;

/** The newest commits the compare view lists. */
const COMPARE_COMMITS = 50;

/** How many runs of a repository its page lists. */
const RUNS_LISTED = 20;

const SHA = /^[0-9a-f]{40}$/;

/** Why `mayCut` is false, said to the viewer with where to act on it. */
export const APPROVES_OFF_FOR_RELEASE = 'Approves is off for you in People, so you cannot cut a release; an admin turns it on in Settings → People.';
export const NOT_LINKED_FOR_RELEASE = 'Link your GitHub account in Settings → Your GitHub account: a release is cut by the account linked to you, proved by its sign-in.';
const VIEW_GONE = 'That view has expired; reload to see the default branch’s head again.';
const SHA_IN_BODY = 'the commit is the one the view showed; reload to see the new head';

/** The audit actions a cut writes. */
export const RELEASE_CUT = 'release.cut';
export const RELEASE_CUT_REFUSED = 'release.cut_refused';

/** Why a cut was refused, as its `release.cut_refused` row says. */
export type CutRefusalReason =
  | 'bad_body'
  | 'view_gone'
  | 'not_linked'
  | 'approves_off'
  | 'version_not_above'
  | 'compare_refused'
  | 'in_flight'
  | 'already_signing'
  | 'sign_in_unavailable'
  | 'sign_in_failed'
  | 'other_account'
  | 'crew_account'
  | 'service_refused';

/** What GitHub's reads answer: the automation account or the app, as `deployClient` gives one. */
export interface ReleaseReader {
  request<T>(method: string, path: string): Promise<T>;
}

/** GitHub's compare of the last release's tag with the pinned head, as the page shows it. */
export type CompareView =
  | { first: true }
  | {
      first: false;
      status: string;
      aheadBy: number;
      totalCommits: number;
      /** The newest first, at most 50. */
      commits: { sha7: string; title: string; author: string | null }[];
      files: number;
      htmlUrl: string | null;
    };

/** What blocks a cut of a view whatever the viewer: its compare, or its version. */
interface Blocked {
  reason: 'version_not_above' | 'compare_refused';
  message: string;
  /**
   * Only for a head version the gate refuses as at or below the last release
   * (`repoVersionNotAbove`): the one refusal Prepare next version answers
   * (#363, docs/adr/0078). A missing file, an unreadable last release or a
   * label mismatch leave it unset.
   */
  notAbove?: { after: RepoVersion };
}

/** What a Prepare next version press may file, as `preparable` answers it: never the SHA, never the service. */
export interface Preparable {
  repo: ReleaseRepo;
  last: { version: RepoVersion; tag: string };
  versionFile: string;
  versionKey: string | null;
  link: { githubLogin: string; githubUserId: number };
}

/** Why `preparable` refused, with the status and the reason its audit row gives. */
export type PreparableRefusal = { status: number; message: string; reason: 'view_gone' | 'not_offered' | 'not_linked' | 'approves_off' | 'in_flight'; url?: string };

interface PinnedView {
  viewId: string;
  identity: string;
  repo: ReleaseRepo;
  sha: string;
  last: LastRelease | null;
  version: string | null;
  blocked: Blocked | null;
  /** The recipe's, kept for a Prepare press; a cut never reads them. */
  versionFile: string;
  versionKey: string | null;
  releaseRepo: string;
  expiresAt: number;
  spent: boolean;
}

/** A cut's sign-in, until `use` runs or the flow ends without it. */
interface Signing {
  flowId: string;
  identity: string;
  view: PinnedView;
  link: { githubLogin: string; githubUserId: number };
  used: boolean;
}

/** A run as the console shows it. The log tail and reason are hostd's, redacted before they were stored. */
export interface RunView {
  id: string;
  runId: string;
  repo: string;
  sha: string;
  state: ReleaseRun['state'];
  clean: boolean;
  version: string | null;
  previousVersion: string | null;
  reason: string | null;
  logTail: string | null;
  tag: string | null;
  releaseUrl: string | null;
  requestedBy: string;
  startedAt: string;
  finishedAt: string | null;
  publishedAt: string | null;
}

export function runView(run: ReleaseRun): RunView {
  return {
    id: run.id,
    runId: run.runId,
    repo: run.repoName,
    sha: run.sha,
    state: run.state,
    clean: run.clean,
    version: run.version,
    previousVersion: run.previousVersion,
    reason: run.reason,
    logTail: run.logTail,
    tag: run.tag,
    releaseUrl: run.releaseUrl,
    requestedBy: run.requestedByLogin,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    publishedAt: run.publishedAt,
  };
}

export interface ReleaseCutDeps {
  /** The service; `release-routes.ts` is the only caller of its `start`. */
  release: Pick<ReleaseService, 'start' | 'lastRelease'>;
  /** A repository OpenADLC works in, by name. */
  repo(name: string): Promise<ReleaseRepo | null>;
  /** Its release recipe (#343), or null when it is not set to release. */
  getRelease(repoId: string): Promise<ReleaseSetting | null>;
  /** A client to read the repository with; null when none can. Reads only. */
  reader(fullName: string): Promise<ReleaseReader | null>;
  /** The repository's runs, newest first. */
  runsOf(repoId: string, limit: number): Promise<ReleaseRun[]>;
  /** One run by its row id. */
  run(id: string): Promise<ReleaseRun | null>;
  /** The repositories set to release. */
  releasing(): Promise<{ id: string; fullName: string; releaseRepo: string | null }[]>;
  flows: Pick<PersonFlows, 'start' | 'state'>;
  /** The viewer's linked GitHub account (`person_accounts`; the operator's on a local install), or null. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  isCrew(login: string): Promise<boolean>;
  /** Whether People has Approves on for the person this account is linked to. A failed read is a refusal. */
  approves(githubUserId: number): Promise<boolean>;
  /**
   * The open Prepare next version of a repository (`release-prepare.ts`), or
   * null. Read for the view alone; a cut never reads it. A failed read says
   * nothing, as null does.
   */
  preparing?(repo: ReleaseRepo): Promise<Preparation | null>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  now?(): number;
  newId?(): string;
  warn?(message: string): void;
}

/** The audit target of a repository's cuts. */
export function cutTarget(fullName: string): string {
  return `${fullName}:release`;
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal and the reason its audit row gives. */
class CutRefusal extends HttpFailure {
  constructor(
    status: number,
    message: string,
    readonly reason: CutRefusalReason,
    details: Record<string, unknown> = {},
  ) {
    super(status, message, details);
  }
}

/** A flow's `use` failing: said to the person as the flow's error, with its reason kept for the audit row. */
class CutUseRefusal extends Error {
  constructor(
    message: string,
    readonly reason: CutRefusalReason,
  ) {
    super(message);
  }
}

export class ReleaseCuts {
  private readonly views = new Map<string, PinnedView>();
  /** Cut sign-ins by flow id, so one that ends without `use` is audited too. */
  private readonly signings = new Map<string, Signing>();

  constructor(private readonly deps: ReleaseCutDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private async repoOf(name: string): Promise<ReleaseRepo> {
    const repo = await this.deps.repo(name);
    if (!repo) throw new HttpFailure(404, `${name} is not a repository this install manages.`);
    return repo;
  }

  private async inFlight(repoId: string): Promise<ReleaseRun | null> {
    const runs = await this.deps.runsOf(repoId, 5);
    return runs.find((run) => releaseRuns.RELEASE_IN_FLIGHT.includes(run.state)) ?? null;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, view] of this.views) if (view.expiresAt <= now) this.views.delete(id);
  }

  /** Keeps a view, dropping the identity's oldest beyond `VIEWS_PER_IDENTITY`. */
  private keep(view: PinnedView): void {
    this.prune();
    const theirs = [...this.views.values()].filter((one) => one.identity === view.identity).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const old of theirs.slice(0, Math.max(0, theirs.length - VIEWS_PER_IDENTITY + 1))) this.views.delete(old.viewId);
    this.views.set(view.viewId, view);
  }

  /** The view a cut names, if it is still this identity's to cut from. */
  private live(viewId: string, identity: string, repoName: string): PinnedView | null {
    this.prune();
    const view = this.views.get(viewId);
    if (!view || view.identity !== identity || view.repo.name !== repoName || view.spent) return null;
    return view;
  }

  /** Whether this viewer may cut, and if not, why and where to act on it. */
  private async viewer(identity: string): Promise<{ link: { githubLogin: string; githubUserId: number } | null; why: string | null; url: string | null }> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    if (!link) return { link, why: NOT_LINKED_FOR_RELEASE, url: LINK_ACCOUNT_URL };
    if (!(await this.deps.approves(link.githubUserId).catch(() => false))) return { link, why: APPROVES_OFF_FOR_RELEASE, url: PEOPLE_URL };
    return { link, why: null, url: null };
  }

  /**
   * Builds the compare view and pins it. The default branch's head is read
   * once, here, and every later read and the run use that SHA, never the
   * branch's name.
   */
  async view(repoName: string, identity: string) {
    await this.sweepFlows();
    const repo = await this.repoOf(repoName);
    const setting = await this.deps.getRelease(repo.id);
    if (!setting) throw new HttpFailure(404, `${repo.name} has no release recipe; an admin sets it in Settings → ${repo.name} → Release.`);
    const releaseRepo = setting.releaseRepo ?? repo.fullName;
    let last: LastRelease | null;
    try {
      last = await this.deps.release.lastRelease(releaseRepo);
    } catch (error) {
      // Never "no release yet": a view compared with nothing would offer a cut of everything.
      throw new HttpFailure(503, `The last release of ${releaseRepo} could not be read, so there is nothing to compare with: ${messageOf(error)}. Try again shortly.`);
    }
    const client = await this.deps.reader(repo.fullName).catch(() => null);
    if (!client) throw new HttpFailure(503, `OpenADLC has no GitHub account to read ${repo.fullName} with yet. Finish connecting the automation account or the app first.`);

    const ref = await client
      .request<{ object?: { sha?: unknown } }>('GET', `/repos/${repo.fullName}/git/ref/heads/${repo.defaultBranch.split('/').map(encodeURIComponent).join('/')}`)
      .catch((error: unknown) => {
        throw new HttpFailure(503, `GitHub did not say where ${repo.defaultBranch} of ${repo.fullName} is: ${messageOf(error)}. Try again shortly.`);
      });
    const sha = typeof ref.object?.sha === 'string' ? ref.object.sha.toLowerCase() : '';
    if (!SHA.test(sha)) throw new HttpFailure(503, `GitHub did not answer a commit for ${repo.defaultBranch} of ${repo.fullName}. Try again shortly.`);

    let blocked: Blocked | null = null;
    let compare: CompareView = { first: true };
    if (last) {
      const read = await this.compare(client, repo, last, sha);
      compare = read.compare ?? compare;
      blocked = read.blocked;
    }
    const version = await this.version(client, repo, setting, last, sha);
    if (!blocked && version.blocked) blocked = version.blocked;

    const inFlight = await this.inFlight(repo.id);
    const who = await this.viewer(identity);
    const preparing = this.deps.preparing ? await this.deps.preparing(repo).catch(() => null) : null;
    const view: PinnedView = {
      viewId: (this.deps.newId ?? randomUUID)(),
      identity,
      repo,
      sha,
      last,
      version: version.text,
      blocked,
      versionFile: setting.versionFile,
      versionKey: setting.versionKey,
      releaseRepo,
      expiresAt: this.now() + VIEW_TTL_MS,
      spent: false,
    };
    this.keep(view);

    const why = blocked
      ? { why: blocked.message, url: null }
      : who.why
        ? { why: who.why, url: who.url }
        : inFlight
          ? { why: `A release of ${repo.name} is in flight (${inFlight.state}); wait for it to end.`, url: `/releases/${encodeURIComponent(repo.name)}#run-${inFlight.id}` }
          : null;
    // Offered only where a cut is refused for a version at or below the last
    // release, to a viewer who may cut, with nothing in flight or preparing.
    const suggested = blocked?.notAbove && !who.why && !inFlight && !preparing ? suggestNextRepoVersion(blocked.notAbove.after) : null;
    const prepare =
      suggested && last && blocked?.notAbove
        ? { suggested, last: { version: blocked.notAbove.after.text, tag: last.tag }, versionFile: setting.versionFile, versionKey: setting.versionKey }
        : null;
    return {
      viewId: view.viewId,
      repo: repo.name,
      fullName: repo.fullName,
      releaseRepo,
      sha,
      defaultBranch: repo.defaultBranch,
      last,
      version: version.text === null ? null : { text: version.text, after: last?.version ?? null },
      compare,
      mayCut: why === null,
      ...(why ? { why: why.why, ...(why.url ? { url: why.url } : {}) } : {}),
      inFlight: inFlight ? runView(inFlight) : null,
      prepare,
      preparing,
      expiresInSeconds: Math.round(VIEW_TTL_MS / 1000),
    };
  }

  /** GitHub's compare of `last.tag...sha`: the SHA, never the branch, so it shows exactly what would be cut. */
  private async compare(client: ReleaseReader, repo: ReleaseRepo, last: LastRelease, sha: string): Promise<{ compare: CompareView | null; blocked: Blocked | null }> {
    let answer: {
      status?: string;
      ahead_by?: number;
      total_commits?: number;
      commits?: { sha?: string; commit?: { message?: string }; author?: { login?: string } | null }[];
      files?: unknown[];
      html_url?: string;
    };
    try {
      answer = await client.request('GET', `/repos/${repo.fullName}/compare/${encodeURIComponent(last.tag)}...${sha}`);
    } catch (error) {
      if (statusOf(error) === 404) {
        return {
          compare: null,
          blocked: { reason: 'compare_refused', message: `${repo.fullName} has no tag ${last.tag} to compare with. Create it on the commit ${last.version} was built from, then reload.` },
        };
      }
      throw new HttpFailure(503, `GitHub could not compare ${last.tag} with ${sha7(sha)} in ${repo.fullName}: ${messageOf(error)}. Try again shortly.`);
    }
    const commits = Array.isArray(answer.commits) ? answer.commits : [];
    const compare: CompareView = {
      first: false,
      status: typeof answer.status === 'string' ? answer.status : 'unknown',
      aheadBy: typeof answer.ahead_by === 'number' ? answer.ahead_by : 0,
      totalCommits: typeof answer.total_commits === 'number' ? answer.total_commits : commits.length,
      commits: commits
        .slice(-COMPARE_COMMITS)
        .reverse()
        .map((commit) => ({
          sha7: sha7(typeof commit.sha === 'string' ? commit.sha : ''),
          title: (commit.commit?.message ?? '').split('\n')[0] ?? '',
          author: typeof commit.author?.login === 'string' ? commit.author.login : null,
        })),
      files: Array.isArray(answer.files) ? answer.files.length : 0,
      htmlUrl: typeof answer.html_url === 'string' ? answer.html_url : null,
    };
    // A head that does not contain the last release would release older work above it.
    if (compare.status === 'behind' || compare.status === 'diverged') {
      return { compare, blocked: { reason: 'compare_refused', message: `${sha7(sha)} does not contain ${last.tag}, so it cannot be released after it.` } };
    }
    return { compare, blocked: null };
  }

  /**
   * The version at the pinned SHA, held above the last release by hostd's own
   * rule. The release page's readiness (#371, docs/adr/0084) reads it too, at
   * the head it read, so the checklist and the cut judge a version alike; it
   * reads only, and pins nothing.
   */
  async version(
    client: ReleaseReader,
    repo: ReleaseRepo,
    setting: ReleaseSetting,
    last: LastRelease | null,
    sha: string,
  ): Promise<{ text: string | null; blocked: Blocked | null }> {
    const refuse = (message: string) => ({ text: null, blocked: { reason: 'version_not_above' as const, message } });
    let file: { content?: string; encoding?: string; size?: number; type?: string };
    try {
      file = await client.request('GET', `/repos/${repo.fullName}/contents/${setting.versionFile.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
    } catch (error) {
      if (statusOf(error) === 404) return refuse(`${setting.versionFile} is not in ${sha7(sha)}: add it, or set the repository's version file`);
      throw new HttpFailure(503, `GitHub could not read ${setting.versionFile} of ${repo.fullName} at ${sha7(sha)}: ${messageOf(error)}. Try again shortly.`);
    }
    if (file.type !== undefined && file.type !== 'file') return refuse(`${setting.versionFile} is not a file in ${sha7(sha)}: point the repository's version file at one`);
    const text = Buffer.from(file.content ?? '', (file.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    if ((typeof file.size === 'number' && file.size > VERSION_FILE_BYTES) || Buffer.byteLength(text) > VERSION_FILE_BYTES) {
      return refuse(`${setting.versionFile} is larger than ${VERSION_FILE_BYTES / 1024} KiB: point the repository's version file at a smaller one`);
    }
    const read = parseRepoVersion(text, setting.versionFile, setting.versionKey);
    if (!read.ok) return refuse(read.reason);
    const after = last ? repoVersionFrom(last.version) : null;
    if (after && !after.ok) return { text: read.version.text, blocked: { reason: 'version_not_above', message: `the last release's version, ${last?.version}, cannot be read` } };
    const gate = repoVersionGate(read.version, after?.ok ? after.version : null, setting.versionFile);
    if (!gate) return { text: read.version.text, blocked: null };
    const notAbove = after?.ok && repoVersionNotAbove(read.version, after.version) ? { notAbove: { after: after.version } } : {};
    return { text: read.version.text, blocked: { reason: 'version_not_above', message: gate, ...notAbove } };
  }

  /**
   * Whether a Prepare next version press may file from this view (#363,
   * docs/adr/0078): the view is the identity's own, unexpired and unspent,
   * its head is refused only as not above the last release, nothing is in
   * flight, and the viewer passes the same `viewer()` check the view and the
   * cut use. It reads only: it never spends the view, and what it answers
   * carries no SHA and no handle on the service, so the prepare route cannot
   * start, pin or sign anything.
   */
  async preparable(viewId: string, identity: string, repoName: string): Promise<{ ok: true; preparable: Preparable } | { ok: false; refusal: PreparableRefusal }> {
    const view = this.live(viewId, identity, repoName);
    if (!view) return { ok: false, refusal: { status: 409, message: VIEW_GONE, reason: 'view_gone' } };
    const notAbove = view.blocked?.notAbove;
    if (!notAbove || !view.last) {
      return { ok: false, refusal: { status: 409, message: `Prepare next version is offered only when ${view.repo.name}'s version is not above the last release; reload to see the page again.`, reason: 'not_offered' } };
    }
    const going = await this.inFlight(view.repo.id);
    if (going) return { ok: false, refusal: { status: 409, message: `A release of ${view.repo.name} is in flight (${going.state}); wait for it to end.`, reason: 'in_flight' } };
    const who = await this.viewer(identity);
    if (who.why || !who.link) {
      return { ok: false, refusal: { status: 403, message: who.why ?? NOT_LINKED_FOR_RELEASE, reason: who.link ? 'approves_off' : 'not_linked', ...(who.url ? { url: who.url } : {}) } };
    }
    return {
      ok: true,
      preparable: { repo: view.repo, last: { version: notAbove.after, tag: view.last.tag }, versionFile: view.versionFile, versionKey: view.versionKey, link: who.link },
    };
  }

  /**
   * Audits a refused cut. A row that cannot be written is said in the log:
   * the person is refused all the same.
   */
  private async auditRefusal(
    at: {
      repo: string;
      identity: string;
      reason: CutRefusalReason;
      why: string;
      stage: 'before_sign_in' | 'after_sign_in';
      view?: PinnedView | null;
      link?: { githubLogin: string; githubUserId: number } | null;
      viewer?: GitHubViewer;
    },
  ): Promise<void> {
    const { repo, identity, reason, why, stage, view, link, viewer } = at;
    try {
      await this.deps.audit({
        actor: identity,
        action: RELEASE_CUT_REFUSED,
        target: cutTarget(view?.repo.fullName ?? repo),
        payload: {
          repo: view?.repo.fullName ?? repo,
          reason,
          why,
          stage,
          viewSha: view?.sha ?? null,
          linkedLogin: link?.githubLogin ?? null,
          linkedId: link?.githubUserId ?? null,
          ...(viewer ? { login: viewer.login, githubUserId: viewer.id } : {}),
          by: identity,
        },
      });
    } catch (failure) {
      this.warn(`[bridge] ${identity}'s refused release cut of ${repo} (${reason}) was not audited: ${messageOf(failure)}`);
    }
  }

  /** The cut's body: exactly `{ viewId, clean? }`. A SHA in it is refused, since the commit is the view's. */
  private bodyProblem(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the cut takes { viewId, clean? }';
    const input = body as Record<string, unknown>;
    if ('sha' in input) return SHA_IN_BODY;
    const extra = Object.keys(input).filter((key) => key !== 'viewId' && key !== 'clean');
    if (extra.length > 0) return `the cut takes { viewId, clean? } only, not ${extra.join(', ')}; the commit is the one the view showed`;
    if (typeof input.viewId !== 'string' || !input.viewId) return 'viewId is the view the page showed; reload to make one';
    if (input.clean !== undefined && typeof input.clean !== 'boolean') return 'clean is true or false';
    return null;
  }

  /**
   * Checks a cut, then starts its device-code sign-in. Each refusal is
   * audited before it is thrown; the commit comes from the view alone.
   */
  async cut(repoName: string, identity: string, body: unknown): Promise<{ flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    await this.sweepFlows();
    const problem = this.bodyProblem(body);
    if (problem) {
      await this.auditRefusal({ repo: repoName, identity, reason: 'bad_body', why: problem, stage: 'before_sign_in' });
      throw new HttpFailure(400, problem);
    }
    const { viewId, clean = false } = body as { viewId: string; clean?: boolean };
    let view: PinnedView | null = null;
    let link: { githubLogin: string; githubUserId: number } | null = null;
    try {
      view = this.live(viewId, identity, repoName);
      if (!view) throw new CutRefusal(409, VIEW_GONE, 'view_gone');
      link = await this.deps.linkOf(personKey(identity)).catch(() => null);
      if (!link) throw new CutRefusal(403, NOT_LINKED_FOR_RELEASE, 'not_linked', { url: LINK_ACCOUNT_URL });
      if (!(await this.deps.approves(link.githubUserId).catch(() => false))) throw new CutRefusal(403, APPROVES_OFF_FOR_RELEASE, 'approves_off', { url: PEOPLE_URL });
      // Said before the sign-in, so nobody approves a code for a cut that would be refused.
      if (view.blocked) throw new CutRefusal(409, view.blocked.message, view.blocked.reason);
      const going = await this.inFlight(view.repo.id);
      if (going) throw new CutRefusal(409, `A release of ${view.repo.name} is in flight (${going.state}); wait for it to end. Nothing was started.`, 'in_flight');
      for (const signing of this.signings.values()) {
        if (signing.view.viewId === viewId && this.deps.flows.state(signing.flowId, signing.identity).state === 'waiting') {
          throw new CutRefusal(409, 'A sign-in to cut this release is still waiting for you; approve that code, or let it expire. Nothing was started.', 'already_signing');
        }
      }
    } catch (error) {
      if (error instanceof CutRefusal) await this.auditRefusal({ repo: repoName, identity, reason: error.reason, why: error.message, stage: 'before_sign_in', view, link });
      throw error;
    }
    const pinned = view;
    const linked = link;
    // `use` waits for the flow's id, known once `start` answers: a code
    // approved at once must still find its sign-in to mark it used.
    let known: (flowId: string) => void = () => undefined;
    const flowId = new Promise<string>((resolve) => (known = resolve));
    let flow: FlowView<{ runId: string; id: string }>;
    try {
      flow = await this.deps.flows.start(identity, async (viewer) => this.use({ view: pinned, link: linked, identity, clean, viewer, flowId: await flowId }), {
        noClientId:
          'OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured, so it cannot take a release cut. An admin finishes “Create the app” first.',
      });
    } catch (error) {
      await this.auditRefusal({ repo: repoName, identity, reason: 'sign_in_unavailable', why: messageOf(error), stage: 'before_sign_in', view: pinned, link: linked });
      throw error;
    }
    this.signings.set(flow.flowId, { flowId: flow.flowId, identity, view: pinned, link: linked, used: false });
    known(flow.flowId);
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }

  /**
   * The cut once the person approved the code: the account that approved is
   * the linked one and not the crew's, Approves is still on, and the view is
   * still theirs. Then the view is spent and the run started for its SHA.
   */
  private async use(input: {
    view: PinnedView;
    link: { githubLogin: string; githubUserId: number };
    identity: string;
    clean: boolean;
    viewer: GitHubViewer;
    flowId: string;
  }): Promise<{ runId: string; id: string }> {
    const { view, link, identity, clean, viewer, flowId } = input;
    const signing = this.signings.get(flowId);
    if (signing) signing.used = true;
    else this.signings.set(flowId, { flowId, identity, view, link, used: true });
    const refused = async (error: CutUseRefusal): Promise<never> => {
      await this.auditRefusal({ repo: view.repo.fullName, identity, reason: error.reason, why: error.message, stage: 'after_sign_in', view, link, viewer });
      throw error;
    };
    if (viewer.id !== link.githubUserId || viewer.login.toLowerCase() !== link.githubLogin.toLowerCase()) {
      await refused(new CutUseRefusal(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; no release was started.`, 'other_account'));
    }
    if (await this.deps.isCrew(viewer.login).catch(() => true)) {
      await refused(new CutUseRefusal(`@${viewer.login} is an account the crew uses; a bot never cuts a release.`, 'crew_account'));
    }
    // Asked again: Approves may have been turned off while the person signed in.
    if (!(await this.deps.approves(viewer.id).catch(() => false))) await refused(new CutUseRefusal(APPROVES_OFF_FOR_RELEASE, 'approves_off'));
    if (!this.live(view.viewId, identity, view.repo.name)) await refused(new CutUseRefusal(VIEW_GONE, 'view_gone'));
    // Spent before `start` is awaited, so a second sign-in on the same view cannot start a second run.
    view.spent = true;
    let run: ReleaseRun;
    try {
      run = await this.deps.release.start({ repo: view.repo, sha: view.sha, clean, by: { login: viewer.login, githubUserId: viewer.id } });
    } catch (error) {
      // Nothing started: the view stays, so the person can retry it with a new proof.
      view.spent = false;
      return refused(new CutUseRefusal(messageOf(error), 'service_refused'));
    }
    try {
      await this.deps.audit({
        actor: identity,
        action: RELEASE_CUT,
        target: cutTarget(view.repo.fullName),
        payload: {
          repo: view.repo.fullName,
          runId: run.runId,
          id: run.id,
          sha: view.sha,
          version: view.version,
          after: view.last?.version ?? null,
          clean,
          state: run.state,
          login: viewer.login,
          githubUserId: viewer.id,
          by: identity,
        },
      });
    } catch (failure) {
      // The run started; told it failed, the person would cut again for nothing.
      this.warn(`[bridge] @${viewer.login}'s release cut of ${view.repo.fullName} at ${sha7(view.sha)} started run ${run.runId} but was not audited: ${messageOf(failure)}`);
    }
    return { runId: run.runId, id: run.id };
  }

  /**
   * Audits each cut sign-in that ended without its `use` running: the code
   * expired, or GitHub's poll or its "who is this" failed. `PersonFlows` says
   * nothing of those to the caller, so they are found here, on every release
   * route and on the bridge's timer.
   */
  async sweepFlows(): Promise<void> {
    for (const [flowId, signing] of this.signings) {
      const seen = this.deps.flows.state<unknown>(flowId, signing.identity);
      if (seen.state === 'waiting') continue;
      this.signings.delete(flowId);
      if (signing.used) continue;
      const error = 'error' in seen && seen.error ? seen.error : 'the sign-in ended before the code was approved';
      await this.auditRefusal({
        repo: signing.view.repo.fullName,
        identity: signing.identity,
        reason: 'sign_in_failed',
        why: error,
        stage: 'after_sign_in',
        view: signing.view,
        link: signing.link,
      });
    }
  }

  /** How a cut's sign-in went, for the identity that started it only. */
  async flowState(flowId: string, identity: string): Promise<{ state: string; runId?: string; id?: string; error?: string }> {
    const seen = this.deps.flows.state<{ runId: string; id: string }>(flowId, identity);
    await this.sweepFlows();
    if (seen.state === 'none') return { state: 'none' };
    const view = seen as FlowView<{ runId: string; id: string }>;
    return {
      state: view.state,
      ...(view.result ? { runId: view.result.runId, id: view.result.id } : {}),
      ...(view.error ? { error: view.error } : {}),
    };
  }

  /** The repositories set to release, each with its latest run. */
  async list(): Promise<{ repos: { name: string; fullName: string; releaseRepo: string | null; latest: RunView | null }[] }> {
    const releasing = await this.deps.releasing();
    const rows = await Promise.all(
      releasing.map(async (one) => {
        const repo = await this.deps.repo(one.fullName).catch(() => null);
        const [latest] = await this.deps.runsOf(one.id, 1).catch(() => []);
        return { name: repo?.name ?? one.fullName, fullName: one.fullName, releaseRepo: one.releaseRepo, latest: latest ? runView(latest) : null };
      }),
    );
    return { repos: rows };
  }

  async runs(repoName: string): Promise<{ runs: RunView[] }> {
    const repo = await this.repoOf(repoName);
    return { runs: (await this.deps.runsOf(repo.id, RUNS_LISTED)).map(runView) };
  }

  async run(id: string): Promise<{ run: RunView }> {
    const run = await this.deps.run(id).catch(() => null);
    if (!run) throw new HttpFailure(404, 'There is no such release run.');
    return { run: runView(run) };
  }
}

/** The live wiring: the database, the person's link and People, and GitHub read as `deployClient` reads it. */
export function liveReleaseCuts(input: {
  release: Pick<ReleaseService, 'start' | 'lastRelease'>;
  reader: (fullName: string) => Promise<ReleaseReader | null>;
  person: PersonGitHubDeps;
  flows: PersonFlows;
  /** The open Prepare next version, read for the view (`ReleasePrepare.preparing`). */
  preparing?: (repo: ReleaseRepo) => Promise<Preparation | null>;
}): ReleaseCuts {
  return new ReleaseCuts({
    release: input.release,
    ...(input.preparing ? { preparing: input.preparing } : {}),
    repo: async (name) => {
      const found = await repos.getRepoByName(name);
      return found ? { id: found.id, name: found.name, fullName: found.fullName, defaultBranch: found.defaultBranch } : null;
    },
    getRelease: (repoId) => repos.getRelease(repoId),
    reader: input.reader,
    runsOf: (repoId, limit) => releaseRuns.forRepo(repoId, limit),
    run: async (id) => {
      // A row id is a uuid; anything else is no run rather than a database error.
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      return releaseRuns.get(id);
    },
    releasing: () => repos.releasing(),
    flows: input.flows,
    // The operator's link on a local install, as Settings shows it (`livePersonGitHubDeps`).
    linkOf: (identity) => input.person.store.ofIdentity(identity),
    isCrew: input.person.isCrew,
    approves: async (githubUserId) => (await peopleStore.personByGithubId(githubUserId))?.approves === true,
    audit: async (entry) => {
      await writeAudit(entry);
    },
  });
}

/**
 * `readiness` answers the release page's checklist (#371, docs/adr/0084). It
 * is a read, given apart from `cuts` so the route holds no handle that could
 * start, pin or sign anything.
 */
export function registerReleaseRoutes(router: Router, cuts: ReleaseCuts, readiness?: Pick<ReleaseReadiness, 'read'>): void {
  router.get('/v1/releases', async () => cuts.list());

  if (readiness) router.get('/v1/repos/:name/release/readiness', async ({ params }) => readiness.read(params.name ?? ''));

  router.post('/v1/repos/:name/release/views', async ({ params, identity }) => cuts.view(params.name ?? '', identity));

  router.post('/v1/repos/:name/release/cut', async ({ params, body, identity }) => {
    let input: unknown;
    try {
      input = await body<unknown>();
    } catch {
      input = null;
    }
    return cuts.cut(params.name ?? '', identity, input);
  });

  router.get('/v1/repos/:name/release/flows/:flowId', async ({ params, identity }) => cuts.flowState(params.flowId ?? '', identity));

  router.get('/v1/repos/:name/releases', async ({ params }) => cuts.runs(params.name ?? ''));

  router.get('/v1/releases/:id', async ({ params }) => cuts.run(params.id ?? ''));
}
