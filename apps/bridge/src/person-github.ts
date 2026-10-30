import { randomUUID } from 'node:crypto';
import { audit as writeAudit, bots, identities, personAccounts, users as usersStore, AccountLinkedElsewhere } from '@openadlc/db';
import {
  appClientSecretRef,
  getSecretStore,
  GitHubClient,
  pollForUserToken,
  requestDeviceCode,
  revokeUserToken,
  type DeviceCode,
  type UserToken,
} from '@openadlc/github';
import type { BridgeConfig } from './config.js';
import { effectiveConfig } from './effective-config.js';
import { HttpFailure, type Router } from './router.js';

/**
 * A console person's own GitHub account: proved by their sign-in, and signed
 * in as again for each post only that account may make.
 *
 * www's page sign-off counts only the page reviewer's own `/approve-pages`
 * comment (#207). A person chose how OpenADLC posts it: a device-flow sign-in
 * at every sign-off, with nothing stored. The app asks for
 * `administration: write` and `pull_requests: write`, so a kept token for an
 * owner could approve pull requests and edit rulesets as that person; a token
 * here lives for the one thing it was asked for, is revoked once that is done,
 * and is never written to the database, the secret store, a log, an audit row,
 * a response or an error. See
 * docs/adr/0018-a-sign-off-is-posted-with-a-token-kept-for-one-post.md.
 *
 * Linking is the same sign-in, once, in Settings: what it keeps is the login
 * and the account id, so a reviewer-only command is offered only to the person
 * whose own sign-in proved them that reviewer, never to one an admin named.
 */

export interface GitHubViewer {
  login: string;
  id: number;
}

export interface PersonGitHubDeps {
  /** The app's client id; null before the app is created. */
  clientId(): Promise<string | null>;
  /** The app's client secret, which revoking a token takes; null when the install holds none. */
  clientSecret(): Promise<string | null>;
  requestCode(clientId: string): Promise<DeviceCode>;
  pollToken(input: { clientId: string; deviceCode: string; intervalSeconds: number; expiresInSeconds: number }): Promise<UserToken>;
  viewer(accessToken: string): Promise<GitHubViewer>;
  revoke(input: { clientId: string; clientSecret: string; accessToken: string }): Promise<boolean>;
  /** Whether a login is one the crew uses: a bot's, or an account OpenADLC holds for one. */
  isCrew(login: string): Promise<boolean>;
  store: Pick<typeof personAccounts, 'link' | 'unlink' | 'ofIdentity'>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
}

export function livePersonGitHubDeps(config: BridgeConfig): PersonGitHubDeps {
  return {
    clientId: async () => (await effectiveConfig(config)).gitHubClientId || null,
    clientSecret: async () => (await getSecretStore().get(appClientSecretRef()).catch(() => null)) || null,
    requestCode: (clientId) => requestDeviceCode({ clientId }),
    pollToken: (input) => pollForUserToken(input),
    viewer: (accessToken) => new GitHubClient({ token: accessToken, actingAs: 'a person' }).viewer(),
    revoke: (input) => revokeUserToken(input),
    isCrew: async (login) => {
      const lower = login.toLowerCase();
      const crew = await bots.listBots();
      if (crew.some((bot) => bot.githubLogin?.toLowerCase() === lower)) return true;
      return Boolean(await identities.identityByLogin(login));
    },
    // Read when used: the api's routes are registered before anything reads a
    // person's link, and a test's mock of the store need not carry this one.
    store: {
      link: (input) => personAccounts.link(input),
      unlink: (identity) => personAccounts.unlink(identity),
      ofIdentity: (identity) => personAccounts.ofIdentity(identity),
    },
    audit: async (entry) => {
      await writeAudit(entry);
    },
  };
}

/** A device flow a person started, kept in memory only: a bridge that restarts forgets it, and the person starts again. */
export interface PersonFlow<R> {
  flowId: string;
  identity: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  state: 'waiting' | 'done' | 'failed';
  result?: R;
  error?: string;
}

export interface FlowView<R> {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  state: PersonFlow<R>['state'] | 'none';
  result?: R;
  error?: string;
}

/** A message with a token taken out of it, whatever said it. */
export function withoutToken(message: string, token: string | null): string {
  return token ? message.split(token).join('[token]') : message;
}

/**
 * Device flows that each sign a person in for one use of the token, then
 * revoke it. `use` is handed the account that approved and its token, and
 * nothing else ever sees the token: it is not kept on the flow, and whatever
 * `use` throws is said without it.
 */
export class PersonFlows {
  private readonly flows = new Map<string, PersonFlow<unknown>>();

  constructor(private readonly deps: PersonGitHubDeps) {}

  /** The client id, or why there is none, said so a person can act on it. */
  async clientId(): Promise<string | null> {
    return this.deps.clientId().catch(() => null);
  }

  async start<R>(
    identity: string,
    use: (viewer: GitHubViewer, accessToken: string) => Promise<R>,
    options: { noClientId?: string } = {},
  ): Promise<FlowView<R>> {
    const clientId = await this.clientId();
    if (!clientId) {
      throw new HttpFailure(409, options.noClientId ?? 'OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured yet. Finish the “Create the app” step first.');
    }
    const code = await this.deps.requestCode(clientId);
    const flow: PersonFlow<R> = {
      flowId: randomUUID(),
      identity,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt: Date.now() + code.expiresIn * 1000,
      state: 'waiting',
    };
    this.prune();
    this.flows.set(flow.flowId, flow as PersonFlow<unknown>);

    const finished = (async () => {
      const token = await this.deps.pollToken({
        clientId,
        deviceCode: code.deviceCode,
        intervalSeconds: code.interval,
        expiresInSeconds: Math.max(1, code.expiresIn),
      });
      let accessToken: string | null = token.accessToken;
      try {
        const viewer = await this.deps.viewer(accessToken);
        flow.result = await use(viewer, accessToken);
        flow.state = 'done';
      } catch (error) {
        flow.state = 'failed';
        flow.error = withoutToken(error instanceof Error ? error.message : String(error), accessToken);
      } finally {
        const secret = await this.deps.clientSecret().catch(() => null);
        if (secret) await this.deps.revoke({ clientId, clientSecret: secret, accessToken }).catch(() => false);
        accessToken = null;
      }
    })();
    void finished.catch((error: unknown) => {
      flow.state = 'failed';
      flow.error = error instanceof Error ? error.message : String(error);
    });
    this.lastRun = finished.catch(() => undefined);
    return this.view(flow);
  }

  /** For tests: the last flow's run, to wait on. */
  lastRun: Promise<void> = Promise.resolve();

  /** How a flow went, for the person who started it only; `none` for one this bridge does not know. */
  state<R>(flowId: string, identity: string): FlowView<R> | { state: 'none' } {
    this.prune();
    const flow = this.flows.get(flowId) as PersonFlow<R> | undefined;
    if (!flow || flow.identity !== identity) return { state: 'none' };
    return this.view(flow);
  }

  /**
   * Drops flows past their code's expiry. A finished flow is kept until then:
   * dropping it on its first read answered a second poll already in flight
   * with `none`, and the panel told a person whose comment was posted to sign
   * in again.
   */
  private prune(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) if (flow.state !== 'waiting' && flow.expiresAt <= now) this.flows.delete(id);
  }

  private view<R>(flow: PersonFlow<R>): FlowView<R> {
    return {
      flowId: flow.flowId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresInSeconds: Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)),
      state: flow.state,
      ...(flow.result !== undefined ? { result: flow.result } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }
}

/** The identity a link is kept under: an address in lower case, as `users` keeps it. */
export function personKey(identity: string): string {
  return usersStore.normalizeEmail(identity);
}

/**
 * Linking a person's GitHub account in Settings: a device flow whose token is
 * used to ask who approved, and revoked. A login the crew uses is refused —
 * a bot's account is not a person's sign-off — and so is one another person
 * has linked.
 */
export async function linkAccount(deps: PersonGitHubDeps, identity: string, viewer: GitHubViewer): Promise<{ login: string }> {
  if (await deps.isCrew(viewer.login)) {
    throw new Error(`@${viewer.login} is an account the crew uses, not a person's. Sign in with your own GitHub account.`);
  }
  try {
    await deps.store.link({ identity: personKey(identity), githubLogin: viewer.login, githubUserId: viewer.id });
  } catch (error) {
    if (error instanceof AccountLinkedElsewhere) throw new Error(error.message);
    throw error;
  }
  await deps.audit({ actor: identity, action: 'person.github_linked', target: personKey(identity), payload: { login: viewer.login, userId: viewer.id } });
  return { login: viewer.login };
}

export function registerPersonGitHubRoutes(router: Router, deps: PersonGitHubDeps, flows: PersonFlows = new PersonFlows(deps)): PersonFlows {
  router.post('/v1/me/github', async ({ identity }) => {
    const flow = await flows.start(identity, (viewer) => linkAccount(deps, identity, viewer));
    return { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds };
  });

  router.get('/v1/me/github/flows/:flowId', async ({ params, identity }) => {
    const seen = flows.state<{ login: string }>(params.flowId ?? '', identity);
    if (seen.state === 'none') return { state: 'none' };
    const view = seen as FlowView<{ login: string }>;
    return { state: view.state, ...(view.result ? { login: view.result.login } : {}), ...(view.error ? { error: view.error } : {}) };
  });

  router.add('DELETE', '/v1/me/github', async ({ identity }) => {
    const held = await deps.store.ofIdentity(personKey(identity));
    if (!(await deps.store.unlink(personKey(identity)))) return { unlinked: false };
    await deps.audit({
      actor: identity,
      action: 'person.github_unlinked',
      target: personKey(identity),
      payload: held ? { login: held.githubLogin, userId: held.githubUserId } : {},
    });
    return { unlinked: true };
  });

  return flows;
}
