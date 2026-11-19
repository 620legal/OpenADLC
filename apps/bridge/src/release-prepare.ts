import { audit as writeAudit, issues as issueStore, lastAudit, requests, withAdvisoryLock } from '@openadlc/db';
import { repoVersionFrom, repoVersionGate } from '@openadlc/shared';
import { requestSubject } from './items.js';
import { cutTarget, type Preparable, type PreparableRefusal, type ReleaseCuts, type ReleaseReader } from './release-routes.js';
import { HttpFailure, type Router } from './router.js';

type RequestRecord = requests.RequestRecord;
type ReleaseRepo = Preparable['repo'];

/**
 * Prepare next version, from a release page whose head version is not above
 * the last release (#363,
 * docs/adr/0078-preparing-the-next-release-version-is-a-console-request-the-crew-builds.md).
 *
 * The press files a console request for intake, in the approver's name,
 * through the same `fileRequest` as `POST /v1/requests`; the crew raises the
 * version on the default branch through a normal pull request, review, ci and
 * the merge line. Nothing here writes a version, a branch or a commit.
 *
 * - **It cannot reach a release.** It holds `ReleaseCuts` only as `preparable`,
 *   which reads a pinned view and never spends it, and imports neither
 *   `ReleaseService`, the publisher nor hostd's client: no SHA comes in, and
 *   nothing is started, pinned or signed.
 * - **Offered and accepted are one decision.** `preparable` checks the view the
 *   page showed with the view's own `viewer()` check — linked, Approves on —
 *   so a press is filed exactly where the page offered it.
 * - **One at a time.** The open preparation is found from the newest
 *   `release.prepare_requested` row and its request, under an advisory lock;
 *   one whose state cannot be read counts as open, since a preparation nobody
 *   can see is never a reason to file a second.
 */

/** The audit actions a press writes, on the repository's cut target. */
export const RELEASE_PREPARE_REQUESTED = 'release.prepare_requested';
export const RELEASE_PREPARE_REFUSED = 'release.prepare_refused';

export type PrepareRefusalReason =
  | 'bad_body'
  | PreparableRefusal['reason']
  | 'crew_account'
  | 'bad_version'
  | 'version_not_above'
  | 'already_preparing'
  | 'intake_refused';

/** An open preparation, as the release page shows it. */
export interface Preparation {
  requestId: string;
  /** Its item, `request:<id8>`, as the console links it. */
  subject: string;
  state: RequestRecord['state'];
  /** The version it raises to. */
  version: string | null;
  issue: { number: number; url: string } | null;
  pullRequest: { number: number; url: string; state: 'open' | 'merged' | 'unknown' } | null;
  /** Whether GitHub could not say an issue's or pull request's state, so it is counted as open. */
  unknown: boolean;
}

/** What a press files: a console request, as `POST /v1/requests` takes one. */
export interface PrepareRequest {
  text: string;
  context: string;
  repo: string;
  kind: 'feature';
}

export interface ReleasePrepareDeps {
  cuts: Pick<ReleaseCuts, 'preparable'>;
  isCrew(login: string): Promise<boolean>;
  /** Files the request as `POST /v1/requests` does: written, queued and triaged by intake. */
  file(request: PrepareRequest, identity: string): Promise<{ id: string; state: RequestRecord['state'] }>;
  /** The newest `release.prepare_requested` row on a target. */
  lastPrepared(target: string): Promise<{ payload: Record<string, unknown> | null } | null>;
  getRequest(id: string): Promise<RequestRecord | null>;
  /** The pull request the crew opened for an issue, as the bridge recorded it. */
  prOf(repoId: string, number: number): Promise<number | null>;
  /** A client to read GitHub with; null when none can. Reads only. */
  reader(fullName: string): Promise<ReleaseReader | null>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  warn?(message: string): void;
}

const BODY = 'Prepare next version takes { viewId, version }';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 500;
}

class PrepareRefusal extends HttpFailure {
  constructor(
    status: number,
    message: string,
    readonly reason: PrepareRefusalReason,
    details: Record<string, unknown> = {},
  ) {
    super(status, message, details);
  }
}

/** The request a press files: what to raise, from what, where, and what moves with it. */
export function prepareRequest(input: { repo: string; version: string; after: string; afterTag: string; versionFile: string; versionKey: string | null }): PrepareRequest {
  const { repo, version, after, afterTag, versionFile, versionKey } = input;
  return {
    kind: 'feature',
    repo,
    text: `Raise ${repo}'s version to ${version} for its next release`,
    context: [
      `Target version: ${version}`,
      `Last release: ${after} (tag ${afterTag})`,
      `Version file: ${versionFile}`,
      `Version key: ${versionKey ?? '(none: the whole file is the version)'}`,
      '',
      `Raise the version on the default branch to exactly ${version}, in ${versionFile}${versionKey ? ` at ${versionKey}` : ''}.`,
      `Change every place this repository's AGENTS.md, README, docs or CI say moves with it, so that CI stays green.`,
      'List every one of those files under Expected paths, so no plan_change is needed.',
      "This request came from the release page's Prepare next version; nothing is released until a person cuts it.",
    ].join('\n'),
  };
}

export class ReleasePrepare {
  constructor(private readonly deps: ReleasePrepareDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private async auditRefusal(repo: string, identity: string, reason: PrepareRefusalReason, why: string, version: string | null): Promise<void> {
    try {
      await this.deps.audit({ actor: identity, action: RELEASE_PREPARE_REFUSED, target: cutTarget(repo), payload: { repo, reason, why, version, by: identity } });
    } catch (failure) {
      this.warn(`[bridge] ${identity}'s refused Prepare next version of ${repo} (${reason}) was not audited: ${messageOf(failure)}`);
    }
  }

  /** The body: exactly `{ viewId, version }`. A SHA, or anything else, is refused. */
  private bodyProblem(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return BODY;
    const input = body as Record<string, unknown>;
    const extra = Object.keys(input).filter((key) => key !== 'viewId' && key !== 'version');
    if (extra.length > 0) return `${BODY} only, not ${extra.join(', ')}`;
    if (typeof input.viewId !== 'string' || !input.viewId) return 'viewId is the view the page showed; reload to make one';
    if (typeof input.version !== 'string' || !input.version.trim()) return 'version is the version to raise to';
    return null;
  }

  /**
   * Files a Prepare next version press. Each refusal is audited before it is
   * thrown; nothing here starts, pins or signs a release.
   */
  async prepare(repoName: string, identity: string, body: unknown): Promise<{ request: { id: string; state: RequestRecord['state'] }; subject: string; preparing: Preparation }> {
    const problem = this.bodyProblem(body);
    if (problem) {
      await this.auditRefusal(repoName, identity, 'bad_body', problem, null);
      throw new HttpFailure(400, problem);
    }
    const viewId = (body as { viewId: string }).viewId;
    const version = (body as { version: string }).version.trim();
    let where = repoName;
    try {
      const offered = await this.deps.cuts.preparable(viewId, identity, repoName);
      if (!offered.ok) {
        const { status, message, reason, url } = offered.refusal;
        throw new PrepareRefusal(status, message, reason, url ? { url } : {});
      }
      const { repo, last, versionFile, versionKey, link } = offered.preparable;
      where = repo.fullName;
      if (await this.deps.isCrew(link.githubLogin).catch(() => true)) {
        throw new PrepareRefusal(403, `@${link.githubLogin} is an account the crew uses; a bot never prepares a release.`, 'crew_account');
      }
      const read = repoVersionFrom(version, versionFile);
      if (!read.ok) throw new PrepareRefusal(422, read.reason, 'bad_version');
      // The head is at or below the last release, so a version above the last release is above the head too.
      const gate = repoVersionGate(read.version, last.version, versionFile);
      if (gate) throw new PrepareRefusal(422, gate, 'version_not_above');

      return await this.deps.lock(`release-prepare:${repo.fullName}`, async () => {
        const open = await this.preparing(repo);
        if (open) {
          throw new PrepareRefusal(409, `A Prepare next version of ${repo.name} is already open (${open.subject}, ${open.state}); it is shown on the page until it is done.`, 'already_preparing', {
            preparing: open,
          });
        }
        let filed: { id: string; state: RequestRecord['state'] };
        try {
          filed = await this.deps.file(prepareRequest({ repo: repo.name, version: read.version.text, after: last.version.text, afterTag: last.tag, versionFile, versionKey }), identity);
        } catch (error) {
          throw new PrepareRefusal(statusOf(error), messageOf(error), 'intake_refused');
        }
        try {
          await this.deps.audit({
            actor: identity,
            action: RELEASE_PREPARE_REQUESTED,
            target: cutTarget(repo.fullName),
            payload: { requestId: filed.id, version: read.version.text, after: last.version.text, afterTag: last.tag, versionFile, versionKey, by: identity },
          });
        } catch (failure) {
          // The request stands: told it failed, the person would press again and file a second.
          this.warn(`[bridge] ${identity}'s Prepare next version of ${repo.fullName} filed request ${filed.id} but was not audited: ${messageOf(failure)}`);
        }
        const subject = requestSubject(filed.id);
        return {
          request: filed,
          subject,
          preparing: { requestId: filed.id, subject, state: filed.state, version: read.version.text, issue: null, pullRequest: null, unknown: false },
        };
      });
    } catch (error) {
      if (error instanceof PrepareRefusal) await this.auditRefusal(where, identity, error.reason, error.message, version);
      throw error;
    }
  }

  /**
   * The repository's open preparation, or null: its newest
   * `release.prepare_requested` row's request, while it is queued, drafted
   * or waiting on questions, or filed with an issue GitHub says is open. A
   * state GitHub would not say counts as open.
   */
  async preparing(repo: ReleaseRepo): Promise<Preparation | null> {
    const row = await this.deps.lastPrepared(cutTarget(repo.fullName));
    const requestId = typeof row?.payload?.requestId === 'string' ? row.payload.requestId : null;
    if (!requestId) return null;
    const request = await this.deps.getRequest(requestId);
    if (!request || request.state === 'abandoned') return null;
    const base = { requestId, subject: requestSubject(requestId), state: request.state, version: typeof row?.payload?.version === 'string' ? row.payload.version : null };
    if (request.state !== 'filed') return { ...base, issue: null, pullRequest: null, unknown: false };
    for (const filed of request.issues) {
      // An issue in a repository no longer on record cannot be read, nor ever closed here.
      if (!filed.repoFullName) continue;
      const fullName = filed.repoFullName;
      const issue = { number: filed.number, url: `https://github.com/${fullName}/issues/${filed.number}` };
      const client = await this.deps.reader(fullName).catch(() => null);
      let state: string | null = null;
      if (client) {
        state = await client
          .request<{ state?: unknown }>('GET', `/repos/${fullName}/issues/${filed.number}`)
          .then((answer) => (typeof answer.state === 'string' ? answer.state : null))
          .catch(() => null);
      }
      if (state === 'closed') continue;
      const unknownIssue = state !== 'open';
      const pullRequest = await this.pullOf(client, filed.repoId, fullName, filed.number);
      return { ...base, issue, pullRequest: pullRequest.view, unknown: unknownIssue || pullRequest.unknown };
    }
    return null;
  }

  /** The issue's pull request, left out when it was closed unmerged. */
  private async pullOf(client: ReleaseReader | null, repoId: string, fullName: string, issue: number): Promise<{ view: Preparation['pullRequest']; unknown: boolean }> {
    const number = await this.deps.prOf(repoId, issue).catch(() => null);
    if (number === null) return { view: null, unknown: false };
    const url = `https://github.com/${fullName}/pull/${number}`;
    if (!client) return { view: { number, url, state: 'unknown' }, unknown: true };
    try {
      const answer = await client.request<{ state?: unknown; merged?: unknown; merged_at?: unknown }>('GET', `/repos/${fullName}/pulls/${number}`);
      if (answer.merged === true || (typeof answer.merged_at === 'string' && answer.merged_at)) return { view: { number, url, state: 'merged' }, unknown: false };
      if (answer.state === 'open') return { view: { number, url, state: 'open' }, unknown: false };
      return { view: null, unknown: false };
    } catch {
      return { view: { number, url, state: 'unknown' }, unknown: true };
    }
  }
}

/** The live wiring: the audit log, the requests store, the issues the bridge recorded, and GitHub read as the release page reads it. */
export function liveReleasePrepare(input: {
  cuts: Pick<ReleaseCuts, 'preparable'>;
  isCrew: (login: string) => Promise<boolean>;
  file: ReleasePrepareDeps['file'];
  reader: (fullName: string) => Promise<ReleaseReader | null>;
}): ReleasePrepare {
  return new ReleasePrepare({
    cuts: input.cuts,
    isCrew: input.isCrew,
    file: input.file,
    lastPrepared: (target) => lastAudit(RELEASE_PREPARE_REQUESTED, target),
    getRequest: (id) => requests.getRequest(id),
    prOf: async (repoId, number) => (await issueStore.getIssue(repoId, number))?.prNumber ?? null,
    reader: input.reader,
    audit: async (entry) => {
      await writeAudit(entry);
    },
    lock: (key, fn) => withAdvisoryLock(key, fn),
  });
}

export function registerReleasePrepareRoutes(router: Router, prepare: ReleasePrepare): void {
  router.post('/v1/repos/:name/release/prepare', async ({ params, body, identity }) => {
    let input: unknown;
    try {
      input = await body<unknown>();
    } catch {
      input = null;
    }
    return prepare.prepare(params.name ?? '', identity, input);
  });
}
