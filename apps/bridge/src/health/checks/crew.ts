import { ConfigurationError, collaboratorsUrl, sameSigningKey } from '@fleetadlc/github';
import { COMMITTING_ROLES, botAtStart, botInWords, holdsCredential, repositoryRoleFor, sameLogin, type Bot, type HealthAction } from '@fleetadlc/shared';
import { botSaid } from '../../bot-said.js';
import type { CheckResult, HealthCheck } from '../types.js';
import { GITHUB_CALLS_AT_ONCE, SLOW_CHECK_MS, mapLimited } from '../limited.js';
import { ACCESS_STEP, RECONNECT } from '../words.js';
import { forbiddenBecause, statusOf } from './app.js';

/** Just enough of `GitHubClient` to be faked in a test. */
export interface GitHubLike {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface RepoRef {
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface CrewReader {
  crew(): Promise<Bot[]>;
  repositories(): Promise<RepoRef[]>;
  /** What the bot holds, which is what the walkthrough calls connected. */
  credential(bot: Bot): Promise<{ kind: 'refresh' | 'static' | null; status: string | null }>;
  /** A token that acts as the bot. Throws with GitHub's reason when its sign-in is refused. */
  token(bot: Bot): Promise<string>;
  /** The GitHub user id recorded when the bot's account was connected; null when none was. */
  githubUserId(bot: Bot): Promise<number | null>;
  github(token: string, login: string): GitHubLike;
}

export interface SigningReader extends CrewReader {
  /**
   * The private half of the bot's stored signing key, or null when it has
   * none. The production reader makes and stores one when there is none, so it
   * returns null never, and throws when the secret store cannot be read or
   * written.
   */
  signingKey(bot: Bot): Promise<string | null>;
  publicKeyOf(privateKey: string): string;
  /** Whether a repository's default branch requires signed commits; null when GitHub could not say. */
  requiresSignatures(repo: RepoRef): Promise<boolean | null>;
  /** Whether the app lacks "SSH signing keys", without which no bot can register its key. */
  appLacksSigningPermission(): Promise<boolean>;
  /** Keeps the id GitHub gave a key OpenADLC registered. */
  recordKeyId(bot: Bot, keyId: number): Promise<void>;
}


async function connected(reader: CrewReader, bot: Bot): Promise<boolean> {
  const held = await reader.credential(bot).catch(() => ({ kind: null, status: null }));
  return holdsCredential(held.kind, held.status ? { status: held.status } : null);
}

/** Whether a failure to act as the bot is GitHub refusing its sign-in, rather than GitHub not answering. */
function refused(error: unknown): boolean {
  if (error instanceof ConfigurationError) return false;
  if (statusOf(error) === 401) return true;
  return /no longer valid|bad credentials|revoked|expired|bad_refresh_token|unauthorized/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function reconnect(bot: Bot): HealthAction {
  return { label: `Reconnect ${botInWords(bot)}`, href: RECONNECT };
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The checks whose answer decides whether a bot can do a task at all: its
 * sign-in, its place in the repository, and the host service that runs it.
 * A task started while one fails only fails, so it is not started; a task that
 * failed on one is run again when the check passes.
 */
export const PREREQUISITE_CHECKS = ['bot-sign-in', 'bot-access', 'hostd'] as const;

/** Whether a health row (`checkId` or `checkId:subject`) is one of those checks'. */
export function isPrerequisiteRow(id: string): boolean {
  return (PREREQUISITE_CHECKS as readonly string[]).includes(id.split(':')[0] ?? '');
}

/** Just the columns of a health row that a blocker is read from. */
export interface HealthAnswer {
  id: string;
  state: string;
  title: string | null;
  detail: string | null;
}

export interface Blocker {
  /** The failing row, which is also the one whose recovery clears this. */
  row: string;
  /** `paused`: a person paused the seat from Crew (`seat-pause.ts`); no health row, and its resume is what clears it. */
  kind: 'sign-in' | 'access' | 'host' | 'paused';
  /** Short enough for a status line: who cannot do what. */
  why: string;
  /** What the board's card tells a person to do, for an error that has to say it too. */
  instruction: string;
}

/** What keeps this seat from working in this repository right now, from what the checks last said. */
export function blockersOf(rows: readonly HealthAnswer[], seat: { id: string; name: string }, repoName: string | null): Blocker[] {
  const failing = (id: string) => rows.find((row) => row.id === id && row.state === 'failing');
  const said = (row: HealthAnswer) => row.detail ?? row.title ?? '';
  const blockers: Blocker[] = [];

  const signIn = failing(`bot-sign-in:${seat.id}`);
  if (signIn) blockers.push({ row: signIn.id, kind: 'sign-in', why: `${seat.name} cannot sign in to GitHub`, instruction: said(signIn) });

  const access = repoName ? failing(`bot-access:${seat.id}:${repoName}`) : undefined;
  if (access) blockers.push({ row: access.id, kind: 'access', why: `${seat.name} cannot work in ${repoName}`, instruction: said(access) });

  const host = failing('hostd');
  if (host) blockers.push({ row: host.id, kind: 'host', why: 'OpenADLC’s host service is not answering', instruction: said(host) });
  return blockers;
}

/**
 * The gate's description when the reviewers it waits on are ones that cannot
 * work, or null when it waits on none of those. "waiting on the reviewer
 * account" says what "waiting on lead-reviewer" leaves a person to find out:
 * that nothing is coming until somebody reconnects it.
 *
 * Read from the description because the callers that need this — the review
 * event and the scheduler's sweep — get the gate from `computeReviewGate`,
 * which names the seats it waits on and nothing more.
 */
export function waitingOnBlocked(description: string, blocked: ReadonlyMap<string, readonly Blocker[]>): string | null {
  const named = /^waiting on (.+)$/.exec(description)?.[1]?.split(', ') ?? [];
  const blockers = named.flatMap((name) => blocked.get(name) ?? []);
  if (blockers.length === 0) return null;
  const ofAccount = blockers.filter((blocker) => blocker.kind === 'sign-in' || blocker.kind === 'access');
  const paused = blockers.filter((blocker) => blocker.kind === 'paused');
  const shown = ofAccount.length > 0 ? ofAccount : paused.length > 0 ? paused : blockers;
  const subject = ofAccount.length > 0 ? 'the reviewer account' : paused.length > 0 ? 'a paused seat' : 'the host service';
  return `waiting on ${subject}: ${[...new Set(shown.map((blocker) => blocker.why))].join('; ')}`;
}

/**
 * The health row a failed task's own words point at, or null when they point
 * at none. Only what a check proves is matched, and only what it plainly says:
 * a model account signed out, a permission the app lacks or a failed build
 * are not these, and a task that failed for them waits for a person.
 */
export function causeOfFailure(reason: string | null | undefined, task: { botId: string; repoName: string | null }): string | null {
  const text = reason ?? '';
  // Work recorded without being started, because a check was failing
  // (`TaskService.open`, `whenBlocked: 'record'`). The words are OpenADLC's own,
  // from the blocker, so they name the row exactly; the first is the one
  // waited on, as a sign-in is put right before anything else can be.
  const held = /^\S+ was not started: ([^.]*)\./.exec(text)?.[1];
  if (held !== undefined) {
    if (/ cannot sign in to GitHub/.test(held)) return `bot-sign-in:${task.botId}`;
    if (task.repoName && / cannot work in /.test(held)) return `bot-access:${task.botId}:${task.repoName}`;
    if (/host service is not answering/.test(held)) return 'hostd';
    return null;
  }
  if (/bad credentials|authorization is no longer valid|is not connected to GitHub|github\.com.*\b401\b/i.test(text)) {
    return `bot-sign-in:${task.botId}`;
  }
  if (task.repoName && /permission to \S+ denied|repository not found|write access to repository not granted/i.test(text)) {
    return `bot-access:${task.botId}:${task.repoName}`;
  }
  // A refused connection is hostd's only when it was the bridge's call to
  // hostd that got no answer: `hostd refused: fetch failed` is what
  // `TaskService.open` records then. A bare `connect ECONNREFUSED` could be the
  // database, a model's API or a proxy, and hostd passing proves none of them.
  if (/host stopped reporting|hostd (?:is not answering|did not answer)|^hostd refused: fetch failed/i.test(text)) return 'hostd';
  return null;
}

export interface CrewChecks {
  signIn: HealthCheck;
  access: HealthCheck;
  signingKey: HealthCheck;
}

export function crewChecks(reader: SigningReader): CrewChecks {
  const signIn: HealthCheck = {
    id: 'bot-sign-in',
    proves: 'Each bot can sign in to GitHub as its own account',
    how: 'mints the bot’s token from its stored sign-in and asks GitHub who it is',
    everyMinutes: 10,
    // A seat on an account is the Crew step. Two connected accounts, with no
    // seat on them yet, is the github-accounts check.
    steps: ['crew'],
    async run() {
      const crew = await reader.crew();
      return Promise.all(
        crew.map(async (bot): Promise<CheckResult> => {
          const facts = { botId: bot.id };
          if (!bot.githubLogin || !(await connected(reader, bot))) {
            return {
              subject: bot.id,
              ok: false,
              severity: 'blocking',
              title: `${botSaid(bot)} has no GitHub account connected`,
              detail:
                'It cannot work until one is. Connect it: OpenADLC shows a code, and you approve it in a browser signed in as the account it should use — or give it an account the crew already has.',
              action: { label: `Connect ${botInWords(bot)}`, href: RECONNECT },
              facts,
            };
          }
          try {
            const token = await reader.token(bot);
            const user = await reader.github(token, bot.githubLogin).request<{ login?: string; id?: number }>('GET', '/user');
            // A sign-in that works as another account: the bot acts on GitHub
            // as someone OpenADLC does not record for it, so its posts are not
            // recognised as the crew's and its access is that account's.
            if (user?.login && !sameLogin(user.login, bot.githubLogin)) {
              // The same account under a new login: the crew is recognised by
              // login, so its posts read as a person's until the new one is
              // recorded. Said, not recorded here: which login is the crew's is
              // for a person to see change.
              const recorded = await reader.githubUserId(bot).catch(() => null);
              if (recorded !== null && user.id === recorded) {
                return {
                  subject: bot.id,
                  ok: false,
                  severity: 'blocking',
                  title: `${botAtStart(bot)} has been renamed on GitHub to ${user.login}`,
                  detail:
                    `The account OpenADLC records as ${bot.githubLogin} is called ${user.login} on GitHub now. OpenADLC knows the crew by ` +
                    `login, so until it records the new one this bot's posts read as a person's. Reconnect it, and approve the ` +
                    `code in a browser signed in as ${user.login}: OpenADLC then records ${user.login} for it.`,
                  action: reconnect(bot),
                  facts: { ...facts, renamedTo: user.login },
                };
              }
              return {
                subject: bot.id,
                ok: false,
                severity: 'blocking',
                title: `${botAtStart(bot)} signs in to GitHub as ${user.login}, not ${bot.githubLogin}`,
                detail:
                  `Its stored sign-in belongs to ${user.login}, and OpenADLC records it as ${bot.githubLogin}. Reconnect it, and ` +
                  `approve the code in a browser signed in as ${bot.githubLogin}.`,
                action: reconnect(bot),
                facts,
              };
            }
            return { subject: bot.id, ok: true, fixed: `${botAtStart(bot)} can sign in to GitHub again`, facts };
          } catch (error) {
            if (!refused(error)) {
              return { subject: bot.id, ok: null, reason: `GitHub could not be asked about ${botInWords(bot)}: ${messageOf(error)}`, facts };
            }
            return {
              subject: bot.id,
              ok: false,
              severity: 'blocking',
              title: `${botAtStart(bot)} cannot sign in to GitHub`,
              detail:
                `GitHub refused its stored sign-in, so it cannot comment, push or review. Reconnect it, and approve the code ` +
                `in a browser signed in as ${bot.githubLogin}.`,
              action: reconnect(bot),
              // What settings' accounts card reads as GitHub refusing it (`Onboarding.accounts`).
              facts: { ...facts, refused: true },
            };
          }
        }),
      );
    },
  };

  const access: HealthCheck = {
    id: 'bot-access',
    proves: 'Each bot is in each repository, with the access its role needs',
    how: 'asks GitHub, with the bot’s own token, what it may do in the repository',
    everyMinutes: 30,
    steps: ['access'],
    timeoutMs: SLOW_CHECK_MS,
    async run() {
      const [crew, repositories] = await Promise.all([reader.crew(), reader.repositories()]);
      if (repositories.length === 0) return [];
      const results: CheckResult[] = [];
      const asking: { bot: Bot; github: GitHubLike; repo: RepoRef }[] = [];
      for (const bot of crew) {
        // A bot never connected has no access to ask about.
        if (!bot.githubLogin) continue;
        // One with no working sign-in is the sign-in check's to say, and its
        // access cannot be asked: no answer, so its rows here stand as they were.
        if (!(await connected(reader, bot))) {
          for (const repo of repositories) {
            results.push({ subject: `${bot.id}:${repo.name}`, ok: null, reason: 'it holds no working sign-in to ask with' });
          }
          continue;
        }
        let github: GitHubLike;
        try {
          github = reader.github(await reader.token(bot), bot.githubLogin);
        } catch (error) {
          for (const repo of repositories) {
            results.push({ subject: `${bot.id}:${repo.name}`, ok: null, reason: `its sign-in did not work: ${messageOf(error)}` });
          }
          continue;
        }
        for (const repo of repositories) asking.push({ bot, github, repo });
      }
      // One GET per seat per repository: asked a few at a time, not one by one.
      const answers = await mapLimited(asking, GITHUB_CALLS_AT_ONCE, async ({ bot, github, repo }): Promise<CheckResult> => {
        const subject = `${bot.id}:${repo.name}`;
        const facts = { botId: bot.id, repo: repo.name };
        const letIn: HealthAction = { label: 'Let the crew in', href: ACCESS_STEP };
        try {
          const seen = await github.request<{
            permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean };
            owner?: { type?: string };
          }>('GET', `/repos/${repo.fullName}`);
          const may = seen.permissions ?? {};
          const needs = repositoryRoleFor(bot.role, seen.owner?.type === 'Organization');
          // More than its role needs is not passing either: admin or maintain
          // can change the rulesets and branch protection that are GitHub's
          // half of "a bot cannot merge", and is what promote-production takes
          // for an emergency override of its testing check. Nothing lowers it
          // on its own; the card says what to change.
          if (may.admin || may.maintain) {
            const role = may.admin ? 'admin' : 'maintain';
            return {
              subject,
              ok: false,
              severity: 'blocking',
              title: `${botAtStart(bot)} has ${role} on ${repo.fullName}`,
              detail:
                `Its account, ${bot.githubLogin}, can change ${repo.fullName}'s rulesets and branch protection, which are what keep a bot ` +
                `from merging on GitHub's side, and could ship to production past the testing check: promote-production lets admin ` +
                `and maintain pass emergency_override. Lower it to ${needs} on the repository's collaborators page; if the account is ` +
                'a person’s, put the seat on an account of its own.',
              action: { label: `Open ${repo.fullName}'s collaborators`, url: collaboratorsUrl(repo.fullName) },
              facts: { ...facts, role },
            };
          }
          const writes = Boolean(may.admin || may.maintain || may.push);
          const enough = needs === 'write' ? writes : writes || Boolean(may.triage);
          if (enough) return { subject, ok: true, fixed: `${botAtStart(bot)} is in ${repo.fullName}`, facts };
          return {
            subject,
            ok: false,
            severity: 'blocking',
            title: `${botAtStart(bot)} cannot ${needs === 'write' ? 'push to' : 'triage in'} ${repo.fullName}`,
            detail:
              `Its role needs ${needs} access and it has less, so its work there fails when it ${needs === 'write' ? 'pushes' : 'labels'}. ` +
              'Let the crew in again from the walkthrough; OpenADLC invites each bot with the role it needs.',
            action: letIn,
            facts,
          };
        } catch (error) {
          const status = statusOf(error);
          // Only a 404 says the bot is not there: GitHub answers 403 for a
          // spent rate limit, an organization's SSO or its IP allow list too.
          if (status === 404) {
            return {
              subject,
              ok: false,
              severity: 'blocking',
              title: `${botAtStart(bot)} is not in ${repo.fullName} yet`,
              detail:
                'Its invitation has not been accepted, so it cannot work there. Let the crew in from the walkthrough: ' +
                'OpenADLC invites each bot as the app and accepts for it.',
              action: letIn,
              facts,
            };
          }
          if (status === 403) {
            const owner = repo.fullName.split('/')[0] ?? repo.fullName;
            const because = forbiddenBecause(error);
            if (because === 'rate-limit') {
              return { subject, ok: null, reason: `GitHub is rate limiting ${bot.githubLogin}, so it could not be asked: ${messageOf(error)}`, facts };
            }
            if (because === 'sso') {
              return {
                subject,
                ok: false,
                severity: 'blocking',
                title: `${botAtStart(bot)} is not signed in to ${owner}’s single sign-on`,
                detail:
                  `${owner} requires SAML single sign-on, and the sign-in of ${bot.githubLogin} is not authorized for it, so GitHub ` +
                  `refuses it in ${repo.fullName}. Sign in to GitHub as ${bot.githubLogin}, authorize it on ${owner}’s single ` +
                  `sign-on page, then reconnect ${botInWords(bot)}.`,
                action: { label: `Open ${owner}’s single sign-on`, url: `https://github.com/orgs/${owner}/sso` },
                facts,
              };
            }
            if (because === 'ip-allow-list') {
              return {
                subject,
                ok: false,
                severity: 'blocking',
                title: `${owner}’s IP allow list refuses ${botInWords(bot)}`,
                detail:
                  `${owner} lets GitHub be reached only from the addresses on its IP allow list, and this host’s address is not ` +
                  `on it, so ${botInWords(bot)} cannot work in ${repo.fullName}. Add the address OpenADLC runs from to the ` +
                  'list on the organization’s authentication security settings.',
                action: { label: `Open ${owner}’s security settings`, url: `https://github.com/organizations/${owner}/settings/security` },
                facts,
              };
            }
            return {
              subject,
              ok: false,
              severity: 'blocking',
              title: `GitHub refused ${botInWords(bot)} in ${repo.fullName}`,
              detail:
                `GitHub answered: ${messageOf(error)}. That does not say it is missing from the repository, so read what GitHub ` +
                'says first; if it is about access, let the crew in again from the walkthrough.',
              action: letIn,
              facts,
            };
          }
          return { subject, ok: null, reason: `GitHub could not be asked: ${messageOf(error)}`, facts };
        }
      });
      return [...results, ...answers];
    },
  };

  const signingKey: HealthCheck = {
    id: 'signing-key',
    proves: 'Each bot that commits has its signing key on its GitHub account',
    how: 'lists the account’s SSH signing keys on GitHub and compares them with the public half of the key OpenADLC stored for the bot',
    everyMinutes: 15,
    // The key is registered when a committing seat is put on an account, which
    // is the Crew step, not the step that only connects the account.
    steps: ['crew'],
    timeoutMs: SLOW_CHECK_MS,
    async run() {
      const [crew, repositories] = await Promise.all([reader.crew(), reader.repositories()]);
      const committing = crew.filter((bot) => COMMITTING_ROLES.includes(bot.role));
      if (committing.length === 0) return [];

      const requiresSignatures: Record<string, boolean | null> = {};
      const required = await mapLimited(repositories, GITHUB_CALLS_AT_ONCE, (repo) => reader.requiresSignatures(repo).catch(() => null));
      repositories.forEach((repo, index) => {
        requiresSignatures[repo.name] = required[index] ?? null;
      });
      const requiring = repositories.filter((repo) => requiresSignatures[repo.name] === true).map((repo) => repo.fullName);
      const lacksPermission = await reader.appLacksSigningPermission().catch(() => false);

      const results: CheckResult[] = [];
      // Per account: the signing keys GitHub lists for it, and the public half
      // of every seat's key on it, so a key nobody here registered is seen.
      // Incomplete when a seat's key could not be read: its key would look
      // like a stranger's.
      const accounts = new Map<string, { listed: { id: number; key: string }[] | null; ours: string[]; complete: boolean }>();
      const account = (login: string) => {
        const known = accounts.get(login) ?? { listed: null, ours: [], complete: true };
        accounts.set(login, known);
        return known;
      };
      for (const bot of committing) {
        const facts: Record<string, unknown> = { botId: bot.id, requiresSignatures };
        // Not connected is the sign-in check's to say.
        if (!bot.githubLogin) continue;
        const keys = account(bot.githubLogin);
        if (!(await connected(reader, bot))) {
          keys.complete = false;
          continue;
        }

        const missing = (why: string): CheckResult => ({
          subject: bot.id,
          ok: false,
          severity: requiring.length > 0 ? 'blocking' : 'warning',
          title: `${botAtStart(bot)} has no signing key on its GitHub account`,
          detail:
            (lacksPermission ? 'The OpenADLC app needs “SSH signing keys” first; then ' : '') +
            `${lacksPermission ? 'reconnect' : 'Reconnect'} ${botInWords(bot)} so GitHub learns its signing key${why}. ` +
            `Until then its commits read Unverified` +
            (requiring.length > 0
              ? `, and ${list(requiring)} ${requiring.length === 1 ? 'requires' : 'require'} signed commits, so no build is handed to it.`
              : '.'),
          action: reconnect(bot),
          waitingFor: lacksPermission ? ['app-permissions:git_signing_ssh_public_keys'] : [],
          facts: { ...facts, registered: false },
        });

        // A store that could not be read or written is not a missing key:
        // read as one, the card sent a person to reconnect, which makes no key
        // the store cannot keep, and the store's own error never reached them.
        let stored: string | null;
        try {
          stored = await reader.signingKey(bot);
        } catch (error) {
          keys.complete = false;
          results.push({
            subject: bot.id,
            ok: null,
            reason: `its signing key could not be read from or written to the secret store: ${messageOf(error)}`,
            facts,
          });
          continue;
        }
        if (!stored) {
          keys.complete = false;
          results.push(missing(': it has none yet, and connecting makes one'));
          continue;
        }

        let github: GitHubLike;
        let publicKey: string;
        try {
          publicKey = reader.publicKeyOf(stored);
          github = reader.github(await reader.token(bot), bot.githubLogin);
        } catch (error) {
          keys.complete = false;
          results.push({ subject: bot.id, ok: null, reason: `its key or its sign-in could not be read: ${messageOf(error)}`, facts });
          continue;
        }

        let listed: { id: number; key: string }[];
        try {
          // The account's public list: no permission is needed to read it,
          // which is what makes it evidence rather than the bot's own say-so.
          listed = await github.request<{ id: number; key: string }[]>('GET', `/users/${bot.githubLogin}/ssh_signing_keys`);
        } catch (error) {
          keys.complete = false;
          results.push({ subject: bot.id, ok: null, reason: `GitHub did not list the signing keys of ${botInWords(bot)}: ${messageOf(error)}`, facts });
          continue;
        }
        keys.listed = listed;
        keys.ours.push(publicKey);

        const known = listed.find((key) => sameSigningKey(key.key, publicKey));
        if (known) {
          results.push({ subject: bot.id, ok: true, fixed: `GitHub knows the signing key of ${botInWords(bot)} now`, facts: { ...facts, registered: true, keyId: known.id } });
          continue;
        }

        // OpenADLC can often do this itself: the bot's own token registers its
        // own key, when its sign-in carries the permission. Only when GitHub
        // refuses is a person asked.
        try {
          const created = await github.request<{ id: number }>('POST', '/user/ssh_signing_keys', {
            title: `fleetadlc-${bot.name}`,
            key: publicKey,
          });
          await reader.recordKeyId(bot, created.id).catch(() => undefined);
          results.push({
            subject: bot.id,
            ok: true,
            note: `Registered the signing key of ${botInWords(bot)} on its GitHub account`,
            fixed: `GitHub knows the signing key of ${botInWords(bot)} now`,
            facts: { ...facts, registered: true, keyId: created.id },
          });
        } catch (error) {
          const status = statusOf(error);
          if (forbiddenBecause(error) === 'rate-limit') {
            results.push(missing(' — GitHub was rate limiting its account when OpenADLC tried to register it, and the next check tries again'));
          } else if (status === 403 || status === 404 || status === 401) {
            results.push(missing(' — its sign-in was made before the app could register one'));
          } else {
            results.push(missing(`: GitHub would not take it (${messageOf(error)})`));
          }
        }
      }

      // A session holds its account's token, and with it the app's "SSH
      // signing keys" permission, which only this check needs. A key it adds
      // verifies for the account as well as the seat's own, so on a shared
      // account a Verified commit no longer says which seat made it, and a key
      // it removes leaves the other seats' commits Unverified. Until sessions
      // get a token without account permissions, a key OpenADLC did not
      // register is a card. Only while it is there: the row goes when it does.
      for (const [login, keys] of accounts) {
        if (!keys.complete || !keys.listed) continue;
        const foreign = keys.listed.filter((key) => !keys.ours.some((ours) => sameSigningKey(key.key, ours)));
        if (foreign.length === 0) continue;
        results.push({
          subject: `account:${login}`,
          ok: false,
          severity: 'warning',
          title: `${login} has ${foreign.length === 1 ? 'a signing key' : `${foreign.length} signing keys`} OpenADLC did not register`,
          detail:
            `GitHub lists ${foreign.length === 1 ? 'a key' : 'keys'} on ${login} that ${foreign.length === 1 ? 'is' : 'are'} no seat's ` +
            `(id ${foreign.map((key) => key.id).join(', ')}). A commit signed with ${foreign.length === 1 ? 'it' : 'one'} reads Verified ` +
            'for the account, whichever seat or session made it. If nobody here added it, remove it on the account’s SSH and GPG keys ' +
            `page, signed in as ${login}; OpenADLC registers each seat’s own key again when it is missing.`,
          action: { label: 'Open the account’s keys', url: 'https://github.com/settings/keys' },
          facts: { login, keyIds: foreign.map((key) => key.id) },
        });
      }
      return results;
    },
  };

  return { signIn, access, signingKey };
}
