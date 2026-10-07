import { createHash } from 'node:crypto';
import { withHeader, withSeat } from '@fleetadlc/shared';
const API = 'https://api.github.com';

export interface GitHubClientOptions {
  token: string;
  /** Recorded in the user agent so audit logs show which bot acted. */
  actingAs: string;
  /**
   * The line every body this client writes starts with — which install and
   * which stage wrote it (`headerFor`, in @fleetadlc/shared). A crew on one GitHub
   * account posts as one user, so GitHub's own attribution cannot say. Absent
   * for a client that writes no prose, such as the app's own.
   */
  header?: string;
  /**
   * The seat this client posts for, tagged at the end of every body
   * (`withSeat`): seats sharing an account post as one user, and this is how
   * OpenADLC tells one reviewer's review from another's.
   */
  seat?: string;
  /**
   * Signs a body as its seat's, last, after the header and the seat tag; see
   * `signBody` in @fleetadlc/shared. Absent for a client that has no key to sign
   * with, whose posts then carry none.
   */
  sign?: (body: string, post: { repo: string; kind: string; n?: number | null }) => string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The header GitHub names the permission it wanted in, on a 403 "Resource not
 * accessible by integration". The body says only that something is missing,
 * so a card built from the body alone could not say what to add.
 */
export const ACCEPTED_PERMISSIONS_HEADER = 'x-accepted-github-permissions';

export class GitHubApiError extends Error {
  /**
   * GitHub's `x-accepted-github-permissions`, such as `issues=write`, on a 403.
   * GitHub sends the header on an app's responses whatever their status, and
   * `failure-words.ts` reads it as "the app lacks this permission", so on a
   * 404 or a 422 it turned the real cause into a permission to add. It is kept
   * for a 403 only.
   */
  readonly acceptedPermissions: string | null;

  constructor(
    readonly status: number,
    readonly path: string,
    /** What GitHub answered, as it was, for a caller that reads its JSON rather than the message. */
    readonly body: string,
    acceptedPermissions: string | null = null,
  ) {
    const accepted = status === 403 ? acceptedPermissions : null;
    // In the message too: what reaches a card is a task's exit reason or a
    // check's detail, which is this text and nothing else (`failure-words.ts`).
    super(`${path} → ${status}: ${body}${accepted ? ` ${ACCEPTED_PERMISSIONS_HEADER}: ${accepted}` : ''}`);
    this.name = 'GitHubApiError';
    this.acceptedPermissions = accepted;
  }
}

/** The accepted-permissions header of a response, or null when GitHub sent none. */
export function acceptedPermissionsOf(response: Response): string | null {
  return response.headers.get(ACCEPTED_PERMISSIONS_HEADER)?.trim() || null;
}

export interface IssueComment {
  id: number;
  body: string;
  htmlUrl: string;
  user: string;
}

/** A commit on a pull request, and who wrote it. */
export interface PullCommit {
  sha: string;
  /** The account GitHub matched the author to; null when it matched none. */
  authorLogin: string | null;
  authorEmail: string;
  authorName: string;
}

/** The most a GitHub list endpoint returns in one page. */
const PAGE = 100;

/** How long a call to GitHub may take before it is given up; see `request`. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The author of a review whose account was deleted: never a GitHub login. */
export const DELETED_ACCOUNT = '(deleted account)';

/** GitHub lists no more than this many of a pull request's files. */
export const PULL_FILES_LISTED = 3000;

/** A comparison lists no more than this many files. */
const COMPARE_FILES_LISTED = 300;

/** GitHub lists no more than this many of a pull request's commits. */
const PULL_COMMITS_LISTED = 250;

/** The base side of a file a pull request adds: there is nothing there. */
const NO_BASE_BLOB = '-';

/**
 * Order-independent, so the same set of changes fingerprints the same however
 * GitHub happens to list them.
 *
 * Both sides of each file count: what it was at the merge base (`baseSha`,
 * null for a file the pull request adds) and what it is at the head. With the
 * head side alone, a push that merged the base but kept the pull request's own
 * version of a file the base had also changed (`git checkout --ours`) hashed
 * the same as the head that was approved, so the approvals stood and the merge
 * quietly undid the base's change to that file.
 *
 * So do where a renamed or copied file came from (`previousFilename`) and its
 * mode at the head. Without them, a push that deleted `config/prod.yaml` and
 * added the approved `stage.yaml`, which git reports as a rename from
 * prod.yaml, hashed the same as the approved rename from staging.yaml; and a
 * reviewed file made executable, or turned into a symlink with the same
 * bytes, hashed the same as the file that was approved.
 */
export function fingerprintOf(
  files: { filename: string; previousFilename: string | null; status: string; mode: string; sha: string; baseSha: string | null }[],
): string {
  const lines = files
    .map(
      (file) =>
        `${file.filename}\u0000${file.previousFilename ?? ''}\u0000${file.status}\u0000${file.mode}\u0000${file.baseSha ?? NO_BASE_BLOB}\u0000${file.sha}`,
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** One entry of a pull request's timeline, as `listPullHistory` reads it. */
export interface PullHistoryEntry {
  event: string;
  /** Who did it: for a review, its author; for a dismissal, who dismissed it. */
  actor: string | null;
  viaApp: boolean;
  sha: string | null;
  subject?: string | null;
  /** On `review_dismissed`: the review's id, and its state before it was dismissed, lower case as the timeline gives it (`changes_requested`). */
  dismissedReviewId?: number | null;
  dismissedState?: string | null;
  /** On `labeled` and `unlabeled`: the label's name. Who put `scope:cross-cutting` on decides whether it counts. */
  label?: string | null;
}

/**
 * Every call is made with the one token the client was built with: a bot's own
 * user token, so GitHub attributes the comment, review, label or push to that
 * bot's account, or the app's installation token, so it is attributed to the
 * app.
 */
export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  /** Who this client acts as (`actingAs`): the app's `fleetadlc-app`, or an account's login. */
  get actingAs(): string {
    return this.options.actingAs;
  }

  constructor(private readonly options: GitHubClientOptions) {
    this.baseUrl = options.baseUrl ?? API;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** A body as this client posts it: headed, when it has a header to put first, and tagged with its seat. */
  private headed(body: string, post?: { repo: string; kind: string; n?: number | null }): string {
    const headed = this.options.header ? withHeader(body, this.options.header) : body;
    const seated = this.options.seat ? withSeat(headed, this.options.seat) : headed;
    return this.options.sign && post ? this.options.sign(seated, post) : seated;
  }

  /**
   * One call to GitHub's REST API, given up after `timeoutMs` (30 seconds unless
   * the caller says otherwise). With no limit, a stalled connection waited five
   * minutes for the runtime's own, holding whatever the caller held: a token
   * refresh's lock and database client, a repository's merge line, a webhook
   * GitHub had already given up on.
   */
  async request<T>(method: string, path: string, body?: unknown, options: { accept?: string; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      headers: {
        accept: options.accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${this.options.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': `fleetadlc (acting as ${this.options.actingAs})`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    if (!response.ok) throw new GitHubApiError(response.status, path, text.slice(0, 400), acceptedPermissionsOf(response));
    return (text ? JSON.parse(text) : {}) as T;
  }

  async viewer(): Promise<{ login: string; id: number }> {
    return this.request<{ login: string; id: number }>('GET', '/user');
  }

  async comment(repo: string, issueNumber: number, body: string): Promise<IssueComment> {
    const created = await this.request<{ id: number; body: string; html_url: string; user: { login: string } }>(
      'POST',
      `/repos/${repo}/issues/${issueNumber}/comments`,
      { body: this.headed(body, { repo, kind: 'comment', n: issueNumber }) },
    );
    return { id: created.id, body: created.body, htmlUrl: created.html_url, user: created.user.login };
  }

  async setLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request('PUT', `/repos/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request('POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    try {
      await this.request('DELETE', `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      // A label that is already gone is the desired state, not an error.
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }
  }

  async assign(repo: string, issueNumber: number, assignees: string[]): Promise<void> {
    await this.request('POST', `/repos/${repo}/issues/${issueNumber}/assignees`, { assignees });
  }

  async requestReviewers(repo: string, prNumber: number, reviewers: string[]): Promise<void> {
    await this.request('POST', `/repos/${repo}/pulls/${prNumber}/requested_reviewers`, { reviewers });
  }

  /** The review-gate status is what holds a PR until every requested review lands. */
  async setCommitStatus(
    repo: string,
    sha: string,
    input: { state: 'pending' | 'success' | 'failure'; context: string; description: string; targetUrl?: string },
  ): Promise<void> {
    await this.request('POST', `/repos/${repo}/statuses/${sha}`, {
      state: input.state,
      context: input.context,
      description: input.description.slice(0, 140),
      ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
    });
  }

  async createIssue(
    repo: string,
    input: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number; htmlUrl: string }> {
    const created = await this.request<{ number: number; html_url: string }>('POST', `/repos/${repo}/issues`, {
      ...input,
      body: this.headed(input.body, { repo, kind: 'issue' }),
    });
    return { number: created.number, htmlUrl: created.html_url };
  }

  /**
   * One page of a repository's issues and pull requests, newest first. `page`
   * counts from 1; a page shorter than `perPage` is the last.
   */
  async listIssues(
    repo: string,
    params: {
      labels?: string[];
      state?: 'open' | 'closed' | 'all';
      perPage?: number;
      page?: number;
      sort?: 'created' | 'updated';
      /** Only those updated at or after this moment, by GitHub's clock. */
      since?: string;
    } = {},
  ): Promise<
    {
      number: number;
      title: string;
      body: string | null;
      labels: string[];
      htmlUrl: string;
      pullRequest: boolean;
      state: 'open' | 'closed';
      /** When it was opened, by GitHub's clock. */
      createdAt: string;
      /** When anything about it last changed, by GitHub's clock. */
      updatedAt: string;
      /** Who opened it, and how they are associated with the repository; see `hasAccess`. */
      author: string | null;
      association: string | null;
    }[]
  > {
    const search = new URLSearchParams({
      state: params.state ?? 'open',
      per_page: String(params.perPage ?? 50),
    });
    if (params.labels?.length) search.set('labels', params.labels.join(','));
    if (params.page && params.page > 1) search.set('page', String(params.page));
    if (params.sort) search.set('sort', params.sort);
    if (params.since) search.set('since', params.since);

    const issues = await this.request<
      {
        number: number;
        title: string;
        body: string | null;
        labels: { name: string }[];
        html_url: string;
        pull_request?: unknown;
        state: 'open' | 'closed';
        created_at: string;
        updated_at: string;
        user?: { login: string } | null;
        author_association?: string;
      }[]
    >('GET', `/repos/${repo}/issues?${search.toString()}`);

    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
      htmlUrl: issue.html_url,
      pullRequest: Boolean(issue.pull_request),
      state: issue.state,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: issue.user?.login ?? null,
      association: issue.author_association ?? null,
    }));
  }

  /** One issue or pull request, with the body a bot has to read to work on it. */
  async getIssue(
    repo: string,
    issueNumber: number,
  ): Promise<{
    number: number;
    title: string;
    body: string | null;
    labels: string[];
    htmlUrl: string;
    state: 'open' | 'closed';
    /** The issues API answers for a pull request's number too. */
    pullRequest: boolean;
    createdAt: string;
    updatedAt: string;
    author: string | null;
    association: string | null;
  }> {
    const issue = await this.request<{
      number: number;
      title: string;
      body: string | null;
      labels: { name: string }[];
      html_url: string;
      state: 'open' | 'closed';
      pull_request?: unknown;
      created_at: string;
      updated_at: string;
      user?: { login: string } | null;
      author_association?: string;
    }>('GET', `/repos/${repo}/issues/${issueNumber}`);

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
      htmlUrl: issue.html_url,
      state: issue.state,
      pullRequest: Boolean(issue.pull_request),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: issue.user?.login ?? null,
      association: issue.author_association ?? null,
    };
  }

  /**
   * An issue's body as GitHub renders it, with its author. An image pasted
   * into an issue is a `user-attachments` link that answers only a signed-in
   * browser for a private repository; in the rendered HTML GitHub gives it as
   * a short-lived signed `private-user-images` URL that answers anyone holding
   * it, for a few minutes. That is what the bridge downloads (`issue-assets.ts`).
   */
  async getIssueHtml(repo: string, issueNumber: number): Promise<{ bodyHtml: string; user: string; association: string | null }> {
    const issue = await this.request<{ body_html?: string | null; user: { login: string } | null; author_association?: string }>(
      'GET',
      `/repos/${repo}/issues/${issueNumber}`,
      undefined,
      { accept: 'application/vnd.github.full+json' },
    );
    return { bodyHtml: issue.body_html ?? '', user: issue.user?.login ?? 'unknown', association: issue.author_association ?? null };
  }

  /** The conversation on an issue, rendered, as `getIssueHtml` reads the body. */
  async listCommentsHtml(repo: string, issueNumber: number): Promise<{ user: string; bodyHtml: string; association: string | null }[]> {
    // Every page, as `listComments` reads them: an image posted after the
    // first page was never collected.
    const comments: { user: { login: string } | null; body_html?: string | null; author_association?: string }[] = [];
    for (let page = 1; ; page++) {
      const listed = await this.request<typeof comments>(
        'GET',
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=${PAGE}&page=${page}`,
        undefined,
        { accept: 'application/vnd.github.full+json' },
      );
      comments.push(...listed);
      if (listed.length < PAGE) break;
    }
    return comments.map((comment) => ({
      user: comment.user?.login ?? 'unknown',
      bodyHtml: comment.body_html ?? '',
      association: comment.author_association ?? null,
    }));
  }

  /** The conversation on an issue or pull request, oldest first. */
  async listComments(repo: string, issueNumber: number): Promise<{ user: string; body: string; at: string; association: string | null }[]> {
    // Every page: GitHub lists comments oldest first and has no way to ask for
    // the newest, so one page of a long thread was its oldest comments, and a
    // task never saw the latest send-back or answer.
    const comments: { user: { login: string } | null; body: string | null; created_at: string; author_association?: string }[] = [];
    for (let page = 1; ; page++) {
      const listed = await this.request<typeof comments>('GET', `/repos/${repo}/issues/${issueNumber}/comments?per_page=${PAGE}&page=${page}`);
      comments.push(...listed);
      if (listed.length < PAGE) break;
    }

    return comments.map((comment) => ({
      user: comment.user?.login ?? 'unknown',
      body: comment.body ?? '',
      at: comment.created_at,
      // How its author is associated with the repository: `OWNER`, `MEMBER`,
      // `COLLABORATOR`, or somebody without access. See `hasAccess`.
      association: comment.author_association ?? null,
    }));
  }

  async listReviews(
    repo: string,
    prNumber: number,
  ): Promise<
    {
      id: number;
      user: string;
      state: string;
      body: string;
      submittedAt: string | null;
      commitId: string | null;
      association: string | null;
    }[]
  > {
    // Every page: GitHub lists reviews oldest first, so a pull request with more
    // than a page of them had its latest verdicts cut off, and a later request
    // for changes went unseen beside an earlier approval.
    const reviews: {
      id: number;
      user: { login: string } | null;
      state: string;
      body: string | null;
      submitted_at: string | null;
      commit_id?: string | null;
      author_association?: string;
    }[] = [];
    for (let page = 1; ; page++) {
      const listed = await this.request<typeof reviews>('GET', `/repos/${repo}/pulls/${prNumber}/reviews?per_page=${PAGE}&page=${page}`);
      reviews.push(...listed);
      if (listed.length < PAGE) break;
    }

    return reviews.map((review) => ({
      // The id is what a dismissal addresses; without it an approval can only
      // be superseded, never withdrawn.
      id: review.id,
      // GitHub gives no user for a review whose author deleted their account.
      // Reading it threw, and the merge line waited on that pull request for
      // good. The parentheses keep it from ever matching a login ('ghost' is
      // a real account).
      user: review.user?.login ?? DELETED_ACCOUNT,
      state: review.state,
      body: review.body ?? '',
      submittedAt: review.submitted_at,
      // Which head was approved. An approval of an earlier commit is not an
      // approval of what would land now.
      commitId: review.commit_id ?? null,
      association: review.author_association ?? null,
    }));
  }

  /**
   * The comments a reviewer left on lines of a pull request's diff, every page.
   * A request for changes made only of line comments has an empty review body,
   * and a patch round briefed from review bodies alone gave the builder nothing.
   */
  async listReviewComments(
    repo: string,
    prNumber: number,
  ): Promise<
    {
      user: string;
      association: string | null;
      path: string;
      line: number | null;
      body: string;
      reviewId: number | null;
      htmlUrl: string;
    }[]
  > {
    const comments: {
      user: { login: string } | null;
      author_association?: string;
      path: string;
      line?: number | null;
      original_line?: number | null;
      body: string | null;
      pull_request_review_id?: number | null;
      html_url: string;
    }[] = [];
    for (let page = 1; ; page++) {
      const listed = await this.request<typeof comments>('GET', `/repos/${repo}/pulls/${prNumber}/comments?per_page=${PAGE}&page=${page}`);
      comments.push(...listed);
      if (listed.length < PAGE) break;
    }

    return comments.map((comment) => ({
      user: comment.user?.login ?? DELETED_ACCOUNT,
      association: comment.author_association ?? null,
      path: comment.path,
      // `line` is null once the line is gone from the current diff; the line it
      // was written against still says where the reviewer was looking.
      line: comment.line ?? comment.original_line ?? null,
      body: comment.body ?? '',
      reviewId: comment.pull_request_review_id ?? null,
      htmlUrl: comment.html_url,
    }));
  }

  /**
   * A file as it is on a ref, not as a pull request proposes it.
   *
   * The human-review rules are read from the pull request's base branch for
   * exactly this reason: a pull request that could supply its own copy could
   * edit its way out of the review it is subject to.
   */
  async readFileAtRef(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const file = await this.request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      if (!file.content) return null;
      return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch {
      // Absent and unreadable are the same answer here, and the caller holds the
      // gate on it rather than releasing.
      return null;
    }
  }

  /**
   * Replaces an issue's body.
   *
   * The status view is one issue that is always current, not a log of what it
   * used to be. At the plan's fifteen-minute cadence a comment per run is
   * ninety-six a day on one issue, which makes the issue unreadable and every
   * notification from it worthless.
   */
  async updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request('PATCH', `/repos/${repo}/issues/${issueNumber}`, {
      body: this.headed(body, { repo, kind: 'edit', n: issueNumber }),
    });
  }

  /**
   * Puts a closed issue back on the board.
   *
   * A merge closes the issue; a revert takes the change away again. Leaving it
   * closed means the work is simply gone — nothing is on the board, nobody is
   * assigned, and the only trace is a revert pull request that references a
   * number nobody is looking at.
   */
  async reopenIssue(repo: string, issueNumber: number): Promise<void> {
    await this.request('PATCH', `/repos/${repo}/issues/${issueNumber}`, { state: 'open' });
  }

  /** Withdraws a review request, for a reviewer a pull request does not need. */
  async removeReviewRequest(repo: string, prNumber: number, reviewers: string[]): Promise<void> {
    if (reviewers.length === 0) return;
    await this.request('DELETE', `/repos/${repo}/pulls/${prNumber}/requested_reviewers`, {
      reviewers,
    }).catch(() => undefined);
  }

  /**
   * Withdraws an approval, with the reason attached to it on the pull request.
   *
   * GitHub's own "dismiss stale reviews on push" is deliberately off, because it
   * would clear approvals when the merge line merges the base into a branch
   * before landing it — a change to the head that changes nothing about the
   * work. So dismissal is the platform's decision, and this is how it is made.
   */
  async dismissReview(repo: string, prNumber: number, reviewId: number, message: string): Promise<void> {
    await this.request('PUT', `/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
      message: this.headed(message),
      event: 'DISMISS',
    });
  }

  /**
   * A fingerprint of what a head actually proposes against a base.
   *
   * Three-dot compare, so it is the diff from the merge base rather than from
   * the base's tip: merging `main` into a branch moves the head and leaves this
   * identical, which is exactly the case an approval must survive. Built from
   * each file's path, where a rename or copy came from, status, mode at the
   * head, and blob on both sides, so a commit that rewrites history without
   * changing content also compares equal.
   */
  async diffFingerprint(repo: string, base: string, head: string): Promise<string | null> {
    try {
      const comparison = await this.request<{
        merge_base_commit?: { commit?: { tree?: { sha?: string } } };
        files?: { filename: string; status: string; sha: string; previous_filename?: string }[];
      }>('GET', `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_FILES_LISTED}`);

      // The compare lists at most 300 files. Two diffs that differ only past
      // the 300th would fingerprint the same, so a longer one is unknown.
      const files = comparison.files ?? [];
      if (files.length >= COMPARE_FILES_LISTED) return null;

      // Each file's blob at the merge base, from one read of its tree. Not the
      // merge base's sha itself: the merge line merges the base in before it
      // lands a pull request, which moves the merge base every time, and that
      // would dismiss every approval. A file the base did not touch has the
      // same blob there before and after.
      let blobs = new Map<string, string>();
      if (files.some((file) => file.status !== 'added')) {
        const tree = comparison.merge_base_commit?.commit?.tree?.sha;
        if (!tree) return null;
        const listing = await this.request<{ truncated?: boolean; tree?: { path: string; type: string; sha: string }[] }>(
          'GET',
          `/repos/${repo}/git/trees/${encodeURIComponent(tree)}?recursive=1`,
        );
        if (listing.truncated) return null;
        blobs = new Map((listing.tree ?? []).filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
      }
      // The compare gives no file mode, so the head's is read separately. A
      // mode that cannot be read is a diff that is not known to be the same.
      const modes = files.length > 0 ? await this.modesAt(repo, head, files.map((file) => file.filename)) : new Map<string, string>();
      if (!modes) return null;
      const sides: Parameters<typeof fingerprintOf>[0] = [];
      for (const file of files) {
        const baseSha = file.status === 'added' ? null : blobs.get(file.previous_filename ?? file.filename);
        if (baseSha === undefined) return null;
        sides.push({
          filename: file.filename,
          previousFilename: file.previous_filename ?? null,
          status: file.status,
          mode: modes.get(file.filename) ?? '',
          sha: file.sha,
          baseSha,
        });
      }
      return fingerprintOf(sides);
    } catch {
      // Unknown rather than "unchanged": a caller must not read a failed
      // comparison as permission to keep an approval.
      return null;
    }
  }

  /**
   * Each path's mode at `ref` (`100644`, `100755`, `120000`, …), empty for a
   * path that is not there, as a file the diff deletes is not. One GraphQL
   * query lists the tree of each directory the paths are in. Not the recursive
   * tree of the whole head: GitHub truncates it on a large repository, and
   * every base merge there would then drop the approvals. Null when GitHub
   * does not answer.
   */
  private async modesAt(repo: string, ref: string, paths: readonly string[]): Promise<Map<string, string> | null> {
    const [owner, name] = repo.split('/');
    const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    const dirs = [...new Set(paths.map(dirOf))];
    const answer = await this.request<{
      data?: { repository?: Record<string, { entries?: { name: string; mode: number | string }[] } | null> | null };
      errors?: { message?: string }[];
    }>('POST', '/graphql', {
      query:
        `query($owner: String!, $name: String!, ${dirs.map((_, i) => `$e${i}: String!`).join(', ')}) { repository(owner: $owner, name: $name) { ` +
        `${dirs.map((_, i) => `d${i}: object(expression: $e${i}) { ... on Tree { entries { name mode } } }`).join(' ')} } }`,
      variables: { owner, name, ...Object.fromEntries(dirs.map((dir, i) => [`e${i}`, `${ref}:${dir}`])) },
    });
    const repository = answer.data?.repository;
    if ((answer.errors?.length ?? 0) > 0 || !repository) return null;
    const found = new Map<string, string>();
    dirs.forEach((dir, i) => {
      // GraphQL gives the mode as a number: 33188 is 100644.
      for (const entry of repository[`d${i}`]?.entries ?? []) {
        found.set(dir ? `${dir}/${entry.name}` : entry.name, typeof entry.mode === 'number' ? entry.mode.toString(8) : String(entry.mode));
      }
    });
    return new Map(paths.map((path) => [path, found.get(path) ?? '']));
  }

  /** What the line needs to decide: where the head is, and whether it may land. */
  async getPullRequest(
    repo: string,
    prNumber: number,
  ): Promise<{
    number: number;
    draft: boolean;
    merged: boolean;
    state: 'open' | 'closed';
    headRef: string;
    headSha: string;
    baseRef: string;
    labels: string[];
    mergeableState: string | null;
    autoMerge: boolean;
    /** Who opened it. */
    author: string | null;
    /** Who merged it, when it is merged. Null on an open pull request, or when that account has since been deleted. */
    mergedBy: string | null;
    /** The repository its head branch is in: another one's for a fork, null when that is gone. */
    headRepoFullName: string | null;
    /** People and teams asked for a review on GitHub who have not given one yet. */
    requestedReviewers: string[];
    requestedTeams: string[];
  }> {
    const pull = await this.request<{
      number: number;
      draft: boolean;
      merged: boolean;
      state: 'open' | 'closed';
      head: { ref: string; sha: string; repo?: { full_name?: string } | null };
      base: { ref: string };
      labels: { name: string }[];
      mergeable_state?: string | null;
      auto_merge?: unknown;
      user?: { login: string } | null;
      merged_by?: { login: string } | null;
      requested_reviewers?: { login: string }[];
      requested_teams?: { slug: string }[];
    }>('GET', `/repos/${repo}/pulls/${prNumber}`);

    return {
      number: pull.number,
      draft: pull.draft,
      merged: pull.merged,
      state: pull.state,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      baseRef: pull.base.ref,
      labels: pull.labels.map((label) => label.name),
      mergeableState: pull.mergeable_state ?? null,
      author: pull.user?.login ?? null,
      mergedBy: pull.merged_by?.login ?? null,
      autoMerge: Boolean(pull.auto_merge),
      headRepoFullName: pull.head.repo?.full_name ?? null,
      requestedReviewers: (pull.requested_reviewers ?? []).map((user) => user.login),
      requestedTeams: (pull.requested_teams ?? []).map((team) => team.slug),
    };
  }

  /**
   * Makes a pull request a draft again: what a send-back does to the open pull
   * request of work that went back before build, so nothing reviews or lands
   * it while the stage before decides. REST has no call for it, so this is the
   * GraphQL mutation, which names the pull request by its node id.
   *
   * GraphQL answers a refusal with 200 and an `errors` list, so the status alone
   * would read a refused mutation as done; the list is what says it was not.
   */
  async convertToDraft(repo: string, prNumber: number): Promise<void> {
    const pull = await this.request<{ node_id: string }>('GET', `/repos/${repo}/pulls/${prNumber}`);
    const answer = await this.request<{ errors?: { message?: string }[] }>('POST', '/graphql', {
      query: 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: pull.node_id },
    });
    const refused = answer.errors?.map((error) => error.message ?? 'refused').join('; ');
    if (refused) {
      throw new GitHubApiError(
        422,
        '/graphql',
        `GitHub would not make ${repo}#${prNumber} a draft (${refused}). ` +
          `Make it a draft on the pull request's page, and check that ${this.options.actingAs} may write pull requests in ${repo}.`,
      );
    }
  }

  /**
   * Who last changed an issue's text, as GitHub records it: its author and
   * their association, the last person to edit its body and when, and who
   * last renamed it. Only the author or someone with write access can edit an
   * issue, so a last editor who is not the author is somebody with access.
   * REST says none of this, so this is GraphQL; a 200 with `errors` is a
   * refusal and throws, which a caller reads as "could not ask".
   */
  async issueEdits(
    repo: string,
    issueNumber: number,
  ): Promise<{ author: string | null; association: string | null; editor: string | null; lastEditedAt: string | null; renamedBy: string | null }> {
    const [owner, name] = repo.split('/');
    const answer = await this.request<{
      data?: {
        repository?: {
          issue?: {
            author?: { login?: string } | null;
            authorAssociation?: string | null;
            editor?: { login?: string } | null;
            lastEditedAt?: string | null;
            timelineItems?: { nodes?: ({ actor?: { login?: string } | null } | null)[] } | null;
          } | null;
        } | null;
      };
      errors?: { message?: string }[];
    }>('POST', '/graphql', {
      query:
        'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { ' +
        'author { login } authorAssociation editor { login } lastEditedAt ' +
        'timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 1) { nodes { ... on RenamedTitleEvent { actor { login } createdAt } } } } } }',
      variables: { owner, name, number: issueNumber },
    });
    const refused = answer.errors?.map((error) => error.message ?? 'refused').join('; ');
    if (refused) throw new GitHubApiError(422, '/graphql', `GitHub would not say who edited ${repo}#${issueNumber} (${refused}).`);
    const issue = answer.data?.repository?.issue;
    if (!issue) throw new GitHubApiError(404, '/graphql', `GitHub has no issue ${repo}#${issueNumber} to say who edited.`);
    return {
      author: issue.author?.login ?? null,
      association: issue.authorAssociation ?? null,
      editor: issue.editor?.login ?? null,
      lastEditedAt: issue.lastEditedAt ?? null,
      renamedBy: issue.timelineItems?.nodes?.at(-1)?.actor?.login ?? null,
    };
  }

  /**
   * The issues in the same repository that a pull request closes as GitHub
   * sees them: a closing keyword in its body ("Closes #N", "Fixed #N", …) and
   * an issue linked in its sidebar alike. Neither is in the webhook delivery,
   * and REST has no call for it, so this is GraphQL.
   *
   * GitHub counts a keyword only on a pull request into the default branch;
   * this list follows it, where reading the body would not. An issue in another
   * repository is left out: the caller moves issues of this one.
   */
  async closingIssues(repo: string, prNumber: number): Promise<number[]> {
    const [owner, name] = repo.split('/');
    const answer = await this.request<{
      data?: {
        repository?: {
          pullRequest?: { closingIssuesReferences?: { nodes?: ({ number: number; repository?: { nameWithOwner?: string } } | null)[] } } | null;
        } | null;
      };
      errors?: { message?: string }[];
    }>('POST', '/graphql', {
      query:
        'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ' +
        'closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } } } } }',
      variables: { owner, name, number: prNumber },
    });
    const refused = answer.errors?.map((error) => error.message ?? 'refused').join('; ');
    if (refused) throw new GitHubApiError(422, '/graphql', `GitHub would not list the issues ${repo}#${prNumber} closes (${refused}).`);
    const nodes = answer.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    return nodes
      .filter((node) => node && node.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase())
      .map((node) => node!.number);
  }

  /**
   * A pull request's history of pushes and drafting, oldest first: who made it
   * a draft or ready, whether an app did it, and which commits were pushed in
   * between. GitHub lists it oldest first, so a history longer than ten pages
   * would be missing its newest events: it is not returned at all (null), and
   * the caller treats it as unknown rather than read the wrong end of it.
   */
  async listPullHistory(
    repo: string,
    prNumber: number,
  ): Promise<PullHistoryEntry[] | null> {
    const history: PullHistoryEntry[] = [];
    for (let page = 1; page <= 10; page++) {
      const events = await this.request<
        {
          event?: string;
          actor?: { login?: string } | null;
          user?: { login?: string } | null;
          performed_via_github_app?: unknown;
          sha?: string;
          requested_reviewer?: { login?: string } | null;
          requested_team?: { slug?: string } | null;
          dismissed_review?: { review_id?: number; state?: string } | null;
          label?: { name?: string } | null;
        }[]
      >('GET', `/repos/${repo}/issues/${prNumber}/timeline?per_page=${PAGE}&page=${page}`);
      for (const entry of events) {
        if (!entry.event) continue;
        history.push({
          event: entry.event,
          // A review's event names its author as `user`.
          actor: entry.actor?.login ?? entry.user?.login ?? null,
          viaApp: Boolean(entry.performed_via_github_app),
          sha: entry.sha ?? null,
          // Who a review was asked of, or no longer asked of.
          subject: entry.requested_reviewer?.login ?? (entry.requested_team?.slug ? `team ${entry.requested_team.slug}` : null),
          // Which review was dismissed, and what it said before: the actor
          // above is who dismissed it.
          ...(entry.event === 'review_dismissed'
            ? { dismissedReviewId: entry.dismissed_review?.review_id ?? null, dismissedState: entry.dismissed_review?.state ?? null }
            : {}),
          ...(entry.event === 'labeled' || entry.event === 'unlabeled' ? { label: entry.label?.name ?? null } : {}),
        });
      }
      if (events.length < PAGE) return history;
    }
    return null;
  }

  /**
   * Squash-merges a pull request, only if its head is still `headSha`: GitHub
   * refuses (409) a head that moved after the caller decided, so what lands is
   * exactly what was checked. Returns the commit it landed as.
   */
  async mergePullRequest(repo: string, prNumber: number, headSha: string): Promise<{ sha: string }> {
    const merged = await this.request<{ sha: string; merged?: boolean; message?: string }>('PUT', `/repos/${repo}/pulls/${prNumber}/merge`, {
      merge_method: 'squash',
      sha: headSha,
    });
    if (merged.merged === false) throw new GitHubApiError(405, `/repos/${repo}/pulls/${prNumber}/merge`, merged.message ?? 'not merged');
    return { sha: merged.sha };
  }

  /** How far the head is from the base: the line only updates what is behind. */
  async behindBy(repo: string, base: string, head: string): Promise<number> {
    const comparison = await this.request<{ behind_by: number }>(
      'GET',
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return comparison.behind_by;
  }

  /**
   * The files the base changed since the head left it: GitHub's comparison of
   * head to base lists what the base has that the head does not. Those of them
   * the pull request also changes are what a conflicted update fought over —
   * GitHub's 422 on an update names none.
   *
   * Null when the comparison lists as many files as it ever does: past that,
   * a conflicted file can be missing, and a partial list of shared files
   * would class a conflict in ordinary code as one the lead alone re-checks.
   */
  async filesChangedOnBaseSince(repo: string, head: string, base: string): Promise<string[] | null> {
    const comparison = await this.request<{ files?: { filename: string; previous_filename?: string }[] }>(
      'GET',
      `/repos/${repo}/compare/${encodeURIComponent(head)}...${encodeURIComponent(base)}?per_page=${COMPARE_FILES_LISTED}`,
    );
    const files = comparison.files ?? [];
    if (files.length >= COMPARE_FILES_LISTED) return null;
    return [...new Set(files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))];
  }

  /**
   * The files `head` changes since it left `from`, renames by both names:
   * GitHub's three-dot comparison.
   *
   * Null when the comparison is capped, listing as many files as it ever does:
   * the list can be missing files, and a stacked update would carry approvals
   * over files nobody saw.
   */
  async changedFilesBetween(repo: string, from: string, head: string): Promise<string[] | null> {
    const comparison = await this.request<{ files?: { filename: string; previous_filename?: string }[] }>(
      'GET',
      `/repos/${repo}/compare/${encodeURIComponent(from)}...${encodeURIComponent(head)}?per_page=${COMPARE_FILES_LISTED}`,
    );
    const files = comparison.files ?? [];
    if (files.length >= COMPARE_FILES_LISTED) return null;
    return [...new Set(files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))];
  }

  /**
   * Merges the base into the pull request's branch, as the account whose
   * credential this client holds — which is why the line uses the builder's:
   * the branch is its work, and it holds write on the repository.
   *
   * GitHub answers 422 for more than one thing, so the pull request is read
   * again to tell them apart, and the caller is told rather than thrown at:
   *
   * - the head is no longer `expectedHeadSha` (a person pushed, or an update
   *   asked for earlier finished): neither updated nor a conflict, and the
   *   next tick reads the new head;
   * - GitHub says there is a merge conflict, or the pull request's mergeable
   *   state is `dirty`: a conflict, which only a person or the branch's owner
   *   can resolve;
   * - anything else, a re-read that fails included: not a conflict, with
   *   GitHub's message. Unknown is not a conflict.
   *
   * Every 422 was read as a conflict, so a head that moved sent an approved
   * pull request to a conflict round that found nothing to resolve, and back
   * to Build.
   */
  async updateBranch(
    repo: string,
    prNumber: number,
    expectedHeadSha: string,
  ): Promise<{ updated: boolean; conflict: boolean; message: string }> {
    try {
      await this.request('PUT', `/repos/${repo}/pulls/${prNumber}/update-branch`, {
        expected_head_sha: expectedHeadSha,
      });
      return { updated: true, conflict: false, message: 'updated from the base branch' };
    } catch (error) {
      const status = error instanceof GitHubApiError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);
      if (status !== 422) return { updated: false, conflict: false, message };
      const now = await this.getPullRequest(repo, prNumber).catch(() => null);
      if (!now) return { updated: false, conflict: false, message };
      if (now.headSha !== expectedHeadSha) return { updated: false, conflict: false, message: `the head moved to ${now.headSha.slice(0, 7)} since it was read` };
      return { updated: false, conflict: /merge conflict/i.test(message) || now.mergeableState === 'dirty', message };
    }
  }

  /**
   * Merges `head` (a branch name) into `branch`, as `updateBranch` does, but
   * through GitHub's merges endpoint, which answers with the commit it made.
   * `updateBranch` answers 202 and nothing more, so the caller could not tell
   * its own commit from any other push to the branch; a stacked pull request's
   * approvals are kept only for that exact commit (`stacking.ts`).
   *
   * 409 is a conflict, as `updateBranch`'s 422 is; 204 is nothing to merge.
   */
  async mergeIntoBranch(
    repo: string,
    branch: string,
    head: string,
  ): Promise<{ merged: boolean; conflict: boolean; sha: string | null; parents: string[]; message: string }> {
    try {
      const made = await this.request<{ sha?: string; parents?: { sha: string }[] }>('POST', `/repos/${repo}/merges`, { base: branch, head });
      if (!made.sha) return { merged: false, conflict: false, sha: null, parents: [], message: `nothing to merge: ${branch} already has ${head}` };
      return { merged: true, conflict: false, sha: made.sha, parents: (made.parents ?? []).map((parent) => parent.sha), message: `merged ${head} into ${branch}` };
    } catch (error) {
      const status = error instanceof GitHubApiError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);
      return { merged: false, conflict: status === 409, sha: null, parents: [], message };
    }
  }

  /**
   * The check runs and commit statuses on this exact commit, as
   * name/status/conclusion. A failed lookup reads as no checks, which the merge
   * line treats as not yet passed, so it waits rather than landing an untested
   * pull request.
   *
   * A pending status is a check still running, not one that finished: read as
   * finished with a conclusion of `pending`, the merge line took it for a
   * failure and sent a pull request back that `review-gate` was only holding.
   */
  async checksFor(
    repo: string,
    sha: string,
  ): Promise<{ name: string; status: string; conclusion: string | null; id?: number }[]> {
    const [runs, statuses] = await Promise.all([
      this.checkRunsFor(repo, sha).catch(() => []),
      this.statusesFor(repo, sha).catch(() => []),
    ]);

    return [
      ...runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, ...(typeof run.id === 'number' ? { id: run.id } : {}) })),
      ...statuses.map((status) =>
        status.state === 'pending'
          ? { name: status.context, status: 'in_progress', conclusion: null }
          : { name: status.context, status: 'completed', conclusion: status.state === 'success' ? 'success' : 'failure' },
      ),
    ];
  }

  async listPullFiles(repo: string, prNumber: number): Promise<string[]> {
    return (await this.listEveryPullFile(repo, prNumber)).files;
  }

  /**
   * Every file a pull request changes, a page at a time. GitHub lists no more
   * than 3000, and says nothing when it stops there, so `complete` is false for
   * a list that reached that many: past it, a path a person must review could
   * be missing, and a caller that decides on the list must not take it as all.
   */
  async listEveryPullFile(repo: string, prNumber: number): Promise<{ files: string[]; complete: boolean; renamedFrom: string[] }> {
    const files: string[] = [];
    const renamedFrom: string[] = [];
    let counted = 0;
    for (let page = 1; counted < PULL_FILES_LISTED; page++) {
      const listed = await this.request<{ filename: string; previous_filename?: string }[]>(
        'GET',
        `/repos/${repo}/pulls/${prNumber}/files?per_page=${PAGE}&page=${page}`,
      );
      counted += listed.length;
      // A renamed file under both its names: moved out of a path a person
      // reviews, or out of CI's own files, it is still a change to that path.
      for (const file of listed) {
        files.push(file.filename);
        if (file.previous_filename) {
          files.push(file.previous_filename);
          renamedFrom.push(file.previous_filename);
        }
      }
      if (listed.length < PAGE) return { files: [...new Set(files)], complete: true, renamedFrom };
    }
    return { files: [...new Set(files)], complete: false, renamedFrom };
  }

  /**
   * The files a pull request leaves in the tree, by the names it gives them:
   * what a patch round may write. A rename's old name is a change to that path
   * for a review, but not a file to write back.
   */
  async listPullFilesAsNamed(repo: string, prNumber: number): Promise<string[]> {
    const listed = await this.listEveryPullFile(repo, prNumber);
    const current = new Set(listed.files.filter((file) => !listed.renamedFrom.includes(file)));
    return listed.files.filter((file) => current.has(file));
  }

  /**
   * A file as it is on a ref, or null when it is not there. Anything else that
   * goes wrong is thrown, not read as absent: a caller comparing a file on two
   * refs must not take "could not read" for "no such file".
   */
  async readFileIfPresent(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const file = await this.request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      );
      return Buffer.from(file.content ?? '', (file.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The check runs on a commit, with the app that made each: a check run is
   * set by its app alone, where a commit status can be set by any token that
   * may write statuses. `suiteId` is what finds the workflow run behind one.
   */
  async checkRunsFor(
    repo: string,
    sha: string,
  ): Promise<{ name: string; status: string; conclusion: string | null; app: string | null; headSha: string; suiteId: number | null; id?: number }[]> {
    const runs: { name: string; status: string; conclusion: string | null; app: string | null; headSha: string; suiteId: number | null; id?: number }[] = [];
    for (let page = 1; ; page++) {
      const listed = await this.request<{
        check_runs: { id?: number; name: string; status: string; conclusion: string | null; head_sha: string; app?: { slug?: string } | null; check_suite?: { id?: number } | null }[];
      }>('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}&page=${page}`);
      for (const run of listed.check_runs) {
        runs.push({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          app: run.app?.slug ?? null,
          headSha: run.head_sha,
          suiteId: run.check_suite?.id ?? null,
          ...(typeof run.id === 'number' ? { id: run.id } : {}),
        });
      }
      if (listed.check_runs.length < PAGE) return runs;
    }
  }

  /** The commit statuses on a commit, and who set each. */
  async statusesFor(repo: string, sha: string): Promise<{ context: string; state: string; creator: string | null }[]> {
    const statuses: { context: string; state: string; creator: string | null }[] = [];
    for (let page = 1; ; page++) {
      const combined = await this.request<{ statuses: { context: string; state: string; creator?: { login?: string } | null }[] }>(
        'GET',
        `/repos/${repo}/commits/${sha}/status?per_page=${PAGE}&page=${page}`,
      );
      statuses.push(...combined.statuses.map((status) => ({ context: status.context, state: status.state, creator: status.creator?.login ?? null })));
      if (combined.statuses.length < PAGE) return statuses;
    }
  }

  /**
   * What someone may do in a repository — `admin`, `maintain`, `write`,
   * `triage`, `read` or `none` — as GitHub answers it, not as a post's
   * `author_association` says: an organization member whose membership is
   * private reads as a contributor to a token outside the organization.
   */
  async permissionOf(repo: string, login: string): Promise<string> {
    const answer = await this.request<{ permission?: string; role_name?: string }>(
      'GET',
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    // An empty `role_name` is someone no longer a collaborator; `permission`
    // is then what GitHub says, and nothing at all is no access.
    return answer.role_name || answer.permission || 'none';
  }

  /** The Actions workflow run a check suite belongs to: its workflow's name and its head. Null when it is none. */
  async workflowRunOfSuite(repo: string, suiteId: number): Promise<{ name: string; headSha: string } | null> {
    const found = await this.request<{ workflow_runs?: { name: string; head_sha: string }[] }>(
      'GET',
      `/repos/${repo}/actions/runs?check_suite_id=${suiteId}&per_page=1`,
    );
    const run = found.workflow_runs?.[0];
    return run ? { name: run.name, headSha: run.head_sha } : null;
  }

  /**
   * Every commit on a pull request, with who wrote it.
   *
   * `authorLogin` is the account GitHub matched the author to, and is null when
   * it could not tie the address to one — which is why the address and the name
   * come too.
   *
   * GitHub lists at most 250 commits for a pull request and says nothing when it
   * stops there. A caller asking who wrote a pull request has to have seen every
   * commit, so a list that reaches 250 is refused rather than returned short.
   */
  async listPullCommits(repo: string, prNumber: number): Promise<PullCommit[]> {
    const commits: PullCommit[] = [];

    for (let page = 1; commits.length < PULL_COMMITS_LISTED; page += 1) {
      const listed = await this.request<
        {
          sha: string;
          author: { login: string } | null;
          commit: { author: { name?: string | null; email?: string | null } | null };
        }[]
      >('GET', `/repos/${repo}/pulls/${prNumber}/commits?per_page=${PAGE}&page=${page}`);

      for (const entry of listed) {
        commits.push({
          sha: entry.sha,
          authorLogin: entry.author?.login ?? null,
          authorEmail: entry.commit.author?.email ?? '',
          authorName: entry.commit.author?.name ?? '',
        });
      }
      if (listed.length < PAGE) break;
    }

    if (commits.length >= PULL_COMMITS_LISTED) {
      throw new Error(
        `GitHub lists at most ${PULL_COMMITS_LISTED} commits for a pull request, and ${repo}#${prNumber} has at least that many`,
      );
    }
    return commits;
  }

  /**
   * The pull requests a commit came from.
   *
   * What a deploy knows is the commit it put on an environment; what has to be
   * labelled is the pull request that commit came from. A squash merge leaves
   * no link back to its branch that is visible from the pushed commit alone, so
   * this is GitHub's answer rather than one the platform can reconstruct.
   */
  async listPullsForCommit(repo: string, sha: string): Promise<{ number: number; headRef: string; headRepoFullName: string | null }[]> {
    const pulls = await this.request<{ number: number; head: { ref: string; repo?: { full_name?: string } | null } }[]>(
      'GET',
      `/repos/${repo}/commits/${sha}/pulls?per_page=100`,
    );
    // Where the branch lives: a fork's branch can be named like a builder's,
    // and only one in the repository itself is an issue's. Null once the fork
    // is deleted.
    return pulls.map((pull) => ({ number: pull.number, headRef: pull.head.ref, headRepoFullName: pull.head.repo?.full_name ?? null }));
  }

  /** Uploaded once per bot after device auth, so signed commits verify on GitHub. */
  async uploadSshSigningKey(title: string, publicKey: string): Promise<number> {
    const created = await this.request<{ id: number }>('POST', '/user/ssh_signing_keys', {
      title,
      key: publicKey,
    });
    return created.id;
  }

  async listSshSigningKeys(): Promise<{ id: number; title: string; key: string }[]> {
    return this.request<{ id: number; title: string; key: string }[]>('GET', '/user/ssh_signing_keys');
  }
}
