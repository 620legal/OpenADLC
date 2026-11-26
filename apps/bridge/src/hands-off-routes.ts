import { audit as writeAudit, people as peopleStore, repos as reposStore, type HandsOffDuration, type HandsOffWindow } from '@openadlc/db';
import { HANDS_OFF_REFUSED, handsOffTarget, type HandsOff, type HandsOffRepo } from './hands-off.js';
import { LINK_ACCOUNT_URL, PEOPLE_URL } from './human-review-decide.js';
import { personKey, type FlowView, type GitHubViewer, type PersonFlows, type PersonGitHubDeps } from './person-github.js';
import { HttpFailure, type Router } from './router.js';

/**
 * Turning hands-off mode on and off from the console (#383,
 * docs/adr/0093-a-hands-off-window-answers-routine-gates-and-never-the-excluded-ones.md).
 *
 * Turning it on lets OpenADLC answer gates in a person's name, so it is held
 * as the release cut is (`release-routes.ts`, ADR 0072): a console person
 * whose linked GitHub account has Approves on in People, asked before the
 * sign-in and again after it, proved by a fresh device-code sign-in whose
 * account id and login are the linked ones and not an account the crew uses.
 * The token is used for nothing but saying who signed in; `PersonFlows`
 * revokes it. Every refusal, before or after the sign-in, is audited as
 * `hands_off.refused`.
 *
 * Turning it off only tightens, so anyone signed in to the console may, at
 * once, and it is audited with who did.
 */

/** Why a turn-on was refused, as its `hands_off.refused` row says. */
export type HandsOffRefusalReason =
  | 'unknown_repo'
  | 'bad_duration'
  | 'not_linked'
  | 'approves_off'
  | 'already_on'
  | 'already_signing'
  | 'sign_in_unavailable'
  | 'sign_in_failed'
  | 'other_account'
  | 'crew_account';

export const NOT_LINKED_FOR_HANDS_OFF =
  'Link your GitHub account in Settings → Your GitHub account: hands-off mode is turned on by the account linked to you, proved by its sign-in.';
export const APPROVES_OFF_FOR_HANDS_OFF = 'Approves is off for you in People, so you cannot turn hands-off mode on; an admin turns it on in Settings → People.';
/**
 * The durations a window may have, as the table's check allows. Kept here
 * rather than read from the store at load: a test's mock of `@openadlc/db`
 * has no store, and every route is registered against one.
 */
const HANDS_OFF_DURATIONS: readonly HandsOffDuration[] = ['1h', '8h', '24h', 'until_off'];
const BAD_DURATION = `duration is one of ${HANDS_OFF_DURATIONS.map((one) => `"${one}"`).join(', ')}: 1 hour, 8 hours, 24 hours, or until turned off`;

/** A window as the console shows it. */
export interface WindowView {
  repo: string;
  fullName: string;
  setByLogin: string;
  setAt: string;
  endsAt: string | null;
  duration: HandsOffDuration;
}

export interface HandsOffRouteDeps {
  handsOff: Pick<HandsOff, 'turnOn' | 'turnOff' | 'openFor' | 'listOpen'>;
  /** A repository OpenADLC works in, by name. */
  repo(name: string): Promise<HandsOffRepo | null>;
  /** Every repository OpenADLC works in: the choices the dialog offers. */
  repos(): Promise<HandsOffRepo[]>;
  flows: Pick<PersonFlows, 'start' | 'state'>;
  /** The viewer's linked GitHub account, or null. */
  linkOf(identity: string): Promise<{ githubLogin: string; githubUserId: number } | null>;
  isCrew(login: string): Promise<boolean>;
  /** Whether People has Approves on for the person this account is linked to. A failed read is a refusal. */
  approves(githubUserId: number): Promise<boolean>;
  audit(entry: { actor: string; action: string; target: string; payload: Record<string, unknown> }): Promise<void>;
  warn?(message: string): void;
}

/** A refusal and the reason its audit row gives. */
class Refusal extends HttpFailure {
  constructor(
    status: number,
    message: string,
    readonly reason: HandsOffRefusalReason,
    details: Record<string, unknown> = {},
  ) {
    super(status, message, details);
  }
}

/** A flow's `use` failing: said as the flow's error, its reason kept for the audit row. */
class UseRefusal extends Error {
  constructor(
    message: string,
    readonly reason: HandsOffRefusalReason,
  ) {
    super(message);
  }
}

interface Signing {
  flowId: string;
  identity: string;
  repo: HandsOffRepo;
  duration: HandsOffDuration;
  link: { githubLogin: string; githubUserId: number };
  used: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDuration(value: unknown): value is HandsOffDuration {
  return typeof value === 'string' && (HANDS_OFF_DURATIONS as readonly string[]).includes(value);
}

export class HandsOffRoutes {
  private readonly signings = new Map<string, Signing>();

  constructor(private readonly deps: HandsOffRouteDeps) {}

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }

  private async view(window: HandsOffWindow, known?: HandsOffRepo[]): Promise<WindowView> {
    const repo = (known ?? (await this.deps.repos().catch(() => []))).find((one) => one.id === window.repoId);
    return {
      repo: repo?.name ?? window.repoId,
      fullName: repo?.fullName ?? window.repoId,
      setByLogin: window.setByLogin,
      setAt: window.setAt,
      endsAt: window.endsAt,
      duration: window.duration,
    };
  }

  /** Whether this viewer may turn it on, and if not, why and where to act on it. */
  private async viewer(identity: string): Promise<{ link: { githubLogin: string; githubUserId: number } | null; why: string | null; url: string | null }> {
    const link = await this.deps.linkOf(personKey(identity)).catch(() => null);
    if (!link) return { link, why: NOT_LINKED_FOR_HANDS_OFF, url: LINK_ACCOUNT_URL };
    if (!(await this.deps.approves(link.githubUserId).catch(() => false))) return { link, why: APPROVES_OFF_FOR_HANDS_OFF, url: PEOPLE_URL };
    return { link, why: null, url: null };
  }

  private async refused(at: {
    repo: string;
    identity: string;
    reason: HandsOffRefusalReason;
    why: string;
    stage: 'before_sign_in' | 'after_sign_in';
    duration?: unknown;
    link?: { githubLogin: string; githubUserId: number } | null;
    viewer?: GitHubViewer;
  }): Promise<void> {
    try {
      await this.deps.audit({
        actor: at.identity,
        action: HANDS_OFF_REFUSED,
        target: handsOffTarget(at.repo),
        payload: {
          repo: at.repo,
          reason: at.reason,
          why: at.why,
          stage: at.stage,
          duration: typeof at.duration === 'string' ? at.duration : null,
          linkedLogin: at.link?.githubLogin ?? null,
          linkedId: at.link?.githubUserId ?? null,
          ...(at.viewer ? { login: at.viewer.login, githubUserId: at.viewer.id } : {}),
          by: at.identity,
        },
      });
    } catch (failure) {
      this.warn(`[bridge] ${at.identity}'s refused hands-off on ${at.repo} (${at.reason}) was not audited: ${messageOf(failure)}`);
    }
  }

  /** The open windows, and whether this viewer may open one. */
  async list(identity: string): Promise<{ windows: WindowView[]; repos: string[]; mayTurnOn: boolean; why?: string; url?: string }> {
    await this.sweepFlows();
    const known = await this.deps.repos();
    const open = await this.deps.handsOff.listOpen();
    const windows = await Promise.all(open.map((window) => this.view(window, known)));
    const who = await this.viewer(identity);
    return {
      windows,
      repos: known.map((repo) => repo.name),
      mayTurnOn: who.why === null,
      ...(who.why ? { why: who.why } : {}),
      ...(who.url ? { url: who.url } : {}),
    };
  }

  /** Checks a turn-on, then starts its device-code sign-in. Each refusal is audited before it is thrown. */
  async turnOn(repoName: string, identity: string, body: unknown): Promise<{ flow: Omit<FlowView<unknown>, 'state' | 'result' | 'error'> }> {
    await this.sweepFlows();
    const duration = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).duration : undefined;
    let link: { githubLogin: string; githubUserId: number } | null = null;
    let repo: HandsOffRepo | null = null;
    try {
      repo = await this.deps.repo(repoName);
      if (!repo) throw new Refusal(404, `${repoName} is not a repository this install manages.`, 'unknown_repo');
      if (!isDuration(duration)) throw new Refusal(400, BAD_DURATION, 'bad_duration');
      link = await this.deps.linkOf(personKey(identity)).catch(() => null);
      if (!link) throw new Refusal(403, NOT_LINKED_FOR_HANDS_OFF, 'not_linked', { url: LINK_ACCOUNT_URL });
      if (!(await this.deps.approves(link.githubUserId).catch(() => false))) throw new Refusal(403, APPROVES_OFF_FOR_HANDS_OFF, 'approves_off', { url: PEOPLE_URL });
      const open = await this.deps.handsOff.openFor(repo.id);
      if (open) throw new Refusal(409, this.alreadyOn(repo, open), 'already_on');
      for (const signing of this.signings.values()) {
        if (signing.repo.id === repo.id && this.deps.flows.state(signing.flowId, signing.identity).state === 'waiting') {
          throw new Refusal(409, `A sign-in to turn hands-off mode on for ${repo.name} is still waiting; approve that code, or let it expire. Nothing was turned on.`, 'already_signing');
        }
      }
    } catch (error) {
      if (error instanceof Refusal) await this.refused({ repo: repo?.fullName ?? repoName, identity, reason: error.reason, why: error.message, stage: 'before_sign_in', duration, link });
      throw error;
    }
    const target = repo;
    const linked = link;
    const chosen = duration;
    let known: (flowId: string) => void = () => undefined;
    const flowId = new Promise<string>((resolve) => (known = resolve));
    let flow: FlowView<WindowView>;
    try {
      flow = await this.deps.flows.start(identity, async (viewer) => this.use({ repo: target, duration: chosen, link: linked, identity, viewer, flowId: await flowId }), {
        noClientId:
          'OpenADLC cannot sign in as a person on this install: no GitHub App client id is configured, so hands-off mode cannot be turned on. An admin finishes “Create the app” first.',
      });
    } catch (error) {
      await this.refused({ repo: target.fullName, identity, reason: 'sign_in_unavailable', why: messageOf(error), stage: 'before_sign_in', duration, link: linked });
      throw error;
    }
    this.signings.set(flow.flowId, { flowId: flow.flowId, identity, repo: target, duration: chosen, link: linked, used: false });
    known(flow.flowId);
    return { flow: { flowId: flow.flowId, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresInSeconds: flow.expiresInSeconds } };
  }

  private alreadyOn(repo: HandsOffRepo, open: HandsOffWindow): string {
    const until = open.endsAt ? `until ${open.endsAt.slice(0, 16).replace('T', ' ')} UTC` : 'until turned off';
    return `Hands-off mode is already on for ${repo.name}, set by @${open.setByLogin} ${until}. Turn it off first to set another.`;
  }

  /**
   * The turn-on once the person approved the code: the account that approved
   * is the linked one and not the crew's, and Approves is still on. Then the
   * window opens, unless another opened meanwhile.
   */
  private async use(input: {
    repo: HandsOffRepo;
    duration: HandsOffDuration;
    link: { githubLogin: string; githubUserId: number };
    identity: string;
    viewer: GitHubViewer;
    flowId: string;
  }): Promise<WindowView> {
    const { repo, duration, link, identity, viewer, flowId } = input;
    const signing = this.signings.get(flowId);
    if (signing) signing.used = true;
    else this.signings.set(flowId, { flowId, identity, repo, duration, link, used: true });
    const refuse = async (error: UseRefusal): Promise<never> => {
      await this.refused({ repo: repo.fullName, identity, reason: error.reason, why: error.message, stage: 'after_sign_in', duration, link, viewer });
      throw error;
    };
    if (viewer.id !== link.githubUserId || viewer.login.toLowerCase() !== link.githubLogin.toLowerCase()) {
      await refuse(new UseRefusal(`You approved the code as @${viewer.login}, which is not the GitHub account linked to you here; hands-off mode was not turned on.`, 'other_account'));
    }
    if (await this.deps.isCrew(viewer.login).catch(() => true)) {
      await refuse(new UseRefusal(`@${viewer.login} is an account the crew uses; a bot never turns hands-off mode on.`, 'crew_account'));
    }
    // Asked again: Approves may have been turned off while the person signed in.
    if (!(await this.deps.approves(viewer.id).catch(() => false))) await refuse(new UseRefusal(APPROVES_OFF_FOR_HANDS_OFF, 'approves_off'));
    const opened = await this.deps.handsOff.turnOn({ repo, setBy: identity, setByLogin: viewer.login, setByGithubId: viewer.id, duration });
    if (!opened.created) await refuse(new UseRefusal(this.alreadyOn(repo, opened.window), 'already_on'));
    return this.view(opened.window, [repo]);
  }

  /** Audits each sign-in that ended without its `use` running. */
  async sweepFlows(): Promise<void> {
    for (const [flowId, signing] of this.signings) {
      const seen = this.deps.flows.state<unknown>(flowId, signing.identity);
      if (seen.state === 'waiting') continue;
      this.signings.delete(flowId);
      if (signing.used) continue;
      const error = 'error' in seen && seen.error ? seen.error : 'the sign-in ended before the code was approved';
      await this.refused({ repo: signing.repo.fullName, identity: signing.identity, reason: 'sign_in_failed', why: error, stage: 'after_sign_in', duration: signing.duration, link: signing.link });
    }
  }

  /** How a turn-on's sign-in went, for the identity that started it only. */
  async flowState(flowId: string, identity: string): Promise<{ state: string; window?: WindowView; error?: string }> {
    const seen = this.deps.flows.state<WindowView>(flowId, identity);
    await this.sweepFlows();
    if (seen.state === 'none') return { state: 'none' };
    const view = seen as FlowView<WindowView>;
    return { state: view.state, ...(view.result ? { window: view.result } : {}), ...(view.error ? { error: view.error } : {}) };
  }

  /** Ends the window at once. Anyone signed in may: it only tightens. */
  async turnOff(repoName: string, identity: string): Promise<{ ended: WindowView & { endedBy: string } }> {
    const repo = await this.deps.repo(repoName);
    if (!repo) throw new HttpFailure(404, `${repoName} is not a repository this install manages.`);
    const ended = await this.deps.handsOff.turnOff(repo, identity);
    if (!ended) throw new HttpFailure(404, `Hands-off mode is not on for ${repo.name}.`);
    return { ended: { ...(await this.view(ended, [repo])), endedBy: ended.endedBy ?? identity } };
  }
}

/** The live wiring: the database, the person's link and People. */
export function liveHandsOffRoutes(input: { handsOff: HandsOffRouteDeps['handsOff']; person: PersonGitHubDeps; flows: PersonFlows }): HandsOffRoutes {
  const toRepo = (found: { id: string; name: string; fullName: string; defaultBranch: string }): HandsOffRepo => ({
    id: found.id,
    name: found.name,
    fullName: found.fullName,
    defaultBranch: found.defaultBranch,
  });
  return new HandsOffRoutes({
    handsOff: input.handsOff,
    repo: async (name) => {
      const found = await reposStore.getRepoByName(name);
      return found ? toRepo(found) : null;
    },
    repos: async () => (await reposStore.listRepos()).map(toRepo),
    flows: input.flows,
    linkOf: (identity) => input.person.store.ofIdentity(identity),
    isCrew: input.person.isCrew,
    approves: async (githubUserId) => (await peopleStore.personByGithubId(githubUserId))?.approves === true,
    audit: async (entry) => {
      await writeAudit(entry);
    },
  });
}

/** The routes: a user's each (`roles.ts`). Approves and the sign-in are checked here, per person, as the release cut checks them. */
export function registerHandsOffRoutes(router: Router, routes: HandsOffRoutes): void {
  router.get('/v1/hands-off', async ({ identity }) => routes.list(identity));
  router.post('/v1/repos/:name/hands-off', async ({ params, body, identity }) => {
    let input: unknown;
    try {
      input = await body<unknown>();
    } catch {
      input = null;
    }
    return routes.turnOn(params.name ?? '', identity, input);
  });
  router.get('/v1/repos/:name/hands-off/flows/:flowId', async ({ params, identity }) => routes.flowState(params.flowId ?? '', identity));
  router.add('DELETE', '/v1/repos/:name/hands-off', async ({ params, identity }) => routes.turnOff(params.name ?? '', identity));
}
