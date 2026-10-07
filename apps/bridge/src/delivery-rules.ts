import { repos as repoStore, settings } from '@fleetadlc/db';
import {
  DELIVERY_RULES_PATH,
  MERGE_IS_SHIPPING,
  defaultDeliveryRules,
  parseDeliveryRules,
  rulesSetApproval,
  storedDeliveryRules,
  type DeliveryRules,
  type ProductionChoice,
} from '@fleetadlc/shared';
import { shipsByMerging, testingDeployChoice, type WorkflowLister } from './deploys.js';

/**
 * How a repository ships, and where the answer came from.
 *
 * Shipping was a choice on Settings → Repositories and a deploy task for the
 * deploy bot, and production waited on a person. A repository now says how it
 * ships in `.github/fleetadlc.yml` on its default branch — a change to it is a
 * pull request that, since it touches `.github/`, merges only once the security
 * reviewer approves that diff, or by a person (`mergeDecision`) — and the
 * bridge follows it: deploy to testing on merge, promote once the smoke passes, and
 * leave production to whatever GitHub's environment holds it for.
 *
 * Read from, in order: the file; the repository's row (`repos.delivery_rules`)
 * for a repository with no file; and Settings' testing-deploy choice, which is
 * what every repository had before, read as the rules it meant. A file that
 * does not parse is not guessed around: its error is kept, said where the
 * rules are shown, and the next source is used. Whichever it is, an approval
 * or a soak it leaves out is the repository's recorded production choice
 * (`repos.production_*`), asked when it was set up, before the default.
 *
 * A file that could not be read is not a file that is not there. Taken for
 * one, a 502 from GitHub put a repository that soaks for an hour on the
 * Settings default, which promoted at once, and kept it that way for five
 * minutes. The fallback is still returned, for the board and Settings to show,
 * but marked (`readError`), and nothing that acts on the rules acts on it.
 */
export type DeliverySource = 'file' | 'repository' | 'setting';

export interface EffectiveDelivery {
  rules: DeliveryRules;
  source: DeliverySource;
  /**
   * Where testing is served, for the QA bot and the readiness report: the
   * rules' own URL, else the repository's (`repos.testing_url`), else the
   * install's `FLEETADLC_TESTING_URL`, which is deprecated and read only so an
   * install that set it keeps working. Null when none says.
   */
  testingUrl: string | null;
  /** Why `.github/fleetadlc.yml` was not used, when it was there and did not parse. */
  fileError: string | null;
  /** Whether the file sets `production.approval` itself, so no recorded choice changes it. Absent is no. */
  approvalInFile?: boolean;
  /**
   * Why these are not the repository's rules for certain: the file, the
   * repository's row or its production choice could not be read, so `rules`
   * is only the fallback. Something that acts on the rules waits for a read
   * that works. Absent or null, everything was read.
   */
  readError?: string | null;
}

/** What reading the rules asks of GitHub. */
export interface DeliveryClient extends WorkflowLister {
  readFileIfPresent(repo: string, path: string, ref: string): Promise<string | null>;
}

export async function effectiveDelivery(input: {
  repo: { id: string; name: string; fullName: string; defaultBranch: string };
  client: DeliveryClient | null;
  /** The install's `FLEETADLC_TESTING_URL`; deprecated. */
  legacyTestingUrl?: string | null;
}): Promise<EffectiveDelivery> {
  const { repo, client } = input;
  const unread: string[] = [];
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const stored = await repoStore.getDelivery(repo.id).catch((error: unknown) => {
    unread.push(`the repository's stored rules could not be read: ${reason(error)}`);
    return { deliveryRules: null, testingUrl: null };
  });
  // Unreadable is no choice for what is shown, but marked: the default it
  // falls to may ship a repository whose person chose to approve production.
  let choiceUnread: string | null = null;
  const recorded = await repoStore.getProductionChoice(repo.id).catch((error: unknown) => {
    choiceUnread = `the repository's production choice could not be read: ${reason(error)}`;
    unread.push(choiceUnread);
    return null;
  });
  const choice: ProductionChoice = { approval: recorded?.approval ?? null, soakMinutes: recorded?.soakMinutes ?? null };
  const urlFor = (rules: DeliveryRules): string | null =>
    rules.testing.url ?? (stored.testingUrl?.trim() || null) ?? (input.legacyTestingUrl?.trim() || null);

  let fileError: string | null = null;
  // Null only for a file that is not there (a 404); anything else throws.
  const text = client
    ? await client.readFileIfPresent(repo.fullName, DELIVERY_RULES_PATH, repo.defaultBranch).catch((error: unknown) => {
        unread.unshift(`${DELIVERY_RULES_PATH} could not be read: ${reason(error)}`);
        return null;
      })
    : null;
  if (text !== null) {
    const parsed = parseDeliveryRules(text, choice);
    if ('rules' in parsed) {
      const approvalInFile = rulesSetApproval(text);
      // A file that sets its own approval needs no recorded choice; one that leaves it out does.
      return {
        rules: parsed.rules,
        source: 'file',
        testingUrl: urlFor(parsed.rules),
        fileError: null,
        approvalInFile,
        readError: approvalInFile ? null : choiceUnread,
      };
    }
    fileError = parsed.error;
  }
  const readError = unread.length > 0 ? unread.join('; ') : null;

  if (stored.deliveryRules !== null) {
    const rules = storedDeliveryRules(stored.deliveryRules, choice);
    if (rules) return { rules, source: 'repository', testingUrl: urlFor(rules), fileError, readError };
  }

  // The choice every repository had before the rules: none ships by merging,
  // has deploys, and automatic is whether a `deploy-testing` workflow exists —
  // and stays on the deploy path when GitHub could not be asked. Production
  // then ships as the repository's recorded choice says.
  const raw = await settings.getSetting('testingDeploy').catch(() => null);
  const byMerging = await shipsByMerging(client, repo.fullName, testingDeployChoice(raw, repo.name));
  const rules = byMerging === true ? MERGE_IS_SHIPPING : defaultDeliveryRules(choice);
  return { rules, source: 'setting', testingUrl: urlFor(rules), fileError, readError };
}

/**
 * The same, remembered for a few minutes per repository: the board asks every
 * fifteen seconds, and a rule changes by a merge, which is not that urgent.
 *
 * A read that failed is never remembered: the last rules that were read stand
 * in for it, however old, and with none the marked fallback is returned and
 * the next ask reads again.
 */
export class DeliveryKnowledge {
  private readonly known = new Map<string, { at: number; delivery: EffectiveDelivery }>();

  constructor(
    private readonly client: () => Promise<DeliveryClient | null>,
    private readonly legacyTestingUrl: string = '',
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(repo: { id: string; name: string; fullName: string; defaultBranch: string }): Promise<EffectiveDelivery> {
    const held = this.known.get(repo.fullName);
    if (held && this.now() - held.at < this.ttlMs) return held.delivery;
    const delivery = await effectiveDelivery({ repo, client: await this.client().catch(() => null), legacyTestingUrl: this.legacyTestingUrl });
    if (delivery.readError) return held?.delivery ?? delivery;
    this.known.set(repo.fullName, { at: this.now(), delivery });
    return delivery;
  }

  /** Forgets what was read about a repository: a merge changed its rules, or a person changed its row. */
  forget(repoFullName: string): void {
    this.known.delete(repoFullName);
  }
}
