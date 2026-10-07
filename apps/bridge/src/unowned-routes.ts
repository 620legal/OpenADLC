import { IGNORE_LABEL, hasIgnoreLabel, inertMarkup, stageFromLabels } from '@fleetadlc/shared';
import { HttpFailure, type Router } from './router.js';
import { publicNameOf } from './thread-view.js';
import { forgetUnowned as forgetStored } from './unowned-issues.js';

/**
 * A person's decision about issues OpenADLC will not take on its own
 * (`unowned-issues.ts`), from their Needs you card: send them to intake, mark
 * them to ignore, or close them.
 *
 * Sending one to intake is the admin's say-so standing in for the author's
 * access: it goes the way an opened issue goes (`Webhooks.learnIssue`), the
 * stage label put on and intake staffed. Each issue is its own step, and one
 * GitHub refuses does not stop the others; what was and was not done is said.
 */
export interface UnownedRouteDeps {
  repo(name: string): Promise<{ id: string; name: string; fullName: string } | null>;
  /** The automation account's client for the repository; null when it cannot act. */
  github(repoFullName: string): Promise<UnownedGitHub | null>;
  /** The automation account's seat name, which `fleetadlc auth login --bot` takes, for the refusal when it is not connected. */
  automationName(): Promise<string>;
  /** Sends an issue to intake as an opened one goes. */
  learn(
    repo: { id: string; name: string },
    issue: { number: number; title: string; body: string | null; htmlUrl: string; labels: string[] },
  ): Promise<void>;
  audit(entry: { actor: string; action: string; target: string; payload?: Record<string, unknown> }): Promise<void>;
  /** Takes decided issues off the repository's list. */
  forget?(repoName: string, numbers: readonly number[]): Promise<void>;
}

export interface UnownedGitHub {
  getIssue(
    repo: string,
    number: number,
  ): Promise<{ number: number; title: string; body: string | null; labels: string[]; htmlUrl: string; state: 'open' | 'closed'; pullRequest?: boolean }>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<unknown>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

interface UnownedOutcome {
  number: number;
  done: boolean;
  what: string;
}

function numbersOf(input: unknown): number[] {
  const raw = (input as { numbers?: unknown } | null)?.numbers;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((one): one is number => Number.isInteger(one) && (one as number) > 0))];
}

/**
 * The issue as GitHub has it now, if it is still one a person decides here.
 * Any number was acted on: a pull request's was sent to intake through the
 * issues API, or closed, and one that a stage label or `fleetadlc:ignore` had
 * reached since the list was read was "sent to intake" all the same.
 */
async function stillUnowned(client: UnownedGitHub, repo: { fullName: string }, number: number) {
  const issue = await client.getIssue(repo.fullName, number);
  if (issue.pullRequest) throw new Error('it is a pull request, not an issue');
  const stage = stageFromLabels(issue.labels);
  if (stage) throw new Error(`it is in ${stage} already, so it is OpenADLC’s work now`);
  return issue;
}

export function registerUnownedRoutes(router: Router, deps: UnownedRouteDeps): void {
  const forget = deps.forget ?? ((repoName: string, numbers: readonly number[]) => forgetStored(repoName, numbers));

  const decide = async (
    params: Record<string, string | undefined>,
    input: unknown,
    identity: string,
    action: 'intake' | 'ignore' | 'close',
    each: (client: UnownedGitHub, repo: { id: string; name: string; fullName: string }, number: number) => Promise<string>,
  ) => {
    const numbers = numbersOf(input);
    if (numbers.length === 0) throw new HttpFailure(400, 'say which issues: { "numbers": [3, 7] }');
    const repo = await deps.repo(params.repo ?? '');
    if (!repo) throw new HttpFailure(404, `OpenADLC does not work in a repository named ${params.repo ?? ''}`);
    const client = await deps.github(repo.fullName);
    if (!client) {
      const name = await deps.automationName();
      throw new HttpFailure(503, `${name} is not connected to GitHub, so GitHub cannot be asked. Run: fleetadlc auth login --bot ${name}`);
    }

    const outcomes: UnownedOutcome[] = [];
    for (const number of numbers) {
      try {
        outcomes.push({ number, done: true, what: await each(client, repo, number) });
      } catch (error) {
        outcomes.push({ number, done: false, what: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    }
    const decided = outcomes.filter((one) => one.done).map((one) => one.number);
    if (decided.length > 0) await forget(repo.name, decided).catch(() => undefined);
    await deps.audit({ actor: identity, action: `unowned.${action}`, target: repo.name, payload: { outcomes } }).catch(() => undefined);
    return {
      repo: repo.name,
      outcomes,
      done: outcomes.filter((one) => one.done).map((one) => `#${one.number}: ${one.what}`),
      notDone: outcomes.filter((one) => !one.done).map((one) => ({ step: `#${one.number}`, what: `#${one.number} was not changed`, why: one.what })),
    };
  };

  router.post('/v1/repos/:repo/unowned/intake', async ({ params, body, identity }) =>
    decide(params, await body<unknown>().catch(() => null), identity, 'intake', async (client, repo, number) => {
      const issue = await stillUnowned(client, repo, number);
      if (issue.state !== 'open') throw new Error('it is closed');
      if (hasIgnoreLabel(issue.labels)) throw new Error(`it is labelled ${IGNORE_LABEL}, which keeps it from intake`);
      await deps.learn(repo, { number: issue.number, title: issue.title, body: issue.body, htmlUrl: issue.htmlUrl, labels: issue.labels });
      return 'sent to intake';
    }),
  );

  router.post('/v1/repos/:repo/unowned/ignore', async ({ params, body, identity }) =>
    decide(params, await body<unknown>().catch(() => null), identity, 'ignore', async (client, repo, number) => {
      await stillUnowned(client, repo, number);
      await client.addLabels(repo.fullName, number, [IGNORE_LABEL]);
      return `labelled ${IGNORE_LABEL}`;
    }),
  );

  router.post('/v1/repos/:repo/unowned/close', async ({ params, body, identity }) => {
    const input = await body<{ numbers?: unknown; reason?: unknown }>().catch(() => null);
    const reason = typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null;
    return decide(params, input, identity, 'close', async (client, repo, number) => {
      await stillUnowned(client, repo, number);
      const said = `Closed by ${publicNameOf(identity)} from OpenADLC: its author has no access to the repository, so OpenADLC would not take it on its own${reason ? `. ${inertMarkup(reason)}` : '.'}`;
      await client.comment(repo.fullName, number, said).catch(() => undefined);
      await client.request('PATCH', `/repos/${repo.fullName}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' });
      return 'closed as not planned';
    });
  });
}
