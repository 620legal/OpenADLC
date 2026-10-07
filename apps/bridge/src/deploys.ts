/**
 * Whether merging is the end of a repository's delivery.
 *
 * Ship deploys through the repository's own workflows — `deploy-testing`, then
 * a promote — and a repository with no deploy workflow has nothing to run
 * after a merge: merging is shipping. The merge handler asks this to move a
 * card straight to Done, and the board asks it to say so on the Ship column
 * rather than "Deploys what was approved · waits for you" over a stage that
 * never happens.
 */

/** The workflow whose presence means a repository deploys to testing after a merge; OpenADLC dispatches it (deploy-pipeline.ts). */
const DEPLOY_WORKFLOW = 'deploy-testing';

/**
 * What Settings → Repositories stores for one repository.
 *
 * Automatic is the default and is not written: a missing key is the same
 * answer. The other two are explicit, so a workflow file that skips at run
 * time — `FLEETADLC_DEPLOY_TESTING` unset — is not what OpenADLC asks GitHub about.
 * OpenADLC does not read that variable.
 */
export const TESTING_DEPLOY_CHOICES = ['automatic', 'has', 'none'] as const;
export type TestingDeployChoice = (typeof TESTING_DEPLOY_CHOICES)[number];

export function isTestingDeployChoice(value: unknown): value is TestingDeployChoice {
  return (TESTING_DEPLOY_CHOICES as readonly unknown[]).includes(value);
}

/** `has` or `none` by repository name. Anything else in the JSON is automatic. */
function testingDeployEntries(raw: string | null | undefined): Record<string, 'has' | 'none'> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A row that is not JSON is the same as no row: every repository stays automatic.
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, 'has' | 'none'> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === 'has' || value === 'none') out[name] = value;
  }
  return out;
}

/** The choice for one repository. Missing, automatic, or unreadable is automatic. */
export function testingDeployChoice(raw: string | null | undefined, repoName: string): TestingDeployChoice {
  return testingDeployEntries(raw)[repoName] ?? 'automatic';
}

/**
 * The JSON to store after one repository changes, or `''` when nothing explicit
 * remains — `setSetting` deletes the row for an empty value, which is automatic
 * for every repository.
 */
export function testingDeployStored(raw: string | null | undefined, repoName: string, choice: TestingDeployChoice): string {
  const entries = testingDeployEntries(raw);
  if (choice === 'automatic') delete entries[repoName];
  else entries[repoName] = choice;
  return Object.keys(entries).length === 0 ? '' : JSON.stringify(entries);
}

export interface WorkflowLister {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Whether any of a repository's workflows is the deploy. */
export function hasDeployWorkflow(workflows: readonly { name?: string; path?: string }[]): boolean {
  return workflows.some((workflow) => workflow.name === DEPLOY_WORKFLOW || /(?:^|\/)deploy-testing\.ya?ml$/.test(workflow.path ?? ''));
}

/**
 * Whether merging is shipping.
 *
 * `none` and `has` are the person's choice and are not checked against GitHub:
 * a workflow file that exists and skips is still "no testing deploy" once they
 * said so. Automatic is the old question — no `deploy-testing` workflow — and
 * null when GitHub could not be asked, which leaves the caller on the deploy path.
 */
export async function shipsByMerging(
  client: WorkflowLister | null,
  repoFullName: string,
  choice: TestingDeployChoice = 'automatic',
): Promise<boolean | null> {
  if (choice === 'none') return true;
  if (choice === 'has') return false;
  if (!client) return null;
  // Every page: the deploy on the second page of a repository with more than
  // a hundred workflows read as none, and merges went straight to Done.
  for (let page = 1; page <= WORKFLOW_PAGES; page += 1) {
    const listed = await client
      .request<{ workflows?: { name?: string; path?: string }[] }>('GET', `/repos/${repoFullName}/actions/workflows?per_page=100&page=${page}`)
      .catch(() => null);
    if (!listed) return null;
    const workflows = listed.workflows ?? [];
    if (hasDeployWorkflow(workflows)) return false;
    if (workflows.length < 100) return true;
  }
  return null;
}

/** How many pages of workflows are read before the answer is given up on. */
const WORKFLOW_PAGES = 20;

/**
 * The same, remembered for a few minutes, for the board: it is drawn every
 * fifteen seconds while it is open, and a workflow added is not that urgent.
 */
export class DeployKnowledge {
  private readonly known = new Map<string, { at: number; byMerging: boolean | null }>();

  constructor(
    private readonly client: () => Promise<WorkflowLister | null>,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async shipsByMerging(repoFullName: string, choice: TestingDeployChoice = 'automatic'): Promise<boolean | null> {
    // An explicit choice is not a workflow list, so it is not cached as one:
    // remembering `none` under the repository's name would answer the next
    // automatic question without asking GitHub.
    if (choice !== 'automatic') return shipsByMerging(null, repoFullName, choice);
    const held = this.known.get(repoFullName);
    if (held && this.now() - held.at < this.ttlMs) return held.byMerging;
    const byMerging = await shipsByMerging(await this.client().catch(() => null), repoFullName, 'automatic');
    this.known.set(repoFullName, { at: this.now(), byMerging });
    return byMerging;
  }
}
