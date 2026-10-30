import {
  ATTACHMENT_LIMITS,
  DELIVERY_RULES_PATH,
  checkAttachment,
  orderPullActions,
  outputIsCurrent,
  pullRequestRules,
  readOutput,
  type PullCommand,
  type PullOutput,
  type PullRequestRules,
} from '@openadlc/shared';
import { assetLinks, downloadAsset, repositoryFileOf } from './issue-assets.js';
import type { PermissionAsker } from './people.js';
import { personKey, type FlowView, type GitHubViewer, type PersonFlows, type PersonGitHubDeps } from './person-github.js';
import { HttpFailure } from './router.js';

/**
 * A pull request's commands and what its repository's workflows posted back,
 * read from GitHub when the console asks, and a command posted when a person
 * presses its button (#207). See `@openadlc/shared`'s `pull-commands.ts` for
 * what a repository declares.
 *
 * - A command anyone may send is posted as the app, with exactly the declared
 *   text. A crew account never posts one: its post is signed, which changes
 *   the text, and unsigned it is an `unattributed-post` card.
 * - A command only a reviewer may send is posted as that reviewer's own
 *   account, from a sign-in held for that one post (`person-github.ts`), and
 *   offered only to the console person whose linked account is that reviewer.
 * - Nothing read here is stored: the head, the checks and the comments are
 *   read for a few seconds, and an image is read through the bridge, never
 *   handed to the browser as a GitHub or signed address.
 *
 * A comment is data. It is read only from the authors an output names, and a
 * link is shown only when it is `https://`.
 */

/** What reading asks of GitHub: the automation account's client. */
export interface PullReader {
  request<T>(method: string, path: string, body?: unknown, options?: { accept?: string }): Promise<T>;
  readFileIfPresent(repo: string, path: string, ref: string): Promise<string | null>;
}

export interface PullRepo {
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface SentRecord {
  head: string;
  commentUrl: string | null;
  at: string;
}

export interface PullCommandDeps {
  reader(): Promise<PullReader | null>;
  /** The app, to post as, on one repository; see `theApp`. */
  app(repoFullName: string): Promise<PermissionAsker | null>;
  flows: PersonFlows;
  person: Pick<PersonGitHubDeps, 'isCrew'> & { store: Pick<PersonGitHubDeps['store'], 'ofIdentity'> & { ofUserId(id: number): Promise<{ githubLogin: string } | null> } };
  /** A login's GitHub account id, or null when GitHub does not know it. */
  userIdOf(login: string): Promise<number | null>;
  /** Posts one comment with a person's own token, exactly as given. */
  postAsPerson(accessToken: string, repoFullName: string, number: number, body: string): Promise<{ id: number; htmlUrl: string }>;
  /** The newest `pull.command_sent` for a pull request's command. */
  lastSent(target: string): Promise<SentRecord | null>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  now?: () => number;
}

/** How long a command waits for its workflow's answer before it may be pressed again. */
export const QUIET_AFTER_MS = 30 * 60_000;
const RULES_KEPT_MS = 60_000;
const PULL_KEPT_MS = 15_000;
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;

export type CommandState = 'ready' | 'sent' | 'answered' | 'quiet';

export interface PullCommandView {
  name: string;
  label: string;
  comment: string;
  by: PullCommand['by'];
  reviewers: string[];
  unblocks: string | null;
  /** Whether the person asking may press it. */
  offered: boolean;
  /** Why not, when it is not: one sentence, with where else it can be sent. */
  why?: string;
  state: CommandState;
  /** The workflow's answer, once it came: "Preview at https://…", "visual-review passed". */
  answer?: string;
  commentUrl?: string;
  sentAt?: string;
}

export interface PullOutputView {
  name: string;
  kind: PullOutput['kind'];
  /** The newest comment that is this output, or null when none was posted. */
  found: {
    commentId: number;
    commentUrl: string;
    at: string;
    url?: string;
    sha?: string;
    current: boolean;
    images?: { index: number; alt: string | null }[];
  } | null;
}

export interface PullView {
  repo: string;
  number: number;
  url: string;
  open: boolean;
  head: string;
  /** Each `unblocks` check's state at the head. */
  checks: Record<string, string | null>;
  /** In `orderPullActions`' order. */
  commands: PullCommandView[];
  outputs: PullOutputView[];
  errors: string[];
}

interface Comment {
  id: number;
  user: string;
  body: string;
  bodyHtml: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  issueUrl: string;
}

interface CheckState {
  state: string | null;
  completedAt: string | null;
}

interface PullFacts {
  open: boolean;
  url: string;
  head: string;
  headCommittedAt: string | null;
  checks: Record<string, CheckState>;
  comments: Comment[];
}

type RawComment = {
  id: number;
  user: { login: string } | null;
  body?: string | null;
  body_html?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  issue_url?: string;
};

function commentOf(raw: RawComment): Comment {
  return {
    id: raw.id,
    user: raw.user?.login ?? 'unknown',
    body: raw.body ?? '',
    bodyHtml: raw.body_html ?? '',
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    issueUrl: raw.issue_url ?? '',
  };
}

const PAGE = 100;

/** The rules each repository declares, read from its default branch and kept a minute. A read that failed is not kept. */
export class PullRules {
  private readonly known = new Map<string, { at: number; rules: PullRequestRules }>();

  constructor(
    private readonly reader: () => Promise<Pick<PullReader, 'readFileIfPresent'> | null>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(repo: PullRepo): Promise<PullRequestRules> {
    const held = this.known.get(repo.fullName);
    if (held && this.now() - held.at < RULES_KEPT_MS) return held.rules;
    const client = await this.reader().catch(() => null);
    if (!client) return held?.rules ?? pullRequestRules(null);
    try {
      const rules = pullRequestRules(await client.readFileIfPresent(repo.fullName, DELIVERY_RULES_PATH, repo.defaultBranch));
      this.known.set(repo.fullName, { at: this.now(), rules });
      return rules;
    } catch {
      return held?.rules ?? pullRequestRules(null);
    }
  }

  /** Whether a repository declares any command: what puts a pull request's buttons on its Needs-you card. */
  async declares(repo: PullRepo): Promise<boolean> {
    return (await this.get(repo)).commands.length > 0;
  }

  /** The repository's rules as last read, without asking GitHub: what a webhook checks a comment against. */
  kept(repoFullName: string): PullRequestRules | null {
    return this.known.get(repoFullName)?.rules ?? null;
  }
}

/**
 * The rules the webhook checks a comment against, set where the routes are
 * registered (`api.ts`). Absent, no comment is a command.
 */
let declared: PullRules | null = null;

export function useDeclaredCommands(rules: PullRules | null): void {
  declared = rules;
}

/**
 * Whether a comment's trimmed body is exactly a command its repository
 * declares. A reviewer's `/approve-pages` answered an open question on the
 * pull request, or woke its build, and the app's `/preview` was told it was
 * not taken; `Webhooks.onIssueComment` stops before all three for one.
 */
export async function isDeclaredCommand(repo: PullRepo, body: string): Promise<boolean> {
  if (!declared) return false;
  const text = body.trim();
  if (!text.startsWith('/')) return false;
  const rules = await declared.get(repo).catch(() => declared?.kept(repo.fullName) ?? null);
  return Boolean(rules?.commands.some((command) => command.comment === text));
}

/** A small cache of images by key, dropping the oldest past its bytes. */
class ImageCache {
  private readonly held = new Map<string, { bytes: Buffer; mediaType: string }>();
  private size = 0;

  get(key: string): { bytes: Buffer; mediaType: string } | undefined {
    const found = this.held.get(key);
    if (found) {
      this.held.delete(key);
      this.held.set(key, found);
    }
    return found;
  }

  set(key: string, value: { bytes: Buffer; mediaType: string }): void {
    if (value.bytes.length > IMAGE_CACHE_BYTES) return;
    this.held.set(key, value);
    this.size += value.bytes.length;
    for (const [oldest, one] of this.held) {
      if (this.size <= IMAGE_CACHE_BYTES) break;
      this.held.delete(oldest);
      this.size -= one.bytes.length;
    }
  }
}

export class PullCommands {
  private readonly facts = new Map<string, { at: number; facts: PullFacts }>();
  private readonly images = new ImageCache();
  private readonly userIds = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly deps: PullCommandDeps,
    readonly rules: PullRules,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  private async reader(): Promise<PullReader> {
    const client = await this.deps.reader().catch(() => null);
    if (!client) throw new HttpFailure(503, 'OpenADLC cannot read GitHub right now: the automation account is not connected. Connect it under Crew.');
    return client;
  }

  private async pullFacts(repo: PullRepo, number: number, rules: PullRequestRules, fresh = false): Promise<PullFacts> {
    const key = `${repo.fullName}#${number}`;
    const held = this.facts.get(key);
    if (!fresh && held && this.now() - held.at < PULL_KEPT_MS) return held.facts;
    const client = await this.reader();
    const pull = await client.request<{ state: string; html_url: string; head: { sha: string } }>('GET', `/repos/${repo.fullName}/pulls/${number}`);
    const head = pull.head.sha;
    const commit = await client
      .request<{ commit?: { committer?: { date?: string } | null } }>('GET', `/repos/${repo.fullName}/commits/${head}`)
      .catch(() => null);
    const checks: Record<string, CheckState> = {};
    const names = [...new Set(rules.commands.map((one) => one.unblocks).filter((one): one is string => Boolean(one)))];
    if (names.length > 0) {
      const statuses = await client
        .request<{ statuses: { context: string; state: string; updated_at?: string }[] }>('GET', `/repos/${repo.fullName}/commits/${head}/status?per_page=${PAGE}`)
        .then((combined) => combined.statuses)
        .catch(() => []);
      for (const name of names) {
        const runs = await client
          .request<{ check_runs: { status: string; conclusion: string | null; completed_at: string | null; started_at?: string | null }[] }>(
            'GET',
            `/repos/${repo.fullName}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`,
          )
          .then((listed) => listed.check_runs)
          .catch(() => []);
        const run = runs[0];
        if (run) {
          checks[name] = { state: run.status === 'completed' ? run.conclusion : run.status, completedAt: run.status === 'completed' ? run.completed_at : null };
          continue;
        }
        const status = statuses.find((one) => one.context === name);
        checks[name] = status
          ? { state: status.state, completedAt: status.state === 'pending' ? null : (status.updated_at ?? null) }
          : { state: null, completedAt: null };
      }
    }
    const authors = new Set(rules.outputs.flatMap((one) => one.from.map((login) => login.toLowerCase())));
    const comments: Comment[] = [];
    if (authors.size > 0) {
      for (let page = 1; ; page++) {
        const listed = await client.request<RawComment[]>('GET', `/repos/${repo.fullName}/issues/${number}/comments?per_page=${PAGE}&page=${page}`, undefined, {
          accept: 'application/vnd.github.full+json',
        });
        for (const raw of listed) if (authors.has((raw.user?.login ?? '').toLowerCase())) comments.push(commentOf(raw));
        if (listed.length < PAGE) break;
      }
    }
    const facts: PullFacts = {
      open: pull.state === 'open',
      url: pull.html_url,
      head,
      headCommittedAt: commit?.commit?.committer?.date ?? null,
      checks,
      comments,
    };
    this.facts.set(key, { at: this.now(), facts });
    return facts;
  }

  /** Forgets what was read about a pull request: a command was just posted, so the next read shows it. */
  forget(repo: PullRepo, number: number): void {
    this.facts.delete(`${repo.fullName}#${number}`);
  }

  private async userId(login: string): Promise<number | null> {
    const key = login.toLowerCase();
    if (this.userIds.has(key)) return this.userIds.get(key)!;
    // Only an id GitHub returned is kept. A null is a lookup that failed (no
    // automation client yet, or GitHub erred), and caching it left a
    // reviewer's command unoffered until the bridge restarted.
    const id = await this.deps.userIdOf(login).catch(() => null);
    if (typeof id !== 'number') return null;
    this.userIds.set(key, id);
    return id;
  }

  /** Whether the person's linked account is one of a command's reviewers, and why not when it is not. */
  private async reviewerCheck(command: PullCommand, identity: string): Promise<{ offered: boolean; why?: string; linkedId?: number }> {
    const who = command.reviewers.map((login) => `@${login}`).join(' or ');
    const onGitHub = `send ${command.comment} on GitHub`;
    const link = await this.deps.person.store.ofIdentity(personKey(identity)).catch(() => null);
    const ids = (await Promise.all(command.reviewers.map((login) => this.userId(login)))).filter((id): id is number => id !== null);
    if (link && ids.includes(link.githubUserId)) {
      if (!(await this.deps.flows.clientId())) {
        return { offered: false, why: `OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured. ${capital(onGitHub)}.` };
      }
      return { offered: true, linkedId: link.githubUserId };
    }
    const linkedBy = await Promise.all(ids.map((id) => this.deps.person.store.ofUserId(id).catch(() => null)));
    const someone = linkedBy.some(Boolean);
    return {
      offered: false,
      why: someone
        ? `${command.label} is ${who}'s to send, from their own account, and it is linked to another person here. They press it, or ${onGitHub}.`
        : `${command.label} is ${who}'s to send; nobody here has linked ${who}'s GitHub account. Link it in Settings, or ${onGitHub}.`,
    };
  }

  /**
   * The comment that is an output, with what it says: the newest one for the
   * head, else the newest for an older head. Taking only the newest showed a
   * rerun of an old commit's preview, marked older, while the head's own
   * preview sat in the comments unshown.
   */
  private found(output: PullOutput, facts: PullFacts, number: number, repo: PullRepo): PullOutputView['found'] {
    let older: NonNullable<PullOutputView['found']> | null = null;
    for (const comment of [...facts.comments].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      const read = readOutput(output, comment, number);
      if (!read) continue;
      if (read.url && !read.url.startsWith('https://')) continue;
      const current = outputIsCurrent(read, facts.head, facts.headCommittedAt, comment.updatedAt);
      if (!current && older) continue;
      const images =
        output.kind === 'images' ? assetLinks(comment.bodyHtml, { repoFullName: repo.fullName }).map((link, index) => ({ index, alt: link.alt })) : undefined;
      const view = {
        commentId: comment.id,
        commentUrl: comment.htmlUrl,
        at: comment.updatedAt,
        ...(read.url ? { url: read.url } : {}),
        ...(read.sha ? { sha: read.sha } : {}),
        current,
        ...(images ? { images } : {}),
      };
      if (current) return view;
      older = view;
    }
    return older;
  }

  /** What the work item's pull panel shows, for the person asking. */
  async read(repo: PullRepo, number: number, identity: string): Promise<PullView> {
    const rules = await this.rules.get(repo);
    const empty: PullView = { repo: repo.name, number, url: `https://github.com/${repo.fullName}/pull/${number}`, open: true, head: '', checks: {}, commands: [], outputs: [], errors: rules.errors };
    if (rules.commands.length === 0 && rules.outputs.length === 0) return empty;
    const facts = await this.pullFacts(repo, number, rules);
    const outputs = rules.outputs.map((output) => ({ name: output.name, kind: output.kind, found: this.found(output, facts, number, repo) }));
    const checks = Object.fromEntries(Object.entries(facts.checks).map(([name, check]) => [name, check.state]));

    const views = new Map<string, PullCommandView>();
    for (const command of rules.commands) {
      const allowed = command.by === 'anyone' ? { offered: true } : await this.reviewerCheck(command, identity);
      const view: PullCommandView = {
        name: command.name,
        label: command.label,
        comment: command.comment,
        by: command.by,
        reviewers: command.reviewers,
        unblocks: command.unblocks,
        offered: allowed.offered,
        ...(allowed.why ? { why: allowed.why } : {}),
        state: 'ready',
      };
      const sent = await this.deps.lastSent(sentTarget(repo, number, command.name)).catch(() => null);
      if (sent && sent.head === facts.head) {
        Object.assign(view, { sentAt: sent.at, ...(sent.commentUrl ? { commentUrl: sent.commentUrl } : {}) });
        const answer = answerOf(command, sent.at, outputs, facts);
        if (answer) Object.assign(view, { state: 'answered', answer });
        else view.state = this.now() - Date.parse(sent.at) < QUIET_AFTER_MS ? 'sent' : 'quiet';
      }
      views.set(command.name, view);
    }
    const order = orderPullActions({ commands: rules.commands, checks, held: false });
    const commands = order.flatMap((action) => (action.kind === 'command' && views.has(action.name) ? [views.get(action.name)!] : []));
    return { repo: repo.name, number, url: facts.url, open: facts.open, head: facts.head, checks, commands, outputs, errors: rules.errors };
  }

  /**
   * Posts a command on `repo#number`, exactly as declared. Refused when the
   * head the person saw is no longer the head: a sign-off pressed on one
   * commit must not land on another. A reviewer's command answers a device
   * flow to approve, and is posted once it is approved by the linked account.
   */
  async send(input: { repo: PullRepo; number: number; name: string; head: string; identity: string }): Promise<{ state: 'sent'; commentUrl: string } | { flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    const { repo, number, identity } = input;
    const rules = await this.rules.get(repo);
    const command = rules.commands.find((one) => one.name === input.name);
    if (!command) throw new HttpFailure(404, `${repo.name} declares no command called ${input.name} in ${DELIVERY_RULES_PATH}.`);
    const facts = await this.pullFacts(repo, number, rules, true);
    if (!facts.open) throw new HttpFailure(409, `Pull request #${number} is not open; nothing was posted.`);
    if (facts.head !== input.head) {
      throw new HttpFailure(409, `Pull request #${number} moved to ${facts.head.slice(0, 7)} since you looked; nothing was posted. Look again and press it on the new head.`);
    }
    const target = sentTarget(repo, number, command.name);
    // A second press while the first is still waiting for its answer would
    // post the comment twice: the panel unlocks its button when the POST
    // returns, before its next read shows the command as sent.
    const sent = await this.deps.lastSent(target).catch(() => null);
    if (sent && sent.head === facts.head) {
      const outputs = rules.outputs.map((output) => ({ name: output.name, kind: output.kind, found: this.found(output, facts, number, repo) }));
      if (!answerOf(command, sent.at, outputs, facts) && this.now() - Date.parse(sent.at) < QUIET_AFTER_MS) {
        throw new HttpFailure(409, `${command.comment} was already sent on #${number} at ${facts.head.slice(0, 7)} and is waiting for its answer; nothing was posted again.`);
      }
    }

    if (command.by === 'anyone') {
      const app = await this.deps.app(repo.fullName);
      if (!app) {
        throw new HttpFailure(
          503,
          `OpenADLC cannot post as its app on ${repo.fullName}: the app is not installed there, or its key cannot be read. Check Settings → GitHub App, or send ${command.comment} on GitHub.`,
        );
      }
      const posted = await app.request<{ id: number; html_url: string }>('POST', `/repos/${repo.fullName}/issues/${number}/comments`, { body: command.comment });
      await this.deps.audit({
        actor: identity,
        action: 'pull.command_sent',
        target,
        payload: { repo: repo.fullName, pr: number, command: command.name, head: facts.head, as: 'app', login: null, commentId: posted.id, commentUrl: posted.html_url, by: identity },
      });
      this.forget(repo, number);
      return { state: 'sent', commentUrl: posted.html_url };
    }

    const allowed = await this.reviewerCheck(command, identity);
    if (!allowed.offered || allowed.linkedId === undefined) {
      if (allowed.why?.startsWith('OpenADLC cannot sign in')) throw new HttpFailure(409, allowed.why, { url: facts.url });
      throw new HttpFailure(403, allowed.why ?? `${command.label} is not yours to send.`, { url: facts.url });
    }
    const linkedId = allowed.linkedId;
    const flow = await this.deps.flows.start(
      identity,
      async (viewer: GitHubViewer, accessToken: string) => {
        if (viewer.id !== linkedId) {
          throw new Error(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; nothing was posted.`);
        }
        if (await this.deps.person.isCrew(viewer.login)) throw new Error(`@${viewer.login} is an account the crew uses; nothing was posted.`);
        const now = await this.pullFacts(repo, number, rules, true);
        if (now.head !== facts.head) throw new Error(`Pull request #${number} moved to ${now.head.slice(0, 7)} while you signed in; nothing was posted.`);
        const posted = await this.deps.postAsPerson(accessToken, repo.fullName, number, command.comment);
        await this.deps.audit({
          actor: identity,
          action: 'pull.command_sent',
          target,
          payload: { repo: repo.fullName, pr: number, command: command.name, head: facts.head, as: 'person', login: viewer.login, commentId: posted.id, commentUrl: posted.htmlUrl, by: identity },
        });
        this.forget(repo, number);
        return { commentUrl: posted.htmlUrl };
      },
      { noClientId: `OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured. Send ${command.comment} on GitHub: ${facts.url}` },
    );
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }

  /**
   * One image in an output's comment, read through the bridge: the comment is
   * read again, and must be an `images` output from a declared author on this
   * pull request; the image is read from GitHub's image hosts, or through the
   * contents API for a file in the same repository. Only an image type
   * `checkAttachment` takes is served.
   */
  async image(repo: PullRepo, number: number, commentId: number, index: number): Promise<{ bytes: Buffer; mediaType: string }> {
    const rules = await this.rules.get(repo);
    const client = await this.reader();
    const raw = await client
      .request<RawComment>('GET', `/repos/${repo.fullName}/issues/comments/${commentId}`, undefined, { accept: 'application/vnd.github.full+json' })
      .catch(() => null);
    if (!raw) throw new HttpFailure(404, 'There is no such comment on GitHub.');
    const comment = commentOf(raw);
    if (!comment.issueUrl.endsWith(`/repos/${repo.fullName}/issues/${number}`) && !comment.issueUrl.toLowerCase().endsWith(`/repos/${repo.fullName.toLowerCase()}/issues/${number}`)) {
      throw new HttpFailure(404, `That comment is not on pull request #${number}.`);
    }
    if (!rules.outputs.some((output) => output.kind === 'images' && readOutput(output, comment, number))) {
      throw new HttpFailure(404, `That comment is not one ${repo.name} declares its screenshots are posted in.`);
    }
    const key = `${commentId}@${comment.updatedAt}#${index}`;
    const kept = this.images.get(key);
    if (kept) return kept;
    const link = assetLinks(comment.bodyHtml, { repoFullName: repo.fullName })[index];
    if (!link) throw new HttpFailure(404, 'That comment has no image there.');
    const file = repositoryFileOf(link.url, repo.fullName);
    let bytes: Buffer;
    try {
      bytes = file ? await readRepositoryFile(client, repo.fullName, file) : await downloadAsset(link.url);
    } catch (error) {
      throw new HttpFailure(502, `The image could not be read from GitHub: ${error instanceof Error ? error.message : error}`);
    }
    const checked = checkAttachment({ name: link.alt ?? 'image', bytes });
    if (!checked.ok || !checked.mediaType.startsWith('image/')) throw new HttpFailure(415, 'That is not an image the console shows.');
    const image = { bytes, mediaType: checked.mediaType };
    this.images.set(key, image);
    return image;
  }
}

/** A file in the repository, through the contents API, or its blob for one past the contents API's megabyte. */
async function readRepositoryFile(client: PullReader, repoFullName: string, file: { ref: string; path: string }): Promise<Buffer> {
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  const found = await client.request<{ type?: string; size?: number; content?: string; encoding?: string; sha?: string }>(
    'GET',
    `/repos/${repoFullName}/contents/${path}?ref=${encodeURIComponent(file.ref)}`,
  );
  if (found.type !== 'file') throw new Error('not a file');
  if ((found.size ?? 0) > ATTACHMENT_LIMITS.fileBytes) throw new Error('larger than a file may be');
  if (found.content && found.encoding === 'base64') return Buffer.from(found.content, 'base64');
  if (!found.sha) throw new Error('GitHub gave neither the file nor its blob');
  const blob = await client.request<{ content?: string; encoding?: string }>('GET', `/repos/${repoFullName}/git/blobs/${found.sha}`);
  if (!blob.content || blob.encoding !== 'base64') throw new Error('GitHub gave no content');
  return Buffer.from(blob.content, 'base64');
}

/** Where a command's sends are recorded in the audit log. */
export function sentTarget(repo: Pick<PullRepo, 'fullName'>, number: number, name: string): string {
  return `${repo.fullName}#${number}:${name}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What answered a sent command, if anything did since: its output, posted or edited after it, or its check, completed after it. */
function answerOf(command: PullCommand, sentAt: string, outputs: PullOutputView[], facts: PullFacts): string | null {
  const after = (at: string | null | undefined) => Boolean(at) && Date.parse(at!) > Date.parse(sentAt);
  if (command.answer) {
    const found = outputs.find((one) => one.name === command.answer)?.found;
    if (found && after(found.at)) return found.url ? `${capital(command.answer)} at ${found.url}` : `${capital(command.answer)} posted`;
  }
  if (command.unblocks) {
    const check = facts.checks[command.unblocks];
    if (check && after(check.completedAt)) {
      const green = ['success', 'neutral', 'skipped'].includes((check.state ?? '').toLowerCase());
      return `${command.unblocks} ${green ? 'passed' : 'failed'}`;
    }
  }
  return null;
}
