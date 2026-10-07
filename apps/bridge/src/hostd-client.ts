import {
  fetchJson,
  type AccountCheck,
  type ContextDocument,
  type EngineUpdateResult,
  type EngineUpdateStart,
  type EngineUpdateStatus,
  type EngineVersions,
  type SubscriptionLogin,
  type TaskAttachment,
} from '@fleetadlc/shared';
import type { EngineReadiness } from '@fleetadlc/engines';

const INTERNAL_SECRET_HEADER = 'x-fleetadlc-internal-secret';
const ON_BEHALF_OF_HEADER = 'x-fleetadlc-on-behalf-of';

export interface HostdStartInput {
  taskId: string;
  bot: string;
  repo: string | null;
  kind: string;
  subjectRef: string;
  branch?: string | null;
  skill: string;
  /** What the bridge read from GitHub for this task; hostd writes it out. */
  context?: ContextDocument[];
  declaredPaths?: string[];
  costCapUsd?: number;
  checkoutExistingBranch?: boolean;
  /** A branch not on the remote yet is started from the base instead of refused; see hostd's `WorktreeRequest`. */
  startFromBaseIfMissing?: boolean;
  /** The header the session's own posts to GitHub start with (`headerFor`). */
  postHeader?: string;
  /** The files its work item carries, which hostd fetches and writes beside its context. */
  attachments?: TaskAttachment[];
  /** A review task's part: the lead decides, a blocking seat's approval counts, an advisory seat only comments. */
  reviewMode?: ReviewMode;
  /** A review task's lens, from config/review.yaml, which its brief states with its part. */
  reviewLens?: string;
  /** Where a new branch starts, `refs/heads/<name>`; the default branch when absent. */
  baseRef?: string;
}

/** A local CI run as hostd reports it; see hostd's `local-ci.ts`. */
export interface LocalCiView {
  id: string;
  taskId: string;
  state: 'running' | 'passed' | 'failed' | 'refused';
  headSha: string | null;
  branch: string | null;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What a review task may post: see `HostdStartInput.reviewMode`, and OpenADLC's `gh`, which holds an advisory seat to comments. */
export type ReviewMode = 'lead' | 'blocking' | 'advisory';

/** A directory's names, or a bounded slice of one file. hostd decides which. */
export type WorktreeAnswer =
  | { kind: 'directory'; path: string; entries: { name: string; kind: string; size: number | null }[]; truncated: boolean }
  | { kind: 'file'; path: string; size: number; bytes: number; truncated: boolean; content: string };

/** What hostd reports about one engine: the engines package's own type, which the bridge proxies and does not compute. */
export type { EngineReadiness };

/**
 * How long the readiness probe may take before `/v1/engines` answers that hostd
 * is not answering. The probe runs a command per engine, in the bot image under
 * docker, and nothing else bounds it; the onboarding screens wait on it.
 */
export const ENGINES_TIMEOUT_MS = 10_000;

/**
 * How long the health probe waits. A hostd that takes connections and never
 * answers (a blocked event loop, a paused container) held it for fetch's five
 * minutes, past the health check's own limit, so the check said nothing and
 * the board said hostd was fine while every task stalled on it.
 */
export const HEALTH_TIMEOUT_MS = 5_000;
/**
 * How long the bridge waits on hostd to start or resume a task. hostd answers
 * only once the session is running: after a first clone of the repository and
 * `make setup`, which hostd gives up on after 30 minutes
 * (`FLEETADLC_SETUP_TIMEOUT_MINUTES`). A start the bridge gave up on sooner was
 * failed while hostd was still completing it, and the session came up anyway.
 * Longer than hostd's slowest start, so it is hostd's answer that arrives. The
 * store now refuses `running` over an ended task, so a start that outlives
 * this anyway is taken down by hostd. Note that fetch itself stops waiting for
 * an answer's headers after five minutes.
 */
export const START_TIMEOUT_MS = 40 * 60_000;

export const HOSTD_NOT_ANSWERING = 'hostd is not answering. It may be restarting; try again in a moment.';

export const HOSTD_NOT_ANSWERING_FOR_ATTACH =
  'hostd is not answering, so there is no terminal to attach to. It may be restarting; try again in a moment.';

export const HOSTD_NOT_ANSWERING_FOR_ACCOUNTS =
  'hostd is not answering, so nothing can be signed in or checked. It may be restarting; try again in a moment.';

/**
 * How long the bridge waits on hostd for an account. A sign-in answers once
 * the CLI has printed its link and code, which hostd gives up waiting for
 * after 45 seconds; a check is one prompt, which hostd gives up on after 120.
 * These are longer, so it is hostd's answer that arrives and not the bridge's.
 */
export const LOGIN_START_TIMEOUT_MS = 60_000;
export const VERIFY_TIMEOUT_MS = 150_000;
/** hostd gives `grok models` 30 seconds, after a container has started. */
export const MODELS_TIMEOUT_MS = 45_000;

export const HOSTD_NOT_ANSWERING_FOR_ENGINES =
  'hostd is not answering, so the engines cannot be read or updated. It may be restarting; try again in a moment.';

/**
 * hostd answers an update at once, and says what an image carries from its
 * label — but an image built before the label has its CLIs asked in a
 * container, which is seconds.
 */
export const ENGINE_STATUS_TIMEOUT_MS = 60_000;
/** A rollback retags, then replaces each idle bot's container: seconds per bot. */
export const ENGINE_ROLLBACK_TIMEOUT_MS = 5 * 60_000;

/** One model a subscription's CLI offers, as hostd reports it. */
export interface CliModel {
  id: string;
  /** Always null from grok, which dates nothing; kept so the shape is the API's. */
  createdAt: string | null;
  /** The one the CLI uses unasked, and what `newest:grok` resolves to. */
  isDefault: boolean;
}

export class HostdClient {
  /**
   * hostd refuses a caller that does not hold the install's internal secret, so
   * every call but the health check carries it. Where a route records who did
   * something, the person travels as an assertion in a header and hostd writes
   * down that it was one — it used to be a field in the body, which meant
   * anything that could reach the port could name itself in the audit log.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly options: { enginesTimeoutMs?: number; healthTimeoutMs?: number } = {},
  ) {}

  // Every path segment below is encoded. The router decodes a route's
  // parameters, so a bot named `..%2F..%2Fengines%2Frollback%23` arrived here as
  // `../../engines/rollback#` and reached another of hostd's routes, carrying
  // the install's secret.
  private headers(onBehalfOf?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      [INTERNAL_SECRET_HEADER]: this.secret,
      ...(onBehalfOf ? { [ON_BEHALF_OF_HEADER]: onBehalfOf } : {}),
    };
  }

  async health(): Promise<{ ok: boolean; host?: string; driver?: string }> {
    try {
      // A hostd that takes the connection and never answers is down, not slow:
      // without a timeout the bridge's own /healthz waited on it for minutes.
      return await fetchJson(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS) });
    } catch {
      return { ok: false };
    }
  }

  async startTask(input: HostdStartInput): Promise<{ session: string; worktree: string }> {
    return this.call('POST', '/tasks', { body: input, timeoutMs: START_TIMEOUT_MS });
  }

  async resumeTask(
    taskId: string,
    context: ContextDocument[],
    postHeader?: string,
    attachments?: TaskAttachment[],
    reviewMode?: ReviewMode,
    reviewLens?: string,
  ): Promise<{ session: string }> {
    return this.call('POST', `/tasks/${encodeURIComponent(taskId)}/resume`, {
      body: {
        context,
        ...(postHeader ? { postHeader } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(reviewMode ? { reviewMode } : {}),
        ...(reviewLens ? { reviewLens } : {}),
      },
      timeoutMs: START_TIMEOUT_MS,
    });
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    await this.call('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, { body: { reason } });
  }

  /** Starts the repository's checks on a running task's head (hostd's `local-ci.ts`), or answers the run already going. */
  async startLocalCi(taskId: string): Promise<{ run: LocalCiView }> {
    return this.call('POST', `/tasks/${encodeURIComponent(taskId)}/local-ci`, { body: {} });
  }

  /** One local CI run of a task, as hostd has it. */
  async localCiRun(taskId: string, runId: string): Promise<{ run: LocalCiView }> {
    return this.call('GET', `/tasks/${encodeURIComponent(taskId)}/local-ci/${encodeURIComponent(runId)}`);
  }

  /** Releases the worktree and session of a task that has already finished. */
  async cleanupTask(taskId: string, reason: string): Promise<void> {
    await this.call('POST', `/tasks/${encodeURIComponent(taskId)}/cleanup`, { body: { reason } });
  }

  /**
   * Whether each engine the crew is configured for could actually run, asked of
   * the host that would run it. The bridge's own environment is the wrong one
   * to look in: the CLIs and keys are hostd's.
   */
  async engines(): Promise<{ host?: string; bots: { bot: string; readiness: EngineReadiness }[] }> {
    return this.call('GET', '/engines', { timeoutMs: this.options.enginesTimeoutMs ?? ENGINES_TIMEOUT_MS });
  }

  async sessions(bot: string): Promise<{ sessions: unknown[] }> {
    return this.call('GET', `/bots/${encodeURIComponent(bot)}/sessions`);
  }

  async pane(bot: string, session: string, lines = 60): Promise<{ pane: string[] }> {
    return this.call(
      'GET',
      `/bots/${encodeURIComponent(bot)}/sessions/${encodeURIComponent(session)}/pane?lines=${encodeURIComponent(String(lines))}`,
    );
  }

  async killSession(bot: string, session: string, identity: string): Promise<void> {
    await this.call('POST', `/bots/${encodeURIComponent(bot)}/sessions/${encodeURIComponent(session)}/kill`, { body: {}, identity });
  }

  /**
   * Renames a bot's computer: its container, sidecar, network, sessions and
   * work folder. A refusal comes back with hostd's own words and status — 409
   * while the bot is working or a folder is in the way, 400 for a name no bot
   * can have — and no answer at all as a 502, so the caller can tell "later"
   * from "never".
   */
  async renameBot(from: string, to: string): Promise<{ from: string; to: string; folder: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bots/${encodeURIComponent(from)}/rename`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ to }),
        // Removing and creating containers is seconds, not minutes.
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw Object.assign(new Error('hostd is not answering, so the bot’s computer is not renamed yet. It may be restarting; the rename is tried again shortly.'), {
        status: 502,
      });
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw Object.assign(new Error(String(body.error ?? `hostd refused with ${response.status}`)), {
        status: response.status,
      });
    }
    return body as { from: string; to: string; folder: string };
  }

  async restartBot(bot: string, identity: string): Promise<void> {
    await this.call('POST', `/bots/${encodeURIComponent(bot)}/restart`, { body: {}, identity });
  }

  /**
   * One read of one path inside a running task's worktree. There is no matching
   * write, and the bridge adds none: what the console shows is what the bot
   * wrote, and changing it is the bot's job or a person's on a branch.
   */
  async worktree(taskId: string, path: string): Promise<WorktreeAnswer> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await fetch(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/worktree${query}`, {
      headers: this.headers(),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    // Not `fetchJson`, which prefixes its error with the URL it called — that is
    // hostd's address on the private network, and a refusal here is read by a
    // person in a browser. hostd's own words travel ("… climbs out of the
    // worktree"), carrying its status so the console gets 403 rather than 500.
    if (!response.ok) {
      throw Object.assign(new Error(String(body.error ?? `hostd refused with ${response.status}`)), {
        status: response.status,
      });
    }
    return body as WorktreeAnswer;
  }

  /**
   * One call about a model account. hostd's refusal travels as its own words
   * with its own status, as the worktree read's does, because a person reads
   * it on the accounts step; no answer at all says hostd is not answering.
   */
  private async account<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { identity?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.call(method, path, {
      ...(method === 'GET' ? {} : { body: {} }),
      ...(options.identity ? { identity: options.identity } : {}),
      timeoutMs: options.timeoutMs ?? 15_000,
      notAnswering: HOSTD_NOT_ANSWERING_FOR_ACCOUNTS,
    });
  }

  /**
   * One call to hostd. Every call goes through here but the health check,
   * the worktree read and the rename, which say the same in their own way.
   *
   * Not `fetchJson`, which prefixed its error with the URL it called. That is
   * hostd's address on the private network, and the router sends an error's
   * message to the browser, so "Stop" on a card showed it. A refusal travels
   * as hostd's own words with hostd's status; no answer at all says hostd is
   * not answering, with a gateway's status.
   */
  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { body?: unknown; identity?: string; timeoutMs?: number; notAnswering?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(options.identity),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw Object.assign(new Error('hostd did not answer in time. It may be busy; try again in a moment.'), { status: 504 });
      }
      throw Object.assign(new Error(options.notAnswering ?? HOSTD_NOT_ANSWERING), { status: 502 });
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw Object.assign(new Error(String(body.error ?? `hostd refused with ${response.status}`)), {
        status: response.status,
      });
    }
    return body as T;
  }

  /**
   * Starts an OpenAI or xAI subscription's device sign-in. The answer carries
   * the link and one-time code for the operator, and nothing else does.
   */
  async startLogin(accountId: string, identity: string): Promise<SubscriptionLogin> {
    return this.account('POST', `/model-accounts/${encodeURIComponent(accountId)}/login`, {
      identity,
      timeoutMs: LOGIN_START_TIMEOUT_MS,
    });
  }

  async loginStatus(accountId: string): Promise<SubscriptionLogin> {
    return this.account('GET', `/model-accounts/${encodeURIComponent(accountId)}/login`);
  }

  /** Stops a sign-in and deletes the account's login directory. */
  async forgetLogin(accountId: string, identity: string): Promise<void> {
    await this.account('DELETE', `/model-accounts/${encodeURIComponent(accountId)}/login`, { identity });
  }

  /** Runs the account's CLI with a one-line prompt, as a session on it would. */
  async verifyAccount(accountId: string, identity: string): Promise<AccountCheck> {
    return this.account('POST', `/model-accounts/${encodeURIComponent(accountId)}/verify`, {
      identity,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  }

  /**
   * What an xAI subscription can call, as its own CLI lists it: hostd runs
   * `grok models` with the account's login, as a bot on it would, and
   * remembers the answer for a few minutes. A seat that is not signed in, or
   * a CLI that did not answer, is hostd's refusal with a gateway's status.
   */
  async accountModels(accountId: string): Promise<{ models: CliModel[] }> {
    return this.account('GET', `/model-accounts/${encodeURIComponent(accountId)}/models`, {
      timeoutMs: MODELS_TIMEOUT_MS,
    });
  }

  /**
   * An OpenAI or xAI subscription's sign-in, as the files a backup carries,
   * or null when it is not signed in. Credentials: they go into an archive
   * the person downloading it seals, and nowhere else.
   */
  async signInFiles(accountId: string): Promise<Record<string, string> | null> {
    const answer = await this.account<{ files?: Record<string, string> | null }>(
      'GET',
      `/model-accounts/${encodeURIComponent(accountId)}/login/files`,
    );
    return answer.files ?? null;
  }

  /**
   * Takes over a subscription's sign-in from a backup: hostd checks a copy of
   * it by using it, as its account check does, and keeps what the CLI leaves
   * only when the CLI answered. The answer is the check's.
   */
  async adoptSignIn(accountId: string, files: Record<string, string>, identity: string): Promise<AccountCheck> {
    return this.call('POST', `/model-accounts/${encodeURIComponent(accountId)}/login/adopt`, {
      body: { files },
      identity,
      timeoutMs: VERIFY_TIMEOUT_MS,
      notAnswering: HOSTD_NOT_ANSWERING_FOR_ACCOUNTS,
    });
  }

  /**
   * The engine CLIs the bot image carries, and the weekly update: whether one
   * is running and how the last one ended. hostd may have to ask an image
   * built before the version label what its CLIs are, which is a container.
   */
  async engineUpdateStatus(): Promise<EngineUpdateStatus> {
    return this.engineCall('GET', '/engines/update', { timeoutMs: ENGINE_STATUS_TIMEOUT_MS });
  }

  /**
   * Starts the engine update, or joins the one running. hostd answers at once
   * — a build takes minutes — and the caller follows `engineUpdateStatus`.
   * `hold` is the version a rollback undid, which the run does not take again;
   * `minReleaseAgeDays` how long an engine CLI release must have been on npm.
   */
  async startEngineUpdate(
    input: { trigger: string; hold: EngineVersions; only?: readonly string[]; pins?: EngineVersions; minReleaseAgeDays?: number },
    identity?: string,
  ): Promise<EngineUpdateStart> {
    return this.engineCall('POST', '/engines/update', { body: input, timeoutMs: ENGINE_STATUS_TIMEOUT_MS, ...(identity ? { identity } : {}) });
  }

  /** Puts the previous bot image back, and moves the idle bots onto it. */
  async rollbackEngines(identity: string): Promise<EngineUpdateResult> {
    return this.engineCall('POST', '/engines/rollback', { body: {}, identity, timeoutMs: ENGINE_ROLLBACK_TIMEOUT_MS });
  }

  /** One call about the engine update, refused in hostd's own words and status, as an account's is. */
  private async engineCall<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; identity?: string; timeoutMs: number },
  ): Promise<T> {
    return this.call(method, path, {
      ...(method === 'GET' ? {} : { body: options.body ?? {} }),
      ...(options.identity ? { identity: options.identity } : {}),
      timeoutMs: options.timeoutMs,
      notAnswering: HOSTD_NOT_ANSWERING_FOR_ENGINES,
    });
  }

  /**
   * A one-use attach token for a bot's session. With the task the session was
   * started for, hostd mints for that task's own computer, or says why it has
   * none — a paused task whose computer was given back, with the branch its
   * work is on.
   */
  async attachToken(
    bot: string,
    session: string,
    identity: string,
    taskId?: string | null,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    // No answer at all was a TypeError whose whole message is `fetch failed`,
    // and the Terminal tab showed exactly that. Said as what did not answer,
    // with a gateway's status, because this is read by a person in a browser.
    return this.call('POST', '/terminal/tokens', {
      body: { bot, session, ...(taskId ? { taskId } : {}) },
      identity,
      notAnswering: HOSTD_NOT_ANSWERING_FOR_ATTACH,
    });
  }
}
