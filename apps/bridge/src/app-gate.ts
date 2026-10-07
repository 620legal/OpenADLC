import { appJwt, GitHubClient, installationTokenFor, type AppApi, type AppCredentials } from '@fleetadlc/github';
import { REVIEW_GATE_CHECK } from '@fleetadlc/shared';

/**
 * `review-gate` published by the GitHub App, as a check run, rather than by a
 * bot as a commit status.
 *
 * A commit status can be set by any token with write access to statuses — and
 * with the builder, intake and automation on one crew account, that includes
 * the builder's own token. A bot could mark its own pull request reviewed. A
 * check run is set by the app that made it, and a ruleset can require a check
 * from one app alone (`integration_id`), so pinned, the gate is the bridge's
 * word and nobody else's. It needs the app to hold "Checks: write"; an app made
 * before OpenADLC asked for it goes on with the status, and the app-permissions
 * card says what to add.
 */

export type GateState = 'pending' | 'success' | 'failure';

export interface AppGateDeps {
  credentials: () => Promise<AppCredentials | null>;
  api: AppApi;
  /** How long what `/app` said is believed. */
  cacheMs?: number;
  now?: () => number;
}

export class AppGate {
  private known: { at: number; appId: number | null; botLogin: string | null } | null = null;

  constructor(private readonly deps: AppGateDeps) {}

  /**
   * The app's id when it can publish the gate — it holds "Checks: write" — and
   * null when it cannot, or cannot be asked.
   */
  async appId(): Promise<number | null> {
    return (await this.about()).appId;
  }

  /**
   * The login GitHub names as the creator of what the app writes, such as
   * `fleetadlc-janedoe[bot]`, whether or not it holds "Checks: write". Null
   * when the app cannot be asked. An app without Checks sets the gate as a
   * status, and this is how that status is told from one a bot's token set.
   */
  async botLogin(): Promise<string | null> {
    return (await this.about()).botLogin;
  }

  /** What `GET /app` said, believed for a while. */
  private async about(): Promise<{ appId: number | null; botLogin: string | null }> {
    const now = (this.deps.now ?? Date.now)();
    if (this.known && now - this.known.at < (this.deps.cacheMs ?? 10 * 60 * 1000)) return this.known;
    const credentials = await this.deps.credentials().catch(() => null);
    let appId: number | null = null;
    let botLogin: string | null = null;
    if (credentials) {
      const app = await this.deps.api
        .request<{ id?: number; slug?: string; permissions?: Record<string, string> }>('GET', '/app', appJwt(credentials, now))
        .catch(() => null);
      appId = app?.id && app.permissions?.checks === 'write' ? app.id : null;
      botLogin = app?.slug ? `${app.slug}[bot]` : null;
    }
    this.known = { at: now, appId, botLogin };
    return this.known;
  }

  private async token(repoFullName: string): Promise<string | null> {
    const credentials = await this.deps.credentials().catch(() => null);
    if (!credentials) return null;
    return installationTokenFor(this.deps.api, credentials, repoFullName)
      .then((minted) => minted.token)
      .catch(() => null);
  }

  /**
   * A client acting as the app itself, on one repository, or null when the app
   * cannot be asked. For what the bridge does in its own name, never a bot's:
   * merging a pull request the merge line decided may land, running a failed
   * CI again, turning auto-merge off, parking a pull request as a draft,
   * putting `adlc:ci` on or taking it off, and dispatching deploys.
   * It writes no prose, so it has no header and no seat.
   */
  async client(repoFullName: string): Promise<GitHubClient | null> {
    const token = await this.token(repoFullName);
    return token ? new GitHubClient({ token, actingAs: 'fleetadlc-app' }) : null;
  }

  /** Publishes the gate on a head. False when the app cannot, and the caller falls back to the status. */
  async publish(repoFullName: string, sha: string, state: GateState, description: string): Promise<boolean> {
    if (!(await this.appId())) return false;
    const token = await this.token(repoFullName);
    if (!token) return false;
    const title = description.slice(0, 140);
    return this.deps.api
      .request('POST', `/repos/${repoFullName}/check-runs`, token, {
        name: REVIEW_GATE_CHECK,
        head_sha: sha,
        ...(state === 'pending'
          ? { status: 'in_progress' }
          : { status: 'completed', conclusion: state === 'success' ? 'success' : 'failure' }),
        output: { title, summary: description },
      })
      .then(() => true)
      .catch((error: unknown) => {
        console.warn(`[bridge] review-gate check run not published on ${repoFullName}@${sha.slice(0, 7)}: ${error instanceof Error ? error.message : error}`);
        return false;
      });
  }

  /**
   * Sets the `review-gate` commit status as the app. The automation account
   * holds triage on an organization's repository so that it cannot push, and
   * GitHub lets only an account that can push set a commit status — so as the
   * automation account the gate was never published there at all. The app
   * holds "Commit statuses: write" on every repository it is installed on.
   * False when it cannot, and the caller tries the automation account.
   */
  async publishStatus(repoFullName: string, sha: string, state: GateState, description: string): Promise<boolean> {
    const token = await this.token(repoFullName);
    if (!token) return false;
    return this.deps.api
      .request('POST', `/repos/${repoFullName}/statuses/${sha}`, token, {
        state,
        context: REVIEW_GATE_CHECK,
        description: description.slice(0, 140),
      })
      .then(() => true)
      .catch((error: unknown) => {
        console.warn(`[bridge] review-gate status not set by the app on ${repoFullName}@${sha.slice(0, 7)}: ${error instanceof Error ? error.message : error}`);
        return false;
      });
  }

  /** The gate as the app last published it on a head, or null when it has not. */
  async standing(repoFullName: string, sha: string): Promise<{ state: GateState; description: string } | null> {
    const appId = await this.appId();
    if (!appId) return null;
    const token = await this.token(repoFullName);
    if (!token) return null;
    const runs = await this.deps.api
      .request<{ check_runs?: { status: string; conclusion: string | null; output?: { title?: string | null }; app?: { id?: number } }[] }>(
        'GET',
        `/repos/${repoFullName}/commits/${sha}/check-runs?check_name=${REVIEW_GATE_CHECK}&filter=latest`,
        token,
      )
      .catch(() => null);
    const run = runs?.check_runs?.find((one) => one.app?.id === appId);
    if (!run) return null;
    const state: GateState = run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'success' : 'failure';
    return { state, description: run.output?.title ?? '' };
  }
}
