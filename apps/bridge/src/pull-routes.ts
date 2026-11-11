import { bots, issues, lastAudit, listEventsOfTypeWith, mergeLines, audit as writeAudit, people as peopleStore, personAccounts, repos } from '@openadlc/db';
import { GitHubClient } from '@openadlc/github';
import { mergeBlockers, mergeDecision, type Automation } from './automation.js';
import { HeldMergeDecisions } from './held-merge-decide.js';
import { decisionTarget, HumanReviewDecisions, remindTarget, type HumanReviewDeps } from './human-review-decide.js';
import { heldForPerson } from './merge-line.js';
import { resolveItem, type Item } from './items.js';
import { theApp } from './people.js';
import { PersonFlows, personKey, type FlowView, type PersonGitHubDeps } from './person-github.js';
import { PullCommands, PullRules, useDeclaredCommands, type PullCommandDeps, type PullReader, type PullRepo } from './pull-commands.js';
import { HttpFailure, STREAMING, type Router } from './router.js';
import type { SendBack } from './send-back.js';
import { standingPersonAsks, standingPersonAwaits } from './wait-chain.js';
import { parseRef, PERSON_ASKED_AGAIN, PERSON_AWAITED, REVIEW_ROUND_OPENED, REVIEW_SUBMITTED_ON } from './work.js';

/**
 * A work item's pull request, as its pull panel shows it: the commands its
 * repository declares, what its workflows posted, and the images in that,
 * read through the bridge. See `pull-commands.ts`.
 */

/** The open pull request of the item a subject names, and its repository. */
export type PullOf = (subject: string) => Promise<{ repo: PullRepo; number: number } | null>;

export const livePullOf: PullOf = async (subject) => {
  const found = await resolveItem(subject);
  if (!found?.repo) return null;
  const target = pullTargetOf(subject, found.item, found.repo.name);
  if (!target) return null;
  const repo = await repos.getRepoByName(target.repo);
  if (!repo) return null;
  return { repo: { name: repo.name, fullName: repo.fullName, defaultBranch: repo.defaultBranch }, number: target.number };
};

/**
 * Which pull request a subject's panel acts on, and in which repository. A
 * Needs-you card names the pull it is about (`www#46`, or `api#15` linked onto
 * an item whose issue is in www), and an item can hold a second pull linked
 * onto it: answering with the item's own repository and `pr` there posted the
 * card's sign-off on the item's other pull, and for a pull in another
 * repository read the item's repository's commands. So a subject that is one
 * of the item's pulls is that pull, in its own repository; an issue or a
 * work-item key is the item's pull request. The repository is part of the
 * match: `www#46` and `api#46` are different pull requests.
 */
export function pullTargetOf(subject: string, item: Pick<Item, 'pr' | 'links' | 'refs'>, repoName: string): { repo: string; number: number } | null {
  const asked = parseRef(subject.trim());
  if (asked) {
    const linked = (item.links ?? []).some((link) => link.kind === 'pull' && link.repo === asked.repo && link.number === asked.number);
    if (linked || item.refs.pullRequest === subject.trim()) return { repo: asked.repo, number: asked.number };
  }
  return item.pr ? { repo: repoName, number: item.pr } : null;
}

/** The live wiring: reads as the automation account, posts as the app or as the person. */
export function livePullCommands(input: { reader: () => Promise<PullReader | null>; person: PersonGitHubDeps; flows: PersonFlows }): PullCommands {
  const rules = new PullRules(input.reader);
  const deps: PullCommandDeps = {
    reader: input.reader,
    app: (fullName) => theApp(fullName),
    flows: input.flows,
    person: {
      isCrew: input.person.isCrew,
      store: { ofIdentity: (identity) => personAccounts.ofIdentity(identity), ofUserId: (id) => personAccounts.ofUserId(id) },
    },
    userIdOf: async (login) => {
      const client = await input.reader();
      if (!client) return null;
      const user = await client.request<{ id?: number }>('GET', `/users/${encodeURIComponent(login)}`).catch(() => null);
      return typeof user?.id === 'number' ? user.id : null;
    },
    postAsPerson: async (accessToken, fullName, number, body) => {
      // Exactly the declared text: no header, no seat, no signature.
      const client = new GitHubClient({ token: accessToken, actingAs: 'a person' });
      const posted = await client.request<{ id: number; html_url: string }>('POST', `/repos/${fullName}/issues/${number}/comments`, { body });
      return { id: posted.id, htmlUrl: posted.html_url };
    },
    lastSent: async (target) => {
      const row = await lastAudit('pull.command_sent', target);
      if (!row) return null;
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        head: typeof payload.head === 'string' ? payload.head : '',
        commentUrl: typeof payload.commentUrl === 'string' ? payload.commentUrl : null,
        at: row.at,
      };
    },
    audit: async (entry) => {
      await writeAudit(entry);
    },
  };
  const commands = new PullCommands(deps, rules);
  useDeclaredCommands(rules);
  return commands;
}

/** Posts a person's `APPROVE` review with their one-post token (ADR 0018), pinned to the head they approved. */
export async function postReviewAsPerson(accessToken: string, fullName: string, number: number, review: { commitId: string; body: string }): Promise<{ id: number; htmlUrl: string }> {
  const client = new GitHubClient({ token: accessToken, actingAs: 'a person' });
  const posted = await client.request<{ id: number; html_url: string }>('POST', `/repos/${fullName}/pulls/${number}/reviews`, {
    commit_id: review.commitId,
    event: 'APPROVE',
    body: review.body,
  });
  return { id: posted.id, htmlUrl: posted.html_url };
}

/** How far back a wait is read: as far as Needs you reads it (`ATTENTION_WINDOW_DAYS`). */
const WAIT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * The live wiring of a held approval's decisions: reads as the automation
 * account, posts Approve as the person and Reject's comment as the app, and
 * opens the patch round through `SendBack`.
 */
export function liveHumanReviewDecisions(input: {
  reader: () => Promise<GitHubClient | null>;
  person: PersonGitHubDeps;
  flows: PersonFlows;
  sendBack: SendBack | null;
}): HumanReviewDecisions {
  const reader = async (): Promise<GitHubClient> => {
    const client = await input.reader();
    if (!client) throw new HttpFailure(503, 'OpenADLC has no GitHub account to read the pull request with yet. Finish connecting the automation account first.');
    return client;
  };
  const deps: HumanReviewDeps = {
    // The operator's link on a local install, as Settings shows it (`livePersonGitHubDeps`).
    linkOf: (identity) => input.person.store.ofIdentity(identity),
    userIdOf: async (login) => {
      const client = await input.reader();
      if (!client) return null;
      const user = await client.request<{ id?: number }>('GET', `/users/${encodeURIComponent(login)}`).catch(() => null);
      return typeof user?.id === 'number' ? user.id : null;
    },
    standing: async (repo, pr, login) => {
      const subjectRef = `${repo}#${pr}`;
      const since = Date.now() - WAIT_WINDOW_MS;
      const recent = <T extends { at: string }>(rows: readonly T[]) => rows.filter((row) => Date.parse(row.at) >= since);
      const [awaits, asks, reviews, rounds, listed] = await Promise.all([
        listEventsOfTypeWith(PERSON_AWAITED, { subjectRef }),
        listEventsOfTypeWith(PERSON_ASKED_AGAIN, { subjectRef }),
        listEventsOfTypeWith(REVIEW_SUBMITTED_ON, { subjectRef }),
        listEventsOfTypeWith(REVIEW_ROUND_OPENED, { subjectRef }),
        issues.listIssues(repo),
      ]);
      const key = `${subjectRef}@${login.toLowerCase()}`;
      // Asked again first, as Needs you shows one card per person and pull request.
      const ask = standingPersonAsks(recent(asks), recent(reviews), listed).get(key);
      if (ask) return { head: ask.head };
      const wait = standingPersonAwaits(recent(awaits), recent(reviews), recent(rounds), listed).get(key);
      return wait ? { head: wait.head } : null;
    },
    pull: async (repo, number) => {
      const client = await reader();
      const pull = await client.request<{ state: string; html_url: string; head: { sha: string } }>('GET', `/repos/${repo.fullName}/pulls/${number}`);
      return { open: pull.state === 'open', head: pull.head.sha, url: pull.html_url };
    },
    flows: input.flows,
    isCrew: input.person.isCrew,
    postReviewAsPerson,
    commentAsApp: async (fullName, number, body) => {
      const app = await theApp(fullName);
      if (!app) return null;
      const posted = await app.request<{ html_url: string }>('POST', `/repos/${fullName}/issues/${number}/comments`, { body });
      return { htmlUrl: posted.html_url };
    },
    rejected: async (repo, pr, head) => {
      const row = await lastAudit('pull.human_review_rejected', decisionTarget(repo, pr));
      // Only a Reject that opened the round holds the head: one refused may be tried again.
      const said = (row?.payload ?? {}) as Record<string, unknown>;
      return said.head === head && said.sentBack === true;
    },
    audit: async (entry) => {
      await writeAudit(entry);
    },
    // Remind (ADR 0057) asks as the automation account, as the dismissed-review
    // path in `webhooks.ts` re-requests a reviewer.
    history: async (repo, number) => (await reader()).listPullHistory(repo.fullName, number),
    requestReviewers: async (fullName, number, logins) => (await reader()).requestReviewers(fullName, number, logins),
    removeReviewRequest: async (fullName, number, logins) => (await reader()).removeReviewRequest(fullName, number, logins),
    lastReminded: async (repo, pr, login) => {
      const row = await lastAudit('pull.human_review_reminded', remindTarget(repo, pr, login));
      if (!row) return null;
      const said = (row.payload ?? {}) as Record<string, unknown>;
      return { at: row.at, byName: typeof said.byName === 'string' && said.byName ? said.byName : row.actor };
    },
    nameOf: async (identity) => {
      const key = personKey(identity);
      const found = (await peopleStore.listPeople()).find((person) => person.email !== null && personKey(person.email) === key);
      return found?.name?.trim() || null;
    },
    sendBack: async ({ repo, number, by, reason }) => {
      if (!input.sendBack) return 'nothing on this bridge sends work back to Build';
      const [found, crew, client] = await Promise.all([repos.getRepoByName(repo.name), bots.listBots(), reader()]);
      if (!found) return `${repo.name} is not a repository this install manages`;
      const pull = await client.request<{ head: { ref: string; sha: string } }>('GET', `/repos/${repo.fullName}/pulls/${number}`);
      return input.sendBack.reviewRound({
        repo: { id: found.id, name: found.name },
        repoFullName: repo.fullName,
        pr: { number, head: { ref: pull.head.ref, sha: pull.head.sha } },
        crew,
        client,
        by,
        reason,
      });
    },
  };
  return new HumanReviewDecisions(deps);
}

/** Merges a held pull request with the person's one-post token, squashed, only if its head is still `head` (ADR 0037). */
export async function mergeAsPerson(accessToken: string, fullName: string, number: number, head: string): Promise<{ sha: string }> {
  return new GitHubClient({ token: accessToken, actingAs: 'a person' }).mergePullRequest(fullName, number, head);
}

/**
 * The live wiring of a held merge's decisions: reads as the automation
 * account, recomputes every merge rule on the head through `Automation`, and
 * merges as the person.
 */
export function liveHeldMergeDecisions(input: {
  reader: () => Promise<GitHubClient | null>;
  person: PersonGitHubDeps;
  flows: PersonFlows;
  automation: Pick<Automation, 'mergeFacts'>;
}): HeldMergeDecisions {
  const reader = async (): Promise<GitHubClient> => {
    const client = await input.reader();
    if (!client) throw new HttpFailure(503, 'OpenADLC has no GitHub account to read the pull request with yet. Finish connecting the automation account first.');
    return client;
  };
  return new HeldMergeDecisions({
    linkOf: (identity) => input.person.store.ofIdentity(identity),
    permissionOf: async (fullName, login) => {
      const client = await input.reader();
      if (!client) return null;
      const said = await client
        .request<{ role_name?: string; permission?: string }>('GET', `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`)
        .catch(() => null);
      return said?.role_name ?? said?.permission ?? null;
    },
    isCrew: input.person.isCrew,
    held: async (repo, pr) => {
      const found = await repos.getRepoByName(repo);
      if (!found) return null;
      const entry = await mergeLines.entryFor(found.id, pr);
      const reason = entry ? heldForPerson(entry) : null;
      return entry && reason ? { head: entry.headSha ?? null, reason } : null;
    },
    pull: async (repo, number) => {
      const client = await reader();
      const pull = await client.getPullRequest(repo.fullName, number);
      return { open: pull.state === 'open' && !pull.merged, head: pull.headSha, url: `https://github.com/${repo.fullName}/pull/${number}` };
    },
    blockers: async (repo, number) => {
      const client = await reader();
      const pull = await client.getPullRequest(repo.fullName, number);
      const facts = await input.automation.mergeFacts({ fullName: repo.fullName, defaultBranch: repo.defaultBranch }, pull);
      if (!facts) return null;
      const blockers = mergeBlockers(facts);
      // Fails closed: were the two ever to disagree, the merge line's own
      // refusal stands, and nothing a person may override is assumed.
      const decision = mergeDecision(facts);
      if (!decision.land && blockers.length === 0) return [{ kind: 'unknown', reason: decision.reason }];
      return blockers;
    },
    flows: input.flows,
    mergeAsPerson,
    audit: async (entry) => {
      await writeAudit(entry);
    },
  });
}

/** A GitHub login a decision names, as GitHub allows one. */
function loginOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)) throw new HttpFailure(400, 'login is the GitHub login the approval waits on');
  return value;
}

function headOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new HttpFailure(400, 'head is the commit the decision was shown for');
  return value;
}

function positive(value: string | undefined, what: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpFailure(400, `${what} is a number`);
  return number;
}

export function registerPullRoutes(
  router: Router,
  commands: PullCommands,
  flows: PersonFlows,
  pullOf: PullOf = livePullOf,
  decisions: HumanReviewDecisions | null = null,
  heldMerges: HeldMergeDecisions | null = null,
): void {
  const pullFor = async (subject: string | undefined) => {
    const found = await pullOf(subject ?? '');
    if (!found) throw new HttpFailure(404, 'This work item has no pull request yet.');
    return found;
  };

  router.get('/v1/items/:subject/pull', async ({ params, identity }) => {
    const { repo, number } = await pullFor(params.subject);
    return commands.read(repo, number, identity);
  });

  router.post('/v1/items/:subject/pull/commands/:name', async ({ params, body, identity }) => {
    const { repo, number } = await pullFor(params.subject);
    const input = await body<{ head?: unknown }>();
    if (typeof input.head !== 'string' || !/^[0-9a-f]{40}$/i.test(input.head)) throw new HttpFailure(400, 'head is the commit the button was shown for');
    return commands.send({ repo, number, name: params.name ?? '', head: input.head, identity });
  });

  /**
   * A held Human-review approval decided from the console
   * (`human-review-decide.ts`): Approve answers with the sign-in to approve,
   * whose flow is read as a command's is; Reject sends it back with a reason.
   */
  router.post('/v1/items/:subject/pull/human-review/approve', async ({ params, body, identity }) => {
    if (!decisions) throw new HttpFailure(503, 'This bridge does not decide Human-review approvals; approve it on GitHub.');
    const { repo, number } = await pullFor(params.subject);
    const input = await body<{ head?: unknown; login?: unknown }>();
    return decisions.approve({ repo, number, login: loginOf(input.login), head: headOf(input.head), identity });
  });

  router.post('/v1/items/:subject/pull/human-review/reject', async ({ params, body, identity }) => {
    if (!decisions) throw new HttpFailure(503, 'This bridge does not decide Human-review approvals; request changes on GitHub.');
    const { repo, number } = await pullFor(params.subject);
    const input = await body<{ head?: unknown; login?: unknown; reason?: unknown }>();
    return decisions.reject({ repo, number, login: loginOf(input.login), head: headOf(input.head), identity, reason: typeof input.reason === 'string' ? input.reason : '' });
  });

  /**
   * What a held approval's card says beside its buttons, read by the card
   * itself so `GET /v1/attention` makes no GitHub call: whether GitHub has a
   * review request out to the person, and the last Remind. Remind asks GitHub
   * to request their review again, once an hour per pull request and person,
   * from anyone the card reaches; it decides nothing (ADR 0057).
   */
  router.get('/v1/items/:subject/pull/human-review/request', async ({ params, query }) => {
    if (!decisions) throw new HttpFailure(503, 'This bridge does not read Human-review requests; look at the pull request on GitHub.');
    const { repo, number } = await pullFor(params.subject);
    return decisions.requestStatus({ repo, number, login: loginOf(query.get('login')) });
  });

  router.post('/v1/items/:subject/pull/human-review/remind', async ({ params, body, identity }) => {
    if (!decisions) throw new HttpFailure(503, 'This bridge does not remind people of Human-review approvals; request their review on GitHub.');
    const { repo, number } = await pullFor(params.subject);
    const input = await body<{ login?: unknown }>();
    return decisions.remind({ repo, number, login: loginOf(input.login), identity });
  });

  /**
   * A held merge merged from the console (`held-merge-decide.ts`): answers
   * with the sign-in to merge as the person, whose flow is read as a
   * command's is, with the merge's sha once it lands.
   */
  router.post('/v1/items/:subject/pull/held-merge/merge', async ({ params, body, identity }) => {
    if (!heldMerges) throw new HttpFailure(503, 'This bridge does not merge held pull requests from the console; merge it on GitHub.');
    const { repo, number } = await pullFor(params.subject);
    const input = await body<{ head?: unknown }>();
    return heldMerges.merge({ repo, number, head: headOf(input.head), identity });
  });

  router.get('/v1/items/:subject/pull/flows/:flowId', async ({ params, identity }) => {
    const seen = flows.state<{ commentUrl: string; mergedSha?: string }>(params.flowId ?? '', identity);
    if (seen.state === 'none') return { state: 'none' };
    const view = seen as FlowView<{ commentUrl: string; mergedSha?: string }>;
    return {
      state: view.state === 'done' ? 'sent' : view.state,
      ...(view.result ? { commentUrl: view.result.commentUrl } : {}),
      ...(view.result?.mergedSha ? { mergedSha: view.result.mergedSha } : {}),
      ...(view.error ? { error: view.error } : {}),
    };
  });

  router.get('/v1/items/:subject/pull/images/:commentId/:index', async ({ params, res }) => {
    const { repo, number } = await pullFor(params.subject);
    const image = await commands.image(repo, number, positive(params.commentId, 'commentId'), positive(params.index, 'index'));
    res.writeHead(200, {
      'content-type': image.mediaType,
      'content-length': String(image.bytes.length),
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=300',
    });
    res.end(image.bytes);
    return STREAMING;
  });
}
