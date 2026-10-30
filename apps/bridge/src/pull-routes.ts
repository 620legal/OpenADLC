import { lastAudit, audit as writeAudit, personAccounts, repos } from '@openadlc/db';
import { GitHubClient } from '@openadlc/github';
import { resolveItem, type Item } from './items.js';
import { theApp } from './people.js';
import { PersonFlows, type FlowView, type PersonGitHubDeps } from './person-github.js';
import { PullCommands, PullRules, useDeclaredCommands, type PullCommandDeps, type PullReader, type PullRepo } from './pull-commands.js';
import { HttpFailure, STREAMING, type Router } from './router.js';
import { parseRef } from './work.js';

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

function positive(value: string | undefined, what: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpFailure(400, `${what} is a number`);
  return number;
}

export function registerPullRoutes(router: Router, commands: PullCommands, flows: PersonFlows, pullOf: PullOf = livePullOf): void {
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

  router.get('/v1/items/:subject/pull/flows/:flowId', async ({ params, identity }) => {
    const seen = flows.state<{ commentUrl: string }>(params.flowId ?? '', identity);
    if (seen.state === 'none') return { state: 'none' };
    const view = seen as FlowView<{ commentUrl: string }>;
    return {
      state: view.state === 'done' ? 'sent' : view.state,
      ...(view.result ? { commentUrl: view.result.commentUrl } : {}),
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
